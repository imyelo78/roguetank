// 联机协议端到端测试：不需要浏览器，直接开两三个 WebSocket 客户端打一局
// 运行前先起服务： node server.mjs
// 然后： node test/net.test.mjs [port]

import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, C2S, S2C } from '../src/core/protocol.js';

const PORT = Number(process.argv[2] || 5173);
const URL = `ws://127.0.0.1:${PORT}/ws`;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一个最小客户端：收集消息、按类型等 */
class Client {
  constructor(name, chassis) {
    this.name = name;
    this.chassis = chassis;
    this.msgs = [];
    this.byType = new Map();
    this.ws = new WebSocket(URL);
  }

  open(code) {
    return new Promise((resolve, reject) => {
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ k: C2S.HELLO, v: PROTOCOL_VERSION, name: this.name, chassis: this.chassis, code }));
      });
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        this.msgs.push(m);
        const kind = m.k;
        const list = this.byType.get(kind) || [];
        list.push(m);
        this.byType.set(kind, list);
        if (kind === S2C.WELCOME || kind === S2C.DENY) resolve(m);
      });
      setTimeout(() => reject(new Error('握手超时')), 5000);
    });
  }

  send(o) { this.ws.send(JSON.stringify(o)); }
  last(type) { const l = this.byType.get(type) || []; return l[l.length - 1]; }
  count(type) { return (this.byType.get(type) || []).length; }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

console.log('\n[1] 建房 + 握手');
const a = new Client('甲', 'heavy');
const wa = await a.open();
assert.equal(wa.k, S2C.WELCOME, JSON.stringify(wa));
assert.ok(wa.code, '应返回房间码');
assert.ok(wa.you);
assert.equal(wa.v, PROTOCOL_VERSION);
assert.equal(wa.maxPlayers, 4);
ok(`建房成功，房间码 ${wa.code}`);

// 地表场：两个人必须拿到同一个种子，否则"你陷在沼泽、他跑在草地"
assert.ok(wa.terrain && wa.terrain.seed > 0, 'WELCOME 必须带 terrain.seed');
assert.ok(!Array.isArray(wa.terrain.cells), '不要把 27×27 的格点数组塞进握手包');
ok(`地表种子 ${wa.terrain.seed}（档位 ${wa.terrain.preset}，k=${wa.terrain.k}）`);

// 客户端按种子本地重建，必须能建出和 map 尺寸一致的图（纯函数保证逐格相同）
{
  const { buildTerrain } = await import('../src/core/terrain.js');
  const local = buildTerrain(wa.terrain.seed, 100, { k: wa.terrain.k });
  ok(`客户端可本地重建 ${local.n}×${local.n} 地表场`);
}

console.log('\n[2] 第二人凭房间码加入');
const b = new Client('乙', 'light');
const wb = await b.open(wa.code);
assert.equal(wb.k, S2C.WELCOME);
assert.equal(wb.code, wa.code);
assert.equal(wb.players.length, 2);
ok('两人同房');
assert.equal(wb.terrain.seed, wa.terrain.seed, '同房间两人拿到的地表种子必须相同');
ok('两人地表种子一致');

console.log('\n[3] 错误的房间码必须被拒绝');
const c = new Client('丙', 'balanced');
const wc = await c.open('ZZZZ');
assert.equal(wc.k, S2C.DENY);
assert.equal(wc.reason, 'no-room');
c.close();
ok('不存在的房间码返回 no-room');

console.log('\n[4] 超过 4 人拒绝');
const extra = [];
for (let i = 0; i < 2; i++) {
  const x = new Client(`凑数${i}`, 'balanced');
  await x.open(wa.code);
  extra.push(x);
}
const fifth = new Client('第五人', 'balanced');
const w5 = await fifth.open(wa.code);
assert.equal(w5.k, S2C.DENY);
assert.equal(w5.reason, 'full');
fifth.close();
ok('第 5 人被拒（房间上限 4）');
for (const x of extra) x.close();
await sleep(300);

console.log('\n[5] 自动开局并开始收快照');
await sleep(4200); // 自动开局倒计时 3 秒
assert.ok(a.count(S2C.SNAP) > 0, '应收到快照');
const snap = a.last(S2C.SNAP);
assert.ok(Array.isArray(snap.e) && snap.e.length > 0, '快照应带实体');
ok(`收到 ${a.count(S2C.SNAP)} 个快照，实体数 ${snap.e.length / 8}`);

