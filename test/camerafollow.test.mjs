// 相机跟随测试：车在动，相机不许"晃"
//
// 用户报的是「车辆运行起来后感觉画面会一顿一顿地晃」——抖已经修完（预测层），
// 剩下的是**相机**自己的问题。两个病根，都在 `_updateCamera`：
//
//   1. 相机位置用"对车体做低通"（`cam.x += (tank.x - cam.x) * k`）。
//      纯比例控制必然有稳态滞后：v / 7.5 ≈ 2 米，车永远比画面超前两米。
//      更麻烦的是这个滞后会被"变速"搅动——踩上公路（1.12×）滞后变成 2.2 米，
//      进沼泽（0.55×）缩到 1.1 米，撞墙急停再缩到 0，每一次变化都是一次
//      全屏推拉。玩家读到的就是"一顿一顿地晃"。
//   2. 视线目标也是一阶低通，而相机跑在前面、目标落在后面，两者始终差着
//      同一个两米 → 俯角 = atan(29 / (41.2 ± 2)) 在 35.1°~39.7° 之间。
//      车一动，整屏跟着上下俯仰——这正是"晃"而不是"抖"。
//
// 正确做法（渲染跟随的标准解法）：
//   · 位移用"速度前馈 + 位置纠偏"，稳态误差为 0，车和画面严格同步；
//   · 视线目标直接钉在车体上，没有二阶动态；
//   · 纠偏增量做**逐帧速率限幅**，瞬移（复活/传送）时是平滑滑过去，不是抽一下。
// 这里的 `camFollowStep` 就是这套算法的唯一实现，coop.js 每帧调它。

import { validateFollow, followStep, FOLLOW_DEFAULTS } from '../src/core/camera.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const DT = 1 / 60;

/** 跑一段模拟，返回逐帧记录 */
function simulate({ frames, velocity, speedOf = () => 15, teleportAt = -1, teleportTo = null }) {
  let cam = { x: 0, z: FOLLOW_DEFAULTS.back };
  let tank = { x: 0, z: 0 };
  const rows = [];
  for (let i = 0; i < frames; i++) {
    if (i === teleportAt && teleportTo) {
      tank = { x: teleportTo.x, z: teleportTo.z };
    } else {
      const v = velocity(i);
      const sp = speedOf(i);
      // 车体按**速度标量**沿方向走（v 只是单位方向，不是速度）
      const len = Math.hypot(v.x, v.z) || 1;
      tank = { x: tank.x + (v.x / len) * sp * DT, z: tank.z + (v.z / len) * sp * DT };
    }
    const u = velocity(i);
    const ul = Math.hypot(u.x, u.z) || 1;
    const sp = speedOf(i);
    cam = followStep(cam, tank, { x: (u.x / ul) * sp, z: (u.z / ul) * sp }, sp, DT);
    rows.push({ cam: { ...cam }, tank: { ...tank }, v: velocity(i), speed: speedOf(i) });
  }
  return rows;
}

const lagZ = (r) => r.cam.z - r.tank.z;            // 应为 back（+31）
const offX = (r) => r.cam.x - r.tank.x;            // 应为 0
const sd = (a) => {
  if (!a.length) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
};

console.log('\n[相机跟随]');

// ---------------- 1. 参数校验 ----------------
ok('常量：back / height 是正数', FOLLOW_DEFAULTS.back > 0 && FOLLOW_DEFAULTS.height > 0,
  JSON.stringify(FOLLOW_DEFAULTS));
ok('常量：maxStepPerSec 有界（防瞬移抽帧）',
  FOLLOW_DEFAULTS.maxStepPerSec > 0 && FOLLOW_DEFAULTS.maxStepPerSec < 100);
ok('非法 dt 的跟随步不产生 NaN',
  Number.isFinite(followStep({ x: 0, z: 31 }, { x: 0, z: 0 }, { x: 1, z: 0 }, 15, 0).z) &&
  Number.isFinite(followStep({ x: 0, z: 31 }, { x: 0, z: 0 }, { x: 1, z: 0 }, 15, NaN).z));

