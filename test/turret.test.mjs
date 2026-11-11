// 炮塔射界与转速
//
// 射界和转速都收进 core/motion.js 的 aimTurret，单机（Tank.js）与
// 联机（world.js 权威 + coop.js 预测）调的都是同一个函数。
//
// 历史：轻装 / 猎手最早是 ±15° 的"无炮塔"车，实机上手根本没法操作
// （想打侧后方要先把车体整台转过去，被贴身就完全没辙），已改回全向炮塔。
// 现在四款车合并成一款「豹式」：全向炮塔 + 瞬间对准，历史 id 走别名映射。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aimTurret, angleDiff } from '../src/core/motion.js';
import { CHASSIS, CHASSIS_TABLE, CHASSIS_LIST, TURRET_SNAP_RATE, turretOf, normalizeChassisId } from '../src/chassis.js';
import { World } from '../src/core/world.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');
const DEG = Math.PI / 180;
const LIMIT15 = 15 * DEG;

let pass = 0;
const ok = (msg) => { pass++; console.log(`  ✓ ${msg}`); };

console.log('\n[1] 车体表：射界与转速从 CHASSIS 派生，没有第二份');

// 四款车已合并成一款「豹式」：全向炮塔 + 瞬间对准。
// 历史 id（balanced/light/heavy/hunter）保留为别名，必须仍能落到豹式上，
// 否则老存档 / 老客户端 / 老排行榜记录会显示成"未知车体"。
const EXPECT = {
  panther: { snap: true, limit: 180 },
};

for (const c of CHASSIS_LIST) {
  const e = EXPECT[c.id];
  assert.ok(e, `未知车体 ${c.id}`);
  assert.ok(c.turret, `${c.name} 缺少 turret 字段`);
  assert.equal(!!c.turret.snap, e.snap, `${c.name} 的 snap 标记不对`);
  assert.equal(c.turret.limit, e.limit, `${c.name} 射界应写成 ${e.limit} 度`);

  const t = CHASSIS_TABLE[c.id];
  assert.equal(t.turretLimit, e.limit * DEG, `${c.name} 派生射界弧度不对`);
  if (e.snap) {
    assert.ok(t.turretRate >= 1e5, `${c.name} 应视为瞬间对准（实际 ${t.turretRate}）`);
    assert.ok(Number.isFinite(t.turretRate), `${c.name} 的转速不能是 Infinity（Infinity*0 = NaN）`);
  } else {
    assert.ok(Math.abs(t.turretRate - 170 * DEG) < 1e-9, `${c.name} 转速应为 170°/s`);
  }
}
ok('车体表的射界 / 转速全部由 CHASSIS 派生，单位换算只在派生表里做一次');

for (const legacy of ['balanced', 'light', 'heavy', 'hunter', 'commander']) {
  assert.equal(normalizeChassisId(legacy), 'panther', `历史车体 ${legacy} 应映射到 panther`);
  assert.deepEqual(turretOf(legacy), turretOf('panther'), `历史车体 ${legacy} 的炮塔参数应等同豹式`);
}
ok('历史车体 id 全部归一化到豹式，不会出现"未知车体"');

assert.deepEqual(turretOf('nope'), turretOf('panther'), '未知车体应退回豹式（全向）');
ok('未知车体 id 退回全向瞬间对准，不会变成 0 射界把炮锁死');

console.log('\n[2] 全向炮塔：瞬间对准正后方');

{
  const b = { x: 0, z: 0, yaw: 0, turretYaw: 0 };
  aimTurret(b, 0, -10, 1 / 60, TURRET_SNAP_RATE, Math.PI);
  assert.ok(Math.abs(angleDiff(b.turretYaw, Math.PI)) < 1e-9, `一帧后应正对后方，实际 ${b.turretYaw}`);
  ok('一帧内转 180°（均衡 / 重装的手感没变）');
}

console.log('\n[3] 无炮塔车：射界夹在 ±15°');

