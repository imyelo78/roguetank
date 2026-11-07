import { R } from './rng.js';

// 挑战词条：每局开局随机一条全局规则，改变整局节奏并给予得分补偿。
// 数值类词条在 start() 时注入 stats（如射速），节奏类通过 Game.mods 查询。
// 注：原"钢铁风暴"（炮击间隔缩短）随炮击系统一起移除，词条池剩 4 条。

export const MODIFIERS = {
  ammo: {
    id: 'ammo',
    name: '弹药告急',
    icon: '📦',
    desc: '射速 -20% · 清波奖励 ×1.5',
    fireRateMul: 0.8,
    waveBonusMul: 1.5,
  },
  elite: {
    id: 'elite',
    name: '精英猎场',
    icon: '🎯',
    desc: '每波必出精英 · 精英击破 +200',
    eliteEveryWave: true,
    eliteScoreBonus: 200,
  },
  fog: {
    id: 'fog',
    name: '迷雾战场',
    icon: '🌫',
    desc: '视距减半 · 击杀得分 ×1.4',
    fogNear: 52,
    fogFar: 115,
    killScoreMul: 1.4,
  },
  race: {
    id: 'race',
    name: '军备竞赛',
    icon: '⚔',
    desc: '敌人血量 +30% · 军械补给改为每 2 波',
    enemyHpMul: 1.3,
    armoryEvery: 2,
  },
};

export const MODIFIER_DEFAULTS = {
  killScoreMul: 1,
  waveBonusMul: 1,
  fireRateMul: 1,
  eliteEveryWave: false,
  eliteScoreBonus: 0,
  fogNear: null,
  fogFar: null,
  enemyHpMul: 1,
  armoryEvery: 3,
};

/**
 * 随机抽一条词条，返回合并默认值后的对象（含 id/name/icon/desc）。
 * 默认走 spawn 流：词条决定「这一局长什么样」，必须与玩家的战斗行为无关，
 * 否则同一个挑战码在不同人手里会抽出不同词条。
 */
export function rollModifier(rng) {
  const r = rng || (() => R.spawn());
  const list = Object.values(MODIFIERS);
  const def = list[(r() * list.length) | 0];
  return { ...MODIFIER_DEFAULTS, ...def };
}