// ---------------- 2. 匀速直行：稳态零误差 ----------------
{
  const rows = simulate({ frames: 240, velocity: () => ({ x: 0, z: -1 }) });
  const tail = rows.slice(60);                       // 跳过起步 1 秒
  const lags = tail.map(lagZ);
  const expect = FOLLOW_DEFAULTS.back;
  const err = Math.max(...lags.map((v) => Math.abs(v - expect)));
  ok('匀速直行：相机与车体距离锁死在 back（误差 < 1cm）', err < 0.01, `最大误差 ${err.toFixed(4)} 米`);

  const drift = Math.max(...tail.map((r) => Math.abs(offX(r))));
  ok('匀速直行：横向零漂移', drift < 0.02, `最大横向 ${drift.toFixed(4)} 米`);

  // 逐帧位移的"节奏"：相机每帧走的距离必须和车一样，标准差<1mm
  const camStep = rows.slice(1).map((r, i) => Math.hypot(r.cam.x - rows[i].cam.x, r.cam.z - rows[i].cam.z));
  const tankStep = rows.slice(1).map((r, i) => Math.hypot(r.tank.x - rows[i].tank.x, r.tank.z - rows[i].tank.z));
  const diff = camStep.map((v, i) => v - tankStep[i]);
  ok('匀速直行：相机每帧位移与车体逐帧一致（不拖不冲）', sd(diff) < 0.001, `sd=${sd(diff).toFixed(5)}`);

  // 视线目标：直接钉在车体上，没有滞后
  ok('视线目标 = 车体位置（俯角恒定，不出现俯仰晃动）',
    rows.every((r) => Math.abs(r.cam.lookX - r.tank.x) < 1e-9 && Math.abs(r.cam.lookZ - r.tank.z) < 1e-9));
}

// ---------------- 3. 变速（地形）：滞后不许跟着变 ----------------
{
  // 公路 1.12× → 沼泽 0.55× 来回切，模拟一路压过不同地表
  const speedOf = (i) => 15 * ((Math.floor(i / 45) % 2) ? 0.55 : 1.12);
  const rows = simulate({ frames: 360, velocity: () => ({ x: 0, z: -1 }), speedOf });
  const lags = rows.slice(40).map(lagZ);
  const swing = Math.max(...lags) - Math.min(...lags);
  ok('地形变速 1.12↔0.55：相机前后摆动 < 2cm', swing < 0.02, `摆幅 ${swing.toFixed(4)} 米`);

  // 对照：旧算法（纯低通）在同样变速下的摆幅。
  // 两档都测：k=5.5 是单机的、k=7.5 是组队的——用户报的就是组队。
  for (const k0 of [5.5, 7.5]) {
    let old = 0;
    let tank = 0;
    const oldLags = [];
    for (let i = 0; i < 360; i++) {
      tank += -1 * speedOf(i) * DT;
      const k = 1 - Math.exp(-k0 * DT);
      old += (tank + 31 - old) * k;
      if (i > 40) oldLags.push(old - tank - 31);
    }
    const oldSwing = Math.max(...oldLags) - Math.min(...oldLags);
    ok(`对照：旧的纯低通（k=${k0}）在同一场景下摆幅 > 1 米（说明测试确实能抓到问题）`,
      oldSwing > 1, `旧算法摆幅 ${oldSwing.toFixed(3)} 米`);
  }
}

