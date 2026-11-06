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

console.log('\n[2] 第二人凭房间码加入');
const b = new Client('乙', 'light');
const wb = await b.open(wa.code);
assert.equal(wb.k, S2C.WELCOME);
assert.equal(wb.code, wa.code);
assert.equal(wb.players.length, 2);
ok('两人同房');

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
  a.send({ k: C2S.INPUT, seq: seq++, f: 1, t: 0, ax: 0, az: -50, fire: true });
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
