// 地形高度场与坡度运动学的回归测试
//
// 重点不是"高度函数算得对不对"（那是数学），而是三条会直接变成线上事故的性质：
//   1. scale = 0 时必须是彻底的全平 —— 旧地图、旧包、没开地形的房间一行不受影响
//   2. 坡度只改目标速度，不改积分 —— 否则客户端预测与服务端权威会慢慢漂开
//   3. 两端调的是同一个函数 —— 这是这个项目已经踩过两次的坑（假墙、速度死锁）

import assert from 'node:assert/strict';
import {
  heightAt, gradientAt, slopeFactor, scanTerrain,
  TERRAIN_SCALE, SLOPE_MAX_SLOW, SLOPE_MAX_FAST,
} from '../src/core/terrain.js';
import { World, buildStaticWorld, HALF } from '../src/core/world.js';
import { stepBody } from '../src/core/motion.js';

let pass = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };

const DT = 1 / 30;

/** 全域找坡度最陡的采样点（测坡度行为要在这里测，最高点/最低点的梯度接近 0） */
function steepestPoint(scale) {
  let best = { s: 0, x: 0, z: 0 };
  for (let x = -98; x <= 98; x += 2) {
    for (let z = -98; z <= 98; z += 2) {
      const g = gradientAt(x, z, scale);
      const s = Math.hypot(g.gx, g.gz);
      if (s > best.s) best = { s, x, z };
    }
  }
  return best;
}

console.log('\n[1] scale = 0 必须彻底全平（旧地图回归保护）');
{
  let bad = 0;
  for (let x = -100; x <= 100; x += 3.7) {
    for (let z = -100; z <= 100; z += 3.7) {
      if (heightAt(x, z, 0) !== 0) bad++;
      const g = gradientAt(x, z, 0);
      if (g.gx !== 0 || g.gz !== 0) bad++;
    }
  }
  assert.equal(bad, 0, `${bad} 个采样点在 scale=0 时不为 0`);
  ok('高度与梯度在 scale=0 时恒为 0');

  // 旧行为：速度恒等于 speedBase，一点坡度影响都不能有
  const col = buildStaticWorld(0);
  assert.equal(col.terrainScale, 0);
  const body = { x: 0, z: -80, yaw: 0, speed: 0, speedBase: 15 };
  stepBody(body, { mx: 0, mz: 1 }, DT, col, HALF);
  assert.equal(body.speed, 15, 'scale=0 时速度被改动了，旧地图会变味');
  ok('scale=0 时速度恒为 speedBase（不引入任何新行为）');
}

console.log('\n[2] 高度场连续、梯度解析正确');
{
  // 相邻 0.5 米的高度差不能跳变，否则车会在"台阶"上抖
  let maxJump = 0;
  for (let x = -100; x < 100; x += 0.5) {
    const a = heightAt(x, 20, 1);
    const b = heightAt(x + 0.5, 20, 1);
    maxJump = Math.max(maxJump, Math.abs(b - a));
  }
  assert.ok(maxJump < 0.15, `相邻 0.5 米最大高度跳变 ${maxJump.toFixed(3)} 米，出现台阶了`);
  ok(`高度连续（最大跳变 ${maxJump.toFixed(4)} 米 / 0.5 米）`);

  // 梯度必须是"真的指向坡上"：沿梯度方向走 1 米，高度应上升约 |grad| 米。
  // 噪声地形没有闭式导数，所以不能按"解析 vs 差分"对拍，只能验行为。
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const x = ((i % 20) * 10) - 100;
    const z = ((((i * 7) % 20) - 10) * 10);
    const g = gradientAt(x, z, 1);
    const len = Math.hypot(g.gx, g.gz);
    if (len < 0.02) continue; // 峰顶/谷底附近方向没有意义
    const h0 = heightAt(x, z, 1);
    const h1 = heightAt(x + (g.gx / len), z + (g.gz / len), 1);
    worst = Math.max(worst, Math.abs((h1 - h0) - len) / len);
  }
  assert.ok(worst < 0.35, `梯度方向与实际上坡方向偏差 ${(worst * 100).toFixed(0)}%`);
  ok(`梯度确实指向坡上（最大相对偏差 ${(worst * 100).toFixed(0)}%）`);

  const r = scanTerrain(HALF, 1, 2);
  assert.ok(r.maxH > 3.5 && r.maxH < 8, `标准地形最高点 ${r.maxH.toFixed(2)} 米，超出预期`);
  assert.ok(r.minH < -3.5 && r.minH > -8, `标准地形最低点 ${r.minH.toFixed(2)} 米，超出预期`);
  assert.ok(r.maxSlopeDeg > 12 && r.maxSlopeDeg < 30, `最陡 ${r.maxSlopeDeg.toFixed(1)}°，超出预期`);
  ok(`标准地形：${r.minH.toFixed(1)} ~ ${r.maxH.toFixed(1)} 米，最陡 ${r.maxSlopeDeg.toFixed(1)}°`);
}

