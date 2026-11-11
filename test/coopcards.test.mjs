// 组队选卡面板的关闭路径回归测试。
//
// 线上症状：打完第一波之后进不去下一波，"点什么都没反应"。
// 根因是两条独立的路都断了：
//
//   1) 面板是单机/联机共用的，但点击回调只有 `onPick: id => this.pickUpgrade(id)`。
//      单机的 `pickUpgrade` 第一行是 `if (this.state !== 'reward') return`，
//      组队局的 state 是 'coop' —— 鼠标点卡片直接空转。键盘 1/2/3 走的是
//      coop 自己绑的监听，所以"键盘能用、鼠标不能用"。
//
//   2) 服务端 12 秒超时替玩家选完、推进下一波，却**没有任何消息告诉客户端**。
//      客户端 `net.cards` 一直留着，面板就停在「0 秒后自动选择」再也不动，
//      把整个画面盖住。玩家以为死机了，其实服务端早就在打第二波。
//
// 这里把三条关闭路径（自己选 / 服务端关窗 / 本地兜底）和点击分流一起钉住。

import assert from 'node:assert/strict';
import { World } from '../src/core/world.js';
import { Room } from '../server/room.js';
import { CoopMode } from '../src/coop.js';
import { Game } from '../src/Game.js';

let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

const DT = 1 / 30;
const CARD_GRACE = 1500;

function mkWorld() {
  const w = new World({ code: 'CARD', seed: 20261109, maxPlayers: 4 });
  w.addPlayer({ id: 'p1', name: '甲', chassisId: 'balanced' });
  w.start();
  return w;
}

/** 模拟"把这一波打光"：清空场上与待刷的敌人，再推一帧 */
function clearWave(w) {
  w.enemies.length = 0;
  w.pending.length = 0;
  return w.step(DT);
}

// [1] 清波必须发 cards，并且带着这一波每人能选的三张
{
  const w = mkWorld();
  const ev = clearWave(w);
  const cards = ev.find((e) => e.kind === 'cards');
  assert.ok(cards, `清波后没有 cards 事件，收到的是 ${JSON.stringify(ev.map((e) => e.kind))}`);
  assert.equal(cards.dealt.length, 1, '一个活着的玩家应该拿到一份选项');
  assert.equal(cards.dealt[0].id, 'p1');
  assert.ok(cards.dealt[0].options.length >= 3, `选项应有 3 张，实际 ${cards.dealt[0].options.length}`);
  assert.equal(w.picksOpen, true);
  ok('清波后服务端发 CARDS，每人一份三张');
}

// [2] 没人选 → 12 秒后服务端必须发 picksClosed 并推进波次
{
  const w = mkWorld();
  clearWave(w);
  const kinds = [];
  let wave2At = -1;
  for (let i = 0; i < 400; i++) {
    const ev = w.step(DT);
    for (const e of ev) kinds.push(e.kind);
    if (wave2At < 0 && w.wave === 2) wave2At = i;
  }
  assert.ok(kinds.includes('picksClosed'), `超时关窗必须发 picksClosed，实际事件：${[...new Set(kinds)].join(',')}`);
  assert.equal(w.picksOpen, false, '12 秒后选卡窗口必须关闭');
  assert.ok(wave2At > 0, '关窗后必须能进入第二波');
  assert.ok(w.enemies.length + w.pending.length > 0, '第二波必须有敌人，不能空转');
  ok('无人选卡：12 秒后发 picksClosed、关窗并开出第二波');
}

// [3] 所有人都选完 → 立刻关窗，同样要发 picksClosed
{
  const w = mkWorld();
  const ev = clearWave(w);
  const dealt = ev.find((e) => e.kind === 'cards');
  const opt = dealt.dealt[0].options[0];
  assert.ok(w.pickCard('p1', opt.id).ok, '第一张卡应该能选');
  const ev2 = w.step(DT);
  assert.ok(ev2.some((e) => e.kind === 'picksClosed'), '全员选完也要发 picksClosed');
  assert.equal(w.picksOpen, false);
  ok('全员选完：立即关窗并通知客户端');
}

