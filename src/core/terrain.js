// 地表类型场：五种地形对行驶速度的影响 —— 唯一真源
//
// 为什么单独抽一个文件（和 levelgen / collide / motion 同一个理由）：
//   客户端要用它画地面颜色、算"脚下这块地软不软"，
//   服务端要用它算单位每一步的实际速度。
//   两边只要有一丁点不一致，就是"我这边陷在沼泽里爬不动，服务端说你在草地上"
//   —— 然后预测被反复校正，手感回到"拖拽"。
//
// 和前一代"起伏地形"的区别：
//   那一版靠高度场改坡度系数，问题是要让建筑、单位、子弹全部贴地，
//   一个顶点法线没算对就是一片死黑，收益却只有"看远处被山挡住"。
//   这一版只做一件事：地表类型决定履带能跑多快。没有 y 轴，就没有贴地问题。
//
// 三条硬约束（和以前一样）：
//   1. 纯函数生成：同 seed 同结果，跨浏览器/Node 完全一致，无全局状态
//   2. 采样必须平滑（双线性）：不允许"跨过一条线速度突然从 1.0 掉到 0.55"
//      —— 那是预测抖动最经典的来源
//   3. map 为 null 时速度恒等于 1 —— 旧关卡、旧回放、单测完全不受影响
//
// 坐标约定：x、z 为世界坐标（米），yaw = 0 朝 +z。

// 只借一张坐标表（出生点），不依赖 levelgen 的生成逻辑，不存在循环引用。
import { SPAWNS } from './levelgen.js';

// ---------------- 类型定义 ----------------
//
// id 必须固定且两端一致：cells 是 Uint8Array，存的就是这个 id。
// 顺序也是"由好走到难走"，调试时看数字就能判断。

export const T_GRASS = 0;
export const T_ROAD = 1;
export const T_SAND = 2;
export const T_SNOW = 3;
export const T_SWAMP = 4;

/**
 * 五种地表。
 *
 * speed 是速度倍率，草地 1.00 是基准 —— 这是刻意的：
 * 现在所有地图手感都是 15 米/秒，草地保持 1.0 等于"老玩家的手感没变"，
 * 只有踩到别的地表才有变化。如果反过来把公路设成基准 1.0，
 * 那整张图默认就比现在慢一截，等于偷偷改了一次全服手感。
 *
 * color 给渲染层做顶点色，数值就是最终看到的基色（再乘一张中性噪点贴图）。
 */
export const TERRAIN = [
  { key: 'grass', name: '草地', speed: 1.00, color: 0x6e7a52, note: '基准速度' },
  { key: 'road', name: '公路', speed: 1.12, color: 0x54555a, note: '硬质路面，最快' },
  { key: 'sand', name: '沙漠', speed: 0.84, color: 0xa8956a, note: '松散沙地，履带打滑' },
  { key: 'snow', name: '雪地', speed: 0.76, color: 0xd3dae0, note: '附着差，起步吃力' },
  { key: 'swamp', name: '沼泽', speed: 0.55, color: 0x3b4630, note: '泥泞，最慢' },
];

export const TERRAIN_COUNT = TERRAIN.length;

/** 单格边长（米）。8 米 ≈ 两个车身长，走进去立刻能感觉到，又不至于碎成马赛克。 */
export const TILE = 8;

/**
 * 强度档位：把 speed 相对 1.0 的偏离按比例缩放。
 *
 * off      = 全 1.0，旧行为（回归保护线）
 * light    = 偏离打五折，新手关
 * standard = 原始数值
 * harsh    = 偏离放大 1.4 倍，老手关
 *
 * 由服务端在 WELCOME 里下发，客户端不猜、也不读 URL 参数，
 * 否则四人房里有人开有人没开，直接漂移。
 */
export const TERRAIN_PRESETS = { off: 0, light: 0.5, standard: 1, harsh: 1.4 };

/** 档位名 → 缩放系数。认不出来的当 off，宁可没效果也不要半开。 */
export function presetK(preset) {
  const v = String(preset ?? '').trim().toLowerCase();
  if (v in TERRAIN_PRESETS) return TERRAIN_PRESETS[v];
  if (v === '') return 1; // 没配就当标准档
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(2, n) : 0;
}

// ---------------- 确定性随机 ----------------
//
// 全部走 32 位整数运算。Math.random 一律不许出现在这里：
// 服务端一个房间生成一次、客户端每个玩家各生成一次，
// 只要有一个人拿到不同的图，那一局就是灾难。

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

