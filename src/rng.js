// 命名随机流（Named RNG Streams）
//
// 为什么不用全局 Math.random：
//   1. 单机时，玩家开火会消耗随机数（弹道散布），导致后续刷怪序列被玩家行为带偏
//      —— 同一天的「每日挑战」实际上每个人打的不是同一局，榜单无法真正比较。
//   2. 联机时，服务端与客户端必须能各自复现同一份世界；全局可变状态做不到。
//   3. 一进程多房间时，多个房间会互相踩踏同一个全局流。
//
// 做法：一条种子派生出多条互不干扰的流。每条流由 (seed, 流名) 独立播种，
// 因此「spawn 流」的序列只取决于种子，与 combat/fx 流被调用了多少次完全无关。

const FNV_OFFSET = 0x811c9dc5;

/** FNV-1a 32 位字符串哈希，用于把流名混进种子 */
function hash32(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 确定性伪随机数生成器（mulberry32），返回 [0,1) */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 随机流容器。
 *
 * 流的分工（这条边界很重要，联机时服务端只需要 spawn，客户端只需要 fx）：
 *   spawn  —— 刷怪位置、波次构成、词条、掉落。决定「这一局长什么样」。
 *   combat —— 弹道散布、敌人行为抖动。影响过程，不改对局结构。
 *   fx     —— 相机抖动等纯表现。不参与任何判定。
 */
export class Rng {
  constructor(seed = 0) {
    this.seed = seed >>> 0;
    this.cache = new Map();
  }

  setSeed(seed) {
    this.seed = seed >>> 0;
    this.cache.clear();
    return this;
  }

  /** 取一条命名流（同一实例内复用，保证序列连续） */
  stream(name) {
    let fn = this.cache.get(name);
    if (!fn) {
      fn = mulberry32((this.seed ^ hash32(name)) >>> 0);
      this.cache.set(name, fn);
    }
    return fn;
  }

  spawn() { return this.stream('spawn')(); }
  combat() { return this.stream('combat')(); }
  fx() { return this.stream('fx')(); }

  /** 便捷：流内取 [min,max) 浮点 */
  range(name, min, max) { return min + this.stream(name)() * (max - min); }

  /** 便捷：流内取整数 [0,n) */
  int(name, n) { return Math.floor(this.stream(name)() * n); }
}

/** 全局默认实例。单机直接用它；联机时服务端应当每个房间各自 new Rng(seed) */
export const R = new Rng();

/** 生成一个随机种子（用于普通模式，不追求可复现） */
export function randomSeed() {
  return (Math.random() * 0x100000000) >>> 0;
}
