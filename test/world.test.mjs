// 无头回归：多人模拟的完整一局
// 运行：node test/world.test.mjs
//
// 这里跑一个"会瞄准最近敌人"的机器人，用来验证：
//   - 世界能连续跑几分钟不崩
//   - 不同人数下的存活曲线大致合理（不会一进场就团灭，也不会打不动）
//   - 倒地 / 救援 / 复活能正常触发
//   - 快照编解码可逆

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, CHASSIS_TABLE, ENEMY_TYPES } from '../src/core/world.js';
import { encodeSnapshot, decodeSnapshot, quantPos, dequantPos } from '../src/core/protocol.js';

let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

/** 简单机器人：炮塔锁最近敌人，车体走位保持距离（与人类玩家一样的八方向输入） */
function botInput(w, me) {
  let target = null;
  let best = Infinity;
  for (const e of w.enemies) {
    if (!e.alive) continue;
    const d = Math.hypot(e.x - me.x, e.z - me.z);
    if (d < best) { best = d; target = e; }
  }
  if (!target) return { mx: 0, mz: 0, aimX: me.x, aimZ: me.z - 10, fire: false };

  const d = best || 1;
  const dx = (target.x - me.x) / d;
  const dz = (target.z - me.z) / d;
  // 太远就压上、太近就后撤、中距离绕圈；侧向分量保证不是一条直线对射
  const radial = best > 26 ? 1 : best < 12 ? -1 : 0;
  const side = best >= 12 && best <= 26 ? 1 : 0.35;
  return {
    mx: dx * radial - dz * side,
    mz: dz * radial + dx * side,
    aimX: target.x,
    aimZ: target.z,
    fire: true,
  };
}

function runGame(n, seconds, seed = 11) {
  const w = new World({ code: 'T', seed });
  // 车体已合并成一款豹式；这里仍轮换历史 id，顺便验证服务端会把它们归一化。
  const chassis = ['panther', 'balanced', 'light', 'heavy', 'hunter'];
  for (let i = 0; i < n; i++) w.addPlayer({ id: `p${i}`, name: `P${i}`, chassisId: chassis[i % chassis.length] });
  w.start();

  const log = { downs: 0, revives: 0, kills: 0, maxWave: 0, cleared: 0 };

  // 脱困记忆：机器人原本只会直线冲，撞上墙角会一直顶着墙（真人会绕）。
  // 每 1 秒检查一次位移，几乎没动就换一个固定方向侧移一会儿。
  const mem = new Map();
  const stuckInput = (p, dir) => ({
    mx: Math.cos(dir * 1.2), mz: Math.sin(dir * 1.2),
    aimX: p.x, aimZ: p.z - 10, fire: false,
  });

  for (let t = 0; t < seconds * 30; t++) {
    for (const p of w.players) {
      if (!p.alive || p.down) { w.setInput(p.id, { mx: 0, mz: 0, aimX: p.x, aimZ: p.z, fire: false }); continue; }

      let m = mem.get(p.id);
      if (!m) { m = { x: p.x, z: p.z, escape: 0, dir: 1 }; mem.set(p.id, m); }

      if (t % 30 === 0) {
        if (Math.hypot(p.x - m.x, p.z - m.z) < 1.2 && m.escape === 0) {
          m.escape = 20;          // 约 0.66 秒
          m.dir = -m.dir;
        }
        m.x = p.x; m.z = p.z;
      }

      if (m.escape > 0) { m.escape -= 1; w.setInput(p.id, stuckInput(p, m.dir)); continue; }
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
  ok('车体表里每款车都有完整数值');
}

console.log('\n[8] 车体数值只有一份来源');
{
  // 历史上 chassis.js 和 world.js 各有一份 CHASSIS_TABLE。
  // 只改一处的话，联机时客户端按新车速预测、服务端按旧车速算权威位置，
  // 每帧的位移差都会进残差、被硬校正拉回，手感变成"拖拽"。
  // 现在 world.js 直接 import chassis.js，这条断言防的是"以后有人又抄一份"。
  const src = readFileSync(new URL('../src/core/world.js', import.meta.url), 'utf8');
  assert.ok(
    /import\s*\{[^}]*CHASSIS_TABLE[^}]*\}\s*from\s*'\.\.\/chassis\.js'/.test(src),
    'world.js 必须从 ../chassis.js import CHASSIS_TABLE',
  );
  assert.ok(!/^const CHASSIS_TABLE\s*=/m.test(src), 'world.js 里不许再自己定义 CHASSIS_TABLE');

  // 派生出来的表和 UI 那份必须逐字段相等（不是"看着差不多"）
  const { CHASSIS_TABLE: ui } = await import('../src/chassis.js');
  for (const [id, a] of Object.entries(ui)) {
    const b = CHASSIS_TABLE[id];
    assert.ok(b, `服务端缺少车体 ${id}`);
    for (const k of ['hp', 'speed', 'turn', 'takenMul', 'killHeal']) {
      assert.equal(b[k], a[k], `${id}.${k}：UI=${a[k]} 服务端=${b[k]}`);
    }
  }
  ok('world.js 从 chassis.js 派生，各车体 × 5 个字段逐项相等');

  // 服务端真正建出来的玩家也要用上新数值
  const w = new World({ code: 'T', seed: 1 });
  for (const [id, a] of Object.entries(ui)) {
    const p = w.addPlayer({ name: id, chassisId: id });
    assert.equal(p.speedBase, a.speed, `${id} 速度没进模拟`);
    assert.equal(p.maxHp, a.hp, `${id} 血量没进模拟`);
    assert.equal(p.takenMul, a.takenMul, `${id} 减伤没进模拟`);
  }
  ok('新建玩家读到的是同一份数值');
}