{
  const b = { x: 0, z: 0, yaw: 0, turretYaw: 0 };
  // 目标在右侧（+x）
  for (let i = 0; i < 120; i++) aimTurret(b, 10, 0, 1 / 60, 170 * DEG, LIMIT15);
  assert.ok(Math.abs(b.turretYaw - LIMIT15) < 1e-6, `应停在 +15°，实际 ${(b.turretYaw / DEG).toFixed(2)}°`);

  // 目标在正后方：也停在 +15°（最近的那一侧）
  const c = { x: 0, z: 0, yaw: 0, turretYaw: 0 };
  for (let i = 0; i < 120; i++) aimTurret(c, 0.001, -10, 1 / 60, 170 * DEG, LIMIT15);
  assert.ok(Math.abs(c.turretYaw - LIMIT15) < 1e-4, `正后方应夹到 +15°（不是 -15°），实际 ${(c.turretYaw / DEG).toFixed(2)}°`);
  ok('侧方与正后方的瞄准都被夹在 15°，且不会左右乱跳');
}

console.log('\n[4] 车体转向时炮塔立即跟上（不能挂在射界外）');

{
  const b = { x: 0, z: 0, yaw: 0, turretYaw: LIMIT15 };
  // 先跑一帧建立基准（真实 tick 序列里第一帧总是这样），否则 _aimYaw 未定义，
  // 无法知道炮塔原来在车头的哪一侧——这是"首帧无历史"的固有限制，不是 bug。
  aimTurret(b, 10, 10, 1 / 60, 170 * DEG, LIMIT15);
  const baseRel = angleDiff(b.turretYaw, b.yaw);

  // 车体猛转 90°，炮塔必须在这一帧就跟着转
  b.yaw = Math.PI / 2;
  aimTurret(b, undefined, undefined, 0, 170 * DEG, LIMIT15);
  const rel = angleDiff(b.turretYaw, b.yaw);
  assert.ok(Math.abs(rel - baseRel) < 1e-6, `相对车头角应保持不变，实际 ${(rel / DEG).toFixed(2)}° vs ${(baseRel / DEG).toFixed(2)}°`);
  assert.ok(Math.abs(b.turretYaw - (Math.PI / 2 + baseRel)) < 1e-6, '炮塔世界角应随车体一起转过去');
  ok('车体转 90° 的同一帧，炮塔就跟着转 90°（炮塔焊在车体上）');

  // 反向同理
  const c = { x: 0, z: 0, yaw: 0, turretYaw: -LIMIT15 };
  aimTurret(c, 0, 10, 1 / 60, 170 * DEG, LIMIT15); // 建基准：此时被夹到 -15°
  const cBase = angleDiff(c.turretYaw, c.yaw);
  c.yaw = -Math.PI / 3;
  aimTurret(c, undefined, undefined, 0, 170 * DEG, LIMIT15);
  assert.ok(Math.abs(angleDiff(c.turretYaw, c.yaw) - cBase) < 1e-6, '反向也要保持相对角');
  ok('往另一边转同样跟着车体走，不会"甩出去再慢慢收回"');
}

console.log('\n[5] 转速限制：170°/s 真的只能转 170°/s');

{
  const b = { x: 0, z: 0, yaw: 0, turretYaw: 0 };
  // 目标在 -15°（左边界），起始在 +15°（右边界）：30° 全行程
  b.turretYaw = LIMIT15;
  aimTurret(b, -10, 0, 0.1, 170 * DEG, LIMIT15); // 0.1 秒最多 17°
  const moved = Math.abs(b.turretYaw - LIMIT15) / DEG;
  assert.ok(Math.abs(moved - 17) < 0.01, `0.1 秒应转 17°，实际 ${moved.toFixed(2)}°`);
  ok('0.1 秒转 17°（170°/s），不是一步到位');

  // 剩余 13° 再给 0.1 秒：应该到位并停住
  aimTurret(b, -10, 0, 0.1, 170 * DEG, LIMIT15);
  assert.ok(Math.abs(b.turretYaw + LIMIT15) < 1e-6, `应停在 -15°，实际 ${(b.turretYaw / DEG).toFixed(2)}°`);
  ok('第二段到位，不会越过边界来回摆');
}

console.log('\n[6] 坏输入不许产生 NaN');