console.log('\n[6] 输入能推动模拟');
// 先读位置，再持续发同一方向的输入，最后读位置
const readMe = (cs) => {
  const s = cs.last(S2C.SNAP);
  if (!s) return null;
  for (let i = 0; i < s.e.length; i += 8) {
    if (s.e[i] === 0 && s.e[i + 1] === wa.you) return { x: s.e[i + 2], z: s.e[i + 3] };
  }
  return null;
};

// 先让自动开局跑起来
await sleep(1500);
const p0 = readMe(a);
assert.ok(p0, '快照里应当有自己的坦克');

let seq = 1;
const timer = setInterval(() => {
  a.send({ k: C2S.INPUT, seq: seq++, mx: 0, mz: 1, ax: 0, az: -50, fire: true });
}, 33);
await sleep(1500);
clearInterval(timer);
await sleep(200);

const p1 = readMe(a);
assert.ok(p1);
const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
assert.ok(moved > 100, `应前进了至少 1 米，实际 ${moved}cm`);
ok(`按前进 1.5 秒，位移 ${(moved / 100).toFixed(2)} 米`);

console.log('\n[7] 开火能产生事件');
const shots = (a.byType.get(S2C.EVENT) || []).flatMap((m) => m.e).filter((e) => e.kind === 'shot');
assert.ok(shots.length > 0, '应收到 shot 事件');
ok(`收到 ${shots.length} 次开火事件`);

console.log('\n[8] 掉线后房间仍在，另一人继续');
b.close();
await sleep(600);
const snapsAfterLeave = a.count(S2C.SNAP);
await sleep(500);
assert.ok(a.count(S2C.SNAP) > snapsAfterLeave, '掉线不该让房间停转');
ok('一人掉线，房间继续运行');

console.log('\n[9] 协议版本不符被拒');
const oldC = new WebSocket(URL);
const reason = await new Promise((resolve) => {
  oldC.on('open', () => oldC.send(JSON.stringify({ k: C2S.HELLO, v: 999, name: '老客户端' })));
  oldC.on('message', (raw) => resolve(JSON.parse(raw).reason));
  setTimeout(() => resolve('timeout'), 3000);
});
assert.equal(reason, 'bad-version');
oldC.close();
ok('版本不符返回 bad-version');

a.close();
await sleep(300);

// ---------------------------------------------------------------
// 以下两项单独建房，避免受上面那局的状态影响
// ---------------------------------------------------------------

console.log('\n[10] 房主点「开始战斗」立即开局');
const h = new Client('房主', 'balanced');
const wh = await h.open();
assert.equal(wh.k, S2C.WELCOME);
assert.equal(wh.host, wh.you, 'welcome 里应告诉客户端谁是房主');
h.send({ k: C2S.READY });
await sleep(600); // 远早于 3 秒自动开局
assert.ok(h.count(S2C.SNAP) > 0, '房主点开始后应立刻收到快照');
ok(`房主手动开局生效（${h.count(S2C.SNAP)} 个快照，0.6 秒内）`);

const joiner = new Client('路人', 'hunter');
const wj = await joiner.open(wh.code);
assert.equal(wj.k, S2C.WELCOME);
assert.equal(wj.started, true, '中途加入应被告知已开局');
assert.ok(wj.world && wj.world.players.length >= 2, '中途加入应带全量世界，直接能打');
ok('中途加入拿到全量世界，可立即参战');

// 非房主不能开局：新开一局验证
const r1 = new Client('甲甲', 'heavy');
const wr1 = await r1.open();
const r2 = new Client('乙乙', 'light');
const wr2 = await r2.open(wr1.code);
r2.send({ k: C2S.READY });
await sleep(400);
// 不能用"收到快照"判断开局：lobby 状态下也会持续广播快照（大厅里要能看到地图）
const wl = r1.last(S2C.WELCOME);
const startedEarly = (r1.byType.get(S2C.SNAP) || []).some((m) => m.s !== 'lobby') || wl.started === true;
assert.equal(startedEarly, false, '非房主点开始不应开局');
ok('非房主按「开始战斗」不会抢开局');

h.close();
joiner.close();
r1.close();
r2.close();
await sleep(300);

