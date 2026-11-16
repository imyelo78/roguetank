// 画质档位：手机 / 平板默认降配（阴影关、粒子减、雾拉近、像素比封顶 1.5），
// 跑起来还不够流畅就按 high → mid → low 逐级自动降，降到 low 为止。
//
// 为什么放在 core/：这张表是"两端共用的客观事实"吗——不是，它只管渲染。
// 放这里只是延续 core/ 的习惯：纯数据 + 纯函数，不碰 document / window 之外
// 的任何东西（检测用 matchMedia，测试里没有就当作桌面高配）。

const LADDER = ['high', 'mid', 'low'];

export const TIERS = {
  // pixelRatio 是"设备像素比的上限"：2K 屏 dpr=3 也没必要按 3 渲染
  high: { pixelRatio: 2, shadows: true, particles: 1, fogMul: 1 },
  mid: { pixelRatio: 1.5, shadows: false, particles: 0.7, fogMul: 0.85 },
  low: { pixelRatio: 1, shadows: false, particles: 0.45, fogMul: 0.7 },
};

/** 雾的基准距离（米）。档位只乘系数，词条（mods.fogFar）改的也是这个基准 */
export const FOG_BASE = { near: 95, far: 215 };

/**
 * 猜初始档位：触屏设备一律 low 起步。
 * 宁可先低后调，也不要先高再卡——首帧卡顿比画质糊更劝退。
 * 鼠标用户给 high：桌面 GPU 跑这套 200×200 场景毫无压力。
 */
export function detectTier() {
  try {
    const coarse = typeof matchMedia === 'function'
      && matchMedia('(pointer: coarse)').matches;
    const touch = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
    return (coarse || touch) ? 'low' : 'high';
  } catch {
    return 'high';
  }
}

export function createQuality(initial = detectTier()) {
  const q = {
    tier: initial,
    ...TIERS[initial],
    /** 降一档。已经在最低档时返回 null（调用方据此停止探测） */
    stepDown() {
      const i = LADDER.indexOf(q.tier);
      if (i < 0 || i >= LADDER.length - 1) return null;
      q.tier = LADDER[i + 1];
      Object.assign(q, TIERS[q.tier]);
      return q.tier;
    },
  };
  return q;
}