/** 分形叠加。比单层噪声更像"成片的地貌"，而不是一个个圆斑。 */
function fbm(x, z) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < 3; o++) {
    sum += amp * noise2(x * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

// ---------------- 生成 ----------------

/**
 * 默认的出生点保护圈。
 *
 * 必须写成一个两端都能调用的函数，而不是由 World 生成完再"告诉"客户端：
 * 保护圈决定了哪些格子被刷成草地，一旦两端清单不一样，
 * 同一 seed 生成出来的地图就不同，玩家会看到"我这边是公路、你那边是沼泽"。
 * 所以这里直接复用 levelgen 的 SPAWNS，保证只有一份坐标表。
 */
export function defaultClearPoints() {
  return [
    [0, 26], // 单机出生点（levelgen.PLAYER_START）
    ...SPAWNS.map(([x, z]) => [x * 0.35, z * 0.35]),
    [0, 0], // 中央通路：别让整张图的正中间变成一滩沼泽
  ];
}

/**
 * 一条穿场公路（会随机左右游走，形成 S 弯）。
 * 覆盖两格宽，8×2 = 16 米 —— 大约两车并行，够宽不会逼着玩家贴着边走。
 */
function carveRoad(cells, n, rnd, vertical) {
  const set = (a, b) => {
    const [ix, iz] = vertical ? [a, b] : [b, a];
    if (ix < 0 || ix >= n || iz < 0 || iz >= n) return;
    cells[iz * n + ix] = T_ROAD;
  };
  // 起点避开最外侧四格：路贴着地图边框跑等于把边界变成高速公路，
  // 玩家一开局就在柏油上，等于这个特性没生效。
  let p = 4 + Math.floor(rnd() * (n - 9));
  for (let i = 0; i < n; i++) {
    // 18% 概率横向漂一格：200 米大约漂 5 格 = 40 米，看起来是弯道而不是蛇形
    if (rnd() < 0.18) p += rnd() < 0.5 ? -1 : 1;
    p = Math.max(3, Math.min(n - 5, p));
    set(i, p);
    set(i, p + 1);
  }
}

/**
 * 生成一张地表类型场。
 *
 * @param {number} seed 地图种子。联机由房间码派生，单机每局随机。
 * @param {number} half 地图半边长（与 levelgen 的 HALF 一致）
 * @param {object} [opts]
 * @param {number} [opts.tile] 单格边长，默认 TILE
 * @param {Array<[number,number]>} [opts.clear] 必须保持可通行的点（出生点）
 * @param {number} [opts.clearRadius] 保护半径，默认 20 米
 * @returns {object} 地表场对象，交给 speedAt / colorWeightsAt 用
 */
export function buildTerrain(seed = 1, half = 100, opts = {}) {
  const tile = Math.max(2, opts.tile || TILE);
  const n = Math.ceil((2 * half) / tile) + 2;
  // 格 ix 覆盖 [x0 + ix*tile, x0 + (ix+1)*tile)；
  // 多留一圈是为了让地图边界的采样不会越界，也避免边缘出现半格权重。
  const x0 = -half - tile;

  const cells = new Uint8Array(n * n); // 默认全 0 = 草地
  const rnd = mulberry32((seed >>> 0) || 0x9e3779b9);

  // ---- 1. 公路：一纵一横打底，25% 的图多出一条 ----
  //
  // 为什么不是"1~2 纵 + 1~2 横"：两条 2 格宽的路各 27 格，四条就吃掉
  // 近 28% 的地面，公路变成主导地形，玩家全程在柏油上飞，
  // 这个特性就白做了。三条封顶（约 21%）还能接受，四条不要。
  const extra = rnd() < 0.25 ? 1 : 0;
  const verts = 1 + (extra && rnd() < 0.5 ? 1 : 0);
  const horzs = 1 + (extra && verts === 1 ? 1 : 0);
  for (let i = 0; i < verts; i++) carveRoad(cells, n, rnd, true);
  for (let i = 0; i < horzs; i++) carveRoad(cells, n, rnd, false);

  // ---- 2. 主地形 / 次地形：两套独立噪声各自取分位 ----
  //
  // 为什么用"排序取分位"而不是"噪声超过阈值"：
  //   value noise 的分布不是均匀的，阈值法要么全是、要么全无，
  //   调到能用的区间又依赖振幅。排序取前 N% 则占比精确可控，
  //   而噪声本身的连续性保证了结果仍然是一团一团的，不是棋盘格。
  // 三种非草地形都保证出现（只是占比不同）：一张图里集不齐五种，
  // 玩家就永远学不会"雪地比沙漠更慢"，这套系统的信息量直接砍半。
  const pool = [T_SAND, T_SNOW, T_SWAMP];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  const mainType = pool[0];
  const subType = pool[1];
  const thirdType = pool[2];

  // 噪声偏移：换 seed 就是完全不同的图案，而不是同一张图整体平移
  const ax = rnd() * 200 - 100;
  const az = rnd() * 200 - 100;
  const bx = rnd() * 200 - 100;
  const bz = rnd() * 200 - 100;

  const buckets = [];
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      if (cells[i] === T_ROAD) continue;
      const cx = x0 + (ix + 0.5) * tile;
      const cz = x0 + (iz + 0.5) * tile;
      // 主地形：中频团块 + 超低频"大势"，让主导地形偏向地图某一侧
      const va =
        0.62 * fbm(cx * 0.026 + ax, cz * 0.026 + az) +
        0.38 * noise2(cx * 0.0085 + bx, cz * 0.0085 + bz);
      // 次地形：另一套频率，避免和主地形完全重合（否则永远看不到次地形）
      const vb = 0.7 * fbm(cx * 0.041 + bx, cz * 0.041 + az) +
        0.3 * noise2(cx * 0.012 + ax, cz * 0.012 + bz);
      // 第三地形：最高频的一层，铺成"零散小块"
      const vc = fbm(cx * 0.058 + bz, cz * 0.058 + bx);
      buckets.push([va, vb, vc, i]);
    }
  }

  const free = buckets.length;
  // 主地形 28%~42%：低于 28% 感觉不到，高于 45% 整局都在爬
  const pMain = 0.28 + rnd() * 0.14;
  // 次地形 8%~15%：成片，但明显比主地形小
  const pSub = 0.10 + rnd() * 0.08;
  // 第三地形 9%~14%：碎块点缀，负责"看着乱、走着要绕"。
  // 给得比目标值高，是因为后面的平滑会啃掉一部分小块（实测平均掉两成）。
  const pThird = 0.09 + rnd() * 0.05;

  // 按占比从大到小依次涂。每涂一层都跳过已被占用的格子，
  // 所以实际占比只会略小于目标值，不会叠在一起变成一片。
  const paint = (key, want, type) => {
    buckets.sort((p, q) => q[key] - p[key]);
    let taken = 0;
    for (let j = 0; j < buckets.length && taken < want; j++) {
      const i = buckets[j][3];
      if (cells[i] !== T_GRASS) continue;
      cells[i] = type;
      taken++;
    }
  };
  paint(0, Math.round(free * pMain), mainType);
  paint(1, Math.round(free * pSub), subType);
  paint(2, Math.round(free * pThird), thirdType);

  // ---- 3. 出生点保护（必须放在平滑之前） ----
  //
  // 一落地就在沼泽里 = 开局就比别人慢一半，还没看清战场就被围住。
  // 保护圈内一律刷成草地（公路保留：踩在路上出生是好事）。
  //
  // 顺序很关键：一定要在平滑之前刷。放在后面会把圈边切出零星的单格
  // （圈内刷成草地，圈外原本连着的那格就孤立了），而那时候平滑已经跑完，
  // 没人再收拾——实测 30 张图能留下 37 个孤立格。
  const clear = opts.clear || defaultClearPoints();
  const cr = opts.clearRadius ?? 20;
  const c2 = cr * cr;
  for (const [px, pz] of clear) {
    for (let iz = 1; iz < n - 1; iz++) {
      for (let ix = 1; ix < n - 1; ix++) {
        const i = iz * n + ix;
        if (cells[i] === T_ROAD || cells[i] === T_GRASS) continue;
        const cx = x0 + (ix + 0.5) * tile;
        const cz = x0 + (iz + 0.5) * tile;
        if ((cx - px) ** 2 + (cz - pz) ** 2 <= c2) cells[i] = T_GRASS;
      }
    }
  }


  // ---- 4. 平滑：清掉孤零零的一格 ----
  //
  // 一格的孤岛在视觉上是噪点，在手感上更糟：车压过去又出来，
  // 速度瞬间掉一截又弹回来，玩家会以为"卡了一下"。
  // 规则：自己只有 ≤1 个同类邻居（真正孤独的一格）、且有某类有 ≥6 个，就随大流。
  // 一开始写的是"≤2 邻居 + ≥5"，结果 2~3 格的小团被整片吃掉，
  // 第三次地形（本来就小）实测只剩 2%，屏幕上根本看不到。
  // 公路不参与（路必须是连续的线，被平滑会被啃断）。
  const NB = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const countNeighbors = (iz, ix, out) => {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; out[4] = 0;
    for (let k = 0; k < 8; k++) out[cells[(iz + NB[k][1]) * n + (ix + NB[k][0])]]++;
    return out;
  };
  const cnt = [0, 0, 0, 0, 0];

  // 第一遍：温和。只把"同类邻居 ≤1 且周围明显是另一个世界"的格子归队。
  // 阈值 6 是试出来的：放宽到 5 会开始啃 2×3 的小块（第三地形直接消失）。
  for (let pass = 0; pass < 2; pass++) {
    const next = cells.slice();
    for (let iz = 1; iz < n - 1; iz++) {
      for (let ix = 1; ix < n - 1; ix++) {
        const i = iz * n + ix;
        const self = cells[i];
        if (self === T_ROAD) continue;
        countNeighbors(iz, ix, cnt);
        if (cnt[self] >= 2) continue;
        let best = self;
        let bestC = cnt[self];
        for (let t = 0; t < TERRAIN_COUNT; t++) {
          if (cnt[t] > bestC) { bestC = cnt[t]; best = t; }
        }
        if (best !== self && bestC >= 6) next[i] = best;
      }
    }
    cells.set(next);
  }

  // 第二遍：清孤岛。上一遍有阈值保护，会漏下"四周一个同类都没有、但邻居也不够 6 个"
  // 的格子（地图边角、公路夹缝里最容易出现）。这种格子只有 1 个，走过去就是
  // "速度掉一下又回来"，比留着一块 2 格的小地形难看得多。所以这里无条件归队。
  // 循环到没有变化为止（归队可能造出新的孤岛，但会很快收敛）。
  //
  // 这里是就地改（不像上一遍写副本）：扫描顺序固定，结果仍然完全确定，
  // 但一轮就能把整条连锁清干净。用副本的话每轮只修一批，
  // 6 轮之后仍然会剩下几个（实测 4 个），于是"没有孤立格"这条断言永远过不了。
  for (let guard = 0; guard < 6; guard++) {
    let changed = 0;
    for (let iz = 1; iz < n - 1; iz++) {
      for (let ix = 1; ix < n - 1; ix++) {
        const i = iz * n + ix;
        const self = cells[i];
        if (self === T_ROAD) continue;
        countNeighbors(iz, ix, cnt);
        if (cnt[self] > 0) continue;
        let best = self;
        let bestC = -1;
        for (let t = 0; t < TERRAIN_COUNT; t++) {
          if (cnt[t] > bestC) { bestC = cnt[t]; best = t; }
        }
        if (best !== self) { cells[i] = best; changed++; }
      }
    }
    if (!changed) break;
  }

  // ---- 5. 统计（调试 / 测试 / HUD 用，不进每帧循环） ----
  const share = [0, 0, 0, 0, 0];
  for (let i = 0; i < cells.length; i++) share[cells[i]]++;
  const stats = TERRAIN.map((t, i) => ({ key: t.key, name: t.name, ratio: share[i] / cells.length }));

  return {
    seed: (seed >>> 0) || 0x9e3779b9,
    half,
    tile,
    n,
    x0,
    cells,
    /** 强度系数：1 = 原始数值，0 = 全部按草地算 */
    k: opts.k ?? 1,
    stats,
  };
}

