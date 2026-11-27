// 维莱博卡日（Villers-Bocage）· 1944-06-13 0900 · N175 公路遭遇战
//
// 「经典战役」第一关：玩家扮演魏特曼车组，从 213 高地南侧的卡昂古道林带
// 杀出，沿 N175 公路从东头撞进英军第 4 伦敦郡义勇骑兵团（4th CLY）的停驻
// 纵队，**沿公路逐个点名**，最后向东突围、从撤离点全身而退。
//
// ============ 布阵依据（为什么是这些车、这个顺序） ============
//
// 布阵与推进顺序按丹尼尔·泰勒《Villers-Bocage: Operation 'Perch': The
// Complete Account》（After the Battle, 2023）还原，从东（213 高地）到西（镇
// 内）依次是：
//
//   A 中队 4 分队（213 脚下）→ 邓洛普的炮兵观察克伦威尔 → A 中队 2/3/1
//   分队 → 步枪旅 1 营 A 连的半履带/运载车队（**路南侧**，给后续部队让路）
//   → 巴特勒反坦克排（2 门 6 磅炮）→ 英格拉姆的 2 辆斯图亚特 + 团部
//   （卡尔/汤普森/戴斯的克伦威尔）→ 医官半履带（街角）→ 威尔斯的观察
//   谢尔曼 + 维克托里的观察克伦威尔 → 史密斯分队的斯图亚特 → 镇西 B 中队
//   （洛克伍德的萤火虫）与圣女贞德广场的 6 磅炮。
//
// 纵队**车头一律朝东**（行军方向，213 一侧）——魏特曼从东杀来，打的是
// 纵队头部的正面、其余车辆的侧后。英军步兵已下车，车辆停在公路上等
// 步兵归队：所以本关的英军**不冲锋**（Enemy 的 hold 行为），醒来只是
// 转炮塔还击。这是"遭遇战"与"围殴"的分界线。
//
// ============ 坐标系与比例 ============
//
// 世界坐标：+x 东、+z 南、-z 北（yaw=0 朝 +z，yaw=π/2 朝 +x/东）。
// 真实镇中心到 213 约 1.5 km，压缩到约 170 m（≈1:10）；路面、房屋、
// 车距按真实尺寸不压缩。压缩的取舍见 git 历史，这里只留结论：
// 15 m/s 的坦克跑 1.5 km 中间没有决策点，压缩后"213 林口 → 队头 →
// 步枪旅车队 → 镇口"四个决策点落在 20~40 秒间隔上。
//
// ============ 没有还原、以及为什么 ============
//
// 1. **高差**。引擎是平面地图，213 的海拔没法表达；用东北角的林地围合
//    + 213 土路下坡的视觉关系代替（玩家从林口出来，公路横在脚下）。
// 2. **A 中队编制是 4 个分队 × (1 萤火虫 + 3 克伦威尔) + 团部**，全放是
//    19 辆坦克；本图每分队取 1 萤火虫 + 2 克伦威尔，步枪旅 A 连 8 半履带
//    + 4 运载车取 3+2。顺序与类型严格按史实，数量压缩是游戏节奏的让步。
// 3. **车号不标**。212 还是 222 至今没定论（docs/boss-plan.md 记过罗生门）。

import { T_GRASS, T_ROAD } from './terrain.js';

/** 关卡元信息。名字与日期直接上 HUD，不要在这里塞玩法文案 */
export const BATTLE = {
  id: 'villers',
  name: '维莱博卡日',
  subtitle: '1944-06-13 · 0900 · N175 公路',
  seed: 19440613,
  /** 纵向压缩比：1 米地图 ≈ 10 米真实。HUD 的"真实距离"换算用 */
  scale: 10,
};

/**
 * 四档难度。用户定的规则：敌军坦克的血量和炮弹速度逐步提高——
 * 就只有这两个轴，不再加第三条（反应速度/索敌范围一加，"冷血"和
 * "魏神"就分不开了）。数值是公开的，HUD 上玩家看得见自己在选什么。
 */
