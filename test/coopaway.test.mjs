/**
 * 组队暂停 = 暂离战场（r48）回归测试
 *
 * 需求：多人版按 Esc 不能直接退出房间（太危险），要跟单人一样"先暂停、后退出"，
 * 暂停期间临时退出房间。
 *
 * 联机世界的时钟在服务端，本地停不了它 —— 所以"暂停"的落地方式是：
 *   1. 服务端把这个玩家从 world.players 摘下来 → 打不到他，也不挡队友的路
 *   2. 席位 / 房间码 / 成长数值都留在 Member 上 → 点「返回战场」原样回去
 *   3. 房间里只剩自己时，整个模拟一起冻结 → 手感和单人暂停一致
 *
 * 这几条一旦被改坏，症状都很"灵异"：暂停一次成长清零、回来站在出生点、
 * 一个人打房间暂停十分钟回来已经第 9 波、或者队友屏幕上永远停着一辆不动的车。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Room } from '../server/room.js';
import { C2S, PROTOCOL_VERSION } from '../src/core/protocol.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

const onlineSocket = () => ({ readyState: 1, send() {} });

function makeRoom() {
  const sent = [];
  const room = new Room({ code: 'AWAY' });
  room._send = (m, data) => sent.push({ id: m.id, data });
  room._broadcastRoster = () => {};
  room._maybeSnapshotAt = () => {};
  return { room, sent };
}

/** 造一个"已经打了一会儿"的玩家：位置、血量、成长都不是初始值 */
function dirtyThePlayer(room, id) {
  const p = room.world.players.find((q) => q.id === id);
  p.x = 12.5;
  p.z = -8.25;
  p.yaw = 1.25;
  p.hp = 37;
  p.maxHp = 160;
  p.stats.damageMul = 2.44;
  p.stats.counts = { damage: 3, speed: 1 };
  return p;
}

// ------------------------------------------------------------ [1] 暂离把人撤出战场
{
  const { room } = makeRoom();
  const sock = onlineSocket();
  const r = room.join(sock, { name: '甲', chassis: 'panther' });
  room.world.start();
  dirtyThePlayer(room, r.id);

  assert.equal(room.setAway(r.id, true), true, 'setAway 应返回 true');
  assert.equal(room.members.size, 1, '席位必须留着（不是 leave）');
  assert.equal(room.members.get(r.id).away, true, 'Member 要标记 away');
  assert.equal(room.world.players.length, 0, '暂离的人不该还在 world.players 里');
  ok('暂离：席位还在、人已撤出战场');

  const snap = room.members.get(r.id).awaySnap;
  assert.equal(snap.stats.damageMul, 2.44, '成长数值要留一份');
  assert.deepEqual(snap.stats.counts, { damage: 3, speed: 1 }, '选卡计数要深拷，不能和原对象共享');
  ok('暂离时把成长 / 血量 / 位置存成快照');
}

// ------------------------------------------------------------ [2] 回来时原样放回
{
  const { room } = makeRoom();
  const sock = onlineSocket();
  const r = room.join(sock, { name: '甲', chassis: 'panther' });
  room.world.start();
  dirtyThePlayer(room, r.id);

  room.setAway(r.id, true);
  // 让世界跑几秒：多人局里其他人还在打，时间在往前走
  for (let i = 0; i < 30; i++) room._oneTick(0);

  assert.equal(room.setAway(r.id, false), true, '归队应返回 true');
  const p = room.world.players.find((q) => q.id === r.id);
  assert.ok(p, '归队后必须回到 world.players');
  assert.equal(p.id, r.id, 'id 不能变（变了客户端会当成另一个人）');
  assert.equal(p.x, 12.5, '位置要回到暂停那一刻');
  assert.equal(p.z, -8.25, '位置要回到暂停那一刻');
  assert.equal(p.hp, 37, '血量不能回满（那等于免费治疗）');
  assert.equal(p.maxHp, 160, '成长带来的上限要保留');
  assert.equal(p.stats.damageMul, 2.44, '成长数值必须原样回来');
  assert.deepEqual(p.stats.counts, { damage: 3, speed: 1 }, '选卡计数必须原样回来');
  ok('归队：位置 / 血量 / 成长与暂停那一刻完全一致');
}

// ------------------------------------------------------------ [3] 全员暂离 → 世界冻结
{
  const { room } = makeRoom();
  const r = room.join(onlineSocket(), { name: '甲', chassis: 'panther' });
  room.world.start();
  const before = room.world.tick;

  room.setAway(r.id, true);
  for (let i = 0; i < 45; i++) room._oneTick(0);
  assert.equal(room.world.tick, before, '没人可推时不该继续推进世界');

  room.setAway(r.id, false);
  room._oneTick(0);
  assert.equal(room.world.tick, before + 1, '回到战场后世界应继续');
  ok('单人房暂停：世界冻结，回来从原处继续（不会被推到第 9 波）');
}

