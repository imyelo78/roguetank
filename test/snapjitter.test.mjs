// 快照抖动回归测试（r41）。
//
// 复现"车行进时整屏一抖一抖"的成因，钉住修复：
//   服务端 30Hz 推进、快照 15Hz 下发，单程延迟 160ms 且**到达时间带抖动**；
//   客户端 60fps 预测 → 吃快照 → 校正 → 外推 → 画出来。
//   匀速直行时，画出来的位置每帧必须走一样远。
//
// 修之前的病根：`_absorbResidual` 里两条"硬贴"分支（领先超过 LEAD_CAP 往回拉、
// 服务端反超 0.75 米往前贴）是**瞬移**，一帧几十厘米到一米；`want` 跟着跳，
// `_disp` 用 25ms 一阶低通去追 —— 画面上就是"整屏猛窜一帧，然后顿一下"。
// 快照每 66ms 来一次、抖动让领先量忽大忽小，于是每次都窜一下，正是"一抖一抖"。
//
// 修法：对 me 的校照样样立刻生效（不然会一直走在错的位置），但把同等偏移记进
// 渲染缓冲 `_corr`，由 `_reconcile` 按米/秒化掉；再加上单帧硬贴限速。
//
// 指标（单程 160ms、12 秒、60fps）：
//   抖动 0     修复前 CV 2.4% / 屏偏 2.4px  → 修复后 1.2% / 0.5px
//   抖动 ±30ms 修复前 CV 13.7% / 屏偏 8.7px → 修复后 1.4% / 0.4px
//   抖动 ±50ms 修复前 CV 34.5% / 屏偏 12.4px → 修复后 4.3% / 1.0px
import assert from 'node:assert/strict';
import { CoopMode } from '../src/coop.js';

const TICK_DT = 1 / 30;
const FRAME = 1 / 60;
const SPEED = 15;

let pass = 0;
const ok = (msg) => { pass++; console.log(`  ✓ ${msg}`); };

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function makeCoop() {
  const c = Object.create(CoopMode.prototype);
  c.myId = 'u1';
  c._shift = { x: 0, z: 0 };
  c._corr = { x: 0, z: 0 };
  c._vel = { x: 0, z: 0 };
  c._disp = { x: 0, z: 0, yaw: 0 };
  c._predAcc = 0;
  c._yawVel = 0;
  c._moveDir = Math.PI;
  c._predFrom = { x: 0, z: 0, yaw: 0 };
  c.me = {
    id: 'u1', x: 0, z: 0, yaw: 0, speed: SPEED, speedBase: SPEED,
    alive: true, down: false, turretYaw: 0, turretRate: 0, turretLimit: Math.PI,
  };
  c.tanks = new Map();
  c.world = { speedAt: () => 1, hit: () => null };
  c.net = { lastSnap: null, rtt: 320 };
  return c;
}

/**
 * 匀速直行。快照里的坐标 = "客户端 delay 秒之前的位置"，与真实网络一致；
 * 返回画出来的逐帧位移与视觉偏离。
 */
function run(jitterMs, { delay = 0.16, seed = 7, seconds = 12 } = {}) {
  const c = makeCoop();
  const rnd = rng(seed);
  const steps = [];
  let t = 0;
  let nextSnap = 0.2;
  let prev = 0;

  for (let f = 0; f < Math.round(seconds / FRAME); f++) {
    t += FRAME;
    // 预测：30Hz 定步长
    c._predAcc += FRAME;
    let ticks = 0;
    while (c._predAcc >= TICK_DT) {
      c._predAcc -= TICK_DT;
      ticks++;
      c.me.z += SPEED * TICK_DT;
    }
    if (ticks > 0) { c._vel.x = 0; c._vel.z = SPEED; }

    // 快照：15Hz，到达时间带抖动，内容是「delay 秒前的权威位置」
    if (t >= nextSnap) {
      nextSnap += 1 / 15;
      const j = (rnd() - 0.5) * 2 * (jitterMs / 1000);
      const d = Math.max(TICK_DT, delay + j);
      c.net.lastSnap = { players: [{ id: 'u1', x: 0, z: SPEED * Math.max(0, t - d), yaw: 0 }] };
    }

    c._reconcile(FRAME);
    if (t > 3) steps.push(c._disp.z - prev);
    prev = c._disp.z;
  }

  const ideal = SPEED * FRAME;
  const speeds = steps.map((d) => d / FRAME);
  const m = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const sd = Math.sqrt(speeds.reduce((a, b) => a + (b - m) ** 2, 0) / speeds.length);
  return {
    mean: m,
    cv: sd / m * 100,
    maxDev: Math.max(...steps.map((d) => Math.abs(d - ideal))) * 20,  // 20px/m，和探针口径一致
  };
}