export const DIFFICULTIES = [
  { id: 'novice', name: '新手', hpMul: 0.6, shellSpeed: 0.7 },
  { id: 'normal', name: '普通', hpMul: 1.0, shellSpeed: 1.0 },
  { id: 'ruthless', name: '冷血', hpMul: 1.4, shellSpeed: 1.3 },
  { id: 'wittmann', name: '魏神', hpMul: 1.9, shellSpeed: 1.6 },
];

/** 按难度 id 查档；不认识的一律落回"普通"，别让手滑的存档开成隐藏档 */
export function difficultyById(id) {
  return DIFFICULTIES.find((d) => d.id === id) || DIFFICULTIES[1];
}

/**
 * 玩家起点：卡昂古道（213 南侧的下沉土路）路面上，2 连当晚的隐蔽位置。
 * 面朝北偏西：穿出林口北门就是 N175 东头，A 中队 4 分队就停在正前方。
 */
export const PLAYER_START = { x: 76, z: 32, yaw: -3.03 };

/**
 * 撤离点：古道东端（2 连来路 / 驻地一侧）。
 * 战果达标前是灰的；达标后变琥珀色，开进去 = 全身而退 = 胜利。
 * 放在出生点东边 10 m：够近（本来就是要撤回出发地），又不会
 * "杀满 22 个的瞬间人正好站在圈里"直接白给。
 */
export const EXTRACTION = { x: 86, z: 32, r: 8 };

/** 圣女贞德广场。用于"深入广场"的提示，不是胜利条件 */
export const TOWN_CENTER = { x: -62, z: 0, r: 14 };

/**
 * 公路网：显式折线，交给 core/terrain.js 按米坐标刷成 T_ROAD。
 * N175 沿 z=0 横贯全图（东：213/卡昂方向；西：穿镇而过）。
 * 蒂利路口在 x=0（南北向岔路向南去蒂利）。
 * 卡昂古道是 213 南侧与 N175 平行的下沉土路——魏特曼当晚的隐蔽位。
 */
export const ROADS = [
  { width: 12, pts: [[102, 0], [-102, 0]] },            // N175 + 镇内主街
  { width: 7, pts: [[0, 6], [0, 64]] },                 // 蒂利路口（向南）
  { width: 6, pts: [[58, 32], [98, 32]] },              // 卡昂古道
  { width: 6, pts: [[71, -26], [71, -2]] },             // 213 土路（下坡）
];

// ---------------- 掩体 ----------------

const C_HEDGE = '#3f4d31';   // 树篱：诺曼底 6 月的深绿
const C_BANK = '#5b5342';    // 土堤：树篱底部的石土
const C_HOUSE = '#8c8375';   // 石灰岩农舍
const C_HOUSE2 = '#7d7568';
const C_BARN = '#6f6659';
const C_CHURCH = '#93887a';

/**
 * 树篱段。axis='z'：南北走向；axis='x'：东西走向。
 * 厚 1.5 m、高 2.5 m —— 真实 bocage 是 2~3 m 高的土堤加灌木，坦克撞不过去、
 * 平射炮弹也打不穿，只能从田口绕。这是"英军纵队为什么跑不掉"的地形前提，
 * 也是玩家撤离时"不能原路直线冲回去"的原因。
 */
function hedgeZ(x, z0, z1, color = C_HEDGE) {
  const d = Math.abs(z1 - z0);
  return [x, (z0 + z1) / 2, 1.5, 2.5, d, color];
}
function hedgeX(z, x0, x1, color = C_HEDGE) {
  const w = Math.abs(x1 - x0);
  return [(x0 + x1) / 2, z, w, 2.5, 1.5, color];
}

/** 房屋：[x, z, w, h, d, color]。h 只影响渲染，碰撞只认 w/d */
function house(x, z, w, d, h = 7, color = C_HOUSE) {
  return [x, z, w, h, d, color];
}