{
  const b = { x: 0, z: 0, yaw: 0, turretYaw: 0 };
  aimTurret(b, NaN, NaN, 1 / 60, 170 * DEG, LIMIT15);
  assert.ok(Number.isFinite(b.turretYaw), 'aim 为 NaN 时角度必须仍是有限值');
  ok('瞄准点是 NaN（射线没打中地面）时炮塔不动，不会变成 NaN');

  const c = { x: 0, z: 0 }; // 没有 yaw / turretYaw
  for (let i = 0; i < 120; i++) aimTurret(c, 0, -10, 1 / 60, 170 * DEG, LIMIT15);
  assert.ok(Number.isFinite(c.turretYaw), '车头未知时也要给出有限角度');
  assert.ok(Math.abs(angleDiff(c.turretYaw, Math.PI)) < 1e-6, `车头未知按全向处理，实际 ${(c.turretYaw / DEG).toFixed(1)}°`);
  ok('车头朝向缺失的老调用方退回全向，不会把车打成 NaN');

  const d = { x: 0, z: 0, yaw: 0, turretYaw: NaN };
  aimTurret(d, 0, 10, 1 / 60, 170 * DEG, LIMIT15);
  assert.ok(Number.isFinite(d.turretYaw), 'turretYaw 自身坏掉时要能自愈');
  ok('turretYaw 已经是 NaN 时能归位，不会一路烂下去');
}

console.log('\n[7] 倒车：车头掉过来，炮口跟着掉');

{
  // 八方向移动模型里按 S 会让车头转向 +Z（朝后走），炮塔相对车头不变。
  // 玩家看到的"倒车"就是这种：车头朝后、炮口朝后，射界仍然相对车头。
  // 这里按真实节奏模拟：车体 8 rad/s 逐帧掉头，炮塔跟着被带走。
  const b = { x: 0, z: 0, yaw: 0, turretYaw: 0 };
  for (let i = 0; i < 30; i++) aimTurret(b, 10, 10, 1 / 60, 170 * DEG, LIMIT15); // 建基准，夹到 +15°
  const before = angleDiff(b.turretYaw, b.yaw);
  assert.ok(Math.abs(before - LIMIT15) < 1e-6, '基准应在 +15°');

  // 车头掉头：每帧 8 rad/s × 1/60
  let guard = 0;
  while (Math.abs(angleDiff(b.yaw, Math.PI)) > 1e-6 && guard++ < 200) {
    const d = angleDiff(Math.PI, b.yaw);
    b.yaw += Math.sign(d) * Math.min(Math.abs(d), 8 / 60);
    // 只看"车体带炮塔"这一件事：不给瞄准目标，避免玩家主动把炮口转回中位
    aimTurret(b, undefined, undefined, 1 / 60, 170 * DEG, LIMIT15);
  }
  const after = angleDiff(b.turretYaw, b.yaw);
  assert.ok(Math.abs(after - before) < 1e-6, `相对车头的角度应保持不变（${(before / DEG).toFixed(2)}° / ${(after / DEG).toFixed(2)}°）`);
  assert.ok(Math.abs(angleDiff(b.turretYaw, Math.PI + before)) < 1e-6, '炮口世界角应跟着掉 180°');
  ok('车头 180° 掉头后炮口相对车头仍是原来的角度（倒车不需要额外代码）');
}

console.log('\n[8] 两端同源：没有第二份炮塔实现');

