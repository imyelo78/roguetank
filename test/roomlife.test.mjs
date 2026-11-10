// 房间生命周期回归测试
//
// 线上真实事故（用户实测复现）：建房 → 复制码 → 发微信 → 朋友一分钟后来，
// 报"房间不存在"，而房主连接还在、界面还显示着房间码。
// 根因不是 TTL，而是：房主挂机等人时被敌人打死 → world 判全员阵亡 →
// room 停循环并在 8 秒后销毁整个房间。
//
// 这个测试钉死两条不变量：
//   1. 只要还有在线连接，世界 over 之后房间必须继续存在（并重开一局）
//   2. 全员断线超过宽限期才允许回收，且回收时必须通知还挂着的人

import assert from 'node:assert/strict';
import { Room } from '../server/room.js';

let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

const onlineSocket = () => ({ readyState: 1, send() {} });

function makeRoom() {
  const sent = [];
  const room = new Room({ code: 'LIFE' });
  room._send = (m, data) => sent.push({ id: m.id, data });
  room._broadcastRoster = () => {};
  room._maybeSnapshotAt = () => {};
  return { room, sent };
}

// [1] 有在线连接时，over 不解散房间
{
  const { room, sent } = makeRoom();
  room.join(onlineSocket(), { name: '房主', chassis: 'heavy' });
  room.world.start();
  // 模拟全员阵亡
  for (const p of room.world.players) { p.alive = false; p.down = true; }
  room._oneTick(0);

  assert.notEqual(room.world.state, 'over', '房间还有人时不该停在 over');
  assert.equal(room.timer, null, 'timer 为空说明房间已被销毁——这正是线上事故');
  assert.ok(room.world.players.every((p) => p.alive), '重开后玩家应该复活');
  assert.equal(room.world.players[0].hp, room.world.players[0].maxHp, '复活应满血');
  ok('全员阵亡但有人在房间 → 自动重开，房间不销毁');

  const endMsgs = sent.filter((s) => JSON.parse(s.data).expired);
  assert.equal(endMsgs.length, 0, '不该给房间发"已过期"');
  ok('重开时不会误发 room-expired');
}

// [2] 无人可战 + 无人在线 → 才走结算销毁
{
  const { room, sent } = makeRoom();
  const sock = onlineSocket();
  room.join(sock, { name: '房主', chassis: 'heavy' });
  room.world.start();
  // 直接让世界进入 over：这是 World 层的判定，本测试关心的是"房间层怎么响应"
  room.world.state = 'over';
  for (const p of room.world.players) { p.alive = false; }
  sock.readyState = 3;              // 断开了
  room._oneTick(0);

  const ends = sent.filter((s) => { const m = JSON.parse(s.data); return m.k === 'end'; });
  assert.ok(ends.length > 0, `全员离线时应发出结算/结束消息，世界状态 ${room.world?.state}`);
  ok('全员离线后仍走正常结算，不会静默断流');
}

// [3] 空闲回收只在全员离线时触发，且有宽限期
{
  const { room } = makeRoom();
  const sock = onlineSocket();
  room.join(sock, { name: '房主', chassis: 'heavy' });

  assert.equal(room._idleExpired(), false, '有在线连接时永不过期');
  ok('房间里有活人时，不论多久没人加入都不会过期');

  sock.readyState = 3;              // 断线
  assert.equal(room._idleExpired(), false, '刚断线不算过期（要留重连时间）');
  ok('刚断线时不立刻回收，给刷新重连留缓冲');

  room._emptySince = Date.now() - 10 * 60 * 1000;   // 假装空了 10 分钟
  assert.equal(room._idleExpired(), true, '超过宽限期应回收');
  ok('全员离线超过宽限期才回收');
}

// [4] 房主离开时房主身份移交
{
  const { room } = makeRoom();
  const a = onlineSocket();
  const b = onlineSocket();
  const ra = room.join(a, { name: '甲', chassis: 'heavy' });
  room.join(b, { name: '乙', chassis: 'light' });
  assert.equal(room.hostId, ra.id);
  room.leave(ra.id);
  assert.ok(room.hostId && room.hostId !== ra.id, '房主走了应该有人接任');
  ok('房主离开后自动移交，剩下的人还能点「开始战斗」');
}

// [5] 全员阵亡回大厅后，必须真的能开出下一局
//
// 线上事故（用户报"主炮不能发射 / 车辆卡住不动"）：房间把 world 打回 'lobby'
// 后把 autoStartT 置 0（原意"等人手动点开始"），可大厅面板只在进场前可见，
// 局内玩家根本找不到那个按钮。于是世界永久停在 lobby：
// 快照照发、车照渲染，但输入被服务端整包丢弃 —— 车不动、炮不响。
{
  const { room } = makeRoom();
  const sock = onlineSocket();
  room.join(sock, { name: '房主', chassis: 'panther' });
  room.world.start();
  for (const p of room.world.players) { p.alive = false; p.down = true; }
  room._oneTick(0);

  assert.equal(room.world.state, 'lobby', '全员阵亡应先回大厅');
  assert.ok(room.autoStartT > 0, '回大厅后必须重新起倒计时，否则永远开不了下一局');
  ok('全员阵亡回大厅时重新起倒计时，不会无限期停在 lobby');

  // 把倒计时跑完（30Hz，3 秒 = 90 步，多给一点余量）
  for (let i = 0; i < 140 && room.world.state !== 'playing'; i++) room._oneTick(0);
  assert.equal(room.world.state, 'playing', `倒计时走完应自动重开，实际 ${room.world.state}`);
  assert.ok(room.world.enemiesLeft >= 0, '新一局波次应正常');
  ok('倒计时走完自动进入下一局，车能开、炮能打');
}

// [6] 开局请求失败不丢：房主点「开始战斗」必须最终生效
//
// World.start() 只在两种情况下返回 false：已经在 playing，或者一个人都没有。
// 以前 requestStart 不看返回值，一旦碰上这两种情况就静默失败，
// 房主连点几下「开始战斗」都没反应，也拿不到任何解释。
{
  const { room } = makeRoom();
  const sock = onlineSocket();
  room.join(sock, { name: '房主', chassis: 'panther' });

  // 世界停在 playing（比如上一局还没收尾）：start() 会拒绝
  room.world.state = 'playing';
  room.requestStart(room.hostId);
  assert.equal(room._startPending, true, '开不起来要挂起，而不是石沉大海');
  ok('开局失败会挂起重试，不是静默失败');

  // 世界回到可开局的状态
  room.world.state = 'lobby';
  for (let i = 0; i < 5 && room.world.state !== 'playing'; i++) room._oneTick(0);
  assert.equal(room.world.state, 'playing', '条件恢复后应自动开局');
  assert.equal(room._startPending, false, '开局成功后要清掉挂起标记');
  ok('条件恢复后挂起的开局自动生效');
}

console.log(`\n房间生命周期测试全部通过（${pass} 项）`);