// [4] 房间把 picksClosed 广播给**所有**成员（不是只发给选卡的人）
{
  class FakeSock {
    constructor() { this.readyState = 1; this.out = []; }
    send(s) { this.out.push(JSON.parse(s)); }
  }
  const room = new Room({ code: 'T2' });
  const a = new FakeSock();
  const b = new FakeSock();
  room.join(a, { name: '甲', chassis: 'balanced' });
  room.join(b, { name: '乙', chassis: 'balanced' });
  room.requestStart(room.hostId);

  // 先跑一会儿让第一波怪刷出来，再一次性清掉
  let t = performance.now();
  for (let i = 0; i < 30; i++) { t += 33; room._oneTick(t); }
  room.world.enemies.length = 0;
  room.world.pending.length = 0;
  a.out.length = 0;
  b.out.length = 0;

  for (let i = 0; i < 400; i++) { t += 33; room._oneTick(t); }
  const kindsOf = (sock) => sock.out.flatMap((m) => (m.e || []).map((e) => e.kind));
  assert.ok(kindsOf(a).includes('picksClosed'), '房主没收到 picksClosed');
  assert.ok(kindsOf(b).includes('picksClosed'), '队友没收到 picksClosed');
  assert.equal(room.world.wave, 2, '关窗后应进入第二波');
  ok('picksClosed 广播到房间内每个人');
}

// [5] 点击卡片：组队走 coop.pickCard，单机才走 pickUpgrade
{
  const g = Object.create(Game.prototype);
  let viaCoop = null;
  let viaSolo = null;
  g.coop = { pickCard: (id) => { viaCoop = id; return true; } };
  g.pickUpgrade = (id) => { viaSolo = id; };

  g.mode = 'coop';
  g._pickCard('dmg');
  assert.equal(viaCoop, 'dmg', '组队时点击必须交给 coop.pickCard');
  assert.equal(viaSolo, null, '组队时绝不能走单机 pickUpgrade（它会被 state 检查挡掉）');

  g.mode = 'solo';
  g._pickCard('hp');
  assert.equal(viaSolo, 'hp', '单机时仍走原来的 pickUpgrade');
  ok('卡片点击按模式分流：组队→coop，单机→pickUpgrade');
}

// [6] _closeCards 一次清干净：net.cards / 面板 / 键盘监听
{
  const c = Object.create(CoopMode.prototype);
  let hidden = 0;
  c.net = { cards: { wave: 2, options: [{ id: 'a' }] } };
  c._cardsShown = true;
  c._onPickKey = () => {};
  c.game = { hud: { hideRewards: () => { hidden += 1; } } };

  c._closeCards();
  assert.equal(c.net.cards, null, 'net.cards 必须清空，否则下一帧又会重新弹面板');
  assert.equal(c._cardsShown, false);
  assert.equal(c._onPickKey, null, '键盘监听必须摘掉，不然会一直挂在 window 上');
  assert.equal(hidden, 1, '面板必须真的收起来');
  ok('_closeCards 清空 cards / 标记 / 键盘监听并收起面板');
}

// [7] 服务端关窗消息到达 → 面板立刻关
{
  const c = Object.create(CoopMode.prototype);
  let hidden = 0;
  c.active = true;
  c.net = { cards: { wave: 2, options: [{ id: 'a' }] } };
  c._cardsShown = true;
  c.game = { hud: { hideRewards: () => { hidden += 1; } } };

  c.onEvents([{ kind: 'picksClosed', wave: 2 }]);
  assert.equal(c.net.cards, null);
  assert.equal(hidden, 1);
  ok('收到 picksClosed 立刻关面板（不用等本地兜底）');
}