/** 重新给一张已有地形场套强度档（服务端改 TERRAIN 时不用重建） */
export function retune(map, k) {
  if (!map) return map;
  map.k = Math.max(0, Number(k) || 0);
  return map;
}

// ---------------- 采样 ----------------

const _w = new Float64Array(5);

/**
 * 双线性混合权重：把 (x,z) 落到四邻格上，各带一个权重。
 *
 * 为什么一定要双线性而不是"查所在格"：
 *   查格的话，跨过一条格线速度会从 1.00 直接跳到 0.55。
 *   客户端预测按自己的位置查、服务端按权威位置查，两人差 3 厘米就可能
 *   落在格线两侧 → 一个按 15 米/秒算、一个按 8.25 米/秒算，
 *   每帧差 0.2 米，两秒后就是肉眼可见的位置漂移，然后被硬拽回去。
 *   双线性让边界连续，3 厘米的位置差只对应很小的速度差，残差自然收敛。
 *
 * @param {object} map
 * @param {number} x
 * @param {number} z
 * @param {Float64Array} out 长度 5 的权重数组（会被清零后写入）
 */
function weightsAt(map, x, z, out) {
  out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; out[4] = 0;
  const { tile, x0, n, cells } = map;

  // -0.5：让"格中心"成为采样点，格中心处正好只取本格
  const fx = (x - x0) / tile - 0.5;
  const fz = (z - x0) / tile - 0.5;

  let ix = Math.floor(fx);
  let iz = Math.floor(fz);
  let tx = fx - ix;
  let tz = fz - iz;
  // 越界（地图外 / 极端值）退化成边界格，不让 NaN 传下去
  if (ix < 0) { ix = 0; tx = 0; }
  else if (ix > n - 2) { ix = n - 2; tx = 1; }
  if (iz < 0) { iz = 0; tz = 0; }
  else if (iz > n - 2) { iz = n - 2; tz = 1; }

  const r0 = iz * n + ix;
  const r1 = r0 + n;
  const w00 = (1 - tx) * (1 - tz);
  const w10 = tx * (1 - tz);
  const w01 = (1 - tx) * tz;
  const w11 = tx * tz;

  out[cells[r0]] += w00;
  out[cells[r0 + 1]] += w10;
  out[cells[r1]] += w01;
  out[cells[r1 + 1]] += w11;
  return out;
}

