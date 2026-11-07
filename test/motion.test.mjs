// 车体运动学一致性：客户端预测 === 服务端权威模拟
//
// 这组断言来自线上事故"进入房间后车体无法移动、反应很迟钝"：
// 客户端预测和服务端模拟各写了一套转向 / 加速 / 撞墙逻辑，
// 只要一边改了一行就分叉——客户端觉得自己撞墙、服务端在正常推进，
// 位置差被软校正拽回去，手感就是"车不动 + 一顿一顿"。
//
// 现在两边都只调 core/motion.js 的 stepBody。这里保证三件事：
//   1. 同一串输入跑 N 步，客户端预测与服务端结果完全一致（逐帧比对）
//   2. 贴墙不会把速度压死（曾经的 0.3 × 0.3 = 0.09 死锁）
//   3. 客户端源码里不许再出现手抄的碰撞/转向代码

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { stepBody, aimTurret, angleDiff, clampDir } from '../src/core/motion.js';
import { World, buildStaticWorld, HALF } from '../src/core/world.js';
import { generateBoxes } from '../src/core/levelgen.js';
import { predict } from '../src/net.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

const DT = 1 / 30;

console.log('\n[1] 客户端预测与服务端逐帧一致');
{
  const w = new World({ code: 'T', seed: 12345, maxPlayers: 4 });
  const p = w.addPlayer({ id: 'u1', name: 'tester', chassisId: 'balanced' });
  w.start();

  // 客户端侧的影子车体：初值抄服务端的，之后完全靠 predict 推进
  const me = {
    x: p.x, z: p.z, yaw: p.yaw, speed: p.speed,
    speedBase: p.speedBase, turnBase: p.turnBase, turretYaw: p.turretYaw,
  };
  const col = w.static; // 服务端就是这份碰撞表，客户端这里是 createLevel 返回的同款接口

  // 输入序列：先加速直行，再边转边走，再倒车转向
  const seq = [];
  for (let i = 0; i < 40; i++) seq.push({ forward: 1, turn: 0 });
  for (let i = 0; i < 40; i++) seq.push({ forward: 1, turn: 1 });
  for (let i = 0; i < 40; i++) seq.push({ forward: -1, turn: -1 });

  for (let i = 0; i < seq.length; i++) {
    w.setInput('u1', { ...seq[i], aimX: 0, aimZ: 0, fire: false, seq: i + 1 });
    w.step(DT);
    predict(me, seq[i], DT, col, HALF);

    const d = Math.hypot(me.x - p.x, me.z - p.z);
    assert.ok(d < 1e-9, `第 ${i} 帧位置分叉 ${d.toFixed(6)} 米（预测 ${me.x.toFixed(3)},${me.z.toFixed(3)} / 权威 ${p.x.toFixed(3)},${p.z.toFixed(3)}）`);
    assert.ok(Math.abs(angleDiff(me.yaw, p.yaw)) < 1e-9, `第 ${i} 帧朝向分叉`);
  }
  ok(`${seq.length} 帧输入，客户端与服务端位置/朝向完全重合`);
  ok(`120 帧后车确实动了：(${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
}

console.log('\n[2] 撞墙不会把速度压死');
{
  const boxes = generateBoxes();
  const b = boxes[0];
  // 车贴着箱体边缘，油门踩满朝箱体推
  const body = {
    x: b.x - b.w / 2 - 2.0, z: b.z, yaw: Math.PI / 2,
    speed: 0, speedBase: 15, turnBase: 3.0, turretYaw: 0,
  };
  const staticW = buildStaticWorld();
  for (let i = 0; i < 90; i++) stepBody(body, { forward: 1, turn: 0 }, DT, staticW, HALF);
  assert.ok(Math.abs(body.speed) > 4, `贴墙 3 秒后速度只剩 ${body.speed.toFixed(2)} 米/秒（会被判定为"车不动"）`);
  ok(`顶着墙推 3 秒仍保持 ${body.speed.toFixed(1)} 米/秒，可以沿墙滑走`);
}

console.log('\n[3] 客户端不许再手抄运动学');
{
  const src = readFileSync(join(here, '..', 'src', 'coop.js'), 'utf8');
  const net = readFileSync(join(here, '..', 'src', 'net.js'), 'utf8');
  assert.ok(!/me\.yaw \+= turn \*/.test(src), 'coop.js 里又出现了手写的转向');
  assert.ok(!/me\.speed \*= 0\.9/.test(src), 'coop.js 里又出现了手写的撞墙衰减');
  assert.ok(!/me\.yaw \+= turn \*/.test(net), 'net.js 里又出现了手写的转向');
  assert.ok(/stepBody/.test(net), 'net.js 应该复用 core/motion.js 的 stepBody');
  ok('coop.js / net.js 均复用 core/motion.js');
}

console.log('\n[4] 输入归一化');
{
  assert.equal(clampDir(undefined), 0);
  assert.equal(clampDir(NaN), 0);
  assert.equal(clampDir('0.5'), 0.5);
  assert.equal(clampDir(9), 1);
  assert.equal(clampDir(-9), -1);
  assert.ok(Math.abs(angleDiff(0.1, 6.2) - (0.1 - 6.2 + Math.PI * 2)) < 1e-9);
  ok('非法输入归零、超界钳制、角度走最短弧');
}

console.log('\n[5] 炮塔转速受限但不掉队');
{
  const body = { x: 0, z: 0, turretYaw: 0 };
  for (let i = 0; i < 30; i++) aimTurret(body, 0, -10, DT, 10); // 目标在正后方
  assert.ok(Math.abs(angleDiff(body.turretYaw, Math.PI)) < 0.02, `1 秒后炮塔仍差 ${angleDiff(body.turretYaw, Math.PI).toFixed(2)} 弧度`);
  ok('目标在正后方时 0.32 秒转 180°（10 rad/s）');
}

console.log('\n[6] 敌人车头始终朝着行进方向（不许绕圈）');
{
  // 线上症状："敌军坦克会绕圈旋转"——车头朝着玩家，身体却侧着平移，
  // 看起来就是原地画圈。这里直接看服务端模拟里两个矢量的夹角。
  const w = new World({ code: 'E', seed: 777, maxPlayers: 1 });
  w.addPlayer({ id: 'u1', name: 'p', chassisId: 'balanced' });
  w.start();
  w.setInput('u1', { forward: 0, turn: 0, aimX: 0, aimZ: 0, fire: false, seq: 1 });

  const angs = [];
  const prev = new Map();
  for (let i = 0; i < 450; i++) {   // 15 秒
    w.step(DT);
    for (const e of w.enemies) {
      const pv = prev.get(e.id);
      if (pv) {
        const dx = e.x - pv.x;
        const dz = e.z - pv.z;
        // 只看真正在走的敌人；撞墙卡住时不算
        if (Math.hypot(dx, dz) > 0.2) {
          angs.push(Math.abs(angleDiff(Math.atan2(dx, dz), e.yaw)) * 180 / Math.PI);
        }
      }
      prev.set(e.id, { x: e.x, z: e.z });
    }
  }
  assert.ok(angs.length > 100, `样本太少：${angs.length}`);
  const over45 = angs.filter((a) => a > 45).length / angs.length;
  assert.ok(over45 < 0.12, `车头与行进方向夹角 >45° 的比例 ${(over45 * 100).toFixed(0)}%，敌人又在绕圈了`);
  ok(`${angs.length} 个移动样本中只有 ${(over45 * 100).toFixed(0)}% 车头明显偏离行进方向`);
}

console.log(`\n运动学测试全部通过（${pass} 项）\n`);