// ---- 1) 不抖时本来就该匀速 ----
{
  const r = run(0);
  assert.ok(Math.abs(r.mean - SPEED) < 0.2, `无抖动时画面速度应≈15m/s，实测 ${r.mean.toFixed(2)}`);
  assert.ok(r.cv < 3, `无抖动时速度变异应 <3%，实测 ${r.cv.toFixed(1)}%`);
  ok(`无抖动：${r.mean.toFixed(2)} m/s，速度变异 ${r.cv.toFixed(1)}%，最大屏偏 ${r.maxDev.toFixed(1)}px`);
}

// ---- 2) 抖动 ±30ms：这是"偶尔抖一下"的档位 ----
{
  const r = run(30);
  assert.ok(r.cv < 4, `±30ms 抖动时速度变异应 <4%，实测 ${r.cv.toFixed(1)}%（修复前 13.7%）`);
  assert.ok(r.maxDev < 3, `±30ms 抖动时最大屏偏应 <3px，实测 ${r.maxDev.toFixed(1)}px（修复前 8.7px）`);
  ok(`抖动 ±30ms：速度变异 ${r.cv.toFixed(1)}%，最大屏偏 ${r.maxDev.toFixed(1)}px`);
}

// ---- 3) 抖动 ±50ms：明显抖动，画面仍必须"看得出在匀速" ----
{
  const r = run(50);
  assert.ok(r.cv < 8, `±50ms 抖动时速度变异应 <8%，实测 ${r.cv.toFixed(1)}%（修复前 34.5%）`);
  assert.ok(r.maxDev < 4, `±50ms 抖动时最大屏偏应 <4px，实测 ${r.maxDev.toFixed(1)}px（修复前 12.4px）`);
  ok(`抖动 ±50ms：速度变异 ${r.cv.toFixed(1)}%，最大屏偏 ${r.maxDev.toFixed(1)}px`);
}

// ---- 4) 服务端位置突然前移 2 米（卡顿恢复 / 漏了一拍）：画面不许跟着窜 ----
{
  const c = makeCoop();
  const steps = [];
  let prev = 0;
  let t = 0;
  for (let f = 0; f < 240; f++) {
    t += FRAME;
    c._predAcc += FRAME;
    let ticks = 0;
    while (c._predAcc >= TICK_DT) { c._predAcc -= TICK_DT; ticks++; c.me.z += SPEED * TICK_DT; }
    if (ticks > 0) { c._vel.x = 0; c._vel.z = SPEED; }
    // f=120 那一帧，权威位置突然比客户端还靠前 2 米
    const srvZ = SPEED * (t - 0.16) + (f >= 120 ? 2 : 0);
    c.net.lastSnap = { players: [{ id: 'u1', x: 0, z: srvZ, yaw: 0 }] };
    c._reconcile(FRAME);
    steps.push(Math.abs(c._disp.z - prev));
    prev = c._disp.z;
  }
  const worst = Math.max(...steps.slice(110));
  assert.ok(worst < SPEED * FRAME * 1.6, `前移 2 米后单帧画面位移应 <${(SPEED * FRAME * 1.6 * 100).toFixed(0)}cm，实测 ${(worst * 100).toFixed(1)}cm`);
  ok(`服务端前移 2 米：单帧画面最大 ${(worst * 100).toFixed(1)}cm（不窜）`);
}

console.log(`快照抖动回归测试全部通过（${pass} 项）`);