/**
 * 全部掩体。坐标是设计出来的，不参与随机扰动——战役图必须每局一模一样。
 * 内部用六元组写，出口统一转成 level.setLayout 认识的对象形状。
 */
export function buildVillersBoxes() {
  const b = [];

  // ---- 1. N175 两侧的连续树篱（纵队的"墙"） ----
  //
  // 北侧 z=-9：从镇口铺到 213 林区西侧。缺口是田口（4~8 m），玩家撤离时
  // 从公路拐进北侧田野就得走这些口。与南侧缺口错开，公路不是一条漏斗。
  b.push(hedgeZ(-9, -6, 8));
  b.push(hedgeZ(-9, 12, 20));
  b.push(hedgeZ(-9, 24, 40));
  b.push(hedgeZ(-9, 44, 60));
  // 南侧 z=+9：到 60 为止（以东是卡昂古道林区，自己有围合）
  b.push(hedgeZ(9, -6, 2));
  b.push(hedgeZ(9, 6, 14));
  b.push(hedgeZ(9, 18, 26));
  b.push(hedgeZ(9, 30, 38));
  b.push(hedgeZ(9, 42, 56));
  // 田口门柱（土堤色，纯视觉）
  b.push(hedgeZ(-9, 8.5, 11.5, C_BANK));
  b.push(hedgeZ(-9, 20.5, 23.5, C_BANK));
  b.push(hedgeZ(9, 2.5, 5.5, C_BANK));
  b.push(hedgeZ(9, 14.5, 17.5, C_BANK));

  // ---- 2. 213 高地林区（东北角） ----
  //
  // 三面围合，南侧留 68~74 的口接土路。A 中队 4 分队就停在林口外的公路上：
  // 玩家从卡昂古道穿过来，第一眼就是它们。
  b.push(hedgeX(-24, 64, 68));       // 南缘西段（口以西）
  b.push(hedgeX(-24, 74, 96));       // 南缘东段（口以东）
  b.push(hedgeZ(64, -56, -24));      // 西缘
  b.push(hedgeX(-56, 64, 96));       // 北缘
  b.push(hedgeZ(96, -56, -24));      // 东缘
  b.push(house(84, -44, 12, 9, 6.5, C_BARN));   // 213 农舍
  b.push([78, -32, 4, 6, 4, C_HEDGE]);
  b.push([88, -36, 3.5, 5, 3.5, C_HEDGE]);
  b.push([74, -48, 3, 5, 3, C_HEDGE]);

  // ---- 3. 卡昂古道林区（东南角，玩家出发地 + 撤离点） ----
  //
  // 古道（z=32）从林区中穿过：北排树篱 z=24（留 78~88 的北门，玩家出发
  // 朝北穿门上公路）、南排 z=40、西端封死、东端出图。撤离点在 (80,42)。
  b.push(hedgeX(24, 60, 78));
  b.push(hedgeX(24, 88, 96));        // 北门 78~88
  b.push(hedgeX(40, 60, 96));        // 南排
  b.push(hedgeZ(60, 24, 40));        // 西端
  b.push(hedgeZ(96, 24, 40));        // 东端（出图侧）
  b.push(hedgeZ(78, 40, 48));        // 撤离点西侧的遮蔽
  b.push([68, 30, 3.5, 5, 3.5, C_HEDGE]);
  // 这两丛在路面以南：不许压古道（z 29~35 是撤离路线，堵了就是"撤离点
  // 永远到不了"的关卡 bug）
  b.push([90, 38, 4, 6, 4, C_HEDGE]);
  b.push(house(62, 50, 10, 8, 6, C_BARN));      // 路口农舍

  // ---- 4. 公路两侧的田野分割（撤离时的绕行路线） ----
  //
  // 北侧田野（z -20 ~ -90）：东西向树篱切块。撤离不能沿公路原路直线冲回
  // （醒过来的纵队侧射），玩家要么钻田口绕行、要么硬穿火线——这是本关
  // 结尾的核心张力。
  b.push(hedgeX(-24, 8, 64));        // 213 林区南缘与公路之间
  b.push(hedgeX(-44, -6, 60));
  b.push(hedgeX(-64, -6, 60));
  b.push(hedgeX(-24, 60, 96));       // 林区以北
  b.push(hedgeX(-56, 64, 92));
  // 南侧田野（z +20 ~ +90）
  b.push(hedgeX(20, -8, 56));
  b.push(hedgeX(40, -8, 56));
  b.push(hedgeX(60, -8, 56));
  b.push(hedgeX(56, 64, 92));        // 古道以南
  b.push(hedgeX(76, 62, 92));

  // ---- 5. 镇区：两排石屋夹主街 ----
  //
  // 街宽 12 m。房屋 5 m 间距当巷子（史实镇子几乎没有缝，全封死的话进镇
  // 就只剩一条线）。北排（z=-16）与南排（z=+16）错位排布，巷口互错。
  // 圣女贞德广场在镇西端（-56~-70 一带放开），6 磅炮伏击位。
  // 北排
  b.push(house(-16, -16, 13, 10));
  b.push(house(-34, -16, 13, 10, 7, C_HOUSE2));
  b.push(house(-52, -16, 13, 10));
  b.push(house(-70, -16, 13, 10, 7, C_HOUSE2));
  b.push(house(-88, -16, 13, 10, 6.5, C_CHURCH));   // 教堂：镇西端地标
  // 南排
  b.push(house(-25, +16, 13, 10, 6.5, C_HOUSE2));
  b.push(house(-43, +16, 13, 10));
  b.push(house(-61, +16, 13, 10, 7, C_HOUSE2));
  b.push(house(-79, +16, 13, 10));
  // 镇口（东侧）夹道：从公路进镇的第一眼，两侧各一栋
  b.push(house(-8, -12, 9, 8, 6, C_HOUSE2));         // 北侧小屋（戴斯的巷子旁）
  b.push(house(-14, +11, 9, 8, 6));                  // 南侧小屋
  // 广场收口：北侧一栋深宅，把广场从主街尽头围出来
  b.push(house(-62, -22, 16, 9, 8, C_HOUSE));
  // 蒂利路口的小屋（x=0 岔口西南）
  b.push(house(6, +13, 10, 8, 6, C_HOUSE2));

  return b.map(([x, z, w, h, d, color]) => ({ x, z, w, h, d, color }));
}

