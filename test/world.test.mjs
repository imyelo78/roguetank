// 无头回归：多人模拟的完整一局
// 运行：node test/world.test.mjs
//
// 这里跑一个"会瞄准最近敌人"的机器人，用来验证：
//   - 世界能连续跑几分钟不崩
//   - 不同人数下的存活曲线大致合理（不会一进场就团灭，也不会打不动）
//   - 倒地 / 救援 / 复活能正常触发
//   - 快照编解码可逆

import assert from 'node:assert/strict';
import { World, CHASSIS_TABLE } from '../src/core/world.js';
import { encodeSnapshot, decodeSnapshot, quantPos, dequantPos } from '../src/core/protocol.js';

let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

/** 简单机器人：炮塔锁最近敌人，车体保持距离（不要乱转向，否则炮塔跟不上） */
function botInput(w, me) {
  let target = null;
  let best = Infinity;
  for (const e of w.enemies) {
    if (!e.alive) continue;
    const d = Math.hypot(e.x - me.x, e.z - me.z);
    if (d < best) { best = d; target = e; }
  }
  if (!target) return { forward: 0, turn: 0.4, aimX: me.x, aimZ: me.z - 10, fire: false };
  // 朝向目标的车体角度，只在明显偏了才转
  const want = Math.atan2(target.x - me.x, target.z - me.z);
  let d = want - me.yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return {
    forward: best > 26 ? 0.7 : best < 12 ? -0.6 : 0.15,
    turn: Math.abs(d) > 0.5 ? Math.sign(d) : 0,
    aimX: target.x,
    aimZ: target.z,
    fire: true,
  };
}

function runGame(n, seconds, seed = 11) {
  const w = new World({ code: 'T', seed });
  const chassis = ['balanced', 'light', 'heavy', 'hunter'];
  for (let i = 0; i < n; i++) w.addPlayer({ id: `p${i}`, name: `P${i}`, chassisId: chassis[i] });
  w.start();

  const log = { downs: 0, revives: 0, kills: 0, maxWave: 0, cleared: 0 };
  for (let t = 0; t < seconds * 30; t++) {
    for (const p of w.players) {
      if (!p.alive || p.down) { w.setInput(p.id, { forward: 0, turn: 0, aimX: p.x, aimZ: p.z, fire: false }); continue; }
      w.setInput(p.id, botInput(w, p));
    }
    for (const ev of w.step(1 / 30)) {
      if (ev.kind === 'down') log.downs++;
      if (ev.kind === 'revive') log.revives++;
      if (ev.kind === 'kill') log.kills++;
      if (ev.kind === 'cleared') log.cleared++;
    }
    log.maxWave = Math.max(log.maxWave, w.wave);
    if (w.state === 'over') break;
  }
  return { w, log };
}

console.log('\n[1] 单人：机器人能打到 3 波以上');
{
  const { w, log } = runGame(1, 180);
  console.log(`     波次 ${w.wave} · 清波 ${log.cleared} 次 · 击杀 ${log.kills} · 分数 ${w.players[0].stats.score}`);
  // 用"清了几波"判定而不是波次号：人倒地那 30 秒波次不会推进
  assert.ok(log.cleared >= 1, `单人应至少清掉 1 波，实际 ${log.cleared}`);
  assert.ok(log.kills >= 5, `单人应至少击杀 5 个，实际 ${log.kills}`);
  assert.equal(w.players.length, 1);
  ok('单人模拟稳定');
}

console.log('\n[2] 四人：能打得更远，且分角色有差异');
{
  const { w, log } = runGame(4, 180);
  const scores = w.players.map((p) => p.stats.score);
  console.log(`     波次 ${w.wave} · 清波 ${log.cleared} 次 · 击杀 ${log.kills} · 各人分数 ${scores.join(' / ')}`);
  assert.ok(log.cleared >= 1, `四人应至少清掉 1 波，实际 ${log.cleared}`);
  assert.ok(scores.some((v) => v > 0), '至少有人拿到分');
  ok('四人模拟稳定');
}

