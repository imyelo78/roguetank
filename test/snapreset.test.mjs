// 快照接收：tick 回退（新一局）的处理。
//
// 这是 19 版线上实测抓到的真 bug，症状极具迷惑性：
// **点「开始战斗」后，队友 / 敌人 / 子弹定格约 3 秒，而自己的车还能动。**
//
// 原因链：
//   1. 服务端 lobby 阶段世界照常跑，tick 已经数到 ~86；
//   2. `world.start()` 把 tick 归零重来（新一局）；
//   3. 客户端只做了"tick 必须递增"的防乱序，于是把归零后的快照全判成乱序包丢弃；
//   4. 要等服务端 tick 重新爬过 86（≈2.9 秒）才恢复接收；
//   5. 恢复瞬间 `_serverOffset` 因为 tick 时间轴换了基准而跳变约 3000ms，
//      渲染游标（want）一口气超前 60 多格，要好几个秒才收回来。
//
// 自己那辆车不受影响，因为它是本地预测画出来的 —— 所以玩家看到的是
// "别人卡住了"，很容易被误判成网络问题或别人的问题。
import assert from 'node:assert/strict';

globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.location = { protocol: 'http:', host: '127.0.0.1', search: '' };
globalThis.window = { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };

// 假 WebSocket：不真连网，只把实例交出来，让测试能手动喂消息给 onmessage。
// 直接用真的 ws 会需要一个活着的服务端（net.test.mjs 就是那样），
// 而这里要测的是纯客户端的状态机，不该依赖服务端进程。
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 1; FakeWS.last = this; }
  send() {}
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeWS;

const { NetClient } = await import('../src/net.js');
const { PROTOCOL_VERSION, S2C, TICK_RATE } = await import('../src/core/protocol.js');

let pass = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };

/** 造一条最小快照（encodeSnapshot 的结构） */
const snapMsg = (tick, x = 0, z = 0, state = 'playing') => ({
  k: S2C.SNAP,
  tick,
  w: 1,
  s: state,
  e: [
    0, 'u1', Math.round(x * 100), Math.round(z * 100), 0, 0, 100, 0,
  ],
  sc: [0],
  ex: 0,
});

/** 把一条消息喂给 NetClient 的 ws.onmessage */
function feed(net, msg) {
  net.ws.onmessage({ data: JSON.stringify(msg) });
}

/** 建一个已连上的 NetClient（connect 会给 ws.onmessage 绑上真处理器） */
function makeNet() {
  const net = new NetClient();
  net.connect({ name: '测试', chassis: 'panther' });
  assert.equal(typeof net.ws.onmessage, 'function', 'connect 后应绑定 onmessage');
  return net;
}

// ---- 1) 正常递增：必须全部接收 ----
{
  const net = makeNet();
  for (let i = 1; i <= 20; i++) feed(net, snapMsg(i * 2));
  assert.equal(net.snaps.length > 0, true, '正常快照一条都没收');
  const ticks = net.snaps.map((s) => s.tick);
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i] > ticks[i - 1], '缓冲里 tick 必须单调递增');
  }
  ok(`正常递增：${net.snaps.length} 条（缓冲上限内）全部接收`);
}

// ---- 2) 乱序（tick 只回退一点点，不是新一局）：应当丢弃 ----
{
  const net = makeNet();
  for (let i = 1; i <= 10; i++) feed(net, snapMsg(i * 2));
  const before = net.snaps.map((s) => s.tick);
  const newest = before[before.length - 1];
  // 回退 2 格：这是真正的乱序包，不该重置，也不该进缓冲
  feed(net, snapMsg(newest - 2));
  const maxTick = Math.max(...net.snaps.map((s) => s.tick));
  assert.equal(maxTick, newest, '轻微乱序不该被当成新一局（tick 不该倒退）');
  assert.equal(net.snaps.length, before.length, '乱序包不该被塞进缓冲');
  ok('轻微乱序（回退 1 格）被正确丢弃，未误判为新一局');
}

// ---- 3) tick 归零（新一局）：必须整段重置并接收 ----
{
  const net = makeNet();
  // lobby 跑到 tick=86
  for (let i = 1; i <= 43; i++) feed(net, snapMsg(i * 2, 0, 0, 'lobby'));
  const lobbyNewest = net.snaps[net.snaps.length - 1].tick;
  assert.ok(lobbyNewest >= 80, `lobby 阶段 tick 应到 ~86，实际 ${lobbyNewest}`);

  // 开局，tick 归零
  feed(net, snapMsg(2, 0, 0, 'playing'));
  const newest = net.snaps[net.snaps.length - 1];
  assert.equal(newest.tick, 2,
    `开局后的第一条快照（tick=2）被丢弃了：最新 tick 还是 ${newest.tick}，`
    + '这会让画面在开局后冻结约 3 秒');
  assert.equal(net.snaps.length, 1, '新一局应当清空旧缓冲，只留新快照');
  ok(`tick 归零被识别为新一局：旧缓冲（tick ${lobbyNewest}）清空，立即接收 tick=2`);
}

// ---- 4) 归零后连续快照必须全部接收（不能只收第一条又卡住）----
{
  const net = makeNet();
  for (let i = 1; i <= 43; i++) feed(net, snapMsg(i * 2, 0, 0, 'lobby'));
  let accepted = 0;
  for (let i = 1; i <= 60; i++) {
    const t = i * 2;
    feed(net, snapMsg(t));
    if (net.snaps[net.snaps.length - 1].tick === t) accepted++;
  }
  assert.equal(accepted, 60, `归零后只接收了 ${accepted}/60 条，仍会卡顿`);
  ok('归零后 60 条快照连续接收，无二次冻结');
}

// ---- 5) 时钟基准必须跟着重置 ----
//
// 旧 tick 时间轴（tick 86 × 33.3ms ≈ 2866ms）和新时间轴（tick 2 × 33.3ms）
// 差约 2800ms。如果 `_serverOffset` 不重置，渲染游标会一口气超前 80 多格，
// 画面表现为"开局后先定住、然后猛地追上"。
{
  const net = makeNet();
  for (let i = 1; i <= 43; i++) feed(net, snapMsg(i * 2, 0, 0, 'lobby'));
  const offBefore = net._serverOffset;
  assert.ok(Number.isFinite(offBefore), 'lobby 阶段 offset 应当已有值');

  feed(net, snapMsg(2));
  // 重置后第一条会重新计算 offset，必须与新 tick 自洽而不是沿用旧的
  const tickMs = 1000 / TICK_RATE;
  const B = net.snaps[net.snaps.length - 1];
  const expect = B.tick * tickMs - B.at;
  assert.ok(Math.abs(net._serverOffset - expect) < 1e-6,
    `offset 没跟着 tick 重置：实际 ${net._serverOffset}，应为 ${expect}（差 ${Math.abs(net._serverOffset - expect)}ms）`);
  ok('tick 归零时 offset 同步重置，游标不会一次性超前');
}

console.log(`\n快照 tick 回退测试全部通过（${pass} 项）`);
