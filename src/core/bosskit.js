// Boss 单一数据源（P0）
//
// 以前 Boss 的信息散在四处：Enemy.js 的 BOSS_INFO/CORE_MATS、world.js 的
// ENEMY_TYPES、Game.js 的一个三元、coop.js 又一份名字与配色。加一个 Boss
// 要改 5 个文件 6 处，而且两边一定会慢慢分叉——联机棱镜至今没有折射风暴
// 就是这么来的（单机写了技能，联机那份没人补）。
//
// 这个文件刻意不 import three、不碰 DOM：服务端算血量、客户端建模型、
// 测试跑轮换，都读同一份。它只回答三个问题：
//   第 n 波出谁？  它有多硬？  它的技能参数是多少？

/**
 * 十个 Boss 的出场顺序。第 n 波（n 为 5 的倍数）取 BOSS_ORDER[n/5 - 1]。
 * 10 个刚好铺到第 50 波；55 波起改随机抽取 + 觉醒词条（见 pickBossForLate）。
 */
export const BOSS_ORDER = [
  'boss_breaker',   // W5   绕：重装炮台，学会横移
  'boss_prism',     // W10  穿：环形弹幕，学会找缝
  'boss_wraith',    // W15  盯：预警跃迁，学会锁视线
  'boss_blitz',     // W20  等：冲刺硬直，学会憋输出
  'boss_bulwark',   // W25  找：正面无效，学会绕后
  'boss_hive',      // W30  分：持续召唤，学会取舍
  'boss_crucible',  // W35  站：岩浆封地，学会找落脚
  'boss_warden',    // W40  掐：旋转激光，学会卡节拍
  'boss_twin',      // W45  平：双子共鸣，学会同步压血
  'boss_terminus',  // W50  换：三阶段，前面九课重考
];

/**
 * 每个 Boss 的静态档案。
 *
 * verb 是玩家必须做的那个动作，也是"这个 Boss 有没有特色"的检验标准：
 * 十个 verb 不能重复，否则就是换皮。
 *
 * typeMul 只影响血量，用来让"血少但难躲"的 Boss（疾风 0.8）和
 * "血厚但不灵活"的 Boss（蜂巢 1.3）在时长上回到同一条线。
 */
export const BOSS_META = {
  boss_breaker: {
    name: '破城者', kind: 'breaker', verb: '绕', tag: '重装',
    core: 0xff6a2a, bar: 'breaker',
    speed: 7.2,
    scale: 1.75, radius: 2.5, typeMul: 1.0,
    near: 13, far: 21, damage: 15,
    skills: ['salvo'],
  },
  boss_prism: {
    name: '棱镜', kind: 'prism', verb: '穿', tag: '折射',
    core: 0x6fe6ff, bar: 'prism',
    speed: 9.2,
    scale: 1.45, radius: 2.1, typeMul: 0.9,
    near: 17, far: 27, damage: 8,
    skills: ['burst', 'ring'],
  },
  boss_wraith: {
    name: '幽影', kind: 'wraith', verb: '盯', tag: '相位',
    core: 0x9b7bff, bar: 'wraith',
    speed: 9.6,
    scale: 1.5, radius: 2.2, typeMul: 0.85,
    near: 8, far: 16, damage: 9,
    skills: ['burst', 'blink'],
  },
  boss_blitz: {
    name: '疾风', kind: 'blitz', verb: '等', tag: '突袭',
    core: 0xffd23a, bar: 'blitz',
    speed: 11.4,
    scale: 1.4, radius: 2.0, typeMul: 0.8,
    near: 10, far: 18, damage: 14,
    skills: ['dash'],
  },
  boss_bulwark: {
    name: '铁壁', kind: 'bulwark', verb: '找', tag: '要塞',
    core: 0x7d8a99, bar: 'bulwark',
    speed: 4.5,
    scale: 1.85, radius: 2.7, typeMul: 1.15,
    near: 9, far: 16, damage: 12,
    skills: ['salvo', 'generators'],
  },
  boss_hive: {
    name: '蜂巢', kind: 'hive', verb: '分', tag: '构造',
    core: 0xc06bd8, bar: 'hive',
    speed: 0,
    scale: 1.7, radius: 2.6, typeMul: 1.3,
    near: 0, far: 60, damage: 7,
    skills: ['spawn'],
  },
  boss_crucible: {
    name: '熔核', kind: 'crucible', verb: '站', tag: '熔炉',
    core: 0xff7a2f, bar: 'crucible',
    speed: 6.8,
    scale: 1.8, radius: 2.6, typeMul: 1.3,
    near: 20, far: 34, damage: 10,
    skills: ['lava', 'barrage'],
  },
  boss_warden: {
    name: '哨戒', kind: 'warden', verb: '掐', tag: '光棱',
    core: 0x59f0c0, bar: 'warden',
    speed: 7.4,
    scale: 1.6, radius: 2.3, typeMul: 1.4,
    near: 22, far: 38, damage: 9,
    skills: ['laser'],
  },
  boss_twin: {
    name: '双生', kind: 'twin', verb: '平', tag: '双子',
    core: 0xb388ff, bar: 'twin',
    speed: 9.8,
    scale: 1.35, radius: 1.9, typeMul: 0.6,   // 两只各 0.6
    near: 15, far: 24, damage: 8,
    skills: ['burst', 'resonance'],
    twins: 2,
  },
  boss_terminus: {
    name: '终焉', kind: 'terminus', verb: '换', tag: '终局',
    core: 0xff3b6b, bar: 'terminus',
    // typeMul 保持 1.0：三阶段各 1/3 已把时长拉到 110s，再乘 1.2 会到 132s，
    // 超过"单场不超过 2 分钟"的上限。它的强度来自换阶段，不来自血厚。
    speed: 8.2,
    scale: 1.9, radius: 2.8, typeMul: 1.0,
    near: 14, far: 26, damage: 14,
    skills: ['salvo', 'burst', 'spawn', 'lava', 'dash'],
  },
};