// ------------------------------------------------------------ [4] 还有队友在打 → 世界照跑
{
  const { room } = makeRoom();
  const a = room.join(onlineSocket(), { name: '甲', chassis: 'panther' });
  room.join(onlineSocket(), { name: '乙', chassis: 'panther' });
  room.world.start();
  const before = room.world.tick;

  room.setAway(a.id, true);
  for (let i = 0; i < 10; i++) room._oneTick(0);
  assert.ok(room.world.tick >= before + 10, '有人在打，世界必须继续推进');
  ok('多人房里有人暂离：世界照跑，暂离的人不在战场上挨打');
}

// ------------------------------------------------------------ [5] 暂停期间换了一局 → 旧成长作废
{
  const { room } = makeRoom();
  const r = room.join(onlineSocket(), { name: '甲', chassis: 'panther' });
  room.world.start();
  dirtyThePlayer(room, r.id);
  room.setAway(r.id, true);

  // 模拟"暂停期间世界被打爆又重开"：局号 +1（见 Room.round）
  room.round += 1;
  room.setAway(r.id, false);

  const p = room.world.players.find((q) => q.id === r.id);
  assert.ok(p, '归队后仍然要回到战场上');
  assert.notEqual(p.stats.counts.damage, 3, '上一局的成长不能带进新一局');
  assert.equal(p.hp, p.maxHp, '新一局应从满血开始');
  ok('暂停期间换局：旧成长作废，按新兵入场（否则一个人满级就是作弊）');
}

// ------------------------------------------------------------ [6] 协议与会话分发
{
  assert.equal(PROTOCOL_VERSION, 5, '暂离是新消息，协议版本必须升到 5');
  assert.equal(C2S.AWAY, 'away', 'C2S 里要有 away 消息');
  const session = read('server/session.js');
  assert.match(session, /case C2S\.AWAY:/, 'session 要处理 away');
  assert.match(session, /setAway\(ctx\.id/, 'away 要落到 Room.setAway');
  ok('协议 v5，away 消息有服务端分发');
}

// ------------------------------------------------------------ [7] 客户端：Esc → 暂停 → 暂离
{
  const game = read('src/Game.js');
  const coop = read('src/coop.js');
  const net = read('src/net.js');

  assert.match(net, /away\(on\) \{/, 'NetClient 要有 away()');
  assert.match(net, /k: C2S\.AWAY, on: want/, 'away() 要真的把消息发出去');
  assert.match(coop, /this\.net\?\.away\(true\)/, 'CoopMode.pause 要通知服务端暂离');
  assert.match(coop, /this\.net\?\.away\(false\)/, 'CoopMode.resume 要通知服务端归队');
  // 暂停时只重画不推进：否则本地预测还在跑，画面停在原地、车却已经飘走
  assert.match(coop, /if \(this\.paused\) \{\s*this\.net\?\.ping\(\);\s*this\.renderer\.render/,
    '暂停时只重画最后一帧，并且继续发心跳（否则 Nginx 60 秒掐连接）');
  // Esc 在任何模式下都不能再"直接退房"
  assert.match(game, /\(this\.mode === 'solo' \|\| this\.mode === 'coop'\)/,
    'Esc 要在单机 / 组队两种模式下都走暂停');
  assert.ok(!/else this\.leaveCoop\(\)/.test(game), '不能再有"Esc 直接退组队"');
  ok('客户端：Esc → 暂停 → 暂离，退出只能走面板按钮');
}

// ------------------------------------------------------------ [8] 暂停期间不发输入
{
  const coop = read('src/coop.js');
  assert.match(coop, /if \(this\.paused\) return;/, '暂停期间键鼠输入要直接丢弃');
  assert.match(coop, /!this\.paused && this\.me && this\.me\.alive/, '暂停时触屏摇杆要禁用');
  // 暂停时游戏事件（击杀 / 爆炸）不能再播：画面是冻的，声音却在响，像没暂停
  assert.match(coop, /onEvents\(list\) \{\s*if \(!this\.active\) return;[\s\S]{0,200}if \(this\.paused\) return;/,
    '暂停期间要丢掉战斗事件反馈');
  ok('暂停期间键盘 / 鼠标 / 摇杆 / 事件反馈全部静默');
}

console.log(`\n组队暂离（暂停）测试全部通过（${pass} 项）`);