// ------------------------------------------------------------------
// Boss 速度语义：tpl.speed 对小兵是倍率（gunner=1），对 Boss 是绝对速度。
// 曾把两者乘在一起：第 5 波破城者 = 基础 10 × 7.2 = 72 m/s，
// 玩家 15 m/s 被近 5 倍时速碾压——"多人模式的破城者跑起来像飞一样"。
{
  const w = new World({ code: 'T', seed: 1 });
  w.addPlayer({ name: '甲' });
  w.state = 'playing';
  w.startWave(5);                       // 5 的倍数 = boss 波
  for (let i = 0; i < 600; i++) w.step(1 / 30);   // 等 pending 全部落地
  const boss = w.enemies.find((e) => e.boss);
  const gunner = w.enemies.find((e) => !e.boss);
  assert.ok(boss, '第 5 波必须刷出 Boss');
  assert.equal(boss.speed, ENEMY_TYPES.boss_breaker.speed,
    `Boss 速度必须是表内绝对值 ${ENEMY_TYPES.boss_breaker.speed}，实际 ${boss.speed}`);
  assert.ok(gunner && gunner.speed > 5 && gunner.speed < 20,
    `小兵速度应为基础速度 × 倍率，实际 ${gunner?.speed}`);
  ok('Boss 用绝对速度、小兵用倍率，两者不再混乘');
}

// ------------------------------------------------------------------
// 联机敌军数量 ×0.6（r30 已拍板：只减敌军，不动玩家、不动血量缩放）。
// 背景：4 人房 12 波 122 只 / 5.3 万血，"人多反而更轻松"——数量缩放
// n^0.85 在 4 人时 ×3.2，火力却线性 ×4。系数 0.6 后 4 人净数量 ≈ ×1.92。
{
  const spawnCount = (wave, players) => {
    const w = new World({ code: 'T', seed: 1 });
    for (let i = 0; i < players; i++) w.addPlayer({ name: `p${i}` });
    w.state = 'playing';
    w.startWave(wave);
    const byType = {};
    for (const it of w.pending) byType[it.type] = (byType[it.type] || 0) + 1;
    return byType;
  };
  const t1 = spawnCount(12, 1);
  const t4 = spawnCount(12, 4);
  // W12 base=32：单人联机 ≈ 32×0.6=19；4 人 ≈ 32×3.249×0.6=62（无 0.6 时会是 97）
  assert.equal(t1.gunner, 19, `W12 单人联机 gunner 应 =round(32×0.6)=19，实际 ${t1.gunner}`);
  assert.equal(t4.gunner, 62, `W12 四人 gunner 应 =round(32×3.249×0.6)=62，实际 ${t4.gunner}`);
  assert.ok(t4.gunner < 97 * 0.7, '4 人数量必须显著低于未加 0.6 的旧值 97');
  // 特色兵种保底不缩成 0
  assert.ok(t4.charger >= 1 && t4.drone >= 1 && t4.shield >= 1,
    `冲锋/无人机/重盾保底 ≥1：${JSON.stringify(t4)}`);
  // 血量缩放不受影响：4 人小兵血 = 单人 ×2（√4）
  assert.equal(t1.gunner > 0 && t4.gunner > 0, true);
  ok(`联机数量 ×0.6 落地：W12 gunner 单人 ${t1.gunner} → 4 人 ${t4.gunner}（血量仍 ×√n）`);
}

console.log(`\n全部通过：${pass} 项\n`);
