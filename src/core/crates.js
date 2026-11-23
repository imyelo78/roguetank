// 战场宝箱（r43）：每波开局按人数空投强化宝箱，玩家开到旁边自动拾取。
//
// **纯函数，不碰 DOM、不碰 three**——联机服务端要 import 它（Node 环境），
// 单机也要 import 它，所以依赖只允许 core/ 与 upgrades.js。
//
// 设计要点：
//   - 宝箱带**类别**而不是具体卡：内容在拾取那一刻才按拾取者的成长状态
//     开出来。这样两个人抢同一个箱子各得其所（谁开到算谁的，开的卡
//     一定对他有效），也天然规避"箱子里的卡我已经满级"的空箱问题。
//   - 类别与卡池的映射见 CARD_CATEGORY。开卡沿用波次选卡同一条权重
//     （common 62 / rare 30 / epic 12），手感与选卡面板一致。
//   - 位置用 world.rng 的 spawn 流：同一 seed 重放时箱子位置也固定。
//   - 数量随人数：1~2 人 1~2 个，3~4 人 2~3 个（40% 概率 +1）。

import { UPGRADES } from '../upgrades.js';
import { weaponCards } from '../weapons.js';

/** 类别定义：icon 同时用作 3D 悬浮标识与小地图颜色依据 */
export const CATEGORIES = {
  attack:  { label: '火力', icon: '💥', color: 0xe8523a, css: '#e8523a' },
  defense: { label: '装甲', icon: '🛡', color: 0x4aa8ff, css: '#4aa8ff' },
  mobility:{ label: '机动', icon: '🛞', color: 0x58d858, css: '#58d858' },
  support: { label: '维修', icon: '🔧', color: 0xffc94a, css: '#ffc94a' },
};

/** 卡 id → 宝箱类别。新卡记得登记，漏登记的卡不会从宝箱开出。 */
const CARD_CATEGORY = {
  damage: 'attack', reload: 'attack', multishot: 'attack', pierce: 'attack',
  explosive: 'attack', railgun: 'attack', overload: 'attack',
  armor: 'defense', reactive: 'defense', bulwark: 'defense',
  engine: 'mobility',
  repair: 'support', nano: 'support',
};

/** 该类别下、这个玩家还没拿满的卡池（含当前武器的专属卡） */
function poolFor(stats, counts, cat) {
  const pool = [];
  for (const u of UPGRADES) {
    if (CARD_CATEGORY[u.id] !== cat) continue;
    if ((counts[u.id] || 0) >= u.max) continue;
    pool.push(u);
  }
  if (stats) {
    for (const c of weaponCards(stats.weaponId)) {
      if (CARD_CATEGORY[c.id] !== cat) continue;
      if ((counts[c.id] || 0) >= c.max) continue;
      pool.push(c);
    }
  }
  return pool;
}

/** 稀有度权重：与 progression.js 的波次选卡同一条，保证手感一致 */
const WEIGHTS = { common: 62, rare: 30, epic: 12 };

/**
 * 拾取时为玩家开一张该类别的卡。
 * 池子抽空（该类别全部满级）时兜底「战地维修」——它 max=99 永远可用。
 *
 * @returns {object} 卡定义 { id, name, icon, rarity, desc, max, apply }
 */
export function rollCard(stats, counts, cat, rnd) {
  const pool = poolFor(stats, counts, cat);
  if (!pool.length) {
    const repair = UPGRADES.find((u) => u.id === 'repair');
    return repair;
  }
  const total = pool.reduce((sum, u) => sum + WEIGHTS[u.rarity], 0);
  let r = rnd() * total;
  for (const u of pool) {
    r -= WEIGHTS[u.rarity];
    if (r <= 0) return u;
  }
  return pool[pool.length - 1];
}

/**
 * 这一波空投几个。
 *
 * 基线：1~2 人 1~2 个，3~4 人 2~3 个（40% 概率 +1）。
 * 另加两条与战斗强度挂钩的规则：
 *   - Boss 波（每 5 波）+1：那一波的同屏压力和时长是普通波的 3~5 倍，
 *     却和第 1 波给一样的补给，等于最需要补给的时刻最抠
 *   - 第 20 波起 +1：敌人从三个方向压上来，1 个箱子覆盖不了多方向走位
 *
 * 上限 3。再多就不是"补给"而是"捡箱子跑图"了——玩家会为了箱子
 * 离开掩体，反而被包围。
 *
 * @param {number} players 存活/在场人数
 * @param {() => number} rnd 确定性随机源（两端必须是同一条流）
 * @param {number} wave 当前波次（从 1 开始）。缺省 0 = 不按波次加成
 */
export function crateCount(players, rnd, wave = 0) {
  const base = players >= 3 ? 2 : 1;
  let n = base + (rnd() < 0.4 ? 1 : 0);
  if (wave > 0 && wave % 5 === 0) n += 1;
  if (wave >= 20) n += 1;
  return Math.min(3, n);
}

/**
 * 空投位置：远离所有玩家（≥26m）、彼此隔开（≥18m）、不落在建筑里。
 * 尝试 40 次，全失败就放宽距离接受最后一次（地图小/人多时兜底）。
 *
 * @param {object} opts { half, players:[{x,z}], blocked:(x,z)=>bool, rnd }
 * @returns {Array<{x:number,z:number}>}
 */
export function cratePositions({ half, players = [], blocked, rnd, count }) {
  const margin = half * 0.72;               // 留出边界与出生区
  const out = [];
  for (let c = 0; c < count; c++) {
    let best = null;
    for (let i = 0; i < 40; i++) {
      const x = (rnd() * 2 - 1) * margin;
      const z = (rnd() * 2 - 1) * margin;
      if (blocked && blocked(x, z)) continue;
      let ok = true;
      for (const p of players) {
        if (Math.hypot(x - p.x, z - p.z) < 26) { ok = false; break; }
      }
      if (!ok) continue;
      for (const q of out) {
        if (Math.hypot(x - q.x, z - q.z) < 18) { ok = false; break; }
      }
      if (!ok) continue;
      best = { x, z };
      break;
    }
    if (!best) {
      // 兜底：只躲建筑，不保证离玩家远——有箱子总比没箱子强
      for (let i = 0; i < 20; i++) {
        const x = (rnd() * 2 - 1) * margin;
        const z = (rnd() * 2 - 1) * margin;
        if (blocked && blocked(x, z)) continue;
        best = { x, z };
        break;
      }
    }
    if (best) out.push(best);
  }
  return out;
}

/** 类别均匀随机（空投时决定箱子的功能标识） */
export function rollCategory(rnd) {
  const keys = Object.keys(CATEGORIES);
  return keys[Math.floor(rnd() * keys.length)];
}