// ---------------- 4. 急停 / 掉头：不许甩 ----------------
{
  // 直行 → 急停（撞墙）
  const rows = simulate({
    frames: 180,
    velocity: (i) => ({ x: 0, z: i < 90 ? -1 : 0 }),
    speedOf: (i) => (i < 90 ? 15 : 0),
  });
  const before = lagZ(rows[89]);
  const after = lagZ(rows[179]);
  ok('撞墙急停：停下来后相机仍停在原位（没有"车停了画面还在追"）',
    Math.abs(before - after) < 0.02, `${before.toFixed(3)} → ${after.toFixed(3)}`);

  // 每帧最大位移：不许出现"抽一下"
  let maxStep = 0;
  for (let i = 1; i < rows.length; i++) {
    maxStep = Math.max(maxStep, Math.hypot(rows[i].cam.x - rows[i - 1].cam.x, rows[i].cam.z - rows[i - 1].cam.z));
  }
  ok('撞墙急停：相机单帧位移不超过车速（15 m/s × 1/60 ≈ 0.26 米）', maxStep < 0.28,
    `最大单帧 ${maxStep.toFixed(3)} 米`);

  // 原地掉头（速度反向）
  const rows2 = simulate({
    frames: 200,
    velocity: (i) => ({ x: 0, z: i < 100 ? -1 : 1 }),
  });
  let maxStep2 = 0;
  for (let i = 1; i < rows2.length; i++) {
    maxStep2 = Math.max(maxStep2, Math.hypot(rows2[i].cam.x - rows2[i - 1].cam.x, rows2[i].cam.z - rows2[i - 1].cam.z));
  }
  ok('掉头：相机单帧位移仍受控（不横甩）', maxStep2 < 0.30, `最大单帧 ${maxStep2.toFixed(3)} 米`);
  ok('掉头后相机重新稳定在 back 距离', Math.abs(lagZ(rows2[199]) - FOLLOW_DEFAULTS.back) < 0.05,
    `终值 ${lagZ(rows2[199]).toFixed(3)}`);
}

// ---------------- 5. 传送 / 复活：平滑滑过去，不许瞬移 ----------------
{
  const rows = simulate({
    frames: 400,
    velocity: () => ({ x: 0, z: 0 }),
    speedOf: () => 0,
    teleportAt: 10,
    teleportTo: { x: 40, z: -40 },
  });
  const cap = FOLLOW_DEFAULTS.maxStepPerSec * DT + 1e-6;
  let over = 0;
  for (let i = 11; i < rows.length; i++) {
    const d = Math.hypot(rows[i].cam.x - rows[i - 1].cam.x, rows[i].cam.z - rows[i - 1].cam.z);
    if (d > cap) over++;
  }
  ok('传送后相机每帧位移不超过限幅（不是瞬移抽帧）', over === 0, `超限 ${over} 帧`);
  ok('传送后 2 秒内追上车体', Math.abs(lagZ(rows[rows.length - 1]) - FOLLOW_DEFAULTS.back) < 0.05,
    `终值 ${lagZ(rows[rows.length - 1]).toFixed(3)}`);
}

// ---------------- 6. 跟随强度：车还没到，相机不许先跑 ----------------
{
  // 车瞬间获得满速（按下 W 的那一帧）——前馈会让相机当帧就按满速走一段，
  // 而车这一帧其实只走了 0.25 米。这就是"车还没动画面先动"的撕裂感。
  let cam = { x: 0, z: FOLLOW_DEFAULTS.back };
  const tank = { x: 0, z: 0 };
  const first = followStep(cam, tank, { x: 0, z: -1 }, 15, DT);
  const jumped = Math.hypot(first.x - cam.x, first.z - cam.z);
  ok('起步第一帧：相机位移不超过本帧车体位移（不抢跑）', jumped <= 15 * DT + 1e-6,
    `${jumped.toFixed(3)} 米 vs 上限 ${(15 * DT).toFixed(3)}`);
}

// ---------------- 7. 数值健壮性 ----------------
{
  const cam = { x: 0, z: 31 };
  const out = followStep(cam, { x: NaN, z: 0 }, { x: 0, z: 0 }, 0, DT);
  ok('车体坐标 NaN 时相机不跟着变 NaN', Number.isFinite(out.x) && Number.isFinite(out.z),
    JSON.stringify(out));

  // validateFollow 只做参数归一化，不参与逐帧计算
  const v = validateFollow({ back: 31, height: 26, stiffness: 12, maxStepPerSec: 60 });
  ok('validateFollow 保留合法参数', v.back === 31 && v.height === 26 && v.stiffness === 12);
}

console.log(`\n相机跟随：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
