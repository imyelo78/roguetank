// 巡逻 / 驻军 / 人数缩放回归。
//
// 背景：r30 之前，敌人 AI 只有"追玩家"一种行为——
//   单机那个叫 patrol 的状态也是以玩家为中心绕圈（离得远时假装巡逻），
//   联机服务端连这个状态都没有。玩家反馈"想活命就开车使劲跑，边跑边打就能过"。
//
// 这里钉住三件事：
//   1. 巡逻决策是纯函数，单机与联机共用同一份；
//   2. 警戒 / 追击上限 / 回防 的转换顺序不会来回抖；
//   3. 人数缩放从 n^0.85 改成 n^0.6，Boss 血量也开始吃人数缩放。

import assert from 'node:assert/strict';
import { mulberry32 } from '../src/rng.js';
import {
  buildPatrolRoutes, createPatrolState, stepPatrol,
  wakePatrol, sendHunting, anchorRoute, PATROL,
} from '../src/core/patrol.js';
import { scaleForPlayers } from '../src/core/players.js';
import { World } from '../src/core/world.js';

let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

console.log('\n[1] 巡逻路线由种子生成，且不穿墙');
{
  const mk = () => buildPatrolRoutes(mulberry32(4242), {
    half: 100, blocked: () => false, count: 6, minGap: 24,
  });
  const a = mk();
  const b = mk();
  assert.equal(a.length, 6, `应生成 6 条路线，实际 ${a.length}`);
  assert.deepEqual(a, b, '同一种子必须生成同一批路线（联机两端各算一份也不会分叉）');
  for (const r of a) {
    assert.ok(r.points.length >= 3, '每条路线至少 3 个航点');
    assert.ok(Math.abs(r.anchor.x) <= 100 && Math.abs(r.anchor.z) <= 100, '锚点必须在地图内');
  }
  // 全图被墙塞满时不能死循环，直接返回空
  assert.equal(buildPatrolRoutes(mulberry32(1), {
    half: 100, blocked: () => true, count: 6,
  }).length, 0);
  ok('同种子一致、航点合法、无路可走时安全返回');
}

console.log('\n[2] 状态转换：巡逻 → 追击 → 拉太远回防 → 恢复巡逻');
{
  const route = {
    id: 0, kind: 'route',
    anchor: { x: 0, z: 0 },
    points: [{ x: 0, z: 0 }, { x: 24, z: 0 }, { x: 24, z: 24 }],
  };
  const st = createPatrolState(route, () => 0);
  assert.equal(st.mode, 'route');

  let d = stepPatrol(st, 0.1, 100, { x: 10, z: 0 });
  assert.equal(d.mode, 'patrol', '警戒圈外应继续走航点');
  assert.ok(Number.isFinite(d.tx) && Number.isFinite(d.tz), '巡逻要给出目标点');

  d = stepPatrol(st, 0.1, 20, { x: 10, z: 0 });
  assert.equal(d.mode, 'chase', '进入警戒圈应转追击');
  assert.equal(st.mode, 'chase');

  d = stepPatrol(st, 0.1, 20, { x: PATROL.leashR + 6, z: 0 });
  assert.equal(d.mode, 'return', '追出 leash 应放弃并回防');
  assert.equal(st.mode, 'return');
  assert.equal(d.tx, route.anchor.x);
  assert.equal(d.tz, route.anchor.z);

  d = stepPatrol(st, 0.1, 100, { x: 1, z: 0 });
  assert.equal(st.mode, 'route', '回到锚点后恢复巡逻');

  wakePatrol(st);
  assert.equal(st.mode, 'chase', '巡逻中挨打立即转追击');

  sendHunting(st);
  assert.equal(stepPatrol(st, 0.1, 999, { x: 999, z: 999 }).mode, 'chase',
    '残局转猎杀后，无论离锚点多远都追玩家');
  ok('巡逻 / 追击 / 回防 / 猎杀 四条路径都正确');
}