/**
 * (x,z) 处的速度倍率。
 *
 * 只作用于"目标速度"，不改积分方式 —— 和上一代坡度系数同一个道理：
 * 一旦让位移本身依赖地形做积分，两端的浮点差会随帧累积成可见漂移。
 *
 * @returns {number} 乘到基础速度上的系数；map 为空时恒为 1
 */
export function speedAt(map, x, z) {
  if (!map || !map.cells) return 1;
  // NaN / Infinity 一律当"没有地形处理"。
  // 为什么不能顺着算下去：Math.floor(NaN) 得到 NaN，四邻格全查不到，
  // 权重和变成 0，混合速度就是 0 —— 车会彻底定住。
  // 一个 NaN 坐标（预测校正、掉线重连时都出现过）不该让车变砖。
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 1;
  const k = map.k ?? 1;
  if (k === 0) return 1;
  const w = weightsAt(map, x, z, _w);
  let s = 0;
  for (let i = 0; i < 5; i++) s += w[i] * TERRAIN[i].speed;
  return 1 + (s - 1) * k;
}

/** 权重数组的复用缓冲：渲染层每帧要刷很多顶点，不想每顶点 new 一个数组 */
export function weightsInto(map, x, z, out) {
  if (!map || !map.cells) {
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0; out[4] = 0;
    // k = 0 时全部按草地渲染，避免"画面是沼泽、手感是草地"的错位
    return out;
  }
  if ((map.k ?? 1) === 0) {
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0; out[4] = 0;
    return out;
  }
  return weightsAt(map, x, z, out);
}

