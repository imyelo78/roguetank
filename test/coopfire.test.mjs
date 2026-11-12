// 联机成长卡与 Boss 连发：防回归
//
// 用户实测（r29 前）：
//   multishot 叠到 3 仍只发 1 发；破城者 11 轮齐射每轮 1 发；棱镜无点射；
//   syncedStats 同步的 8 项成长字段没有一项被消费（仅涡轮增压/复合装甲/战地维修有效）。
// 根因：服务端 _playerFire 只认 PLAYER_WEAPON 裸数值，resolveWeapon 在联机
// 从未被调用；Boss 开火是单发 push，单机的三连发/点射没有搬过来。
//
// 运行：node test/coopfire.test.mjs

import assert from 'node:assert/strict';
import { World, ENEMY_TYPES } from '../src/core/world.js';
import { createStats } from '../src/upgrades.js';
import { applyCard } from '../src/core/progression.js';

let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

console.log('\n[联机开火 / 成长卡消费]');

/** 造一个 World + 玩家，玩家可通过 patch 直接改 stats */
function makeWorld(patch) {
  const w = new World({ code: 'T', seed: 1 });
  w.addPlayer({ name: '甲' });
  w.state = 'playing';
  const p = w.players[0];
  p.stats = { ...createStats(p.chassis), ...patch };
  w.bullets.length = 0;
  return { w, p };
}

// ---------------- 1. 玩家开火 ----------------
{
  const { w, p } = makeWorld({});
  p.x = 0; p.z = 0; p.turretYaw = 0;
  w._playerFire(p);
  assert.equal(w.bullets.length, 1, `默认 multishot=1 应 1 发，实际 ${w.bullets.length}`);
  const b = w.bullets[0];
  assert.equal(b.damage, 26, `突击炮裸伤 26，实际 ${b.damage}`);
  assert.ok(p.fireCd > 0.3 && p.fireCd <= 0.4, `fireCd 应为 0.4，实际 ${p.fireCd}`);
  ok('基础开火：1 发 / 26 伤 / 0.4s 冷却');
}

{
  // 多联装 ×3 + 火力 ×1.22^2 + 快速装填 ×1.18 + 弹速 ×1.15
  const { w, p } = makeWorld({
    multishot: 3,
    damageMul: 1.22 * 1.22,
    fireRateMul: 1.18,
    bulletSpeedMul: 1.15,
  });
  w._playerFire(p);
  assert.equal(w.bullets.length, 3, `multishot=3 应 3 发，实际 ${w.bullets.length}`);
  // 三发呈对称散布（yaw 各不同），速度与伤害走解算
  const yaws = new Set(w.bullets.map((b) => b.yaw));
  assert.equal(yaws.size, 3, '三发弹道应互不相同');
  assert.ok(Math.abs(w.bullets[0].damage - 26 * 1.4884) < 0.01,
    `伤害应 = 26×1.22²=${(26 * 1.4884).toFixed(1)}，实际 ${w.bullets[0].damage}`);
  assert.ok(Math.abs(Math.hypot(w.bullets[0].vx, w.bullets[0].vz) - 68 * 1.15) < 0.01,
    '弹速应吃 bulletSpeedMul');
  assert.ok(p.fireCd < 0.4 && Math.abs(p.fireCd - 0.4 / 1.18) < 0.01,
    `fireCd 应 = 0.4/1.18=${(0.4 / 1.18).toFixed(2)}，实际 ${p.fireCd.toFixed(2)}`);
  ok('多联装/火力/装填/弹速 4 张卡全部生效');
}

// ---------------- 2. 穿透与高爆 ----------------
{
  const { w, p } = makeWorld({ pierce: 1, explosive: 2, splashDamageMul: 1.5 });
  p.x = 0; p.z = 0; p.turretYaw = 0;
  // 两个敌人排成一列，正前方 3m 和 6m；旁边再放一个溅射圈内的
  w.enemies.push(
    { id: 'e1', type: 'gunner', x: 0, z: 3, yaw: 0, turretYaw: 0, hp: 100, maxHp: 100, radius: 1.45, alive: true, boss: false },
    { id: 'e2', type: 'gunner', x: 0, z: 8, yaw: 0, turretYaw: 0, hp: 100, maxHp: 100, radius: 1.45, alive: true, boss: false },
    { id: 'e3', type: 'gunner', x: 2, z: 3.5, yaw: 0, turretYaw: 0, hp: 100, maxHp: 100, radius: 1.45, alive: true, boss: false },
  );
  w._playerFire(p);
  const b = w.bullets[0];
  assert.equal(b.pierce, 1, '子弹应带 pierce=1');
  assert.equal(b.explosive, 2, '子弹应带 explosive=2');
  // 推进到第一目标命中
  for (let i = 0; i < 3; i++) w._updateBullets(1 / 30);
  const e1 = w.enemies.find((e) => e.id === 'e1');
  assert.ok(e1.hp < 100, `e1 应被打中，实际 hp=${e1.hp}`);
  // 穿透：子弹还活着，继续飞到 e2
  assert.ok(w.bullets.length === 1, `穿透后子弹应继续飞行，当前 ${w.bullets.length}`);
  for (let i = 0; i < 6; i++) w._updateBullets(1 / 30);
  const e2 = w.enemies.find((e) => e.id === 'e2');
  assert.ok(e2.hp < 100, `穿透应命中 e2，实际 hp=${e2.hp}`);
  const e3 = w.enemies.find((e) => e.id === 'e3');
  assert.ok(e3.hp < 100, `高爆溅射应伤到 e3，实际 hp=${e3.hp}`);
  const splashDmg = 100 - e3.hp;
  assert.ok(splashDmg > 0 && splashDmg < 100, `溅射伤害应有效且低于直击，实际 ${splashDmg}`);
  ok('穿透（穿 2 敌）与高爆溅射（含 splashDamageMul）生效');
}