// ---------------- 英军布阵 ----------------
//
// 单位类型映射（沿用现成的敌人 AI，不新开一套）：
//   cromwell → gunner   克伦威尔巡洋坦克，本关血量 150
//   firefly  → elite    萤火虫（17 磅炮），血量 420，纵队里最危险的目标
//   stuart   → gunner   斯图亚特轻坦，血量 90，快但脆
//   halftrack→ gunner   半履带/运载车，血量 55~70，一炮就散
//   op       → gunner   炮兵观察坦克，血量 130
//   atgun    → turret   6 磅反坦克炮，固定、射程 38 m，伏击位
//
// 全员 hold（驻军）：车体钉在原地，醒来只转炮塔还击——纵队是停驻状态，
// 步兵在车外，不是会冲锋的猎杀 AI。血量档位是为了节奏不是装甲还原：
// 玩家 88 炮单发约 44 伤，克伦威尔 4 发、萤火虫 10 发、半履带 2 发。
// 难度的 hpMul 只乘这些数（见 DIFFICULTIES）。

export const UNITS = [
  // ---- A 中队 4 分队（213 林口正下方，纵队头部；历史上最先挨打） ----
  // yaw=π/2 朝 +x（东，行军方向/213 一侧）——魏特曼从东来，打的是它们的正面
  { x: 72, z: -3, yaw: 1.5708, type: 'elite', hp: 420, role: 'firefly', tag: 'A 中队 4 分队 · 萤火虫' },
  { x: 72, z: 3, yaw: 1.5708, type: 'gunner', hp: 150, role: 'cromwell', tag: 'A 中队 4 分队 · 克伦威尔' },
  { x: 68, z: -3, yaw: 1.5708, type: 'gunner', hp: 150, role: 'cromwell', tag: 'A 中队 4 分队 · 克伦威尔' },
  // 邓洛普的炮兵观察克伦威尔（5th RHA），跟在纵队前半段
  { x: 68, z: 3, yaw: 1.5708, type: 'gunner', hp: 130, role: 'op', tag: '邓洛普 · 观察克伦威尔' },

  // ---- A 中队 2 分队（213 西坡） ----
  { x: 62, z: -3, yaw: 1.5708, type: 'elite', hp: 420, role: 'firefly', tag: 'A 中队 2 分队 · 萤火虫' },
  { x: 62, z: 3, yaw: 1.5708, type: 'gunner', hp: 150, role: 'cromwell', tag: 'A 中队 2 分队 · 克伦威尔' },
  { x: 58, z: -3, yaw: 1.5708, type: 'gunner', hp: 150, role: 'cromwell', tag: 'A 中队 2 分队 · 克伦威尔' },

  // ---- A 中队 3 分队（斜坡末端） ----
  { x: 58, z: 3, yaw: 1.5708, type: 'elite', hp: 420, role: 'firefly', tag: 'A 中队 3 分队 · 萤火虫' },
  { x: 54, z: -3, yaw: 1.5708, type: 'gunner', hp: 150, role: 'cromwell', tag: 'A 中队 3 分队 · 克伦威尔' },
  { x: 54, z: 3, yaw: 1.5708, type: 'gunner', hp: 150, role: 'cromwell', tag: 'A 中队 3 分队 · 克伦威尔' },

  // ---- A 中队 1 分队（镇子与斜坡之间的开阔地） ----
  { x: 48, z: -3, yaw: 1.5708, type: 'elite', hp: 420, role: 'firefly', tag: 'A 中队 1 分队 · 萤火虫' },
  { x: 48, z: 3, yaw: 1.5708, type: 'gunner', hp: 150, role: 'cromwell', tag: 'A 中队 1 分队 · 克伦威尔' },
  { x: 44, z: -3, yaw: 1.5708, type: 'gunner', hp: 150, role: 'cromwell', tag: 'A 中队 1 分队 · 克伦威尔' },

  // ---- 步枪旅 1 营 A 连（路南侧让行的车队） ----
  // 停在道路右侧（南），给后续部队留出通车的一半路面——所以玩家沿公路
  // 西行时，它们全部暴露在右手侧。历史上这一段是"战车墓地"的主体。
  { x: 30, z: 5, yaw: 1.5708, type: 'gunner', hp: 70, role: 'halftrack', tag: '步枪旅 A 连 · 半履带' },
  { x: 26, z: 5, yaw: 1.5708, type: 'gunner', hp: 70, role: 'halftrack', tag: '步枪旅 A 连 · 半履带' },
  { x: 22, z: 5, yaw: 1.5708, type: 'gunner', hp: 55, role: 'carrier', tag: '步枪旅 A 连 · 运载车' },
  { x: 18, z: 5, yaw: 1.5708, type: 'gunner', hp: 70, role: 'halftrack', tag: '步枪旅 A 连 · 半履带' },
  { x: 14, z: 5, yaw: 1.5708, type: 'gunner', hp: 55, role: 'carrier', tag: '步枪旅 A 连 · 运载车' },

  // ---- 巴特勒反坦克排（2 门 6 磅炮，路南侧） ----
  { x: 10, z: 5, yaw: 1.5708, type: 'turret', hp: 200, role: 'atgun', tag: '巴特勒排 · 6 磅炮' },
  { x: 6, z: 5, yaw: 1.5708, type: 'turret', hp: 200, role: 'atgun', tag: '巴特勒排 · 6 磅炮' },

  // ---- 英格拉姆的侦察斯图亚特 + 团部（镇东口） ----
  { x: 2, z: -3, yaw: 1.5708, type: 'gunner', hp: 90, role: 'stuart', tag: '英格拉姆 · 斯图亚特' },
  { x: 2, z: 3, yaw: 1.5708, type: 'gunner', hp: 90, role: 'stuart', tag: '英格拉姆 · 斯图亚特' },
  { x: -2, z: -3, yaw: 1.5708, type: 'gunner', hp: 150, role: 'cromwell', tag: '团部 · 卡尔的克伦威尔' },
  { x: -2, z: 3, yaw: 1.5708, type: 'gunner', hp: 150, role: 'cromwell', tag: '团部 · 汤普森的克伦威尔' },
  // 戴斯的克伦威尔：停在侧面巷子里，魏特曼第一遍冲过去时没看见它
  { x: -10, z: -13, yaw: 1.5708, type: 'gunner', hp: 150, role: 'cromwell', tag: '团部 · 戴斯（巷内）' },

  // ---- 镇内主街（西向） ----
  { x: -12, z: 4, yaw: 1.5708, type: 'gunner', hp: 70, role: 'halftrack', tag: '医官麦克莱恩 · 半履带' },
  { x: -16, z: -3, yaw: 1.5708, type: 'gunner', hp: 130, role: 'op', tag: '威尔斯 · 观察谢尔曼' },
  { x: -20, z: 3, yaw: 1.5708, type: 'gunner', hp: 130, role: 'op', tag: '维克托里 · 观察克伦威尔' },
  { x: -24, z: -3, yaw: 1.5708, type: 'gunner', hp: 90, role: 'stuart', tag: '史密斯分队 · 斯图亚特' },
  { x: -28, z: 3, yaw: 1.5708, type: 'gunner', hp: 90, role: 'stuart', tag: '史密斯分队 · 斯图亚特' },
  { x: -32, z: -3, yaw: 1.5708, type: 'gunner', hp: 90, role: 'stuart', tag: '史密斯分队 · 斯图亚特' },

  // ---- 镇西 B 中队 + 圣女贞德广场的 6 磅炮 ----
  { x: -38, z: -3, yaw: 1.5708, type: 'gunner', hp: 150, role: 'cromwell', tag: 'B 中队 · 克伦威尔' },
  { x: -44, z: 3, yaw: 1.5708, type: 'elite', hp: 420, role: 'firefly', tag: 'B 中队 · 萤火虫' },
  // 洛克伍德的萤火虫：主街尽头朝东列阵。历史上它跟虎式在街上对射，魏特曼
  // 就是打到这里掉头撤退的——本关最深处的"硬点"，撤离路线上的最大威胁。
  { x: -50, z: -3, yaw: 1.5708, type: 'elite', hp: 420, role: 'firefly', tag: 'B 中队 · 洛克伍德的萤火虫' },
  { x: -56, z: 4, yaw: 1.5708, type: 'turret', hp: 200, role: 'atgun', tag: '广场 · 6 磅炮（东）' },
  { x: -62, z: -4, yaw: 1.5708, type: 'turret', hp: 200, role: 'atgun', tag: '广场 · 6 磅炮' },
];

/**
 * 目标：击毁 22 辆。
 *
 * 全场 36 个目标里，公路东段（A 中队 + 步枪旅 + 反坦克排 + 侦察/团部）
 * 恰好 22 个——"沿公路逐个点名打穿纵队"就达标；想多拿战果就往镇里
 * 走，洛克伍德的萤火虫和广场的 6 磅炮在等。达标后撤离点开启，向东
 * 突围、全身而退 = 通关。
 */
export const OBJECTIVE = {
  kills: 22,
  /** 秒。真实单车突入持续 20~30 分钟；给足 15 分钟是游戏节奏 */
  timeLimit: 15 * 60,
};

/** 战场宽度（HALF）。与 levelgen 一致，这里只导出给测试用，不要另建一张图 */
export { T_GRASS, T_ROAD };
