// 阵营配色：车体底色负责「敌我」，炮塔识别灯负责「自己 / 队友 / 敌人」。
//
// 为什么要单独一个文件：
// 单机（Game.js / Enemy.js）和组队（coop.js）各自 new Tank，颜色以前是三处
// 各写一份——组队里玩家、队友、敌人全都没传颜色，一起落到 Tank 的默认绿
// 0x5f7a3c，战场上满屏绿车，只能靠头顶血条猜谁是谁。现在色板只有这一份，
// 谁建车都必须从这儿取色，漏传也会按 team 拿到阵营色而不是"默认绿"。
//
// 分工：
//   车体  body/accent —— 大色块，远距离一眼分敌我：我方军绿，敌方暖色（红橙黄）。
//   识别灯 lamp        —— 炮塔顶的小发光球，不受光照影响：自己青绿、队友青蓝、敌人红。
// 绿 = 我方、暖色 = 敌方，是 FPS/TPS 里最不需要学习成本的约定，
// 而且不与地形撞色（草绿地形上我方偏亮偏黄，敌方是全暖色）。
//
// 本文件不 import 任何渲染库，服务端/测试可以直接读。

import { CHASSIS } from './chassis.js';

/** 自己：直接取车体表的配色，保证"车库里的车"和"战场上的车"永远是同一辆 */
export const SELF_SKIN = {
  ...CHASSIS.panther.colors,
  lamp: 0x6bff9a,
};

/**
 * 队友：同阵营的暗一档军绿。
 *
 * 为什么不换色系（比如蓝）：四个人挤在一起时，改变色系会让"我方"变成两种
 * 颜色，反而要在脑子里维护两套映射；只压明度差一档，既保住"绿=友军"，
 * 又能从自己的亮绿里分出来。
 */
export const MATE_SKIN = {
  body: 0x6f8f4a,
  accent: 0x3f5426,
  metal: 0x363f3a,
  lamp: 0x37c8ff,
};

/**
 * 敌方：统一暖色系，按类型在红/橙/黄区间里分。
 *
 * 以前补给车是绿的（0x4f8f5f）、炮台是灰绿的，正好和我方撞色——玩家会朝
 * 补给车开火、或者对炮台放松警惕。现在所有敌人都落在暖色半边：
 * 类型只靠色相/明度细分，不再出现"绿色敌人"。
 */
const ENEMY_SKINS = {
  // 普通炮手：铁锈红，最典型的"敌军"
  gunner: { body: 0x9c4436, accent: 0x5a2419, metal: 0x332b28 },
  // 自爆冲锋：亮橙，一看就危险
  charger: { body: 0xbf5a22, accent: 0x6d2a0e, metal: 0x2b2522 },
  // 精英：金铜，明显比杂兵"贵"
  elite: { body: 0xb08a3a, accent: 0x6d5018, metal: 0x332b28 },
  // 无人机：品红（仍属暖色，且和地面任何颜色都不撞）
  drone: { body: 0x9c3f6e, accent: 0x55203c, metal: 0x2a2432 },
  // 固定炮台：灰褐，去掉了原来的灰绿
  turret: { body: 0x7d6a5e, accent: 0x453830, metal: 0x2e2b28 },
  // 补给车：沙黄（弹药车的语义），治疗光环仍然是绿圈——绿圈只表示"回血"
  support: { body: 0xa8903c, accent: 0x5f4f18, metal: 0x2b332c },
  // 重盾兵：暗红棕，厚重感
  shield: { body: 0x6e3a34, accent: 0x3d1d18, metal: 0x2a2e38 },
  // BOSS：破阵者是深绯，棱镜是冷青（唯一的冷色 BOSS，用体型和血条区分）
  boss_breaker: { body: 0x8a2e24, accent: 0x4a1410, metal: 0x2a2220 },
  boss_prism: { body: 0x2f6f86, accent: 0x1d4354, metal: 0x223038 },
};

/** 敌方识别灯：血红，和敌方血条同色 */
export const ENEMY_LAMP = 0xff3b26;

/** 取某个敌人类型的配色；未知类型退回普通炮手（永远是暖色，不会变成绿） */
export function enemySkin(type) {
  return ENEMY_SKINS[type] || ENEMY_SKINS.gunner;
}

/**
 * Tank 的最终配色：显式传入优先，缺省按 team 取阵营色。
 *
 * 存在意义就是"漏传不等于绿"：coop 以前三处 new Tank 全没传 body，
 * 于是玩家/队友/敌人共用 0x5f7a3c。现在只要 team 对，颜色就对。
 */
export function tankSkin({ team = 'enemy', type, body, accent, metal, lamp } = {}) {
  // 队友也走 team='player'（同阵营），靠显式传入 MATE_SKIN 区分，不另开一类
  const base = team === 'player' ? SELF_SKIN : enemySkin(type);
  return {
    body: body ?? base.body,
    accent: accent ?? base.accent,
    metal: metal ?? base.metal,
    lamp: lamp ?? (team === 'player' ? SELF_SKIN.lamp : ENEMY_LAMP),
  };
}

/** 全部敌方类型（给测试和 UI 用） */
export const ENEMY_SKIN_TYPES = Object.keys(ENEMY_SKINS);