console.log('\n[3] 坡度因子方向正确、有上下限');
{
  // 必须挑坡度最陡的点：最高点/最低点的梯度接近 0，测出来什么都是 1
  const at = steepestPoint(1);
  const g = gradientAt(at.x, at.z, 1);
  const gl = Math.hypot(g.gx, g.gz) || 1;
  const up = slopeFactor(at.x, at.z, g.gx / gl, g.gz / gl, 1);
  const down = slopeFactor(at.x, at.z, -g.gx / gl, -g.gz / gl, 1);
  assert.ok(up < 1, `上坡系数 ${up.toFixed(3)} 应该 < 1`);
  assert.ok(down > 1, `下坡系数 ${down.toFixed(3)} 应该 > 1`);
  assert.ok(up < 0.8, `最陡处上坡系数 ${up.toFixed(3)} 偏大，减速感不明显`);
  ok(`最陡处（${(at.s * 100).toFixed(0)}% 坡）上坡 ×${up.toFixed(2)}、下坡 ×${down.toFixed(2)}`);

  // 全域扫一遍，系数不能越界
  let lo = 9, hi = -9;
  for (let x = -100; x <= 100; x += 3) {
    for (let z = -100; z <= 100; z += 3) {
      for (const [ux, uz] of [[1, 0], [0, 1], [-0.707, 0.707]]) {
        const f = slopeFactor(x, z, ux, uz, 1);
        lo = Math.min(lo, f); hi = Math.max(hi, f);
      }
    }
  }
  assert.ok(lo >= 1 - SLOPE_MAX_SLOW - 1e-9, `速度系数下限 ${lo.toFixed(3)} 越界`);
  assert.ok(hi <= 1 + SLOPE_MAX_FAST + 1e-9, `速度系数上限 ${hi.toFixed(3)} 越界`);
  ok(`全域速度系数 ${lo.toFixed(2)} ~ ${hi.toFixed(2)}（不出现爬不动或飞出）`);
}

console.log('\n[4] 客户端预测与服务端权威必须逐帧一致');
{
  // 这是最要命的一条：坡度如果只在一边生效，残差会持续累积，
  // 表现就是"车在坡上一直被打滑的感觉拽回去"。
  const w = new World({ code: 'T', seed: 7, maxPlayers: 4, terrainScale: 1 });
  const p = w.addPlayer({ id: 'u1', name: 't', chassisId: 'balanced' });
  w.start();

  assert.equal(w.static.terrainScale, 1, '服务端碰撞源没拿到地形强度');

  // 客户端侧：一份独立 body，走同一个 stepBody、同一套碰撞源
  const body = { x: p.x, z: p.z, yaw: p.yaw, speed: 0, speedBase: 15 };

  let maxDrift = 0;
  for (let i = 0; i < 60; i++) {
    const input = { mx: 0.8, mz: 0.6, aimX: 0, aimZ: 0, fire: false, seq: i + 1 };
    w.setInput('u1', input);
    w.step(DT);
    stepBody(body, input, DT, w.static, HALF);

    const drift = Math.hypot(body.x - p.x, body.z - p.z);
    maxDrift = Math.max(maxDrift, drift);
  }
  assert.ok(maxDrift < 1e-9, `预测与权威最大偏差 ${maxDrift.toExponential(2)} 米，两端算法不一致`);
  ok(`60 帧后位置完全重合（最大偏差 ${maxDrift.toExponential(1)} 米）`);
}

console.log('\n[5] 上坡确实变慢、下坡确实变快');
{
  const col = buildStaticWorld(1);

  // 沿最陡坡面的梯度方向走
  const at = steepestPoint(1);
  const g = gradientAt(at.x, at.z, 1);
  const gl = Math.hypot(g.gx, g.gz) || 1;

  const up = { x: at.x, z: at.z, yaw: 0, speed: 0, speedBase: 15 };
  stepBody(up, { mx: g.gx / gl, mz: g.gz / gl }, DT, col, HALF);

  const down = { x: at.x, z: at.z, yaw: 0, speed: 0, speedBase: 15 };
  stepBody(down, { mx: -g.gx / gl, mz: -g.gz / gl }, DT, col, HALF);

  assert.ok(up.speed < 15, `上坡速度 ${up.speed.toFixed(2)} 没有下降`);
  assert.ok(down.speed > 15, `下坡速度 ${down.speed.toFixed(2)} 没有上升`);
  assert.ok(up.speed > 8, `上坡速度 ${up.speed.toFixed(2)} 掉太多，会爬不动`);
  assert.ok(up.speed < 11.5, `上坡速度 ${up.speed.toFixed(2)} 没掉够，坡度手感不明显`);
  ok(`最陡坡（${(at.s * 100).toFixed(0)}%）上坡 ${up.speed.toFixed(1)}、下坡 ${down.speed.toFixed(1)} 米/秒（基础 15）`);
}

console.log('\n[6] 三档强度的量级符合预期');
{
  for (const [name, scale] of Object.entries(TERRAIN_SCALE)) {
    if (!scale) continue;
    const r = scanTerrain(HALF, scale, 4);
    console.log(`      ${name.padEnd(8)} 高度 ${r.minH.toFixed(1)} ~ ${r.maxH.toFixed(1)} 米，最陡 ${r.maxSlopeDeg.toFixed(1)}°`);
  }
  const gentle = scanTerrain(HALF, TERRAIN_SCALE.gentle, 4);
  const rugged = scanTerrain(HALF, TERRAIN_SCALE.rugged, 4);
  assert.ok(gentle.maxSlopeDeg < 12, 'gentle 档太陡，新手会觉得到处在打滑');
  assert.ok(rugged.maxSlopeDeg > 25, 'rugged 档太平，山地关做不出感觉');
  ok('gentle 适合新手关，rugged 适合山地关');
}

console.log(`\n全部通过（${pass} 项）\n`);
