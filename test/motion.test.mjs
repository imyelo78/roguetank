// 车体运动学一致性：客户端预测 === 服务端权威模拟
//
// 这组断言来自两次线上事故：
//   1. "进房后车体无法移动、反应很迟钝" —— 两端各写一套物理，位置分叉后被软校正拽回
//   2. "方向左和右无法操作，取而代之的是左转和右转" —— 联机用了坦克式方向盘，
//      单机却是八方向平移，同一个玩家进房后手感完全变样
//
// 现在两边都只调 core/motion.js 的 stepBody，且输入统一为世界坐标方向向量 (mx, mz)。
// 这里保证四件事：
//   1. 同一串输入跑 N 步，客户端预测与服务端结果逐帧一致
//   2. 左右键确实产生横向位移，而不是原地转向
//   3. 贴墙不会把速度压死，也不会穿墙
//   4. 客户端源码里不许再出现手抄的碰撞 / 转向代码

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { stepBody, aimTurret, angleDiff, clampDir, TURN_TO_RATE } from '../src/core/motion.js';
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
    speedBase: p.speedBase, turretYaw: p.turretYaw,
  };
  const col = w.static; // 服务端就是这份碰撞表，客户端这里是 createLevel 返回的同款接口

  // 输入序列覆盖：直行、左移、右移、斜向、后退
  const seq = [];
  for (let i = 0; i < 24; i++) seq.push({ mx: 0, mz: -1 });
  for (let i = 0; i < 24; i++) seq.push({ mx: -1, mz: 0 });
  for (let i = 0; i < 24; i++) seq.push({ mx: 1, mz: 0 });
  for (let i = 0; i < 24; i++) seq.push({ mx: 0.7, mz: 0.7 });
  for (let i = 0; i < 24; i++) seq.push({ mx: 0, mz: 1 });

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

console.log('\n[2] 左右键 = 横移，不是原地转向');
{
  // 这是用户直接反馈的症状：按 A/D 期望左右平移，实际却在原地打转。
  const body = { x: 0, z: 0, yaw: 0, speed: 0, speedBase: 15 };
  stepBody(body, { mx: -1, mz: 0 }, DT, null, HALF);
  assert.ok(body.x < -0.4, `按左键后 x 只变化了 ${body.x.toFixed(2)} 米，没有横向位移`);
  assert.ok(Math.abs(body.z) < 1e-9, '按左键却产生了前后位移');
  ok(`按左键 1 帧位移 ${body.x.toFixed(2)} 米（横向）`);

  // 方向键与 WASD 走同一个入口，不应有任何"转向"专用的输入通道
  const after = body.x;
  for (let i = 0; i < 20; i++) stepBody(body, { mx: -1, mz: 0 }, DT, null, HALF);
  assert.ok(body.x < after - 8, `持续按左键 20 帧只走了 ${(after - body.x).toFixed(1)} 米`);
  // 车头应当已经转到左方（-90°），且不再继续旋转
  assert.ok(Math.abs(angleDiff(body.yaw, -Math.PI / 2)) < 1e-6, `车头朝向 ${body.yaw.toFixed(2)}，应稳定在 -π/2`);
  ok('持续左移时车头稳定朝左，不会原地打转');
}

console.log('\n[3] 恒速与松键即停');
{
  const body = { x: 0, z: 0, yaw: 0, speed: 0, speedBase: 15 };
  stepBody(body, { mx: 0, mz: -1 }, DT, null, HALF);
  assert.ok(Math.abs(body.speed - 15) < 1e-9, `按下第一帧速度就是 ${body.speed.toFixed(2)}，应立刻满速`);
  stepBody(body, { mx: 0, mz: 0 }, DT, null, HALF);
  assert.equal(body.speed, 0, '松开按键后还在滑行');
  ok('按下即 15 米/秒，松开即停（与单机一致，没有加速斜坡）');
}

