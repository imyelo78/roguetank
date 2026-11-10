// 相机跟随：唯一实现
//
// 单机（Game._updateCamera）和组队（CoopMode._updateCamera）共用这一份。
// 以前两边各写一套：单机是纯低通，组队也是纯低通，只是系数不同，
// 于是"车动起来画面一顿一顿地晃"在两个模式里都成立——组队里还因为
// 车体位置本身是插值出来的，滞后量每帧变一次，晃得更明显。
//
// ----------------------------------------------------------------------
// 为什么纯低通一定会晃
// ----------------------------------------------------------------------
// `cam += (tank + back - cam) * k` 是比例控制。匀速行驶时它有一个
// 无法消除的稳态误差：
//
//     滞后 = 速度 / k
//
//   k = 7.5 → 15 m/s 时相机比车落后 2 米。车是屏幕中心，画面永远
//   "超前两米"，玩家不会察觉；但**这个两米不是常数**：
//
//   · 踩上公路（1.12×）：滞后变成 2.24 米
//   · 进沼泽（0.55×）：缩到 1.1 米
//   · 撞墙急停：缩到 0
//
//   每一次变化，整屏都跟着推拉一次。再加上视线目标（camLook）也是低通，
//   而相机跑在前、目标落在后，两者差着同一个两米 → 俯角在
//   35.1°~39.7° 之间摆，读起来就是"画面一顿一顿地晃"（不是抖，是晃）。
//
// ----------------------------------------------------------------------
// 这套算法怎么做到不晃
// ----------------------------------------------------------------------
//   1) 位移**前馈**：每帧先把相机按车体速度推同样一段，稳态误差直接归零。
//      车和画面严格同步，变速时也不会留下"要追的差值"。
//   2) 位置**纠偏**：剩下的只有预测误差（撞墙、传送、残差消化），
//      用一阶趋近收掉。它只在真出错时工作，平时恒等于 0。
//   3) 纠偏增量**速率限幅**：瞬移时相机是匀滑过去的，不是抽一下。
//      前馈本身不限幅（那是真实运动），限幅只管纠偏量。
//   4) 视线目标 = 车体位置本身，不做低通。俯角由 back/height 两个常量决定，
//      因此**恒定**。
//
// 本文件不 import three.js，纯数字运算，浏览器和 Node 测试跑同一份代码。

/** 默认相机参数（数值来自原单机 CAM_HEIGHT / CAM_BACK） */
export const FOLLOW_DEFAULTS = {
  back: 31,            // 相机在车体后方的距离（+z 方向）
  height: 26,          // 相机离地高度
  stiffness: 12,       // 位置纠偏的速度（1/s，越大追得越快）
  maxStepPerSec: 60,   // 纠偏位移的速度上限（米/秒）：够快追上传送，又不会抽帧
};

/** 参数归一化：缺省值填充 + 非数字兜底。返回一个新的普通对象。 */
export function validateFollow(opts = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    back: num(opts.back, FOLLOW_DEFAULTS.back),
    height: num(opts.height, FOLLOW_DEFAULTS.height),
    stiffness: num(opts.stiffness, FOLLOW_DEFAULTS.stiffness),
    maxStepPerSec: num(opts.maxStepPerSec, FOLLOW_DEFAULTS.maxStepPerSec),
  };
}

/**
 * 走一帧相机跟随。
 *
 * @param {{x:number,z:number}} cam   当前相机位置（世界坐标，y 由 height 决定）
 * @param {{x:number,z:number}} tank  车体位置（画出来的位置，含插值）
 * @param {{x:number,z:number}} vel   车体本帧速度（米/秒，世界坐标）
 * @param {number} speed              速度的标量（用了判断"是否在动"）
 * @param {number} dt                 帧间隔（秒）
 * @param {object} [opts]             见 FOLLOW_DEFAULTS
 * @returns {{x:number,z:number,lookX:number,lookZ:number,y:number}}
 *          直接可用的相机状态；lookX/lookZ 是不带任何滞后的视线目标。
 */
export function followStep(cam, tank, vel, speed, dt, opts = FOLLOW_DEFAULTS) {
  const o = opts && opts.back ? opts : validateFollow(opts);
  const dtc = Math.min(Math.max(Number(dt) || 0, 0), 0.05);

  const tx = Number(tank?.x);
  const tz = Number(tank?.z);
  if (!Number.isFinite(tx) || !Number.isFinite(tz)) {
    // 坐标坏了：原样返回，绝不让一个 NaN 传染给相机（以前整屏会直接黑掉）
    return { x: cam.x, z: cam.z, y: o.height, lookX: cam.x, lookZ: cam.z - 10 };
  }

  const vx = Number.isFinite(Number(vel?.x)) ? Number(vel.x) : 0;
  const vz = Number.isFinite(Number(vel?.z)) ? Number(vel.z) : 0;
  const sp = Number.isFinite(Number(speed)) ? Math.max(0, Number(speed)) : Math.hypot(vx, vz);

  // 目标位置：车体正后方固定距离
  const goalX = tx;
  const goalZ = tz + o.back;

  // ---- 1) 前馈 ----
  // 只在"这一帧车真的走了"的时候推。速度会随地形变（0.55×~1.12×），
  // 但前馈用的是实测速度，所以推的距离与车走的距离一致，不留差值。
  const moving = sp > 0.01 || Math.hypot(vx, vz) > 0.01;
  let nextX = Number.isFinite(cam.x) ? cam.x : goalX;
  let nextZ = Number.isFinite(cam.z) ? cam.z : goalZ;
  if (moving) {
    nextX += vx * dtc;
    nextZ += vz * dtc;
  }

  // ---- 2) 位置纠偏（只处理真正剩下的误差）----
  const ex = goalX - nextX;
  const ez = goalZ - nextZ;
  const err = Math.hypot(ex, ez);
  if (err > 1e-9) {
    const k = 1 - Math.exp(-o.stiffness * dtc);
    let cx = ex * k;
    let cz = ez * k;
    // ---- 3) 纠偏增量速率限幅 ----
    const cap = o.maxStepPerSec * dtc;
    const cm = Math.hypot(cx, cz);
    if (cm > cap && cm > 0) {
      cx = (cx / cm) * cap;
      cz = (cz / cm) * cap;
    }
    nextX += cx;
    nextZ += cz;
  }

  return {
    x: nextX,
    z: nextZ,
    y: o.height,
    // ---- 4) 视线目标：钉在车体上，没有低通 ----
    // 车体稍有抖动会直接传给视线吗？会——但这正是我们要的：
    // 车体位置（_disp）本身已经是平滑的插值结果，再给视线加一层低通，
    // 只会让相机（无滞后）和视线（有滞后）之间多出一个随速度变化的夹角。
    lookX: tx,
    lookZ: tz,
  };
}
