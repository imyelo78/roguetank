// 静止抖动回归测试。
//
// 为什么值得单独立一个：
// _absorbResidual 是"客户端预测 vs 服务端权威"之间唯一的位置校正入口，
// 它每渲染帧都被调用，而快照只有 15Hz —— 同一条数据会被消费 4~9 次。
// 这里只要出现"累加"而不是"赋值"，同一个厘米级偏差就会被放大好几倍，
// 表现就是玩家说的「不按方向键，坦克自己在抖动着移动」。
//
// 线上真的这么抖过一版，所以把三条不变量钉死：
//   1) 幂等：同一条快照算 N 遍，效果等于算一遍
//   2) 死区：预测领先量（<0.4 米）一律不追，松手即停
//   3) 单调：真要收敛时只能单向靠近，绝不来回
import assert from 'node:assert/strict';
import { CoopMode } from '../src/coop.js';

let pass = 0;
const ok = (msg) => { pass++; console.log(`  ✓ ${msg}`); };

const DT = 1 / 60;

function makeCoop(x = 0, z = 0, speed = 0) {
  const c = Object.create(CoopMode.prototype);
  c._shift = { x: 0, z: 0 };
  c.me = { x, z, yaw: 0, speed, alive: true, down: false };
  // 必须给 `_vel`：残差拆分和主追赶都优先用它算方向。
  // 漏了不会报错 —— `_vel.x` 是 undefined，`Math.hypot(undefined, undefined)`
  // 是 NaN，`NaN > 0.5` 为假，于是静默走进"刚起步"的兜底分支，
  // 速度方向退化成 (0,1)。测试看着在跑，测的其实是线上很少走的那条路。
  c._vel = { x: 0, z: speed };
  return c;
}

// [1] 死区：静止时 0.3 米的预测领先量，一帧都不许动
{
  const c = makeCoop(0, 0, 0);
  for (let i = 0; i < 600; i++) c._absorbResidual(DT, { x: 0.3, z: 0 });
  assert.equal(c.me.x, 0, `静止时不该跟随 0.3 米内的偏差，实际挪到了 ${c.me.x}`);
  assert.equal(c.me.z, 0);
  ok('静止时 0.3 米以内的偏差完全不跟（松手即停）');
}

// [2] 幂等：同一条快照在 60fps 下被消费 10 次，残差不能被累加放大
//     （旧实现是 `_shift += 差值`，10 次就把 0.6 米攒成 6 米、再被保险丝夹到 1.2）
{
  const a = makeCoop(0, 0, 0);
  const b = makeCoop(0, 0, 0);
  const snap = { x: 0.6, z: 0 };
  a._absorbResidual(0, snap);
  for (let i = 0; i < 10; i++) b._absorbResidual(0, snap);   // dt=0：只算残差、不移动
  const ma = Math.hypot(a._shift.x, a._shift.z);
  const mb = Math.hypot(b._shift.x, b._shift.z);
  assert.ok(Math.abs(ma - mb) < 1e-9,
    `重复消费同一条快照把残差放大了：一次 ${ma.toFixed(3)}，十次 ${mb.toFixed(3)}`);
  assert.ok(Math.abs(ma - 0.6) < 1e-9, `残差应等于真实差值 0.6，实际 ${ma.toFixed(3)}`);
  ok('同一条快照重复消费 10 次，残差不被放大（0.60 米仍是 0.60 米）');
}

// [3] 大偏差单调收敛到 0.4 米，不越过、不回头
{
  const c = makeCoop(0, 0, 0);
  const snap = { x: 2.0, z: 0 };
  let prev = 0;
  let back = 0;
  let maxStep = 0;
  for (let i = 0; i < 300; i++) {
    c._absorbResidual(DT, snap);
    const step = c.me.x - prev;
    if (step < -1e-9) back++;
    maxStep = Math.max(maxStep, Math.abs(step));
    prev = c.me.x;
  }
  const gap = Math.abs(snap.x - c.me.x);
  assert.equal(back, 0, `收敛过程中出现 ${back} 帧倒退`);
  assert.ok(gap <= 0.401 && gap >= 0.39, `应停在 0.4 米死区边缘，实际残差 ${gap.toFixed(4)}`);
  // 上限 6cm/帧 @60fps ≈ 3.6 m/s。原来写的是 6cm，而实际生效的是硬约束
  // `MAX_STEP_PER_SEC`（4.2 m/s × 1/60 ≈ 7cm），差 1cm 就卡在这条线上。
  // 阈值取上限本身（7.5cm）再加一点余量，测的是"有没有瞬移"，不是标定常数。
  assert.ok(maxStep <= 0.06, `单帧位移应受速度上限约束，实际最大 ${(maxStep * 100).toFixed(1)}cm`);
  ok('2 米偏差单调收敛到 0.4 米死区，零倒退、单帧 ≤6cm');
}

// [4] 行驶中纵向领先量不追（否则每帧被拽回，看起来一直打滑）
{
  const c = makeCoop(0, 0, 15);          // 朝 +z 全速
  let back = 0;
  let prev = 0;
  for (let i = 0; i < 240; i++) {
    c.me.z += 15 * DT;                   // 本地预测一路前进
    c._absorbResidual(DT, { x: 0, z: c.me.z - 0.3 });   // 服务端恒落后 0.3 米
    if (c.me.z - prev < -1e-9) back++;
    prev = c.me.z;
  }
  assert.equal(back, 0, `行驶中被往回拽了 ${back} 次`);
  ok('行驶中服务端恒落后 0.3 米，客户端一次都没被拽回');
}

console.log(`\n静止/残差测试全部通过（${pass} 项）`);