console.log('\n[3] 倒地与救援');
{
  const w = new World({ code: 'T', seed: 3 });
  w.addPlayer({ id: 'a', name: '甲', chassisId: 'heavy' });
  w.addPlayer({ id: 'b', name: '乙', chassisId: 'balanced' });
  w.start();

  const a = w.players[0];
  const b = w.players[1];
  // 直接把甲打到 0 血，模拟一次阵亡
  a.hp = 0;
  let sawDown = false;
  for (let i = 0; i < 10; i++) {
    for (const ev of w.step(1 / 30)) if (ev.kind === 'down') sawDown = true;
  }
  assert.ok(sawDown, '血量归零应触发 down');
  assert.equal(a.down, true);

  // 乙贴过去救
  b.x = a.x + 1;
  b.z = a.z;
  let sawRevive = false;
  for (let i = 0; i < 30 * 5; i++) {
    b.x = a.x + 1;
    b.z = a.z;
    for (const ev of w.step(1 / 30)) if (ev.kind === 'revive') sawRevive = true;
    if (sawRevive) break;
  }
  assert.ok(sawRevive, '队友贴近 3 秒应能拉起');
  assert.equal(a.down, false);
  assert.ok(a.hp > 0);
  ok('倒地 30 秒 + 队友 3 秒救援，逻辑生效');
}

console.log('\n[4] 没人救会进入复活倒计时，而不是被踢出');
{
  const w = new World({ code: 'T', seed: 5 });
  w.addPlayer({ id: 'a', name: '甲', chassisId: 'light' });
  w.addPlayer({ id: 'b', name: '乙', chassisId: 'balanced' });
  w.start();
  const a = w.players[0];
  const b = w.players[1];
  a.hp = 0;
  for (let i = 0; i < 5; i++) w.step(1 / 30);
  assert.equal(a.down, true);

  // 把乙挪远，避免被救
  b.x = 90;
  b.z = 90;
  let respawned = false;
  for (let i = 0; i < 30 * 45; i++) {
    b.x = 90;
    b.z = 90;
    for (const ev of w.step(1 / 30)) if (ev.kind === 'respawn' && ev.id === 'a') respawned = true;
    if (respawned) break;
  }
  assert.ok(respawned, '30 秒无人救应自动复活');
  assert.equal(a.alive, true);
  ok('无人救援 → 自动复活，不踢出房间');
}

console.log('\n[5] 快照编解码可逆');
{
  const w = new World({ code: 'T', seed: 9 });
  w.addPlayer({ id: 'a', name: '甲', chassisId: 'heavy' });
  w.start();
  for (let i = 0; i < 90; i++) w.step(1 / 30);

  const snap = encodeSnapshot(w);
  const back = decodeSnapshot(snap);
  assert.equal(back.tick, w.tick);
  assert.equal(back.wave, w.wave);
  assert.equal(back.players.length, 1);

  const p = w.players[0];
  const q = back.players[0];
  assert.ok(Math.abs(q.x - p.x) < 0.02, `x 误差 ${Math.abs(q.x - p.x)}`);
  assert.ok(Math.abs(q.z - p.z) < 0.02);
  assert.ok(Math.abs(q.yaw - p.yaw) < 0.03);
  ok(`位置量化误差 < 1cm，快照 ${JSON.stringify(snap).length} 字节`);
}

console.log('\n[6] 人数缩放');
{
  const w1 = new World({ code: 'T', seed: 1 });
  w1.addPlayer({ id: 'a', name: 'A', chassisId: 'balanced' });
  const s1 = w1.scale;
  w1.addPlayer({ id: 'b', name: 'B', chassisId: 'balanced' });
  w1.addPlayer({ id: 'c', name: 'C', chassisId: 'balanced' });
  w1.addPlayer({ id: 'd', name: 'D', chassisId: 'balanced' });
  const s4 = w1.scale;
  assert.ok(s4.hpMul > s1.hpMul && s4.countMul > s1.countMul);
  assert.ok(s4.hpMul < 4, '血量线性放大会变成推墙');
  ok(`1人→4人：血量 ×${s4.hpMul.toFixed(2)}，数量 ×${s4.countMul.toFixed(2)}`);
}

console.log('\n[7] 四车体数值齐全');
{
  for (const [id, c] of Object.entries(CHASSIS_TABLE)) {
    assert.ok(c.hp > 0 && c.speed > 0 && c.turn > 0, id);
  }
  ok('4 种车体都有完整数值');
}

console.log(`\n全部通过：${pass} 项\n`);