// [8] 消息丢了也要能自己收场：超过服务端窗口 + 宽限就本地关
{
  const c = Object.create(CoopMode.prototype);
  let hidden = 0;
  c.net = { cards: { wave: 2, options: [{ id: 'a' }] } };
  c._cardsShown = true;
  c._cardDeadline = performance.now() - CARD_GRACE - 1000;   // 已过窗口 + 宽限
  c._cardsLeft = -1;
  c.game = { hud: { hideRewards: () => { hidden += 1; }, setRewardSub: () => {} } };

  c._syncCards();
  assert.equal(c.net.cards, null, '超时兜底必须清掉 cards');
  assert.equal(hidden, 1);
  ok('picksClosed 丢失时，超过窗口 + 宽限本地自动关面板');
}

// [9] 但窗口还没到就绝不能提前关（玩家正在看卡）
{
  const c = Object.create(CoopMode.prototype);
  let hidden = 0;
  c.net = { cards: { wave: 2, options: [{ id: 'a' }] } };
  c._cardsShown = true;
  c._cardDeadline = performance.now() + 8000;
  c._cardsLeft = -1;
  c.game = { hud: { hideRewards: () => { hidden += 1; }, setRewardSub: () => {} } };

  c._syncCards();
  assert.equal(hidden, 0, '窗口期内不许关面板');
  assert.ok(c.net.cards, '窗口期内 cards 必须保留');
  ok('窗口期内不提前关面板');
}

// [10] 发卡时必须附带服务端权威的成长数值（快照不带成长）
{
  const w = mkWorld();
  const ev = clearWave(w);
  const cards = ev.find((e) => e.kind === 'cards');
  const st = cards.dealt[0].stats;
  assert.ok(st, 'CARDS 必须带 stats，否则客户端永远显示第一波的白板数值');
  assert.ok(st.counts && typeof st.counts === 'object', 'stats 必须含 counts（卡片等级靠它）');
  assert.ok(Number.isFinite(st.speed), 'stats.speed 必须存在（本地预测用它）');
  assert.ok(Number.isFinite(st.maxHp), 'stats.maxHp 必须存在');
  // max 是卡片底部「Lv.1 → Lv.2 / 5」的分母。rollForPlayer 早期只挑 5 个字段、
  // 把 max 漏了，组队面板一直显示「/ undefined」（单机走另一条路径所以没事）。
  assert.ok(
    cards.dealt[0].options.every((o) => Number.isFinite(o.max)),
    `每张卡都必须带 max，实际 ${JSON.stringify(cards.dealt[0].options.map((o) => o.max))}`,
  );
  ok('发卡附带权威成长数值（含 counts / speed / maxHp）');
}

// [11] 客户端收到 CARDS.stats 后对齐本地成长，且不覆盖战绩计数
{
  const c = Object.create(CoopMode.prototype);
  c.me = {
    x: 0, z: 0, yaw: 0, speed: 0, alive: true, down: false, hp: 120, maxHp: 120,
    stats: { kills: 5, score: 99, counts: {} },
  };
  c.net = {
    cards: {
      wave: 3,
      options: [{ id: 'a' }],
      until: performance.now() + 12000,
      stats: { speed: 18.5, maxHp: 160, counts: { spd: 2 } },
    },
  };
  c._cardsShown = false;
  c.firing = true;
  c.keys = new Set(['KeyW']);
  let shownCounts = null;
  c.game = { hud: { showRewards: (wv, opts, counts) => { shownCounts = counts; } } };

  c._syncCards();
  assert.equal(c.me.speedBase, 18.5, '本地预测速度必须跟上服务端');
  assert.equal(c.me.maxHp, 160, '最大装甲必须跟上');
  assert.deepEqual(c.me.stats.counts, { spd: 2 }, '卡牌等级必须用权威 counts');
  assert.equal(c.me.stats.kills, 5, '战绩计数不能被成长同步覆盖');
  assert.equal(shownCounts.spd, 2, '卡片上的 Lv 必须来自权威 counts，不能是 NEW');
  assert.equal(c.firing, false, '开面板要松开扳机，避免端着炮看卡');
  ok('收到 CARDS.stats 后对齐速度/装甲/等级，战绩计数不受影响');
}

console.log(`\n组队选卡测试全部通过（${pass} 项）`);