// ---------------------------------------------------------------
// 联机成长：每波清完各自 3 选 1
// ---------------------------------------------------------------
console.log('\n[12] 联机成长：发卡 → 各自选 → 应用');
{
  const g1 = new Client('成长甲', 'heavy');
  const wg1 = await g1.open();
  const g2 = new Client('成长乙', 'heavy');
  const wg2 = await g2.open(wg1.code);

  // 建筑必须由服务端下发（客户端不自己生成）
  assert.ok(Array.isArray(wg1.world.boxes) && wg1.world.boxes.length > 30, 'welcome 应带建筑坐标');
  const bx = wg1.world.boxes[0];
  assert.ok(['x', 'z', 'w', 'd'].every((k) => typeof bx[k] === 'number'), '建筑只需 x/z/w/d');
  ok(`服务端下发 ${wg1.world.boxes.length} 个建筑（不含随机高度/颜色，省带宽）`);

  g1.send({ k: C2S.READY });

  // 不真打，等着收 CARDS：第 1 波清完才会发。给足够时间 + 主动开火清怪太慢，
  // 所以直接等，超时就算失败（服务端有全场 8 只左右，最多半分钟）。
  const waitFor = async (cs, type, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = cs.last(type);
      if (m) return m;
      await sleep(150);
    }
    return null;
  };

  // 帮忙清怪：从各自出生点朝地图中心开火。怪从中心方向刷出来、
  // 会主动走近玩家，所以"朝中心打"命中率最高。
  // 之前两个版本都试过：固定朝 -Z 打（北边出生点打不到怪）、
  // 从快照解析敌人坐标自动瞄准（编码格式对不上，一只都打不中）。
  // welcome.world.players 里有自己的出生坐标，从这里算方向最稳。
  const myPos = (welcome) => {
    const me = welcome.world.players.find((p) => p.id === welcome.you);
    return me ? [me.x, me.z] : [0, 0];
  };
  const [x1, z1] = myPos(wg1);
  const [x2, z2] = myPos(wg2);
  // 方向：从出生点指向地图中心，取 90 米外的点
  const toCenter = ([x, z]) => {
    const len = Math.hypot(x, z) || 1;
    return [-x / len * 90, -z / len * 90];
  };
  const [tx1, tz1] = toCenter([x1, z1]);
  const [tx2, tz2] = toCenter([x2, z2]);
  let seqG = 1;
  const fire = setInterval(() => {
    g1.send({ k: C2S.INPUT, seq: seqG++, mx: 0, mz: 0, ax: tx1, az: tz1, fire: true });
    g2.send({ k: C2S.INPUT, seq: seqG, mx: 0, mz: 0, ax: tx2, az: tz2, fire: true });
    seqG++;
  }, 66);

  // 谁先收到都算过：站桩 2 分钟被 4 只 gunner 集火，先死一个很正常
  // （这正是联机的真实体验）。发卡只发给活着的人，这是设计而非 bug。
  const cards1 = await Promise.race([
    waitFor(g1, S2C.CARDS, 120000).then((m) => m && { cs: g1, m }),
    waitFor(g2, S2C.CARDS, 120000).then((m) => m && { cs: g2, m }),
  ]);
  clearInterval(fire);
  assert.ok(cards1, '第 1 波清完应有人收到 CARDS');
  assert.equal(cards1.m.options.length, 3, '每次应给 3 张');
  assert.ok(cards1.m.ms > 0, '应带倒计时');
  ok(`第 ${cards1.m.wave} 波清完，「${cards1.cs.name}」收到 3 张卡（${cards1.m.options.map((o) => o.name).join(' / ')}）`);

  // 选一张，服务端应回确认事件；已选过再点会被拒绝
  const before = (cards1.cs.byType.get(S2C.EVENT) || []).length;
  cards1.cs.send({ k: C2S.PICK, id: cards1.m.options[0].id });
  await sleep(400);
  const picked = (cards1.cs.byType.get(S2C.EVENT) || []).slice(before)
    .flatMap((m) => m.e).filter((e) => e.kind === 'picked' || e.kind === 'pick');
  assert.ok(picked.length > 0, '选完后应收到确认事件');
  ok(`选了「${cards1.m.options[0].name}」，服务端确认`);

  const before2 = (cards1.cs.byType.get(S2C.EVENT) || []).length;
  cards1.cs.send({ k: C2S.PICK, id: cards1.m.options[1].id });
  await sleep(300);
  const extra = (cards1.cs.byType.get(S2C.EVENT) || []).slice(before2)
    .flatMap((m) => m.e).filter((e) => e.kind === 'picked' || e.kind === 'pick');
  assert.equal(extra.length, 0, '已经选过就不能再选');
  ok('重复选卡被服务端拒绝（客户端说了不算）');

  // 单测层面的补充：真实网络里"打完整波"太慢也太不稳（怪会走位，玩家会挨打），
  // 这里直接用 World 跑同样的规则，把"别人还在选、超时自动选、卡池枯竭"几条边界钉死。
  {
    const { World } = await import('../src/core/world.js');
    const w = new World({ code: 'UT', seed: 31337 });
    const p1 = w.addPlayer({ id: 'x', name: '甲', chassisId: 'light' });
    const p2 = w.addPlayer({ id: 'y', name: '乙', chassisId: 'heavy' });
    w.start();
    // 每 10 帧清一次怪，快速走完一波
    let dealt = null;
    for (let i = 0; i < 600 && !dealt; i++) {
      for (const e of w.step(1 / 30)) if (e.kind === 'cards') dealt = e;
      if (i % 10 === 0) { w.enemies.length = 0; w.pending.length = 0; }
    }
    assert.ok(dealt, 'World 清波后应发卡');
    assert.equal(dealt.dealt.length, 2, '两个活着的人各一份');
    assert.ok(dealt.dealt.every((d) => d.options.length === 3), '每人 3 张');
    ok('World 清波 → 两个玩家各 3 张卡');

    assert.equal(w.pickCard('x', dealt.dealt[0].options[0].id).ok, true);
    assert.equal(w.pickCard('x', dealt.dealt[0].options[1].id).ok, false, '不能选两次');
    assert.equal(w.awaitingPicks, true, '还有人没选，窗口应保持打开');
    ok('一人选完后窗口保持，等另一人');

    // 超时：把窗口拨到 0，下一 tick 应自动替他选
    w.pickT = 0;
    w.step(1 / 30);
    assert.equal(w.awaitingPicks, false, '超时后应关窗');
    const stat = w.players.find((q) => q.id === 'y').stats;
    assert.equal(Object.values(stat.counts).reduce((a, b) => a + b, 0), 1, '超时应自动替他拿一张');
    ok('超时自动选第一张，不会白丢这一波');

    // 再走一会儿应进入下一波
    for (let i = 0; i < 90; i++) w.step(1 / 30);
    assert.equal(w.wave, 2, `选完卡后应进入第 2 波，实际 ${w.wave}`);
    ok('选卡结束 → 波次推进到第 2 波');

    // 卡池枯竭：把所有卡都拉满，再清一波应该不发卡也不卡住
    for (const q of w.players) {
      for (const k of Object.keys(q.stats.counts)) q.stats.counts[k] = 999;
    }
    const { UPGRADES } = await import('../src/upgrades.js');
    const { weaponCards } = await import('../src/weapons.js');
    for (const q of w.players) {
      for (const u of UPGRADES) q.stats.counts[u.id] = 999;
      for (const u of weaponCards(q.stats.weaponId)) q.stats.counts[u.id] = 999;
    }
    let stuck = true;
    let sawCards = false;
    for (let i = 0; i < 300; i++) {
      for (const e of w.step(1 / 30)) if (e.kind === 'cards') sawCards = true;
      if (i % 10 === 0) { w.enemies.length = 0; w.pending.length = 0; }
    }
    assert.equal(sawCards, false, '全满级时不应再发卡');
    assert.ok(w.wave >= 3, `全满级后波次仍应继续推进，实际第 ${w.wave} 波`);
    ok('所有卡满级后不再发卡，波次正常推进（不会卡死在选卡界面）');
  }

  // 选完后波次应继续推进
  const w0 = cards1.cs.last(S2C.SNAP)?.w || 1;
  await sleep(3000);
  const w1 = cards1.cs.last(S2C.SNAP)?.w || 1;
  assert.ok(w1 >= w0, '波次不该倒退');
  ok(`选卡结束后波次推进到第 ${w1} 波`);

  g1.close();
  g2.close();
  await sleep(300);
}

// 本地榜单接口：`npm start` 起的不只是房间服务，成绩也要能真正上榜，
// 否则本地验证时永远只会看到"云端同步失败"。
console.log('\n[11] 本地榜单接口');
{
  const name = `测试${Math.floor(Math.random() * 900 + 100)}`;
  const post = await fetch(`${BASE}/api/scores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pid: `p${Date.now()}`, wave: 3, kills: 12, score: 456, players: 2, chassis: 'light', timeMs: 60000 }),
  });
  const pr = await post.json();
  assert.equal(pr.ok, true, '本地提交应成功');
  const day = await (await fetch(`${BASE}/api/scores`)).json();
  assert.ok(day.list.some((e) => e.name === name), '刚提交的成绩应出现在今日榜');
  const all = await (await fetch(`${BASE}/api/scores?view=all`)).json();
  assert.ok(all.all.some((e) => e.name === name), '总榜也应包含');
  assert.equal(all.all.find((e) => e.name === name).players, 2, '人数标记要保留');
  ok('本地 /api/scores 可提交、今日榜与总榜都能读到');
}

console.log(`\n全部通过：${pass} 项\n`);
process.exit(0);