console.log('\n[3] 驻军与 Boss 的单点锚位');
{
  const guard = createPatrolState(anchorRoute('guard', 5, 5), () => 0);
  let d = stepPatrol(guard, 0.1, 100, { x: 5, z: 5 });
  assert.equal(d.mode, 'hold', '驻军在锚点上应原地警戒');
  d = stepPatrol(guard, 0.1, PATROL.guardAlertR + 5, { x: 5, z: 5 });
  assert.equal(d.mode, 'hold', '玩家在警戒圈外时驻军不动');
  d = stepPatrol(guard, 0.1, 10, { x: 5, z: 5 });
  assert.equal(d.mode, 'chase');

  const boss = createPatrolState(anchorRoute('boss', 0, 0), () => 0);
  d = stepPatrol(boss, 0.1, PATROL.bossAlertR - 1, { x: 0, z: 0 });
  assert.equal(d.mode, 'chase');
  d = stepPatrol(boss, 0.1, 10, { x: PATROL.bossLeashR + 10, z: 0 });
  assert.equal(d.mode, 'return', 'Boss 被拉出区域后也要回防');
  ok('驻军不追出岗位、Boss 有警戒圈与追击上限');
}

console.log('\n[4] 人数缩放：数量 n^0.6，Boss 血量乘 √n');
{
  const s1 = scaleForPlayers(1);
  const s4 = scaleForPlayers(4);
  assert.equal(s1.countMul, 1);
  assert.ok(Math.abs(s4.countMul - Math.pow(4, 0.6)) < 1e-9);
  assert.ok(s4.countMul < 2.4, `4 人数量倍率应小于 2.4（实际 ${s4.countMul.toFixed(2)}）`);
  assert.equal(s4.hpMul, 2);

  const bossHp = (n) => {
    const w = new World({ code: 'B' + n, seed: 77, maxPlayers: 4 });
    for (let i = 0; i < n; i++) w.addPlayer({ id: 'p' + i, name: 'P' + i, chassisId: 'balanced' });
    w.start();
    w.startWave(5);
    return w.pending.find((p) => p.type.startsWith('boss_')).hpScale;
  };
  const h1 = bossHp(1);
  const h4 = bossHp(4);
  assert.equal(h4, Math.round(h1 * 2), `4 人 Boss 血量应为单人的 2 倍（${h1} → ${h4}）`);
  ok('4 人数量倍率 2.30，Boss 血量随人数缩放');
}

console.log('\n[5] 联机世界：一波敌人里同时存在巡逻与猎杀');
{
  const w = new World({ code: 'PT', seed: 20261111, maxPlayers: 4 });
  for (let i = 0; i < 4; i++) w.addPlayer({ id: 'p' + i, name: 'P' + i, chassisId: 'balanced' });
  w.start();
  // 玩家站中心，避免刚出生就被四个角落的出生点影响判断
  const dt = 1 / 30;
  for (let i = 0; i < 30 * 14; i++) {
    for (const p of w.players) {
      p.x = 0; p.z = 0;
      p.input = { seq: i, mx: 0, mz: 0, aimX: 0, aimZ: -10, fire: false };
    }
    w.step(dt);
  }

  assert.ok(w.patrolRoutes.length > 0, '联机世界应生成本局的巡逻路线');
  const patrolled = w.enemies.filter((e) => e.patrol);
  const hunters = w.enemies.filter((e) => !e.patrol);
  assert.ok(patrolled.length > 0, '至少应有一部分敌人带巡逻状态');
  assert.ok(hunters.length > 0, '也必须保留猎杀队，不能全图都是驻军');
  assert.ok(patrolled.length >= hunters.length,
    `巡逻/驻军应占多数（${patrolled.length} vs ${hunters.length}）`);
  ok(`编成 ${patrolled.length} 巡逻 / ${hunters.length} 猎杀`);
}

console.log(`\n全部通过（${pass} 项）`);