// ---------------- 3. Boss 连发 ----------------
{
  const { w, p } = makeWorld({});
  // 破城者正前方 12m，炮塔已对准 → 下一帧必开火（三连发）
  const tpl = ENEMY_TYPES.boss_breaker;
  w.enemies.push({
    id: 'bb', type: 'boss_breaker', boss: true, x: p.x, z: p.z - 12, yaw: 0, turretYaw: 0,
    hp: 1000, maxHp: 1000, speed: tpl.speed, radius: tpl.radius, damage: tpl.damage,
    range: tpl.range, fireCd: 0, fireCdRange: tpl.fireCd, bulletSpeed: tpl.bulletSpeed,
    score: tpl.score, alive: true,
  });
  const before = w.bullets.length;
  w.step(1 / 30);
  const fired = w.bullets.length - before;
  assert.equal(fired, 3, `破城者一轮应 3 发，实际 ${fired}`);
  ok('破城者三连发（±0.15 散布）');
}

{
  const { w, p } = makeWorld({});
  const tpl = ENEMY_TYPES.boss_prism;
  w.enemies.push({
    id: 'bp', type: 'boss_prism', boss: true, x: p.x, z: p.z - 14, yaw: 0, turretYaw: 0,
    hp: 1000, maxHp: 1000, speed: tpl.speed, radius: tpl.radius, damage: tpl.damage,
    range: tpl.range, fireCd: 0, fireCdRange: tpl.fireCd, bulletSpeed: tpl.bulletSpeed,
    score: tpl.score, alive: true,
  });
  // 一帧触发开火（第 1 发），后续 0.1s 间隔的 burst 再补 2 发。
  // 用 eshot 事件计数（子弹会飞出判定区被销毁，按存量数不准）
  let shots = 0;
  for (let i = 0; i < 30; i++) {
    for (const ev of w.step(1 / 30)) if (ev.kind === 'eshot') shots++;
    if (shots >= 3) break;
  }
  const e = w.enemies[0];
  assert.ok(e.burst !== undefined, '棱镜应有 burst 状态');
  assert.ok(shots >= 3, `棱镜一轮应打满 3 发（eshot），实际 ${shots}`);
  ok('棱镜三连点射（0.1s × 3）');
}

// ---------------- 4. 清波回血：waveHeal 卡生效 ----------------
{
  const w = new World({ code: 'T', seed: 1 });
  w.addPlayer({ name: '甲' });
  w.state = 'playing';
  const p = w.players[0];
  p.stats = createStats(p.chassis);
  p.stats.waveHeal = 12;
  p.hp = 60;
  p.maxHp = 120;
  // 直接触发清波分支：无敌人 + waveActive
  w.waveActive = true;
  w.enemiesLeft = 0;
  w._updateWaves(1 / 30);
  // 60 + 120×0.25 + 12 = 102
  assert.equal(p.hp, 102, `清波回血应 = 60+30+12=102，实际 ${p.hp}`);
  ok('纳米修复（waveHeal +12）计入清波回血');
}

// ---------------- 5. applyCard 同步 killHeal ----------------
{
  const w = new World({ code: 'T', seed: 1 });
  w.addPlayer({ name: '甲' });
  const p = w.players[0];
  p.stats = createStats(p.chassis);
  // 无 killHeal 卡池项时至少不应被 applyCard 弄丢 chassis 自带的
  const before = p.killHeal;
  p.stats.killHeal = 3;
  applyCard(p, 'repair');
  assert.equal(p.killHeal, 3, `applyCard 后 p.killHeal 应同步为 3，实际 ${p.killHeal}`);
  ok('applyCard 同步 killHeal 到模拟层');
}

console.log(`\n  ${pass} 项全部通过\n`);
