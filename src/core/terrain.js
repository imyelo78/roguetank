// 地形高度场：起伏地形的唯一真源
//
// 为什么单独抽一个文件，而不是直接在 level.js 里位移顶点：
//   客户端要用它把车贴到地面、服务端要用它算坡度对速度的影响。
//   两边只要有一点点不一致，就会出现"我这边在上坡被减速、服务端说你在平地"
//   —— 然后预测被反复校正，手感回到"拖拽"。
//   这和 levelgen.js（地图箱子）、collide.js（圆-矩形判定）是同一个教训。
//
// 三条硬约束：
//   1. 纯函数，不许有 Math.random / Date.now / 任何全局状态
//   2. 高度连续（C1），不出现台阶或尖角
//   3. scale = 0 时恒等于 0 —— 旧地图完全不受影响，这是回归保护线
//
// 为什么不用正弦叠加：
//   试过四组正弦，起伏是有的，但整张图像规则排布的鸡蛋托盘，
//   一格一格肉眼可辨。地形要拿来当关卡设计工具（山谷、隘口、高地），
//   规律感会直接毁掉"这是块地形"的错觉。所以换成 value noise 分形。
//
// 坐标约定：x、z 为世界坐标（米），高度 h 为米。yaw = 0 朝 +z。

/**
 * 地形强度。
 *
 * 0    = 全平（现有关卡、旧包、所有没开地形的房间）
 * 0.45 = 缓坡，新手关
 * 1    = 标准起伏
 * 1.5  = 山地关
 *
 * 由关卡配置决定，服务端在 WELCOME 里下发给客户端，不靠 URL 参数，
 * 否则四人房里有人开有人没开，直接漂移。
 */
export const TERRAIN_SCALE = {
  flat: 0,
  gentle: 0.45,
  standard: 1,
  rugged: 1.5,
};

// ---------------- 确定性噪声 ----------------
//
// 用坐标哈希做 value noise，不预生成随机表：
// 表一旦有内存状态，服务端多房间并发就会串（A 房改了表，B 房的地形跟着变）。
// 哈希全部走 32 位整数运算，跨平台（浏览器 / Node）结果完全一致。

function hash2(ix, iz) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296; // [0,1)
}

const smoothstep = (t) => t * t * (3 - 2 * t);

/** 二维 value noise，返回 [0,1] */
function noise2(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = smoothstep(fx);
  const v = smoothstep(fz);

  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);

  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

/** 基础频率：波长约 85 米，正好是"一个山谷到下一个山头"的尺度 */
const BASE_FREQ = 0.0118;
/** 八度数：4 个足够（第 5 个只增加噪点，玩家看不出来，却要多算 25%） */
const OCTAVES = 4;
/**
 * 主起伏振幅（米，scale=1 时）。
 * 15 这个数是扫参扫出来的：分形噪声的方差远小于单层噪声，
 * 想让标准档落在 ±5 米 / 最陡 20°，振幅要给到 15 而不是 6。
 */
const AMP = 15;
/** 超低频"大势"振幅：让整张地图一侧高、一侧低 */
const BIG_AMP = 5.4;
const BIG_FREQ = 0.0072;

/**
 * 某点地面高度（米）。
 * @param {number} x
 * @param {number} z
 * @param {number} scale 0 表示全平
 */
export function heightAt(x, z, scale = 0) {
  if (!scale) return 0;

  // 分形叠加：每层频率 ×2.07（非整数，避免各层峰谷对齐成网格）、振幅 ×0.5
  let amp = 1;
  let freq = BASE_FREQ;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < OCTAVES; o++) {
    sum += amp * noise2(x * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  const n = sum / norm; // [0,1]，均值约 0.5

  // 大势：一个斜向的超低频，让地图有"从一侧向另一侧缓降"的整体倾斜
  const big = Math.sin((x + z * 0.7) * BIG_FREQ + 2.1);

  return scale * (AMP * (n - 0.5) + BIG_AMP * big * 0.5);
}

/**
 * 梯度（中心差分）。
 *
 * 噪声没有闭式导数，用差分。步长 0.35 米是折中：
 * 再小会被 value noise 的格点结构放大噪声，再大会把陡坡削平。
 * 两端调的是同一个函数、同一个步长，所以结果完全一致。
 */
export function gradientAt(x, z, scale = 0) {
  if (!scale) return { gx: 0, gz: 0 };
  const e = 0.35;
  return {
    gx: (heightAt(x + e, z, scale) - heightAt(x - e, z, scale)) / (2 * e),
    gz: (heightAt(x, z + e, scale) - heightAt(x, z - e, scale)) / (2 * e),
  };
}

/** 坡度对速度的衰减上限 */
export const SLOPE_MAX_SLOW = 0.35; // 最陡上坡掉 35%
export const SLOPE_MAX_FAST = 0.45; // 最陡下坡快 45%

/**
 * 沿行进方向的速度系数。
 *
 * 只作用于"目标速度"，不改积分方式 —— 这是刻意的：
 * 一旦让位移本身依赖坡度积分，客户端预测和服务端权威的微小浮点差异
 * 会随帧数累积，几秒后就是肉眼可见的漂移。改目标速度则每帧都会重新对齐。
 *
 * @param {number} x
 * @param {number} z
 * @param {number} ux 归一化方向 x
 * @param {number} uz 归一化方向 z
 * @param {number} scale
 * @returns {number} 乘到基础速度上的系数，1 表示不变
 */
export function slopeFactor(x, z, ux, uz, scale = 0) {
  if (!scale) return 1;
  const { gx, gz } = gradientAt(x, z, scale);
  const slope = gx * ux + gz * uz; // >0 上坡，<0 下坡
  if (slope > 0) return 1 - Math.min(SLOPE_MAX_SLOW, slope * 0.9);
  return 1 + Math.min(SLOPE_MAX_FAST, -slope * 1.1);
}

/**
 * 高地加成：站在高处看远处，视野更远、打得更准。
 * 用一个平滑的归一化高度，避免"差 1 厘米就换档"的跳变。
 */
export function highGroundBonus(x, z, scale = 0) {
  if (!scale) return 0;
  const h = heightAt(x, z, scale);
  // 标准强度下大约 ±5 米映射到 0..1
  return Math.max(0, Math.min(1, (h + 2.5) / 8));
}

/**
 * 地图尺寸扫描：给关卡工具用，找出最高点/最低点/最大坡度。
 * 只在开发期和测试里调，不进每帧循环。
 */
export function scanTerrain(half, scale, step = 2) {
  let maxH = -Infinity;
  let minH = Infinity;
  let maxSlope = 0;
  let at = { x: 0, z: 0 };
  for (let x = -half; x <= half; x += step) {
    for (let z = -half; z <= half; z += step) {
      const h = heightAt(x, z, scale);
      if (h > maxH) { maxH = h; at = { x, z }; }
      if (h < minH) minH = h;
      const g = gradientAt(x, z, scale);
      const s = Math.hypot(g.gx, g.gz);
      if (s > maxSlope) maxSlope = s;
    }
  }
  return {
    maxH, minH, maxSlope,
    maxSlopeDeg: (Math.atan(maxSlope) * 180) / Math.PI,
    highestAt: at,
  };
}
