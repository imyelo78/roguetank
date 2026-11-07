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

// 坡度对速度的影响。地形高度场与客户端渲染、服务端模拟共用同一份实现，
// 所以这里直接 import，不另写一套公式。
import { slopeFactor } from './terrain.js';

/** 归一化到 [-1,1]，非数字一律当 0 */
export const clampDir = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
};

/**
 * 车体半径：碰撞判定用的外接圆。
 *
 * 单机各车型是 1.32~1.62，联机统一 1.9（四人同场时留一点安全间距）。
 * 注意这个值只影响"能不能挤过去"，不影响操作手感。
 */
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
  //
  // 地形：只有"目标速度"乘坡度系数，位移仍是一步到位。
  // 不能让位移本身依赖坡度积分——两端浮点差会随帧累积成可见漂移。
  // col.terrainScale 为 0（旧地图 / 没开地形的房间）时完全走原路径。
  const baseSpeed = body.speedBase || 15;
  const ts = col?.terrainScale || 0;
  body.speed = ts > 0
    ? baseSpeed * slopeFactor(body.x, body.z, ux, uz, ts)
    : baseSpeed;

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
  const clampX = (v) => Math.max(-half + r, Math.min(half - r, v));
  const clampZ = (v) => Math.max(-half + r, Math.min(half - r, v));

  // 优先走新接口（真实圆判定 + 切向滑行）。空场景里的 mock col 只有 blocked，
  // 保留旧分支只是为了单测方便，线上两端都实现了 hit。
  if (typeof col.hit === "function") {
    // 已经嵌在箱子里（单位挤推 / 出生偏移 / 网络校正）→ 先推出来。
    // 不修这个，下面每个方向都会被判成撞墙，车就彻底卡死了。
    const stuck = col.hit(body.x, body.z, r);
    if (stuck) {
      body.x = clampX(body.x + stuck.nx * (stuck.depth + 1e-3));
      body.z = clampZ(body.z + stuck.nz * (stuck.depth + 1e-3));
    }

    // 先钳边界、再判箱体：贴边不该算撞墙
    const nx = clampX(body.x + stepX);
    const nz = clampZ(body.z + stepZ);

    const h = col.hit(nx, nz, r);
    if (!h) {
      body.x = nx;
      body.z = nz;
      return;
    }

    // 斜着顶墙：把位移里指向墙内的分量减掉，只保留切向 → 沿墙滑行。
    // 分轴判定（先试 x 再试 z）在 45° 顶住建筑拐角时两个轴同时被拒，
    // 车一格都动不了，这就是"贴着楼边走会被黏住"的来源。
    const vx = nx - body.x;
    const vz = nz - body.z;
    const dot = vx * h.nx + vz * h.nz;
    const tx = vx - h.nx * dot;
    const tz = vz - h.nz * dot;

    if (tx * tx + tz * tz > 1e-8) {
      const sx = clampX(body.x + tx);
      const sz = clampZ(body.z + tz);
      const h2 = col.hit(sx, sz, r);
      if (!h2) {
        body.x = sx;
        body.z = sz;
        return;
      }
      // 沿建筑拐角的圆弧滑行时，切向位移会让圆和角点"刚好相切"甚至压进去
      // 几毫米，纯判定会把它当成撞墙而钉死。这里只允许把这种浅重叠推出去，
      // 深了（>0.25 米，说明是另一个面）就直接停，避免被推出一个身位。
      if (h2.depth < 0.25) {
        body.x = clampX(sx + h2.nx * (h2.depth + 1e-4));
        body.z = clampZ(sz + h2.nz * (h2.depth + 1e-4));
      }
    }
    return;
  }

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