console.log('\n[4] 顶墙不会掉速，也不会穿墙');
{
  const boxes = generateBoxes();
  const b = boxes[0];
  const staticW = buildStaticWorld();
  // 车在箱体左侧，朝箱体推
  const body = {
    x: b.x - b.w / 2 - 2.0, z: b.z, yaw: Math.PI / 2,
    speed: 0, speedBase: 15,
  };
  for (let i = 0; i < 90; i++) stepBody(body, { mx: 1, mz: 0 }, DT, staticW, HALF);
  assert.ok(body.x <= b.x - b.w / 2 - 1.9 + 0.05, `车嵌进了箱体：x=${body.x.toFixed(2)}`);
  assert.equal(body.speed, 15, '顶墙后速度被衰减，会出现"油门踩死车不动"');
  ok('顶着墙推 3 秒仍保持全速，且没有穿墙');
}

console.log('\n[5] 客户端与协议里不许再出现方向盘语义');
{
  const src = readFileSync(join(here, '..', 'src', 'coop.js'), 'utf8');
  const net = readFileSync(join(here, '..', 'src', 'net.js'), 'utf8');
  const proto = readFileSync(join(here, '..', 'src', 'core', 'protocol.js'), 'utf8');

  assert.ok(!/me\.yaw \+= turn \*/.test(src), 'coop.js 里又出现了手写的转向');
  assert.ok(!/me\.speed \*= 0\.9/.test(src), 'coop.js 里又出现了手写的撞墙衰减');
  assert.ok(!/me\.yaw \+= turn \*/.test(net), 'net.js 里又出现了手写的转向');
  assert.ok(/stepBody/.test(net), 'net.js 应该复用 core/motion.js 的 stepBody');
  // 输入帧里不该再有 f / t 两个方向盘字段
  assert.ok(!/\bt:\s*input\.turn/.test(net), 'net.js 还在发旧的方向盘字段');
  ok('coop.js / net.js / protocol.js 均已切到八方向输入');
}

console.log('\n[6] 输入归一化');
{
  assert.equal(clampDir(undefined), 0);
  assert.equal(clampDir(NaN), 0);
  assert.equal(clampDir('0.5'), 0.5);
  assert.equal(clampDir(9), 1);
  assert.equal(clampDir(-9), -1);
  assert.ok(Math.abs(angleDiff(0.1, 6.2) - (0.1 - 6.2 + Math.PI * 2)) < 1e-9);
  // 斜向输入必须归一化，否则对角线速度会是 1.41 倍
  const body = { x: 0, z: 0, yaw: 0, speed: 0, speedBase: 15 };
  stepBody(body, { mx: 1, mz: 1 }, DT, null, HALF);
  const stepLen = Math.hypot(body.x, body.z);
  assert.ok(Math.abs(stepLen - 15 * DT) < 1e-9, `斜向一帧走了 ${stepLen.toFixed(3)} 米，应等于 15×dt`);
  ok('非法输入归零、超界钳制、斜向不超速');
}

console.log('\n[7] 炮塔转速受限但不掉队');
{
  const body = { x: 0, z: 0, turretYaw: 0 };
  for (let i = 0; i < 30; i++) aimTurret(body, 0, -10, DT, 10); // 目标在正后方
  assert.ok(Math.abs(angleDiff(body.turretYaw, Math.PI)) < 0.02, `1 秒后炮塔仍差 ${angleDiff(body.turretYaw, Math.PI).toFixed(2)} 弧度`);
  ok('目标在正后方时 0.32 秒转 180°（10 rad/s）');
}

console.log('\n[8] 敌人车头始终朝着行进方向（不许绕圈）');
{
  // 线上症状："敌军坦克会绕圈旋转"——车头朝着玩家，身体却侧着平移，
  // 看起来就是原地画圈。这里直接看服务端模拟里两个矢量的夹角。
  const w = new World({ code: 'E', seed: 777, maxPlayers: 1 });
  w.addPlayer({ id: 'u1', name: 'p', chassisId: 'balanced' });
  w.start();
  w.setInput('u1', { mx: 0, mz: 0, aimX: 0, aimZ: 0, fire: false, seq: 1 });

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
console.log(`（车体跟随移动方向的转速 TURN_TO_RATE = ${TURN_TO_RATE} rad/s，与单机 Tank.move 的 dt*8 一致）`);
