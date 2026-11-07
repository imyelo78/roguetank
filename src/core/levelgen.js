// 地图生成：唯一真源。
//
// 为什么单独抽出来：客户端要建 mesh、服务端要建碰撞表，两边各写一份生成循环
// 迟早会分叉。线上真实事故就是这么来的——客户端生成随机箱体时多算了一个
// 高度 h 的随机数（视觉需要），服务端没有，于是从第二个随机箱子开始两边
// 的坐标完全错位。表现是"客户端有墙、服务端没有"，玩家一进房就被假墙反复
// 判定碰撞、速度每帧乘 0.3 压到 0.8，看起来就是"油门踩到底车不动"，
// 同时服务端位置正常推进，客户端又被拽回去，手感像在拖拽。
//
// 现在两端都只调用 generateBoxes()，数据不可能再分叉。

export const HALF = 100;

/** 单机出生点（也是相机初始看向的位置） */
export const PLAYER_START = { x: 0, z: 26 };

/** 多人出生点（未缩放）。room.js 里按 0.35 缩到四角与边缘 */
export const SPAWNS = [
  [-82, -82], [82, -82], [-82, 82], [82, 82],
  [0, -88], [-88, 0], [88, 0], [0, 88],
];

/** 出生点周围必须留空的半径：否则玩家一落地就卡在箱子里 */
const SPAWN_CLEAR = 14;

const MAP_SEED = 20261029;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 手工摆放的掩体群。
 * [x, z, w, h, d, color] —— w/d 是碰撞尺寸，h 只影响渲染高度。
 */
const FIXED = [
  [-16, -2, 12, 7, 5, '#8b95a3'],
  [16, -2, 12, 7, 5, '#8b95a3'],
  [0, -20, 6, 8, 6, '#96a1b0'],
  [-34, 24, 8, 5, 8, '#818b99'],
  [34, 24, 8, 5, 8, '#818b99'],
  [0, 44, 18, 3.5, 4, '#8a8a6a'],
  // 外围掩体群（扩大战场后的战术点）
  [-64, -36, 14, 6, 6, '#8b95a3'],
  [64, -36, 14, 6, 6, '#8b95a3'],
  [-70, 52, 10, 4.5, 10, '#818b99'],
  [70, 52, 10, 4.5, 10, '#818b99'],
  [0, -72, 22, 5, 4, '#8a8a6a'],
  [-30, 78, 8, 3.2, 8, '#858f7a'],
  [30, -50, 6, 4, 12, '#929aa6'],
  [-6, 62, 10, 2.8, 8, '#7f8b7c'],
];

const RANDOM_COUNT = 30;
const COLORS = ['#9a8a6c', '#7f9070', '#8e929c', '#a08a70'];

/** 所有需要留空的点（单机出生点 + 8 个多人出生点缩放后） */
const CLEAR_POINTS = [
  [PLAYER_START.x, PLAYER_START.z],
  ...SPAWNS.map(([x, z]) => [x * 0.35, z * 0.35]),
];

/**
 * 生成整张地图的箱体。
 * @returns {{x:number,z:number,w:number,h:number,d:number,color:string}[]}
 */
export function generateBoxes() {
  const boxes = FIXED.map(([x, z, w, h, d, color]) => ({ x, z, w, h, d, color }));

  const rnd = mulberry32(MAP_SEED);
  const placed = [];
  let guard = 0;

  while (placed.length < RANDOM_COUNT && guard++ < 2000) {
    const x = (rnd() * 2 - 1) * (HALF - 12);
    const z = (rnd() * 2 - 1) * (HALF - 12);

    // 出生点留空：不消耗随机数，只跳过这个候选点
    if (CLEAR_POINTS.some(([cx, cz]) => Math.hypot(x - cx, z - cz) < SPAWN_CLEAR)) continue;
    // 中央通路留空
    if (Math.hypot(x, z) < 12) continue;
    // 离已摆放的掩体太近就跳过，避免连成一片堵死通路
    if (boxes.some((b) => Math.hypot(x - b.x, z - b.z) < Math.max(b.w, b.d) / 2 + 9)) continue;
    if (placed.some(([px, pz]) => Math.hypot(x - px, z - pz) < 11)) continue;

    // 注意顺序：w → h → d → color 四个随机数，两端必须一致。
    // 这里留成一整块，改动时不要只改一半。
    const w = 3.5 + rnd() * 4;
    const h = 2.6 + rnd() * 4.5;
    const d = 3.5 + rnd() * 4;
    const color = COLORS[(rnd() * COLORS.length) | 0];

    boxes.push({ x, z, w, h, d, color });
    placed.push([x, z, w, d]);
  }

  return boxes;
}

/**
 * 圆形是否与任一箱体重叠（只判箱体，不含边界）。
 * 与 world.js / level.js 里的 blocked 用同一套算法，避免判定差异。
 */
export function blockedAt(boxes, x, z, r) {
  for (const b of boxes) {
    if (Math.abs(x - b.x) < b.w / 2 + r && Math.abs(z - b.z) < b.d / 2 + r) return true;
  }
  return false;
}

/**
 * 多人出生点（已按 0.35 缩放）。
 *
 * 不能直接用 SPAWNS * 0.35：固定掩体是硬编码的，改布局时很容易正好压住
 * 某个出生点。实测 (-82,82)*0.35 就落在 [-34,24,8,5,8] 这个箱子边缘上，
 * 玩家一落地就被判定撞墙。这里在生成完地图后检查一遍，被压住就沿径向
 * 向外挪（挪动范围不超过留空半径，保证挪过去也是空的）。
 */
export function resolveMultiSpawns(boxes) {
  return SPAWNS.map(([x, z]) => {
    const px = x * 0.35;
    const pz = z * 0.35;
    if (!blockedAt(boxes, px, pz, 1.9)) return [px, pz];

    const len = Math.hypot(px, pz) || 1;
    for (let d = 1; d <= SPAWN_CLEAR - 1; d += 1) {
      const qx = px + (px / len) * d;
      const qz = pz + (pz / len) * d;
      if (Math.abs(qx) > HALF - 4 || Math.abs(qz) > HALF - 4) break;
      if (!blockedAt(boxes, qx, qz, 1.9)) return [qx, qz];
    }
    return [px, pz];
  });
}
