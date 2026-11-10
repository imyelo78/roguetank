/**
 * 弹道拦截解算（提前量）。
 *
 * 背景：敌方主炮原本是"瞄准玩家**当前**位置打一条直线"。玩家横移 15 m/s 时，
 * 18 米距离、弹速 44 要飞 0.41 秒，人已经横挪 6.1 米，而命中半径才 1.45 米——
 * 数学上必空。用户反馈"破城者主炮一点伤害都没有"就是这么来的：
 * 不是炮坏了，是炮只会打"你刚才站的地方"。
 *
 * 这里解一个二次方程：|D + V·t|² = (s·t)²
 *   D = 目标相对炮口的位置，V = 目标速度，s = 弹速，t = 命中所需时间。
 * 取最小正根，代回去就是"该往哪打"。
 *
 * lead 是"预判系数"，故意不做成 1：
 *   - lead = 1   → 指哪打哪，匀速跑和变向都躲不掉，玩家没有解法；
 *   - lead ≈ 0.85 → 匀速跑会被打中，急停/变向能甩掉，才是可玩的博弈。
 *
 * 纯函数、无依赖，单机与联机服务端共用同一份。
 */

/** 求解拦截点。返回相对炮口的 {t, x, z}；无解（永远追不上）时返回 null。 */
export function solveIntercept({ dx, dz, vx = 0, vz = 0, speed, lead = 1 }) {
  if (!(speed > 0)) return null;

  const tvx = vx * lead;
  const tvz = vz * lead;

  const a = tvx * tvx + tvz * tvz - speed * speed;
  const b = 2 * (dx * tvx + dz * tvz);
  const c = dx * dx + dz * dz;

  let t = null;
  if (Math.abs(a) < 1e-9) {
    // 目标速度与弹速同速（退化情况）：方程退化为一次式
    if (Math.abs(b) > 1e-9) {
      const rt = -c / b;
      if (rt > 0) t = rt;
    }
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * a);
      const t2 = (-b + sq) / (2 * a);
      const cands = [t1, t2].filter((v) => v > 1e-6).sort((m, n) => m - n);
      if (cands.length) t = cands[0];
    }
  }

  // 追不上（或者算出的交点荒唐地远）：退回直接瞄准当前点
  if (t === null || !Number.isFinite(t) || t > 8) return null;

  return { t, x: dx + tvx * t, z: dz + tvz * t };
}

/**
 * 便捷封装：给炮口/目标坐标与速度，直接返回朝向角（atan2(sin, cos) 约定）。
 * 解不出来时退回"直接瞄当前点"。
 */
export function aimYawAt({ fromX, fromZ, toX, toZ, vx = 0, vz = 0, speed, lead = 1 }) {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const sol = solveIntercept({ dx, dz, vx, vz, speed, lead });
  return sol ? Math.atan2(sol.x, sol.z) : Math.atan2(dx, dz);
}

/**
 * 弹道手感参数。单机 Enemy 与联机 world.js 共用这一份。
 */
export const AIM_DEFAULTS = {
  /**
   * 破城者主炮：弹速 62、预判 0.92。
   *
   * 0.92 是实测调出来的：躲避的收益不来自"预判误差"，而来自"速度反向"——
   * 玩家变向时真实速度从 +15 变成 -15，与预判用的 +13.8 差了 28.8 m/s，
   * 0.26 秒就是 7.4 米，闭着眼睛也躲开了。所以预判可以给足，
   * 让"匀速跑/绕圈"必被命中，"变向/急停"必能甩脱，这才是清晰的博弈。
   *
   * （试过 0.75：匀速跑的理论误差 1 米，叠加炮口位置、圆周曲率、
   *   炮塔转速后实测偏到 2 米，比 1.45 米的命中半径还大，等于白改。）
   */
  breakerSpeed: 62,
  breakerLead: 0.92,
  /** 棱镜点射：本来就 66 弹速 + 三连点射，预判给低一点，避免"必中" */
  prismSpeed: 66,
  prismLead: 0.88,
};

/**
 * 玩家命中判定的高度上限（米）。Game._updateBullets 与敌方开火共用这一个值。
 *
 * 这条常量原本硬编码在 Game 里，藏了一个致命 bug：
 * 破城者与棱镜的模型会放大（1.75 / 1.45 倍），炮口世界高度因此变成 2.89 / 2.39 米，
 * 而判定上限是 2.3 米——它们平射出去的炮弹永远从玩家头顶掠过，伤害恒为 0。
 * 玩家看到的是"它明明在开炮，我一点血都不掉"。
 */
export const HIT_TOP = 2.3;

/** 玩家车身中部（瞄准/俯角的目标高度） */
export const AIM_BODY_Y = 1.1;

/**
 * 俯角下限（斜率，米/米）。0.18 ≈ 10°。
 *
 * 光"落到目标身上"是不够的：3° 的俯角在 20 米处正好把弹压到 1.8 米——
 * 擦着坦克剪影的最上沿过，实际只判中半个身位（实测 22 米站桩，最近距离
 * 3.7 米、命中 0 次）。所以凡是高过人的炮口（Boss 2.89 米，按交战距离算是
 * 5~10°），一律至少压 10°，让全段弹道都落在 0~2.3 米的判定区间里。
 */
export const PITCH_MIN = 0.18;

/**
 * 平射类武器（小兵主炮）的 DPS 设计斜率，米/米，约 1.4°。
 *
 * 敌人炮口大多在 1.5~1.6 米，本来就低于 2.3 米的命中上限——对小兵来说
 * 高度从来不是问题，它们平射就是对的。真正的坑是 Boss：模型放大后炮口
 * 2.89 米，平射直接飞过头顶。所以下压量按"自己有多高"来定：
 * 1.6 米的炮口只压 1.4°，2.89 米的炮口压 10.3°，两者都能落进 0~2.3 米。
 */
export const FLAT_SLOPE = 0.025;

/**
 * 按实际交战距离定俯角：让弹道在命中点正好穿过车身中部（1.1 米）。
 *
 * 只按"炮口→车身"连线取俯角是不够的：2.89 米炮口、20 米距离，弹道在 15 米处
 * 还有 1.3 米高、10 米处只剩 0.2 米——玩家前后挪 1 米，弹就从他脚前扎进土里。
 * 实测表现就是"距离越远越打不中，最近距离 21.7 米"。
 *
 * ⚠ 符号：俯角是"每米水平降多少米"，所以竖直分量必须是**负**的。
 * 写成 (toY - fromY) / h 会得到正数（往下瞄却是往上飞），第一版就是这么错的：
 * 测试里 18 米处高度算出来 -0.3 米，命中率掉到 6%，看着像"调参没调好"。
 *
 * @param {number} fromY  炮口世界高度
 * @param {number} horiz  到目标的水平距离
 */
export function flatPitch(fromY, horiz) {
  const h = Math.max(6, horiz);
  const need = (fromY - AIM_BODY_Y) / h;
  // 炮口 1.6 米时 need ≈ 0.028（1.6°）——小兵本来就打得中，不要动它们的弹道
  return -Math.max(FLAT_SLOPE, need);
}

/** 斜率 → 角度（度），只给日志和测试看 */
export const slopeDeg = (s) => Math.atan(Math.abs(s)) * 180 / Math.PI;

/** 把 (yaw, 俯角) 拼成单位方向向量，单机与联机共用，避免各写一份。 */
export function dirFrom(yaw, pitch) {
  const len = Math.hypot(1, pitch);
  return { x: Math.sin(yaw) / len, y: pitch / len, z: Math.cos(yaw) / len };
}
