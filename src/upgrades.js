// 肉鸽强化系统
import { WEAPONS, weaponCards } from './weapons.js';
import { CHASSIS, normalizeChassisId } from './chassis.js';

export const RARITY = {
  common: { label: '常规', color: '#93a7b8' },
  rare: { label: '稀有', color: '#4aa6ff' },
  epic: { label: '史诗', color: '#c07bff' },
};

export function createStats(chassisId = 'panther') {
  const c = CHASSIS[normalizeChassisId(chassisId)];
  return {
    damageMul: 1,
    fireRateMul: 1,
    bulletSpeedMul: 1,
    splashDamageMul: 1,
    damageTakenMul: c.perks?.damageTakenMul ?? 1,
    speed: c.speed,
    maxHp: c.hp,
    // 每张卡已选次数。联机时要存进玩家状态、跟着重连恢复，
    // 所以不能再散落在 UI 的 this.upgradeCounts 里 ——
    // 单机的这份字段是给联机对齐用的同一形状，两边行为才一致。
    counts: {},
    multishot: 1,
    pierce: 0,
    explosive: 0,
    waveHeal: 0,
    killHeal: c.perks?.killHeal ?? 0,
    chassisId: c.id,
    weaponId: 'assault',
    weaponMods: {},
  };
}

export const UPGRADES = [
  {
    id: 'damage', name: '火力强化', icon: '💥', rarity: 'common', max: 5,
    desc: '主炮伤害 +22%',
    apply(s) { s.damageMul *= 1.22; },
  },
  {
    id: 'reload', name: '快速装填', icon: '⚡', rarity: 'common', max: 4,
    desc: '射速 +18%',
    apply(s) { s.fireRateMul *= 1.18; },
  },
  {
    id: 'engine', name: '涡轮增压', icon: '🛞', rarity: 'common', max: 4,
    desc: '移动速度 +12%',
    apply(s) { s.speed *= 1.12; },
  },
  {
    id: 'armor', name: '复合装甲', icon: '🛡', rarity: 'common', max: 5,
    desc: '装甲上限 +25，并修复 25',
    apply(s, p) { s.maxHp += 25; p.maxHp = s.maxHp; p.hp = Math.min(s.maxHp, p.hp + 25); },
  },
  {
    id: 'repair', name: '战地维修', icon: '🔧', rarity: 'common', max: 99,
    desc: '立即修复 45 点装甲',
    apply(s, p) { p.hp = Math.min(p.maxHp, p.hp + 45); },
  },
  {
    id: 'multishot', name: '双联炮组', icon: '🔫', rarity: 'rare', max: 2,
    desc: '每次开炮 +1 发（带散布）',
    apply(s) { s.multishot += 1; },
  },
  {
    id: 'pierce', name: '穿甲弹芯', icon: '🎯', rarity: 'rare', max: 2,
    desc: '子弹可多穿透 1 辆敌方坦克',
    apply(s) { s.pierce += 1; },
  },
  {
    id: 'explosive', name: '高爆弹头', icon: '💣', rarity: 'rare', max: 2,
    desc: '命中后引发爆炸，溅射 30 伤害',
    apply(s) { s.explosive += 1; },
  },
  {
    id: 'railgun', name: '电磁轨道', icon: '🚀', rarity: 'epic', max: 2,
    desc: '弹速 +35%，伤害 +12%',
    apply(s) { s.bulletSpeedMul *= 1.35; s.damageMul *= 1.12; },
  },
  {
    id: 'overload', name: '过载核心', icon: '🔥', rarity: 'epic', max: 1,
    desc: '伤害 +35%，射速 +20%',
    apply(s) { s.damageMul *= 1.35; s.fireRateMul *= 1.2; },
  },
  {
    id: 'reactive', name: '反应装甲', icon: '💠', rarity: 'rare', max: 2,
    desc: '受到的伤害 -12%',
    apply(s) { s.damageTakenMul *= 0.88; },
  },
  {
    id: 'nano', name: '纳米修复', icon: '🧬', rarity: 'common', max: 3,
    desc: '每波清除额外修复 12 点装甲',
    apply(s) { s.waveHeal += 12; },
  },
  {
    id: 'bulwark', name: '壁垒协议', icon: '🏰', rarity: 'epic', max: 1,
    desc: '受到的伤害 -22%，移动速度 -5%',
    apply(s) { s.damageTakenMul *= 0.78; s.speed *= 0.95; },
  },
];

/** 军械卡：选择后打开武器面板 */
export const ARMORY = {
  id: 'armory',
  name: '军械补给',
  icon: '🛠',
  rarity: 'epic',
  max: 99,
  armory: true,
  desc: '打开军械库，换装一门新主炮',
};

const WEIGHTS = { common: 62, rare: 30, epic: 12 };

/**
 * 按稀有度加权抽 n 张不重复的卡。
 * allowArmory 为真时，军械卡必定出现在结果里（随机位置）。
 */
export function rollChoices(counts, n = 3, { weaponId = 'assault', allowArmory = false } = {}) {
  const pool = UPGRADES.filter((u) => (counts[u.id] || 0) < u.max);
  for (const card of weaponCards(weaponId)) {
    if ((counts[card.id] || 0) < card.max) pool.push(card);
  }

  const picks = [];
  const want = allowArmory ? n - 1 : n;

  while (picks.length < want && pool.length > 0) {
    const total = pool.reduce((sum, u) => sum + WEIGHTS[u.rarity], 0);
    let r = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= WEIGHTS[pool[i].rarity];
      if (r <= 0) { idx = i; break; }
    }
    picks.push(pool.splice(idx, 1)[0]);
  }

  if (allowArmory) {
    picks.splice((Math.random() * (picks.length + 1)) | 0, 0, ARMORY);
  }

  return picks;
}

/** 武器专属卡也按同样方式查定义（给 HUD 显示用） */
export function findUpgrade(counts, weaponId, id) {
  for (const u of UPGRADES) if (u.id === id) return u;
  for (const u of weaponCards(weaponId)) if (u.id === id) return u;
  if (id === ARMORY.id) return ARMORY;
  return null;
}

export { WEAPONS };
