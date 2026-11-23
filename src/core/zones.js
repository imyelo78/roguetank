// 战区表：每 5 波一个战区，一轮 10 个，正好对上 10 个 Boss。
//
// 设计约束（和 bosskit 一样，这里是纯数据，不 import three）：
//   1. 战区 = "这一轮 5 波的地形与掩体风格"，第 5 波就是该战区 Boss 的主场
//   2. 布局要为 Boss 的机制服务，而不是随机撒墙：
//      - 哨戒的旋转光束需要开阔，否则光束被墙挡住、机制直接失效
//      - 铁壁要绕后，所以给巷战布局（多掩体、多转角）
//      - 蜂巢的自爆机从四面来，环形墙把接近方向收成几条通道
//      - 终焉三阶段要打很久，中央必须是大空场，否则召唤物和玩家挤在一起
//   3. 任何布局都不能压住出生点、不能堵死中央通路（单机出生点在 (0,26)，
//      多人出生点是 SPAWNS × 0.35）。新增战区请跑 test/zones.test.mjs。
//
// 与 levelgen 的关系：战区只提供"骨架 + 密度"，坐标扰动和随机建筑仍然
// 由 levelgen.generateBoxes 按种子生成，所以同一个战区每局长得都不一样。

import { T_SAND, T_SNOW, T_SWAMP } from './terrain.js';

export const WAVES_PER_ZONE = 5;

/**
 * 战区种子：在"这一局的地形种子"上混入战区号。
 *
 * 只允许从这里取——服务端的房间种子、客户端的 welcome.terrain.seed、
 * 单机的 seed 异或常数，最后都要换算成同一个基数再调它。
 * 两端各写一次异或常数，就是"你看得见墙、服务端没有"的起点。
 */
export const ZONE_SEED_MIX = 0x51ed270b;

export function zoneSeedFor(baseTerrainSeed, zoneId) {
  return ((baseTerrainSeed >>> 0) ^ Math.imul(zoneId | 0, ZONE_SEED_MIX)) >>> 0;
}

/** 掩体：[x, z, w, h, d, color]。h 只影响渲染高度，碰撞只认 x/z/w/d。 */
const C_WALL = '#8b95a3';
const C_LOW = '#8a8a6a';
const C_DARK = '#818b99';
const C_ROCK = '#858f7a';

// ---- 骨架 ----

/** 标准：现有布局（第一轮保持熟悉感） */
const FIX_STANDARD = [
  [-16, -2, 12, 7, 5, C_WALL],
  [16, -2, 12, 7, 5, C_WALL],
  [0, -20, 6, 8, 6, C_WALL],
  [-34, 24, 8, 5, 8, C_DARK],
  [34, 24, 8, 5, 8, C_DARK],
  [0, 44, 18, 3.5, 4, C_LOW],
  [-64, -36, 14, 6, 6, C_WALL],
  [64, -36, 14, 6, 6, C_WALL],
  [-70, 52, 10, 4.5, 10, C_DARK],
  [70, 52, 10, 4.5, 10, C_DARK],
  [0, -72, 22, 5, 4, C_LOW],
  [-30, 78, 8, 3.2, 8, C_ROCK],
  [30, -50, 6, 4, 12, C_WALL],
  [-6, 62, 10, 2.8, 8, C_ROCK],
];

/** 开阔：只有几块矮掩体散在四周，视线和弹道都不被切碎 */
const FIX_OPEN = [
  [-46, -30, 10, 3, 5, C_LOW],
  [46, -30, 10, 3, 5, C_LOW],
  [-46, 34, 10, 3, 5, C_LOW],
  [46, 34, 10, 3, 5, C_LOW],
  [0, -58, 22, 3.5, 4, C_LOW],
  [0, 58, 22, 3.5, 4, C_LOW],
  [-70, 6, 6, 4, 12, C_DARK],
  [70, 6, 6, 4, 12, C_DARK],
];

/** 干渠：两道纵向长墙把战场切成三条走廊，冲刺/直线弹道被放大 */
const FIX_CORRIDOR = [
  [-18, 0, 6, 5, 118, C_WALL],
  [18, 0, 6, 5, 118, C_WALL],
  [-60, -40, 8, 4, 8, C_DARK],
  [60, -40, 8, 4, 8, C_DARK],
  [-60, 45, 8, 4, 8, C_DARK],
  [60, 45, 8, 4, 8, C_DARK],
  [0, -86, 40, 4, 6, C_LOW],
  [0, 86, 40, 4, 6, C_LOW],
];

/** 废墟：密集小掩体，巷战。绕后与卡视线都成立 */
const FIX_DENSE = [
  [-40, -40, 10, 5, 6, C_WALL],
  [-20, -46, 8, 4, 8, C_DARK],
  [6, -40, 12, 6, 6, C_WALL],
  [30, -48, 8, 4, 10, C_DARK],
  [-52, -12, 8, 5, 10, C_DARK],
  [-26, -14, 10, 4, 6, C_WALL],
  [24, -16, 10, 5, 8, C_WALL],
  [50, -8, 8, 4, 8, C_DARK],
  [-44, 18, 10, 6, 6, C_WALL],
  [-16, 12, 8, 4, 10, C_ROCK],
  [16, 14, 10, 5, 6, C_WALL],
  [44, 20, 8, 4, 8, C_DARK],
  [-34, 52, 12, 4, 6, C_ROCK],
  [0, 46, 10, 3.5, 6, C_ROCK],
  [34, 54, 10, 4, 8, C_ROCK],
];