{
  const tank = src('src/Tank.js');
  assert.ok(/import\s*\{[^}]*aimTurret[^}]*\}\s*from\s*'\.\/core\/motion\.js'/.test(tank),
    'Tank.js 必须 import core/motion.js 的 aimTurret');
  assert.ok(!/turretYaw\s*\+=\s*Math\.sign/.test(tank), 'Tank.js 不许自己算转速（会与 core 漂移）');
  assert.ok(/aimAt\s*\(/.test(tank) && /_syncTurret/.test(tank), 'Tank.js 应提供 aimAt + _syncTurret');

  const world = src('src/core/world.js');
  assert.ok(/aimTurret\(p, inp\.aimX, inp\.aimZ, dt, p\.turretRate, p\.turretLimit\)/.test(world),
    '服务端必须用玩家自己的 turretRate / turretLimit');

  const coop = src('src/coop.js');
  assert.ok(/aimTurret\(this\.me, input\.aimX, input\.aimZ, TICK_DT/.test(coop),
    '客户端预测要按 TICK_DT 推进炮塔，与服务端同频');

  const game = src('src/Game.js');
  assert.ok(/player\.aimAt\(/.test(game), '单机必须走 Tank.aimAt（最终进 core/motion.js）');
  assert.ok(!/player\.setAim\(Math\.atan2\(dx, dz\)\)/.test(game), '单机不许再瞬间对准鼠标');

  // 单机开火方向必须是炮口，不是鼠标 —— 否则射界只是视觉效果
  assert.ok(/const fy = player\.turretYaw;/.test(game) && /Math\.sin\(fy\), 0, Math\.cos\(fy\)/.test(game),
    '单机开火必须按炮口朝向（player.turretYaw）');
  ok('Tank / world / coop / Game 四处都走同一份 aimTurret，开火方向是炮口');
}

console.log('\n[9] 车体卡上写得出射界（玩家看得见才叫机制）');

{
  for (const c of CHASSIS_LIST) {
    const txt = c.perkText + c.desc;
    assert.ok(/全向/.test(txt), `${c.name} 的卡面没提"全向"`);
    assert.ok(!/±15/.test(txt), `${c.name} 的卡面还写着 ±15°，与实际不符`);
  }
  ok('车体卡都写明全向炮塔，文案与实际一致');
}

console.log('\n[10] 服务端集成：World 真的按车体夹射界');

{
  const w = new World({ code: 'T', seed: 12345 });
  // 故意用历史 id：服务端必须归一化到豹式，而不是当成未知车体
  const a = w.addPlayer({ id: 'a', name: '甲', chassisId: 'light' });
  const b = w.addPlayer({ id: 'b', name: '乙', chassisId: 'balanced' });
  assert.equal(w.start(), true, 'World 应能开始');

  // 车头朝 -Z（按 W 前进），准星甩到正侧方
  const inp = (p) => ({ seq: 1, mx: 0, mz: -1, aimX: p.x + 50, aimZ: p.z, fire: false });
  for (let i = 0; i < 90; i++) {
    w.setInput('a', inp(a));
    w.setInput('b', inp(b));
    w.step(1 / 30);
  }

  const relDeg = (p) => (angleDiff(p.turretYaw, p.yaw) * 180) / Math.PI;
  // 豹式是全向瞬间对准，3 秒足够把炮口甩到正侧方（90°）
  assert.ok(Math.abs(relDeg(a)) > 80, `豹式应能对到侧方，实际 ${relDeg(a).toFixed(2)}°`);
  assert.ok(Math.abs(relDeg(b)) > 80, `豹式应能对到侧方，实际 ${relDeg(b).toFixed(2)}°`);
  assert.equal(a.chassis, 'panther', '历史 id light 应归一化为 panther');
  assert.equal(b.chassis, 'panther', '历史 id balanced 应归一化为 panther');
  ok('世界里的豹式（含历史 id 进来的）能转到正侧方，且服务端车体已归一化');
}

console.log('\n[11] 客户端预测与服务端算出一致的结果');

{
  // 同一辆车、同一串输入，服务端（World）与客户端（predict + aimTurret）
  // 必须得到同一个炮塔角。差一点点，联机时炮弹就会偏出准星。
  const w = new World({ code: 'P', seed: 777 });
  const p = w.addPlayer({ id: 'a', name: '甲', chassisId: 'panther' });
  w.start();

  // 客户端侧的影子副本
  const { predict } = await import('../src/net.js');
  const { HALF } = await import('../src/level.js');
  const me = { x: p.x, z: p.z, yaw: p.yaw, turretYaw: p.turretYaw, speed: 0,
    speedBase: p.speedBase, turretRate: p.turretRate, turretLimit: p.turretLimit };

  const mk = () => ({ seq: 1, mx: 0.6, mz: -0.8, aimX: p.x + 30, aimZ: p.z + 12, fire: false });
  for (let i = 0; i < 45; i++) {
    w.setInput('a', mk());
    w.step(1 / 30);
    predict(me, mk(), 1 / 30, w.static, HALF);
    aimTurret(me, (mk()).aimX, (mk()).aimZ, 1 / 30, me.turretRate, me.turretLimit);
  }
  const dPos = Math.hypot(me.x - p.x, me.z - p.z);
  const dTur = Math.abs(angleDiff(me.turretYaw, p.turretYaw)) * 180 / Math.PI;
  assert.ok(dPos < 0.2, `位置偏差应小于 0.2 米，实际 ${dPos.toFixed(3)}`);
  assert.ok(dTur < 1.0, `炮塔角偏差应小于 1°，实际 ${dTur.toFixed(2)}°`);
  ok(`45 个 tick 后位置差 ${dPos.toFixed(3)} 米、炮塔差 ${dTur.toFixed(2)}°（两端同源）`);
}

console.log(`\n炮塔射界测试全部通过（${pass} 项）\n`);
