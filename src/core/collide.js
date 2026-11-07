// 圆 vs 轴对齐矩形：碰撞判定的唯一真源。
//
// 为什么单独抽出来：
// 原来两端（服务端 world.static / 客户端 level / 地图生成 blockedAt）都用
// "把圆当方块"的判定：
//     |x-bx| < w/2 + r && |z-bz| < d/2 + r
// 这个式子把半径 r 直接加到矩形两边上，等价于一个边角是直角的方形碰撞体。
// 坦克在建筑正面顶墙时两者没差别，但**贴着建筑拐角**时，方形的角比真实圆弧
// 多出 r*(√2-1) ≈ 0.79 米（r=1.9）。玩家的感受就是"沿着楼边开过去，
// 莫名其妙被墙吸住，得倒一把才能走"——这就是"建筑卡坦克"。
//
// 现在统一用真实圆-矩形距离（角上是四分之一圆弧），并且提供
// `slideCircle` / `pushOut`：撞墙走切向滑行，已经嵌进墙里也能自己出来。
// 三处调用方（world.static、level、levelgen）都从这里走，不会再分叉。

/** 圆 (x,z,r) 与矩形 (bx,bz,半宽,半深) 的重叠信息；不重叠返回 null */
export function boxHit(x, z, r, bx, bz, hw, hd) {
  // 矩形上离圆心最近的点
  const px = x < bx - hw ? bx - hw : x > bx + hw ? bx + hw : x;
  const pz = z < bz - hd ? bz - hd : z > bz + hd ? bz + hd : z;
  const dx = x - px;
  const dz = z - pz;
  const d2 = dx * dx + dz * dz;

  if (d2 >= r * r) return null;

  if (d2 > 1e-12) {
    // 圆心在矩形外：法线就是最近点→圆心方向（角上是 45° 斜法线，正是圆弧该有的行为）
    const d = Math.sqrt(d2);
    return { nx: dx / d, nz: dz / d, depth: r - d };
  }

  // 圆心已经落在矩形内部：沿最浅的一条边推出去
  const ox = hw + r - Math.abs(x - bx);
  const oz = hd + r - Math.abs(z - bz);
  if (ox <= oz) return { nx: Math.sign(x - bx) || 1, nz: 0, depth: ox };
  return { nx: 0, nz: Math.sign(z - bz) || 1, depth: oz };
}

/**
 * 与所有箱体比较，返回穿透最深的那一个。
 * @param {Array<[number,number,number,number]>} boxes [x, z, w, d]
 */
export function deepestHit(boxes, x, z, r) {
  let best = null;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const h = boxHit(x, z, r, b[0], b[1], b[2] * 0.5, b[3] * 0.5);
    if (h && (!best || h.depth > best.depth)) best = h;
  }
  return best;
}

/** 是否与任意箱体重叠 */
export function hitsAny(boxes, x, z, r) {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (boxHit(x, z, r, b[0], b[1], b[2] * 0.5, b[3] * 0.5)) return true;
  }
  return false;
}

/**
 * 已经嵌在墙里时把圆推出来。
 * 不修这个，坦克一旦因为单位挤推 / 出生点偏移 / 网络校正陷进箱子，
 * 之后每个方向都被判定撞墙，车就彻底死在原地——这是"卡住出不来"的直接原因。
 */
export function pushOut(boxes, x, z, r, rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    const h = deepestHit(boxes, x, z, r);
    if (!h) break;
    x += h.nx * (h.depth + 1e-3);
    z += h.nz * (h.depth + 1e-3);
  }
  return { x, z };
}

/**
 * 走一步并处理碰撞：正面顶墙停住，斜着顶墙沿墙滑行。
 *
 * 和"分轴判定"（先试 x 再试 z）的区别：分轴判定在 45° 顶住建筑拐角时，
 * 两个轴会同时被拒，车一动不动；这里是把位移里指向墙内的分量减掉，
 * 只保留切向，所以贴着墙永远能滑，不会黏住。
 */
export function slideCircle(boxes, x, z, dx, dz, r) {
  const nx = x + dx;
  const nz = z + dz;
  const h = deepestHit(boxes, nx, nz, r);
  if (!h) return { x: nx, z: nz, hit: false };

  // 去掉速度中指向墙内的分量（法线朝外，朝内时点积为负）
  const dot = dx * h.nx + dz * h.nz;
  const tx = dx - h.nx * dot;
  const tz = dz - h.nz * dot;
  const sx = x + tx;
  const sz = z + tz;

  if (tx * tx + tz * tz > 1e-8) {
    const h2 = deepestHit(boxes, sx, sz, r);
    if (!h2) return { x: sx, z: sz, hit: true };

    // 贴着建筑拐角滑行时，切线走的是弦：从圆上一点沿切线走一步，
    // 中点必然压进圆弧几毫米。纯判定会当成"撞墙"把车钉在角上。
    // 只容忍这种浅重叠（<5 厘米），推回表面继续滑。
    if (h2.depth < 0.05) {
      return {
        x: sx + h2.nx * (h2.depth + 1e-4),
        z: sz + h2.nz * (h2.depth + 1e-4),
        hit: true,
      };
    }
  }
  return { x, z, hit: true };
}