/** 环形：一圈墙围出中央空地，只留几个口。自爆机只能从口里挤进来 */
const FIX_RING = [
  [-30, 0, 8, 6, 16, C_WALL],
  [30, 0, 8, 6, 16, C_WALL],
  [0, -30, 16, 6, 8, C_WALL],
  [0, 44, 16, 6, 8, C_WALL],
  [-22, -22, 10, 5, 10, C_DARK],
  [22, -22, 10, 5, 10, C_DARK],
  [-22, 24, 10, 5, 10, C_DARK],
  [22, 24, 10, 5, 10, C_DARK],
  [-70, -50, 8, 4, 8, C_ROCK],
  [70, -50, 8, 4, 8, C_ROCK],
  [-70, 58, 8, 4, 8, C_ROCK],
  [70, 58, 8, 4, 8, C_ROCK],
];

/** 孤岛：中央一座大堡垒，四周完全空旷。旋转光束不被任何东西遮挡 */
const FIX_ISLAND = [
  [0, -6, 26, 8, 20, C_WALL],
  [-64, -56, 8, 4, 8, C_DARK],
  [64, -56, 8, 4, 8, C_DARK],
  [-64, 62, 8, 4, 8, C_DARK],
  [64, 62, 8, 4, 8, C_DARK],
  [-80, 0, 6, 4, 14, C_ROCK],
  [80, 0, 6, 4, 14, C_ROCK],
];

/** 镜像：左右严格对称。双生各占一侧时，两边的掩体价值完全对等 */
const FIX_MIRROR = [
  [-34, -20, 12, 6, 6, C_WALL],
  [34, -20, 12, 6, 6, C_WALL],
  [-34, 10, 8, 5, 12, C_DARK],
  [34, 10, 8, 5, 12, C_DARK],
  [-52, 38, 10, 4, 8, C_ROCK],
  [52, 38, 10, 4, 8, C_ROCK],
  [0, -48, 14, 6, 6, C_WALL],
  [-70, -52, 8, 4, 8, C_DARK],
  [70, -52, 8, 4, 8, C_DARK],
];

/** 竞技场：外圈压一圈掩体，中央留出半径 50 米的大空场 */
const FIX_ARENA = [
  [-70, -62, 16, 6, 6, C_WALL],
  [70, -62, 16, 6, 6, C_WALL],
  [-70, 64, 16, 6, 6, C_WALL],
  [70, 64, 16, 6, 6, C_WALL],
  [-88, -8, 6, 4, 16, C_DARK],
  [88, -8, 6, 4, 16, C_DARK],
  [-40, -86, 12, 4, 6, C_ROCK],
  [40, -86, 12, 4, 6, C_ROCK],
  [-40, 86, 12, 4, 6, C_ROCK],
  [40, 86, 12, 4, 6, C_ROCK],
];

/** 棋盘：等距小方块，缝隙均匀。岩浆把空地切碎后，这些缝隙就是落脚点 */
const FIX_GRID = [
  [-48, -48, 9, 5, 9, C_WALL], [-16, -48, 9, 5, 9, C_WALL], [16, -48, 9, 5, 9, C_WALL], [48, -48, 9, 5, 9, C_WALL],
  [-48, -18, 9, 5, 9, C_DARK], [-16, -18, 9, 5, 9, C_DARK], [16, -18, 9, 5, 9, C_DARK], [48, -18, 9, 5, 9, C_DARK],
  [-48, 16, 9, 5, 9, C_DARK], [-16, 16, 9, 5, 9, C_DARK], [16, 16, 9, 5, 9, C_DARK], [48, 16, 9, 5, 9, C_DARK],
  [-48, 46, 9, 5, 9, C_WALL], [-16, 46, 9, 5, 9, C_WALL], [16, 46, 9, 5, 9, C_WALL], [48, 46, 9, 5, 9, C_WALL],
];

/** 十字：两道长墙把战场分成四块，四个口在中段。分区感最强，适合多目标 */
const FIX_CROSS = [
  [-26, 0, 5, 6, 150, C_WALL],
  [26, 0, 5, 6, 150, C_WALL],
  [0, -40, 150, 6, 5, C_WALL],
  [0, 40, 150, 6, 5, C_WALL],
  [-64, -64, 8, 4, 8, C_DARK],
  [64, -64, 8, 4, 8, C_DARK],
  [-64, 66, 8, 4, 8, C_DARK],
  [64, 66, 8, 4, 8, C_DARK],
];

