// 局内成长：卡池 / 抽卡 / 应用。**纯函数，不碰 DOM、不碰 three**。
//
// 为什么联机也要单独一份：
//   单机（Game.js）里成长散在 UI 流程里——点卡片、调 apply、改 HUD。
//   联机要做到"每波结束各自 3 选 1"，就必须让服务端能**独立**算出
//   "这个人这次能抽到哪三张"，并且能校验"他选的那张是否合法"。
//   服务端不能 import Game.js（那会把 three 拖进 Node），所以抽卡与应用
//   这两件事必须从 UI 里剥出来，放进 core/。
//
// 抽卡用服务端自己的 RNG（world.rng），不用 Math.random：
//   - 可复现：同一个种子同一局，出卡顺序固定，出了问题能照着重放
//   - 四个人的卡池从同一个流里取，天然不会出现"两个人抽到一模一样的死卡池"
//     （虽然各自独立抽也是允许的，但同流更容易解释）

import { UPGRADES, ARMORY } from '../upgrades.js';
import { weaponCards } from '../weapons.js';

const WEIGHTS = { common: 62, rare: 30, epic: 12 };

/** 每人每波能抽几张（与单机一致） */
export const CHOICES_PER_WAVE = 3;

/**
 * 这一波他该看到哪几张卡。
 *
 * @param {object} s        玩家的 stats（createStats 的返回值）
 * @param {object} counts   已选次数 { cardId: n }
 * @param {Function} rnd    返回 [0,1) 的函数。传 () => world.rng.spawn() 即可。
 *
 * 为什么收函数而不是 Rng 对象：Rng 是"命名流容器"，抽卡属于局内结构、
 * 跟着 spawn 流走（和出怪共一条），这样同一 seed 的重放里卡池也是固定的。
 * @param {object} opts     { armory: boolean } 是否插入军械卡
 * @returns {object[]} 卡定义数组（含 desc/rarity/icon，前端直接渲染）
 */
export function rollForPlayer(s, counts, rnd, { armory = false, n = CHOICES_PER_WAVE } = {}) {
  const pool = UPGRADES.filter((u) => (counts[u.id] || 0) < u.max);
  for (const card of weaponCards(s.weaponId)) {
    if ((counts[card.id] || 0) < card.max) pool.push(card);
  }

  const picks = [];
  const want = armory ? n - 1 : n;

  // 池子抽空（后期所有卡都满级）时返回空数组，由调用方决定"直接开下一波"
  while (picks.length < want && pool.length > 0) {
    const total = pool.reduce((sum, u) => sum + WEIGHTS[u.rarity], 0);
    let r = rnd() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= WEIGHTS[pool[i].rarity];
      if (r <= 0) { idx = i; break; }
    }
    picks.push(pool.splice(idx, 1)[0]);
  }

  if (armory) {
    // 军械卡插在随机位置：固定在首位会让"第一张永远不是卡"，节奏太机械
    const at = Math.floor(rnd() * (picks.length + 1));
    picks.splice(at, 0, ARMORY);
  }

  // max 必须带上：卡片底部显示「Lv.1 → Lv.2 / 5」，少了它就成了「/ undefined」。
  // 这个字段从联机上线起就没传过 —— 单机走的是 upgrades.js 的 rollChoices（返回整张卡），
  // 所以只有组队面板是坏的。
  return picks.map((u) => ({
    id: u.id, name: u.name, icon: u.icon, rarity: u.rarity, desc: u.desc,
    max: u.max, armory: !!u.armory,
  }));
}

/** 按 id 找卡定义（服务端校验用）；找不到返回 null */
export function findCard(s, id) {
  if (id === ARMORY.id) return ARMORY;
  for (const u of UPGRADES) if (u.id === id) return u;
  for (const c of weaponCards(s.weaponId)) if (c.id === id) return c;
  return null;
}

/**
 * 把一张卡应用到玩家身上。
 *
 * @param {object} p      玩家（要有 stats / hp / maxHp / speedBase）
 * @param {string} id     卡 id
 * @returns {{ ok:boolean, reason?:string, hp?:number }}
 */
export function applyCard(p, id) {
  const s = p.stats;
  if (!s) return { ok: false, reason: 'no-stats' };
  const card = findCard(s, id);
  if (!card) return { ok: false, reason: 'unknown' };
  if (id === ARMORY.id) return { ok: false, reason: 'armory' }; // 军械库联机暂未开放
  if ((s.counts[id] || 0) >= card.max) return { ok: false, reason: 'maxed' };

  // apply 的第二个参数约定是"有 hp/maxHp 的对象"，单机传的是 Tank 实例。
  // 服务端没有 Tank，这里传玩家本身：字段名一致（hp / maxHp），apply 不关心类型。
  card.apply(s, p);
  s.counts[id] = (s.counts[id] || 0) + 1;

  // 数值型成长要同步到模拟层用的字段
  p.speedBase = s.speed;
  p.maxHp = s.maxHp;
  p.hp = Math.min(p.hp, p.maxHp);

  return { ok: true, hp: Math.round(p.hp), maxHp: p.maxHp };
}

/**
 * 军械库是否该出现（与单机同一节奏：每 N 波一次，且还有没解锁的炮）。
 * 联机目前只有突击炮，armoryEvery 未定义时退回 3。
 */
export function shouldOfferArmory(wave, armoryEvery, unlockedCount, totalWeapons) {
  const every = armoryEvery || 3;
  return wave % every === 0 && unlockedCount < totalWeapons;
}
