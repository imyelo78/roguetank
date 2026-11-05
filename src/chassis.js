// 车体定义：开局选择，决定装甲/移速基础值与车体配色、专属特性。
// 主炮（weapons.js）与车体（本文件）自由组合，强化卡对两者通吃。

export const CHASSIS = {
  balanced: {
    id: 'balanced',
    name: '均衡型',
    icon: '🎖',
    tag: '标准',
    desc: '各项均衡，任何主炮都能胜任。',
    hp: 120,
    speed: 15,
    colors: { body: 0x8fae5c, accent: 0x53682f, metal: 0x3a4048 },
    perks: {},
  },

  light: {
    id: 'light',
    name: '轻装突击型',
    icon: '🏍',
    tag: '高速',
    desc: '低血高机动，靠走位躲弹幕，玻璃大炮打法。',
    hp: 90,
    speed: 19.5,
    colors: { body: 0x6f9ab5, accent: 0x33566e, metal: 0x2c333b },
    perks: {},
  },

  heavy: {
    id: 'heavy',
    name: '重装堡垒型',
    icon: '🛡',
    tag: '重甲',
    desc: '厚实但笨重，受到的伤害永久 -15%。',
    hp: 170,
    speed: 11.5,
    colors: { body: 0x8a8f78, accent: 0x4d5140, metal: 0x35392f },
    perks: { damageTakenMul: 0.85 },
  },

  hunter: {
    id: 'hunter',
    name: '猎手型',
    icon: '🏹',
    tag: '续航',
    desc: '每次击毁敌人修复 3 点装甲，越战越勇。',
    hp: 110,
    speed: 14,
    colors: { body: 0xb58a4a, accent: 0x6e5226, metal: 0x33302a },
    perks: { killHeal: 3 },
  },
};

export const CHASSIS_LIST = Object.values(CHASSIS);