const LAYOUTS = {
  standard: { fixed: FIX_STANDARD, random: 30, minGap: 9 },
  open:     { fixed: FIX_OPEN,     random: 10, minGap: 15 },
  corridor: { fixed: FIX_CORRIDOR, random: 16, minGap: 11 },
  dense:    { fixed: FIX_DENSE,    random: 34, minGap: 7 },
  ring:     { fixed: FIX_RING,     random: 14, minGap: 12 },
  island:   { fixed: FIX_ISLAND,   random: 8,  minGap: 16 },
  mirror:   { fixed: FIX_MIRROR,   random: 18, minGap: 11 },
  arena:    { fixed: FIX_ARENA,    random: 12, minGap: 14 },
  grid:     { fixed: FIX_GRID,     random: 10, minGap: 12 },
  cross:    { fixed: FIX_CROSS,    random: 14, minGap: 12 },
};

// ---- 十个战区（顺序即 Boss 轮换顺序）----

export const ZONES = [
  {
    id: 0, name: '训练场', boss: '破城者', layout: 'standard',
    // types 为空 = 沿用原来的随机三地形（第一轮不该让玩家一上来就背地形）
    types: null, mainMul: 1,
    note: '标准布局。破城者的三连发需要掩体躲，但通道要保持宽',
  },
  {
    id: 1, name: '镜湖', boss: '棱镜', layout: 'island',
    types: [T_SNOW, T_SAND, T_SWAMP], mainMul: 1.15,
    note: '中央堡垒。棱镜是远程炮台，绕堡垒躲弹幕是这场的核心动作',
  },
  {
    id: 2, name: '荒原', boss: '幽影', layout: 'open',
    types: [T_SAND, T_SWAMP, T_SNOW], mainMul: 1.45,
    note: '几乎无掩体。幽影的跃迁预警圈不能被墙挡住，落点也必须有空间',
  },
  {
    id: 3, name: '干渠', boss: '疾风', layout: 'corridor',
    types: [T_SAND, T_SNOW, T_SWAMP], mainMul: 1.1,
    note: '三条走廊。疾风 8 米冲刺在直线通道里威胁最大，横向躲闪要靠侧走廊',
  },
  {
    id: 4, name: '废墟', boss: '铁壁', layout: 'dense',
    types: [T_SWAMP, T_SAND, T_SNOW], mainMul: 1.25,
    note: '密集巷战。铁壁正面减伤 70%，必须靠转角绕后；沼泽减速让绕后更有代价',
  },
  {
    id: 5, name: '蜂巢', boss: '蜂巢', layout: 'ring',
    types: [T_SWAMP, T_SNOW, T_SAND], mainMul: 1.3,
    note: '环形墙收口。自爆机只能从几个缺口挤进来——这就是"目标优先级"的地形表达',
  },
  {
    id: 6, name: '熔炉', boss: '熔核', layout: 'grid',
    types: [T_SAND, T_SNOW, T_SWAMP], mainMul: 1.5,
    note: '棋盘掩体。岩浆把空地切碎之后，等距的缝隙是唯一均匀的落脚点',
  },
  {
    id: 7, name: '哨塔', boss: '哨戒', layout: 'arena',
    types: [T_SNOW, T_SAND, T_SWAMP], mainMul: 0.85,
    note: '中央半径 50 米全空。旋转光束必须没有遮挡，否则玩家看不懂"卡间隙"',
  },
  {
    id: 8, name: '双镜', boss: '双生', layout: 'mirror',
    types: [T_SNOW, T_SAND, T_SWAMP], mainMul: 1.0,
    note: '严格左右对称。两只双生各占一侧时，两边的掩体价值完全对等',
  },
  {
    id: 9, name: '终焉', boss: '终焉', layout: 'cross',
    types: [T_SWAMP, T_SAND, T_SNOW], mainMul: 1.4,
    note: '十字分区。终焉会在三个阶段召唤精英，四个区各自成战场，不会被挤成一堆',
  },
];

/** 第 n 波属于第几个战区（0 起）。55 波之后循环回训练场 */
export function zoneIndexForWave(n) {
  const w = Math.max(1, Math.floor(n) || 1);
  return Math.floor((w - 1) / WAVES_PER_ZONE) % ZONES.length;
}

export function zoneForWave(n) {
  return ZONES[zoneIndexForWave(n)];
}

/**
 * 战区的地形生成参数（直接喂给 buildTerrain 的 opts）。
 *
 * ⚠ 这里**不能**返回 k：调用方要用 `{ k: presetK(档位), ...terrainOptsFor(zone) }`
 * 展开，返回值里若有 k 就会把玩家选的画质档位覆盖成 1 ——
 * "我明明选了困难地形，怎么全是草地"就是这么来的。
 */
export function terrainOptsFor(zone) {
  const o = {};
  if (zone && zone.types) o.types = zone.types;
  if (zone && zone.mainMul) o.mainMul = zone.mainMul;
  return o;
}

/** 战区的布局参数（直接喂给 generateBoxes 的 opts） */
export function layoutOptsFor(zone) {
  const base = LAYOUTS[(zone && zone.layout) || 'standard'] || LAYOUTS.standard;
  return { fixed: base.fixed, random: base.random, minGap: base.minGap };
}

export { LAYOUTS };