/** 技能参数。数值集中在这里，两个 AI 各读一次，避免"单机 9 秒、联机 11 秒"。 */
export const BOSS_SKILLS = {
  salvo: { cd: 4.6, enragedCd: 3.4, count: 3, spread: 0.15 },

  burst: { cd: 2.6, enragedCd: 1.8, count: 3, gap: 0.1, spread: 0.05 },
  ring: { cd: 9, enragedCd: 6.5, windup: 0.95, count: 12, enragedCount: 16 },

  // 幽影：预警圈收缩到位才传送。
  //
  // 落点必须是**贴身**距离（5~8m），不能是 12~16m —— 落地冲击波半径 6m，
  // 如果落在 16m 外，冲击波永远够不着玩家，这个技能就是个没有威胁的动画。
  // 贴身落地也符合它的定位：从视野边缘消失，然后从你背后撞出来。
  blink: {
    cd: 9, enragedCd: 6.5, warn: 1.2,
    minDist: 5, maxDist: 8, shockR: 6, shockDmg: 8,
  },

  // 疾风：冲刺后硬直是唯一输出窗口，所以冲刺本身必须可躲（0.32s / 8m 可读）。
  dash: {
    cd: 7, enragedCd: 5.5, dur: 0.32, dist: 8,
    stun: 1.5, dmg: 14, hitR: 2.6, startDist: 10,
  },

  // 铁壁：正面减伤 70%（保留 30% 伤害），四个发生器打光才破防。
  generators: { cd: 12, count: 4, hpShare: 0.08, breakDur: 6, frontArmor: 0.3 },

  // 蜂巢：本体不动，场上召唤物硬上限 9。
  spawn: { cd: 10, count: 3, cap: 9, hpShare: 0.06 },

  // 熔核：岩浆区是"可站空间"的约束，不是伤害来源本身。
  lava: { cd: 14, count: 3, r: 5, dur: 8, dps: 12, warn: 0.9, minGap: 6 },
  barrage: { cd: 18, warn: 2.5, dmg: 22 },

  // 哨戒：0.55 rad/s 一圈 11.4 秒，反向周期 20 秒——
  // 玩家不能靠"一直顺时针跑"混过去。
  //
  // 判定用「角差 × 距离」，**不用子弹**：
  // 沿射线每 0.09 秒发一颗速度 78 的弹，10 米处两颗之间已经隔了 1 米，
  // 玩家站在光束里反而只被擦到一两颗，光束会变成"看着吓人、其实不掉血"的
  // 装饰（初版就是这么写的，探针一测 dps 只有 1.6）。连续判定才和设计里
  // "碰到就掉血"一致，顺带省掉每秒 22 颗子弹的渲染与同步。
  laser: {
    cd: 20, speed: 0.55, enragedSpeed: 0.8, enrageAt: 0.4,
    len: 40, halfWidth: 1.35, dps: 18, tick: 0.2,
  },

  // 双生：共鸣钳位。
  //
  // 方案文档里写的是"一方受伤，另一方每秒回已损失血量的 8%"，但按这个数值
  // 是**打不死的**：第 45 波的目标时长 95 秒，玩家 DPS 折成百分比约 1%/秒，
  // 而 8%/秒 的回血意味着血量稳定在"掉了 12.5%"的位置——你怎么打都在 87%。
  // 所以真正的规则改成钳位：两只的血量差不允许超过 15%，低了的那只被拉回来。
  // 效果与设计意图一致（必须两边同步压血，最后 15% 一起收），但它是可执行的。
  resonance: { gap: 0.15, pullRate: 0.35 },

  // 终焉：三个阶段，转阶段 2 秒无敌 + 全场冲击波。
  phases: {
    invuln: 2,
    thresholds: [0.66, 0.33],
    shockR: 11, shockDmg: 12,
    // 各阶段的节奏：阶段一三连点射、阶段二召唤+岩浆、阶段三冲刺+环射
    stage2EliteCd: 20, stage2LavaCd: 12, stage2Elites: 2,
    stage3DashCd: 7, stage3RingCd: 9, stage3SpeedMul: 1.8,
  },
};