/**
 * (x,z) 处占比最大的地表类型 id。
 * 只给 HUD 显示"脚下是什么"用，不参与物理——物理一律走 speedAt 的混合值，
 * 否则手感和显示会对不上（站在边界上显示草地、实际速度是两格的平均）。
 */
export function dominantAt(map, x, z) {
  if (!map || !map.cells) return T_GRASS;
  const w = weightsAt(map, x, z, _w);
  let best = 0;
  for (let i = 1; i < 5; i++) if (w[i] > w[best]) best = i;
  return best;
}

/**
 * 地图级统计：各类型占比、速度极值、最容易/最难走的位置。
 * 只在测试和关卡工具里调，不进每帧循环。
 */
export function scanTerrain(map) {
  if (!map || !map.cells) return null;
  const w = new Float64Array(5);
  let minSpeed = Infinity;
  let maxSpeed = -Infinity;
  let at = { x: 0, z: 0 };
  const step = map.tile * 0.5;
  for (let x = -map.half; x <= map.half; x += step) {
    for (let z = -map.half; z <= map.half; z += step) {
      const s = speedAt(map, x, z);
      if (s < minSpeed) { minSpeed = s; at = { x, z }; }
      if (s > maxSpeed) maxSpeed = s;
    }
  }
  void w;
  return { minSpeed, maxSpeed, slowestAt: at, stats: map.stats };
}
