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

/** 撞墙后速度保留比例：只乘一次，不能两轴各乘一次（0.09 会把车钉死在原地） */
const WALL_KEEP = 0.9;

/** 速度趋近目标值的快慢（每秒） */
const ACCEL = 8;

/**
 * 走一步车体运动。
 *
 * @param {object} body  { x, z, yaw, speed, speedBase, turnBase }
 * @param {object} input { forward, turn }
 * @param {number} dt
 * @param {object} col   碰撞源：{ blocked(x, z, r) => boolean }，可省略（只算位移）
 * @param {number} half  地图半边长（贴边钳制用）
 */
export function stepBody(body, input, dt, col, half) {
  const turn = clampDir(input?.turn);
  if (turn !== 0) body.yaw += turn * (body.turnBase || 3.0) * dt;

  const throttle = clampDir(input?.forward);
  const target = (body.speedBase || 15) * throttle;
  body.speed += (target - body.speed) * Math.min(1, dt * ACCEL);

  if (Math.abs(body.speed) <= 0.05) return;

  const stepX = dirX(body.yaw) * body.speed * dt;
  const stepZ = dirZ(body.yaw) * body.speed * dt;

  if (!col) {
    // 没有碰撞源：纯运动（单测 / 无墙场景）
    body.x += stepX;
    body.z += stepZ;
    return;
  }

  const r = BODY_RADIUS;
  // 先钳边界、再判箱体：贴边不该算撞墙，否则车会一直"顶着"边线掉速
  const nx = Math.max(-half + r, Math.min(half - r, body.x + stepX));
  const nz = Math.max(-half + r, Math.min(half - r, body.z + stepZ));

  // 轴向分离：贴墙时还能沿墙滑行
  let hit = false;
  if (!col.blocked(nx, body.z, r)) body.x = nx; else hit = true;
  if (!col.blocked(body.x, nz, r)) body.z = nz; else hit = true;
  if (hit) body.speed *= WALL_KEEP;
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