/** 第 n 波的目标时长（秒）。血量由它反推，而不是直接给一个血数字。 */
const TARGET_SECONDS = [
  [5, 30], [10, 45], [15, 55], [20, 60], [25, 65],
  [30, 75], [35, 80], [40, 85], [45, 95], [50, 110],
];

/**
 * 该波玩家的大致 DPS（单人）。卡池乘区有上限（伤害 ×2.69 / 射速 ×1.94），
 * 所以这条线是"前期陡、后期平"，而时长线是"一直涨"——
 * 两者相除，后期 Boss 自然越来越硬，不需要额外乘一个指数系数。
 */
const EXPECTED_DPS = [
  [5, 120], [10, 170], [15, 220], [20, 270], [25, 320],
  [30, 360], [35, 400], [40, 440], [45, 480], [50, 520],
];

function lerpTable(table, n) {
  if (n <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (n >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (n === x1) return y1;
    if (n < x1) {
      const [x0, y0] = table[i - 1];
      const k = (n - x0) / (x1 - x0);
      return y0 + (y1 - y0) * k;
    }
  }
  return last[1];
}

export function bossTargetSeconds(n) {
  return lerpTable(TARGET_SECONDS, n);
}

export function expectedDps(n) {
  return lerpTable(EXPECTED_DPS, n);
}

/**
 * 已经实现技能的 Boss 数量（BOSS_ORDER 的前 N 个）。
 *
 * 加这一条是为了"随时可上线"：BOSS_ORDER 里可以先排满 10 个设计，
 * 但只有前 N 个真的会放技能。没实现的如果上场，就是一个纯肉桩——
 * 玩家会立刻发现"第 25 波那个 Boss 跟第 5 波一模一样，只是血更厚"。
 * 轮换超过 N 时取模回到开头，等于"暂时循环已完成的阵容"。
 */
export const BOSS_READY = 10;

/** 该波出什么 Boss；不是 Boss 波返回 null。55 波起返回 null，交由随机抽取。 */
export function bossTypeForWave(n) {
  if (n % 5 !== 0 || n <= 0) return null;
  const idx = n / 5 - 1;
  const ready = Math.max(1, Math.min(BOSS_ORDER.length, BOSS_READY));
  return BOSS_ORDER[idx % ready];
}

/** 55 波后的随机抽取：不与上一波重复，避免连续两波同一个 Boss。 */
export function pickLateBoss(rng, previous = null) {
  const ready = Math.max(1, Math.min(BOSS_ORDER.length, BOSS_READY));
  const pool = BOSS_ORDER.slice(0, ready).filter((t) => t !== previous);
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/**
 * Boss 血量。
 * hpMul 由调用方给（单机传 1，联机传人数缩放），已包含人数系数。
 */
export function bossHpFor(n, type, hpMul = 1) {
  const meta = BOSS_META[type];
  if (!meta) return 0;
  const raw = bossTargetSeconds(n) * expectedDps(n) * meta.typeMul * hpMul;
  return Math.max(400, Math.round(raw / 100) * 100);
}

/**
 * Boss 的人数血量系数。
 *
 * 小兵用 c^0.45 是因为"数量也跟着涨"，但 Boss 是单体：4 个人打同一个血条，
 * 0.45 次幂只补偿了一半，实际四人房的 Boss 战比单人快一倍多。
 * Boss 加血不影响渲染开销（r42 已验证），所以这里单独给一条更陡的曲线。
 */
export function bossHpMul(playerCount) {
  const c = Math.max(1, Math.min(4, playerCount || 1));
  return Math.pow(c, 0.8);
}

/**
 * 55 波后的觉醒词条：用组合换重复可玩性，不给每个 Boss 再造一套美术。
 *
 * ready=false 的词条不进抽取池。理由很直接：词条会在 HUD 上写出来，
 * 写了却没实现，等于告诉玩家"这个 Boss 有折射"然后什么也没发生——
 * 比没有这个词条更糟。等真正实现了再翻 ready。
 */
export const AWAKENS = [
  { id: 'frenzy', name: '狂暴', desc: '技能冷却 -20%', ready: true },
  { id: 'armor', name: '装甲', desc: '受到伤害 -25%', ready: true },
  { id: 'split', name: '分裂', desc: '死亡时裂成两个 30% 血的分身', ready: false },
  { id: 'regen', name: '再生', desc: '每秒回复 0.5% 最大血量', ready: true },
  { id: 'haste', name: '疾行', desc: '移动速度 +40%', ready: true },
  { id: 'summon', name: '召唤', desc: '额外 +30% 护卫', ready: true },
  { id: 'refract', name: '折射', desc: '所有子弹命中后分裂成两发', ready: false },
  { id: 'greed', name: '贪婪', desc: '掉落两个强化宝箱', ready: false },
];

/** 词条的数值，集中在这里——两端不可能各写一份。 */
export const AWAKEN_NUM = {
  cdMul: 0.8,        // 狂暴：技能冷却 ×0.8
  dmgMul: 0.75,      // 装甲：受到伤害 ×0.75
  regenPerSec: 0.005, // 再生：每秒回 0.5% 最大血量
  speedMul: 1.4,     // 疾行：移速 ×1.4
  escortMul: 1.3,    // 召唤：护卫 +30%
};

/** 55~70 波 1 个、75~90 波 2 个、95 波起 3 个。 */
export function awakensForWave(n) {
  if (n < 55) return 0;
  if (n < 75) return 1;
  if (n < 95) return 2;
  return 3;
}

/** 抽 n 个不重复词条。rng 必须是确定性流（联机要双端一致）。 */
export function rollAwakens(n, rng) {
  const pool = AWAKENS.filter((a) => a.ready);
  const want = Math.min(awakensForWave(n), pool.length);
  if (want <= 0) return [];
  const out = [];
  for (let i = 0; i < want; i++) {
    const k = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    out.push(pool.splice(k, 1)[0].id);
  }
  return out;
}

/** 词条数组 ↔ 位掩码（快照里只发一个整数） */
export function awakenMaskOf(ids = []) {
  let m = 0;
  for (const id of ids) {
    const i = AWAKENS.findIndex((a) => a.id === id);
    if (i >= 0) m |= (1 << i);
  }
  return m;
}

export function awakenIdsOf(mask = 0) {
  const out = [];
  for (let i = 0; i < AWAKENS.length; i++) if (mask & (1 << i)) out.push(AWAKENS[i].id);
  return out;
}

/** 给 HUD 用：掩码 → "装甲·再生" */
export function awakenNamesOf(mask = 0) {
  return awakenIdsOf(mask)
    .map((id) => (AWAKENS.find((a) => a.id === id) || {}).name)
    .filter(Boolean)
    .join('·');
}

/** 词条对技能冷却的影响（只有 frenzy 改 CD，其余在各自的结算点判断）。 */
export function skillCdMul(awakens = []) {
  return awakens.includes('frenzy') ? AWAKEN_NUM.cdMul : 1;
}

export function isAwakened(awakens, id) {
  return Array.isArray(awakens) && awakens.includes(id);
}

/**
 * 双生的共鸣钳位：把"比同伴低太多"的那只拉回来。
 *
 * @returns {number} 本 tick 应该补的血量（0 = 不用补）
 */
export function resonancePull(hp, otherHp, maxHp, dt) {
  const R = BOSS_SKILLS.resonance;
  const floor = otherHp - maxHp * R.gap;
  if (hp >= floor - 1e-6) return 0;
  // 按速率补而不是瞬间跳到钳位线：瞬移式回血会让玩家以为"血条显示错了"
  return Math.min(floor - hp, maxHp * R.pullRate * dt);
}

/** 终焉的三阶段：按血量比例算当前阶段（0/1/2） */
export function bossStageFor(ratio) {
  const th = BOSS_SKILLS.phases.thresholds;
  if (ratio > th[0]) return 0;
  if (ratio > th[1]) return 1;
  return 2;
}

/**
 * 阶段内血条进度（0~1）。
 *
 * 三阶段各算一条满格血条：玩家看到的是"这一阶段打了多少"，而不是
 * "整场打了多少"——后者在二阶段开始时只剩 2/3，看起来像打错了。
 */
export function stageBarRatio(ratio, stage) {
  const th = BOSS_SKILLS.phases.thresholds;
  const hi = stage === 0 ? 1 : th[stage - 1];
  const lo = th[stage] ?? 0;
  const span = Math.max(1e-6, hi - lo);
  return Math.max(0, Math.min(1, (ratio - lo) / span));
}

const wrapPi = (a) => {  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
};

/**
 * 点是否落在哨戒的双光束上。
 *
 * 判据是「横向偏移」而不是「角度差」：0.1 弧度的偏差在 5 米处只有半米，
 * 在 30 米处是 3 米——按角度判会让远端的光束变成一把看不见的巨剑。
 * 两端（单机 Enemy.js / 联机 world.js）都调这一个函数，不会各判一套。
 *
 * @param {number} x 光束原点
 * @param {number} z
 * @param {number} yaw 主光束朝向（第二道在 yaw + π）
 * @param {number} tx 目标点
 * @param {number} tz
 */
export function laserHits(x, z, yaw, tx, tz) {
  const L = BOSS_SKILLS.laser;
  const dx = tx - x;
  const dz = tz - z;
  const d = Math.hypot(dx, dz);
  if (d > L.len || d < 0.5) return false;
  const ang = Math.atan2(dx, dz);
  const off = Math.min(
    Math.abs(wrapPi(ang - yaw)),
    Math.abs(wrapPi(ang - yaw - Math.PI)),
  ) * d;
  return off < L.halfWidth;
}

// ---------------- 场地标记（zone） ----------------
//
// "地上画了个东西"统一成一条 { kind, x, z, r, t, ttl, dur }：
// 单机建特效、联机打包进快照的 bz，判定逻辑两端共用下面这一个 stepZones。
//
// 为什么判定也要共用：岩浆是"每 0.25 秒结算一次"的持续伤害，blast 是
// "寿命归零那一下结算一次"的一次性伤害——这两种时序各写一遍，迟早出现
// "单人房掉血、联机房不掉血"这种只有玩过两种模式的人才能发现的分叉。
export const ZONE = {
  WARN: 0,     // 跃迁预警：环随 t 收缩，收满即落地
  LAVA: 1,     // 岩浆：站上去持续掉血
  DASH: 2,     // 冲刺路径：只是可视
  SHOCK: 3,    // 冲击波：只是可视
  BLAST: 4,    // 炮击预警：t 走到 1 的那一下炸一次
};

/** 岩浆的结算粒度（秒）。逐帧结算会每帧推一个 hurt 事件，音效直接糊成一片。 */
const LAVA_TICK = 0.25;

/**
 * 推进所有场地标记，并结算它们造成的伤害。
 *
 * @param {object[]} zones  会被原地修改（推进 ttl、删除过期项）
 * @param {number} dt
 * @param {object[]} targets  有 { x, z, alive, down } 的目标（两端都适配）
 * @param {(t:object, amount:number)=>void} damage
 * @param {object[]} [events] 产出的事件（爆炸的视觉由调用方转成特效/网络事件）
 */
export function stepZones(zones, dt, targets, damage, events) {
  for (let i = zones.length - 1; i >= 0; i--) {
    const z = zones[i];
    z.ttl -= dt;
    z.t = z.dur > 0 ? Math.max(0, Math.min(1, 1 - z.ttl / z.dur)) : 1;

    if (z.kind === ZONE.LAVA) {
      z.acc = (z.acc || 0) + dt;
      if (z.acc >= LAVA_TICK) {
        const amount = BOSS_SKILLS.lava.dps * z.acc;
        z.acc = 0;
        for (const t of targets) {
          if (!t.alive || t.down) continue;
          if (Math.hypot(t.x - z.x, t.z - z.z) < z.r) damage(t, amount);
        }
      }
    } else if (z.kind === ZONE.BLAST) {
      // 到点爆炸：只结算一次，然后随 ttl 一起被删掉
      if (z.ttl <= 0 && !z.done) {
        z.done = true;
        for (const t of targets) {
          if (!t.alive || t.down) continue;
          if (Math.hypot(t.x - z.x, t.z - z.z) < z.r) damage(t, BOSS_SKILLS.barrage.dmg);
        }
        if (events) events.push({ kind: 'bossShock', x: z.x, z: z.z, r: z.r });
      }
    }

    if (z.ttl <= 0) zones.splice(i, 1);
  }
}

