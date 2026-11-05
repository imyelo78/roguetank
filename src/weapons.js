// 局内武器定义与武器专属强化
// 基础数值由武器决定，通用强化通过倍率叠加，切换武器后依然生效。

function mods(s, id) {
  return s.weaponMods[id] || (s.weaponMods[id] = {});
}

export const WEAPONS = {
  assault: {
    id: 'assault',
    name: '突击炮',
    icon: '🎯',
    tag: '均衡',
    uiColor: '#ffcf8a',
    desc: '单发高伤、射速均衡，中距离对炮最稳。',
    damage: 26,
    fireCd: 0.4,
    minFireCd: 0.22,
    bulletSpeed: 68,
    color: 0xfff3c4,
    glow: 0xffb03a,
    bulletScale: 1,
    cards: [
      {
        id: 'assault_brake', name: '炮口制退器', icon: '🛠', rarity: 'common', max: 2,
        desc: '突击炮：射速 +12%，伤害 +8%',
        apply(s) {
          const m = mods(s, 'assault');
          m.fireRate = (m.fireRate || 1) * 1.12;
          m.damage = (m.damage || 1) * 1.08;
        },
      },
      {
        id: 'assault_ap', name: '钨芯穿甲弹', icon: '🎯', rarity: 'rare', max: 2,
        desc: '突击炮：穿透 +1，弹速 +15%',
        apply(s) {
          const m = mods(s, 'assault');
          m.pierce = (m.pierce || 0) + 1;
          m.speed = (m.speed || 1) * 1.15;
        },
      },
    ],
  },

  gatling: {
    id: 'gatling',
    name: '速射机炮',
    icon: '🔫',
    tag: '压制',
    uiColor: '#ffd24a',
    desc: '低单发伤害、极高射速，弹道散布略大。',
    damage: 11,
    fireCd: 0.115,
    minFireCd: 0.07,
    bulletSpeed: 82,
    color: 0xffe9a8,
    glow: 0xffc23a,
    bulletScale: 0.72,
    spread: 0.028,
    cards: [
      {
        id: 'gatling_cool', name: '枪管散热器', icon: '❄', rarity: 'rare', max: 2,
        desc: '速射机炮：射速 +18%，散布 -20%',
        apply(s) {
          const m = mods(s, 'gatling');
          m.fireRate = (m.fireRate || 1) * 1.18;
          m.spread = (m.spread || 1) * 0.8;
        },
      },
      {
        id: 'gatling_ammo', name: '穿甲弹链', icon: '🔗', rarity: 'epic', max: 1,
        desc: '速射机炮：伤害 +25%，穿透 +1',
        apply(s) {
          const m = mods(s, 'gatling');
          m.damage = (m.damage || 1) * 1.25;
          m.pierce = (m.pierce || 0) + 1;
        },
      },
    ],
  },

  laser: {
    id: 'laser',
    name: '激光过热',
    icon: '⚡',
    tag: '爆发',
    uiColor: '#5fe0ff',
    desc: '高伤光束可穿透，连续射击会过热；停火后冷却。',
    damage: 30,
    fireCd: 0.24,
    minFireCd: 0.16,
    bulletSpeed: 180,
    color: 0x9ff4ff,
    glow: 0x38d8ff,
    bulletScale: 0.8,
    pierce: 1,
    heat: { perShot: 0.075, cool: 0.34, lockCool: 0.5 },
    cards: [
      {
        id: 'laser_cool', name: '超导冷却', icon: '❄', rarity: 'rare', max: 2,
        desc: '激光：热量增长 -22%，冷却速度 +25%',
        apply(s) {
          const m = mods(s, 'laser');
          m.heat = (m.heat || 1) * 0.78;
          m.cool = (m.cool || 1) * 1.25;
        },
      },
      {
        id: 'laser_focus', name: '聚焦透镜', icon: '🔍', rarity: 'epic', max: 1,
        desc: '激光：伤害 +30%，穿透 +1',
        apply(s) {
          const m = mods(s, 'laser');
          m.damage = (m.damage || 1) * 1.3;
          m.pierce = (m.pierce || 0) + 1;
        },
      },
    ],
  },

  mortar: {
    id: 'mortar',
    name: '榴弹炮',
    icon: '💣',
    tag: '范围',
    uiColor: '#ff8a5a',
    desc: '慢速重弹，命中后大范围爆炸，专治集群。',
    damage: 64,
    fireCd: 0.95,
    minFireCd: 0.62,
    bulletSpeed: 44,
    color: 0xffd08a,
    glow: 0xff6a2a,
    bulletScale: 1.55,
    explosive: 1,
    splashMul: 1.25,
    cards: [
      {
        id: 'mortar_charge', name: '高爆装药', icon: '💥', rarity: 'rare', max: 2,
        desc: '榴弹炮：爆炸范围 +20%，溅射伤害 +30%',
        apply(s) {
          const m = mods(s, 'mortar');
          m.splash = (m.splash || 1) * 1.2;
          s.splashDamageMul *= 1.3;
        },
      },
      {
        id: 'mortar_loader', name: '自动装填机', icon: '⚙', rarity: 'rare', max: 2,
        desc: '榴弹炮：射速 +15%，弹速 +10%',
        apply(s) {
          const m = mods(s, 'mortar');
          m.fireRate = (m.fireRate || 1) * 1.15;
          m.speed = (m.speed || 1) * 1.1;
        },
      },
    ],
  },
};

/** 根据基础武器 + 通用倍率 + 武器专属改装，算出当前实际数值 */
export function resolveWeapon(stats) {
  const w = WEAPONS[stats.weaponId] || WEAPONS.assault;
  const m = stats.weaponMods[w.id] || {};
  const fireRate = stats.fireRateMul * (m.fireRate || 1);
  const heat = w.heat ? {
    perShot: w.heat.perShot * (m.heat || 1),
    cool: w.heat.cool * (m.cool || 1),
    lockCool: w.heat.lockCool * (m.cool || 1),
  } : null;

  return {
    weapon: w,
    damage: w.damage * stats.damageMul * (m.damage || 1),
    fireCd: Math.max(w.minFireCd, w.fireCd / fireRate),
    bulletSpeed: w.bulletSpeed * stats.bulletSpeedMul * (m.speed || 1),
    pierce: stats.pierce + (w.pierce || 0) + (m.pierce || 0),
    explosive: stats.explosive + (w.explosive || 0),
    splashMul: (w.splashMul || 1) * (m.splash || 1),
    spread: (w.spread || 0) * (m.spread || 1),
    heat,
    color: w.color,
    glow: w.glow,
    scale: w.bulletScale,
  };
}

/** 当前武器专属强化（用于抽卡池） */
export function weaponCards(weaponId) {
  const w = WEAPONS[weaponId] || WEAPONS.assault;
  return w.cards;
}
