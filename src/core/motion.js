// 车体运动学：转向 / 加速 / 撞墙滑行
//
// 为什么单独抽一个文件：
// 服务端 _updatePlayers 和客户端预测（net.js 的 predict + coop.js 的碰撞段）
// 一旦有一行不一致，表现就是"我这边动不了但服务端在动"，然后被 _reconcile
// 硬拽回去，手感像拖拽。线上已经因为"两端各写一套"出过两次事故（假墙、速度死锁）。
// 所以这里只提供一份实现，两边都调它。

/** 前进方向：yaw=0 朝 +z，与 three.js 的 rotation.y 一致 */
export const dirX = (yaw) => Math.sin(yaw);
export const dirZ = (yaw) => Math.cos(yaw);

/** 归一化到 [-1,1]，非数字一律当 0 */
export const clampDir = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
};

/** 车体半径：碰撞判定用的外接圆 */
export const BODY_RADIUS = 1.9;

/**
 * 车体追移动方向的角速度（rad/s）。
 *
 * 必须与单机 src/Tank.js 的 `turnTo(..., dt * 8)` 保持一致：
 * 单机是"八方向平移 + 车头平滑跟上"，联机如果换成坦克式（A/D 原地转），
 * 同一个玩家进房后手感会突然变成另一种车——这是线上真实投诉。
 */
export const TURN_TO_RATE = 8;

/**
 * 走一步车体运动。
 *
 * 模型与单机完全一致（见 Game.js `_updatePlayer` + Tank.move）：
 *   - 输入是世界坐标的八方向单位向量（mx, mz），不是"油门 + 方向盘"
 *   - 按下即全速、松开即停，没有加减速斜坡
 *   - 车体朝向以 8 rad/s 平滑追随移动方向（履带车掉头要时间，但位移不等人）
 *   - 撞墙只做轴向分离（贴墙滑行），不衰减速度
 *
 * @param {object} body  { x, z, yaw, speed, speedBase }
 * @param {object} input { mx, mz }
 * @param {number} dt
 * @param {object} col   碰撞源：{ blocked(x, z, r) => boolean }，可省略（只算位移）
 * @param {number} half  地图半边长（贴边钳制用）
 */
export function stepBody(body, input, dt, col, half) {
  const mx = clampDir(input?.mx);
  const mz = clampDir(input?.mz);
  const len = Math.hypot(mx, mz);

  if (len < 0.001) {
    body.speed = 0;
    return;
  }

  const ux = mx / len;
  const uz = mz / len;

  // 恒速：不插值、不趋近。原来用 dt*8 的速度斜坡，松键后还会滑 0.2~0.3 秒，
  // 叠加网络延迟与预测校正，体感就是"按了没反应、松了还在动"。
  body.speed = body.speedBase || 15;

  // 车头追移动方向。位移是立即生效的，所以方向感不受转速影响。
  const want = Math.atan2(ux, uz);
  const diff = angleDiff(want, body.yaw);
  const maxStep = TURN_TO_RATE * dt;
  if (Math.abs(diff) <= maxStep) body.yaw = want;
  else body.yaw += Math.sign(diff) * maxStep;

  const stepX = ux * body.speed * dt;
  const stepZ = uz * body.speed * dt;

  if (!col) {
    // 没有碰撞源：纯运动（单测 / 无墙场景）
    body.x += stepX;
    body.z += stepZ;
    return;
  }

  const r = BODY_RADIUS;
  // 先钳边界、再判箱体：贴边不该算撞墙
  const nx = Math.max(-half + r, Math.min(half - r, body.x + stepX));
  const nz = Math.max(-half + r, Math.min(half - r, body.z + stepZ));

  // 轴向分离：正面顶墙时还能沿墙滑行，不会两个轴一起被判定为"撞"
  if (!col.blocked(nx, body.z, r)) body.x = nx;
  if (!col.blocked(body.x, nz, r)) body.z = nz;
}

/** 炮塔朝世界坐标转（有限转速，避免瞬狙） */
export function aimTurret(body, aimX, aimZ, dt, radPerSec = 10) {
  if (aimX === undefined || aimZ === undefined) return;
  const want = Math.atan2(aimX - body.x, aimZ - body.z);
  let diff = want - body.turretYaw;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  const maxStep = radPerSec * dt;
  body.turretYaw += Math.sign(diff) * Math.min(Math.abs(diff), maxStep);
}

/** 角度插值（走最短弧） */
export function lerpAngle(a, b, t) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * t;
}

/** 角度差归一化到 [-PI, PI] */
export function angleDiff(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}
