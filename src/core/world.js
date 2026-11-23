// 权威模拟：多人对局里"世界到底发生了什么"
//
// 这份代码同时跑在服务端和浏览器（Web Worker）里，所以：
//   - 不 import three
//   - 不碰 document / window / localStorage
//   - 不读全局 Math.random（用注入的 rng，保证可复现、多房间互不干扰）

// 地图数据与边界常量来自 levelgen（纯数据，不依赖 three）。
// 客户端建 mesh、这里建碰撞表，都只读这一份，物理上不可能再分叉。
import { HALF, generateBoxes, resolveMultiSpawns } from './levelgen.js';
// 车体运动学（转向 / 加速 / 撞墙滑行）：与客户端预测共用同一份实现
import { stepBody, aimTurret, angleDiff } from './motion.js';
// 圆-矩形碰撞：与客户端 level.js、地图生成共用，避免三处判定各写一套
import { deepestHit, hitsAny, slideCircle, pushOut } from './collide.js';
// 战场宝箱（r43）：空投数量/位置/开卡都是纯函数，单机 Game.js 共用同一份
import { crateCount, cratePositions, rollCategory, rollCard, CATEGORIES } from './crates.js';
// Boss 单一数据源（r46）：轮换表、血量公式、技能参数，单机 Enemy.js 读同一份。
// 以前 Boss 的信息散在四个文件里，联机棱镜至今没有折射风暴就是这么漏掉的。
import {
  BOSS_META, BOSS_SKILLS, bossTypeForWave, pickLateBoss, bossHpFor, bossHpMul,
  rollAwakens, awakensForWave, skillCdMul, ZONE, stepZones, laserHits,
  resonancePull, bossStageFor, awakenMaskOf, awakenNamesOf, AWAKEN_NUM,
} from './bosskit.js';
// 地表类型场：两端同源的速度系数（地形为空时完全退化成 1.0）
import { buildTerrain, speedAt, presetK } from './terrain.js';
import { createPlayer, updateRevive, scaleForPlayers,
  emptyInput, DOWN_TIME, RESPAWN_DELAY, newStats,
} from './players.js';
import {
  buildPatrolRoutes, createPatrolState, anchorRoute, stepPatrol,
  wakePatrol, sendHunting, PATROL,
} from './patrol.js';
import { R, Rng } from '../rng.js';
// 弹道拦截（提前量）：和单机共用同一份解算，别再两处各写一套弹道数学
import { solveIntercept } from './aim.js';
// 车体数值：从 UI 那份定义直接派生，不在这里再抄一遍。
// 抄两份的代价不是"维护麻烦"，是联机手感 —— 一边 20 一边 19.5，
// 每帧 0.5 m/s 的位移差都会进残差，攒几帧后被硬校正，玩家感觉车在拖拽。
import { CHASSIS_TABLE, normalizeChassisId } from '../chassis.js';
// 局内成长（抽卡/应用）：纯函数，单机与联机共用同一份卡池与权重
import { createStats } from '../upgrades.js';
import { rollForPlayer, applyCard } from './progression.js';
// 武器解算：纯函数无依赖，服务端直接复用单机同一套
// （伤害/射速/弹速/穿甲/高爆/多联装全在这一个函数里算齐）。
// 以前联机的 _playerFire 只认 PLAYER_WEAPON 的裸数值，syncedStats
// 同步的 8 项成长字段没有一项被消费——multishot 叠到 3 仍只发 1 发。
import { resolveWeapon } from '../weapons.js';

export { HALF };

/**
 * 下发给客户端的成长字段。
 *
 * 只挑模拟需要的，别把整个 stats 塞进协议：kills/score/damage 这些是战绩
 * 计数器，走快照和结算，混进成长同步里会让"这波打了多少"和"我拿了哪些卡"
 * 两件事互相干扰。counts / weaponMods 是对象，必须浅拷贝，否则序列化时
 * 会把内部字段一起漏出去。
 *
 * 两个地方用：中途加入的 welcome（重建成长），以及每波发卡的 CARDS
 * （客户端据此修正本地预测的速度/血量，见 coop._syncCards）。
 */
export function syncedStats(s) {
  return {
    damageMul: s.damageMul,
    fireRateMul: s.fireRateMul,
    bulletSpeedMul: s.bulletSpeedMul,
    splashDamageMul: s.splashDamageMul,
    damageTakenMul: s.damageTakenMul,
    speed: s.speed,
    maxHp: s.maxHp,
    multishot: s.multishot,
    pierce: s.pierce,
    explosive: s.explosive,
    waveHeal: s.waveHeal,
    killHeal: s.killHeal,
    weaponId: s.weaponId,
    counts: { ...s.counts },
  };
}

// ---------------- 数值表（与单机保持一致） ----------------

/** 敌人车体转向速率（rad/s）。给足 3.0，否则急转时车头追不上行进方向就一直原地打圈 */
const TURN_RATE = 3.0;

/**
 * 敌人类型编码（协议字段 typeCode）。
 *
 * 以前是 `Object.keys(ENEMY_TYPES).indexOf(type) + 1` —— 靠数组顺序。
 * 往中间插一个类型、或者两端版本不一致，客户端就会把 Boss 渲染成 gunner
 * （模型、血条、颜色全错），而且**不报错**，只能靠肉眼发现。
 * 现在手写死：只能追加，不能插队，也不能改已有值。
 */
export const TYPE_CODE = {
  gunner: 1, charger: 2, elite: 3, drone: 4, turret: 5, support: 6, shield: 7,
  boss_breaker: 8, boss_prism: 9,
  boss_wraith: 10, boss_blitz: 11, boss_bulwark: 12, boss_hive: 13,
  boss_crucible: 14, boss_warden: 15, boss_twin: 16, boss_terminus: 17,
};

export const CODE_TO_TYPE = {};
for (const [name, code] of Object.entries(TYPE_CODE)) CODE_TO_TYPE[code] = name;

export const typeCodeOf = (type) => TYPE_CODE[type] || 0;

/** 敌人模板：只保留模拟需要的字段，渲染层按 type 自己建模型 */
export const ENEMY_TYPES = {
  gunner: { hp: 1, speed: 1, radius: 1.45, damage: 5, range: 26, fireCd: [2.0, 3.6], bulletSpeed: 42, score: 10, scale: 1 },
  charger: { hp: 0.5, speed: 1.25, radius: 1.35, damage: 12, range: 4, selfDestruct: 4.6, score: 12, scale: 0.85 },
  elite: { hp: 4, speed: 0.85, radius: 1.65, damage: 8, range: 30, fireCd: [1.5, 2.6], bulletSpeed: 48, score: 40, scale: 1.18 },
  drone: { hp: 0.3, speed: 2.2, radius: 0.9, damage: 7, range: 3.5, selfDestruct: 3.5, score: 14, scale: 0.62 },
  turret: { hp: 2.2, speed: 0, radius: 1.3, damage: 9, range: 46, fireCd: [2.4, 3.2], bulletSpeed: 55, score: 25, scale: 0.95, static: true },
  // 补给车：治疗量必须按**百分比**，不能按固定值。
  // 原来单机是固定 +6/1.2 秒：对 60 血的枪手是 10%/秒（打不死），
  // 对 4000 血的精英是 0.15%/秒（等于没有）——同一台车在前后期完全不是一个东西。
  // bossHealMul = 0：Boss 血量是按「目标时长 × 玩家 DPS」反推的，
  // 任何回血都会直接破坏那条曲线（6%/秒 的治疗能把 110 秒的 Boss 战变成打不死）。
  support: {
    hp: 1.4, speed: 0.95, radius: 1.5, damage: 0, range: 0,
    healAura: 8, healRate: 0.04, bossHealMul: 0,
    score: 30, scale: 1.05,
  },
  shield: { hp: 1.3, speed: 0.9, radius: 1.55, damage: 6, range: 28, fireCd: [2.2, 3.6], bulletSpeed: 44, score: 20, scale: 1.12, frontArmor: 0.45 },
  // Boss 弹速从 46/52 提到 58/62：加了提前量之后，飞行时间仍是命中率的主导项，
  // 34m 外 46 m/s 要飞 0.74 秒，玩家挪 11 米，预判误差被放大到躲不躲都随缘。
  boss_breaker: { hp: 24, speed: 7.2, radius: 2.5, damage: 11, range: 34, fireCd: [1.8, 3.0], bulletSpeed: 58, score: 300, scale: 1.75, boss: true },
  boss_prism: { hp: 20, speed: 9.2, radius: 2.1, damage: 6, range: 40, fireCd: [1.3, 2.2], bulletSpeed: 62, score: 300, scale: 1.45, boss: true },
  // ---- r46 新增八种（顺序即 typeCode，必须追加在末尾）----
  // 形态差别写在速度/射程/射速上，机制差别在 bosskit 的技能表与各自的 AI 分支。
  boss_wraith: { hp: 20, speed: 9.6, radius: 2.2, damage: 9, range: 30, fireCd: [1.2, 2.0], bulletSpeed: 64, score: 320, scale: 1.5, boss: true },
  boss_blitz: { hp: 18, speed: 11.4, radius: 2.0, damage: 14, range: 16, fireCd: [2.0, 3.0], bulletSpeed: 60, score: 320, scale: 1.4, boss: true },
  // frontArmor 0.3 = 正面只吃 30% 伤害（减 70%）。这就是"找"：绕到侧面/背面才打得动。
  boss_bulwark: { hp: 26, speed: 4.5, radius: 2.7, damage: 12, range: 30, fireCd: [2.2, 3.4], bulletSpeed: 56, score: 340, scale: 1.85, boss: true, frontArmor: 0.3 },
  // 蜂巢本体不动（speed 0 就是全部，别加 static：static 会跳过移动分支但也让人误以为它不该开火）
  boss_hive: { hp: 24, speed: 0, radius: 2.6, damage: 7, range: 60, fireCd: [2.6, 3.8], bulletSpeed: 46, score: 340, scale: 1.7, boss: true },
  boss_crucible: { hp: 24, speed: 6.8, radius: 2.6, damage: 10, range: 34, fireCd: [1.8, 2.8], bulletSpeed: 56, score: 360, scale: 1.8, boss: true },
  boss_warden: { hp: 24, speed: 7.4, radius: 2.3, damage: 9, range: 38, fireCd: [1.6, 2.6], bulletSpeed: 60, score: 360, scale: 1.6, boss: true },
  boss_twin: { hp: 20, speed: 9.8, radius: 1.9, damage: 8, range: 26, fireCd: [1.4, 2.2], bulletSpeed: 62, score: 300, scale: 1.35, boss: true },
  boss_terminus: { hp: 30, speed: 8.2, radius: 2.8, damage: 14, range: 30, fireCd: [1.6, 2.6], bulletSpeed: 62, score: 500, scale: 1.9, boss: true },
};

/**
 * 玩家受伤系数。
 *
 * 单机的伤害数值是"一对一"调出来的；多人时敌人数量会翻倍，
 * 若沿用原数值，四个人的火力都集中在同一个人的概率变小但总弹量变多，
 * 实测 90 秒就会被压死。这里统一打七折，并把护甲回复做成波间自动补。
 */
const PLAYER_TAKEN = 0.7;
const WAVE_HEAL = 0.25;

/**
 * 基础主炮（对应单机的「突击炮」）。
 * 数值直接对齐 weapons.js：26 伤 / 0.4 秒 → 65 DPS。
 * 之前这里写成 14 伤，导致第 1 波都清不完，整局节奏被拖死。
 */
export const PLAYER_WEAPON = {
  damage: 26,
  bulletSpeed: 68,
  fireCd: 0.4,
  range: 120,
};

/** 障碍物：服务端也必须有静态碰撞表，否则敌人会穿墙 */
export function buildStaticWorld(terrain = null, seed = 0) {
  // 地图数据只在 core/levelgen.js 生成一次，客户端建 mesh、这里建碰撞表。
  //
  // 为什么不再手抄一份：线上出过事故——两边各写一套生成循环，客户端为了建
  // 模型多算了一个高度 h 的随机数，服务端没有，从第二个随机箱子开始坐标整体
  // 错位；固定掩体里还把渲染高度 h 当成深度 d 抄了过来。结果是"客户端有墙、
  // 服务端没有"，玩家一进房就撞假墙，速度每帧乘 0.3 压到 0.8 米/秒，
  // 表现就是油门踩到底车不动，同时服务端位置正常推进又被拽回去。
  const boxes = generateBoxes(seed).map((b) => [b.x, b.z, b.w, b.d]);

  return {
    half: HALF,
    boxes,
    // 地表类型场。stepBody 用它查脚下的速度倍率；为 null 时恒等 1.0（旧路径）。
    terrain,
    /**
     * 圆形与箱体的碰撞。
     * 真实圆-矩形判定（角上是圆弧）。原来把半径直接加到矩形两边，
     * 等价于方形碰撞体，贴着建筑拐角走会被多挡 0.79 米，表现为"建筑卡坦克"。
     * 注意：这里不判边界——边界由各调用方 clamp 处理，保证"贴边能走"。
     */
    blocked(x, z, r) {
      return hitsAny(boxes, x, z, r);
    },
    /** 穿透最深的那一个，{ nx, nz, depth } 或 null；撞墙滑行与脱困用 */
    hit(x, z, r) {
      return deepestHit(boxes, x, z, r);
    },
    /** 带滑行的位移，返回 { x, z, hit } */
    slide(x, z, dx, dz, r) {
      return slideCircle(boxes, x, z, dx, dz, r);
    },
    clamp(x, z, r) {
      return {
        x: Math.max(-HALF + r, Math.min(HALF - r, x)),
        z: Math.max(-HALF + r, Math.min(HALF - r, z)),
      };
    },
  };
}



/**
 * 线段 (ax,az)→(bx,bz) 与圆 (cx,cz,r) 是否相交。
 * @returns {number} 命中处在线段上的参数 t∈[0,1]，-1 表示未命中
 */
function segCircle(ax, az, bx, bz, cx, cz, r) {
  const dx = bx - ax;
  const dz = bz - az;
  const fx = ax - cx;
  const fz = az - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-9) return (fx * fx + fz * fz <= r * r) ? 0 : -1;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  let disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  disc = Math.sqrt(disc);
  const t1 = (-b - disc) / (2 * a);
  const t2 = (-b + disc) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return Math.max(0, t1);
  return -1;
}

/** 出生点：四角 + 四边中点，多人时错开 */

/**
 * 4 人出生点：生成地图后立刻校验，避免被固定掩体压住。
 *
 * 现在建筑按局种子变化，出生点也必须跟着算——常量表是上一版（地图固定）
 * 留下的，换种子后会有人直接出生在墙里。按 seed 缓存，同一局只算一次。
 */
const SPAWN_CACHE = new Map();
function spawnsFor(seed) {
  const k = seed >>> 0;
  let v = SPAWN_CACHE.get(k);
  if (!v) {
    v = resolveMultiSpawns(generateBoxes(k));
    if (SPAWN_CACHE.size > 64) SPAWN_CACHE.clear();
    SPAWN_CACHE.set(k, v);
  }
  return v;
}

let NEXT_ID = 1;
const nextId = () => NEXT_ID++;

/**
 * 一局多人合作 PvE。
 *
 * 与单机最大的结构差异：玩家是数组，所有"谁受伤""谁开火"都由 id 定位。
 * 规则本身（波次公式、敌人类型、伤害数值）与单机一致。
 */
export class World {
  constructor({ code, seed = 1, maxPlayers = 4, terrain = null, terrainPreset = 'standard' } = {}) {
    this.code = code || 'LOCAL';
    this.seed = seed >>> 0;
    this.maxPlayers = Math.max(1, Math.min(4, maxPlayers));

    // ---- 地表类型场 ----
    //
    // 由种子完全决定：同一个房间 seed 派生同一张地形图，
    // 客户端只收 seed，自己重建一份，不需要传 27×27 的格点数组。
    //
    // seed 异或一个常数，是为了让"地形图案"和"波次随机序列"不共用一个流——
    // 否则改一下地形生成算法的步数，整局的出怪顺序也跟着变。
    //
    // 出生点保护圈由 terrain.js 内部按 levelgen.SPAWNS 自动铺，这里不传——
    // 传了服务端的一份（resolveMultiSpawns 挪过位）而客户端传默认清单，
    // 同一 seed 就会生成两张不同的图。
    this.terrainPreset = terrainPreset;
    this.terrain = terrain || buildTerrain(
      (this.seed ^ 0x7e3a91) >>> 0,
      HALF,
      { k: presetK(terrainPreset) },
    );

    this.rng = new Rng(this.seed);
    // 建筑布局也由种子决定：同一房间所有人拿到同一张图。
    // 客户端不自己生成一份再对比，而是直接收 fullState().boxes ——
    // 生成算法哪怕只差一个随机数，后果都是"你看得见墙、服务端没有"。
    this.static = buildStaticWorld(this.terrain, this.seed);

    // ---- 巡逻路线：种子生成，不通过网络同步 ----
    //
    // 放在 static 之后建：航点要避墙，必须拿得到碰撞表。
    // 用独立随机流，避免"多生成 8 条路线"把刷怪/弹道序列整体带偏。
    const patrolRng = new Rng((this.seed ^ 0x2f7a31c5) >>> 0);
    this.patrolRoutes = buildPatrolRoutes(() => patrolRng.spawn(), {
      half: HALF,
      blocked: (x, z, r) => this.static.blocked(x, z, r),
      avoid: spawnsFor(this.seed).map(([x, z]) => ({ x, z, r: 26 })),
      count: 10,
      minGap: 26,
    });

    this.players = [];
    this.enemies = [];
    this.bullets = [];
    this.crates = [];              // 战场宝箱（r43）：{ id, x, z, cat }
    this._crateSeq = 0;
    // Boss 场地标记（r46）：预警圈 / 岩浆区 / 冲刺路径 / 冲击波。
    // { kind, x, z, r, t, dur } —— t 是剩余时间，dur 是总时长（算收缩进度用）。
    // 走快照的 bz 字段同步，迟入玩家也能看到"它要跳到哪"。
    this.zones = [];
    this.events = [];

    this.tick = 0;
    this.time = 0;
    this.wave = 0;
    this.waveActive = false;
    this.waveGap = 3.0;
    this.pending = [];
    this.state = 'lobby';         // lobby | playing | over
    this.enemiesLeft = 0;
    this.mods = null;

    // ---- 局内成长 ----
    //
    // 每波清完后，每个活着的玩家各自 3 选 1：卡池来自 core/progression.js，
    // 服务端在这里生成并保管"他这一波能看到哪三张"，客户端只是把它渲染出来。
    // 为什么不信任客户端上报的卡：作弊是次要的，主要是重连。
    //   断线回来的人必须看到**同一批**没选完的卡，否则他会发现自己"错过了一波"。
    this.cards = new Map();     // id → { wave, options[], picked }
    this.pickWindow = 12;       // 秒；超时默认拿第一张（不能让一个人拖住全队）
    this.picksOpen = false;
  }

  /** 波间选卡是否还开着（有任何人没选完） */
  get awaitingPicks() {
    if (!this.picksOpen) return false;
    for (const p of this.players) {
      if (!p.alive || p.down) continue;
      const c = this.cards.get(p.id);
      if (c && !c.picked) return true;
    }
    return false;
  }

  /**
   * 给每个玩家发一组卡。只在清波时调用一次。
   * @returns {{id:string, wave:number, options:object[], stats:object}[]} 每人一份，调用方负责发出去
   */
  _dealCards() {
    const out = [];
    this.cards.clear();
    const rnd = () => this.rng.spawn();
    for (const p of this.players) {
      if (!p.alive || p.down) continue;
      const options = rollForPlayer(p.stats, p.stats.counts, rnd, {
        armory: this._armoryDue(p),
      });
      if (!options.length) continue;   // 全部满级：这一波直接跳过
      this.cards.set(p.id, { wave: this.wave, options, picked: false });
      // 附上他此刻的成长数值：客户端拿不到每帧成长的同步（快照只发位置血量），
      // 不在这里对齐，他会一直按"上一波开头的速度/血量"做本地预测 ——
      // 选了速度卡之后服务端变快、客户端还慢，每帧都被拉回一截，手感变拖。
      out.push({ id: p.id, wave: this.wave, options, stats: syncedStats(p.stats) });
    }
    this.picksOpen = out.length > 0;
    this.pickT = this.pickWindow;
    return out;
  }

  /** 军械库：联机目前只有突击炮，等有第二门炮再开这条分支 */
  _armoryDue() {
    return false;
  }

  /**
   * 选卡。校验"这张卡确实在他的选项里"，然后应用到玩家身上。
   * @returns {{ ok:boolean, reason?:string, hp?:number, maxHp?:number }}
   */
  pickCard(id, cardId) {
    const p = this.players.find((q) => q.id === id);
    const c = this.cards.get(id);
    if (!p || !c) return { ok: false, reason: 'undefined' };
    if (c.picked) return { ok: false, reason: 'already' };
    if (!c.options.some((o) => o.id === cardId)) return { ok: false, reason: 'not-offered' };

    const r = applyCard(p, cardId);
    if (!r.ok) {
      // 军械卡在联机里尚未开放：当作"跳过"，否则玩家会卡在选卡界面
      if (r.reason === 'armory') {
        c.picked = true;
        this._pushEvent({ kind: 'pick', id, card: cardId, skipped: true });
        return { ok: true, skipped: true };
      }
      return r;
    }
    c.picked = true;
    this._pushEvent({ kind: 'pick', id, card: cardId });
    return r;
  }

  /** 波间推进：所有人选完 / 超时后关窗 */
  _updatePicks(dt) {
    if (!this.picksOpen) return;
    this.pickT -= dt;
    if (this.awaitingPicks && this.pickT > 0) return;

    // 超时：没选的人默认拿第一张。不罚、不跳过，避免"去倒杯水回来整波收益没了"
    if (this.awaitingPicks) {
      for (const [id, c] of this.cards) {
        if (c.picked) continue;
        const p = this.players.find((q) => q.id === id);
        if (p && c.options.length) this.pickCard(id, c.options[0].id);
      }
    }
    this.picksOpen = false;
    // 必须告诉客户端"窗口关了"。
    //
    // 之前服务端到点自己替玩家选完、直接推进波次，客户端那边一无所知：
    // `net.cards` 还留着，面板就一直停着，副标题从「12 秒」数到「0 秒后自动选择」
    // 之后再也不动，整个画面被盖住。玩家感受到的是"打完第一波就进不去，
    // 点什么都没反应"——而服务端其实已经开到第二波了。
    this._pushEvent({ kind: 'picksClosed', wave: this.wave });
    this.waveGap = 1.2;   // 选完卡再短暂缓冲，避免"刚点完就贴脸"
  }

  // ---------------- 玩家进出 ----------------

  /** 加人。返回 player 或 null（满了） */
  addPlayer({ id, name, chassisId }) {
    if (this.players.length >= this.maxPlayers) return null;
    // 车体 id 必须先归一化：历史 id（light/heavy/hunter/balanced）都要落到豹式上。
    // 直接把原始字符串存进 p.chassis 的话，客户端拿到的就是"未知车体"，
    // 尺寸表查不到会退回默认尺寸，各端看到的大车小车还不一致。
    const cid = normalizeChassisId(chassisId);
    const c = CHASSIS_TABLE[cid];
    const pid = id || `p${nextId()}`;
    const idx = this.players.length;
    // 出生点由 levelgen 校验过，保证不与掩体重叠（否则一落地就卡墙）
    const spawns = spawnsFor(this.seed);
    const [sx, sz] = spawns[idx % spawns.length];

    const p = createPlayer({
      id: pid,
      name,
      chassisId: cid,
      x: sx,
      z: sz,
      hp: c.hp,
      maxHp: c.hp,
    });
    p.speedBase = c.speed;
    p.turnBase = c.turn;
    p.takenMul = c.takenMul;
    p.killHeal = c.killHeal || 0;
    // 记下出生点：联机里"全员阵亡但房间还在"时要原地满血重开（见 room.js）。
    // 不记的话复活点只能猜，很容易把车放进掩体里卡死。
    p._spawnX = sx;
    p._spawnZ = sz;
    p._spawnYaw = p.yaw;
    // 局内成长：与单机 createStats 同一份结构（联机以前没有 stats，
    // 于是第 8 波和第一波操作完全一样，这是两种模式体验割裂的根源）。
    // 注意合并顺序：createPlayer 已经塞了 newStats()（score/kills 这些战斗统计），
    // createStats 是成长数值，两者**都要**——直接覆盖会把 score 抹成 undefined，
    // 击杀加分时 NaN 会顺着协议扩散到所有人的计分板。
    p.stats = { ...newStats(), ...createStats(p.chassis) };
    // 炮塔参数同样来自 CHASSIS_TABLE，客户端预测读的是同一份数值
    p.turretRate = c.turretRate;
    p.turretLimit = c.turretLimit;
    p.aimX = p.x;
    p.aimZ = p.z - 10;
    p.joinedAt = this.time;

    this.players.push(p);
    this._pushEvent({ kind: 'join', id: pid, name: p.name, chassis: p.chassis });
    return p;
  }

  removePlayer(id) {
    this.players = this.players.filter((p) => p.id !== id);
    this._pushEvent({ kind: 'leave', id });
  }

  /**
   * 开始这一局。人数变化时重新计算缩放，所以"3 人等 4 人"也能直接开始。
   *
   * ⚠ 必须**清场**再开。这里曾经只写了 state / tick / startWave(1)：
   *   房间在"全员阵亡 → 回大厅"或"结算重开"时会再次调到 start()，
   *   而上一局的敌人、子弹、待入场队列全都原封不动地留着。
   *   于是新一局一开始就顶着上一局的血量：第 1 波刷出来的怪和上一局残党
   *   叠在一起，`enemiesLeft` 永远清不到 0 → `cleared` 不触发 → 选卡不弹 →
   *   波次卡死。表现就是"通关后进不了下一关""打着打着敌人越打越多"。
   */
  start() {
    if (this.state === 'playing') return false;
    if (this.players.length === 0) return false;

    // ---- 清场：上一局的一切都不该带进新一局 ----
    this.enemies.length = 0;
    if (this.bullets) this.bullets.length = 0;
    if (this.crates) this.crates.length = 0;
    if (this.zones) this.zones.length = 0;
    this.pending.length = 0;
    this.events.length = 0;
    this.waveActive = false;
    this.waveGap = 0;
    this.left = 0;
    this.picksOpen = false;
    this.picks = null;
    this.enemiesLeft = 0;

    // 玩家回出生点满血，输入清空（不然上一帧按着 W 会直接被带进新局）
    for (const p of this.players) {
      // 出生点是 addPlayer 时记下的 _spawnX/_spawnZ，**不是** _spawn 对象。
      // 早先这里写成 p._spawn（不存在），会把车"传送"到它当前的位置再拿 yaw 当坐标，
      // 一旦有人照着改就是车飞到地图角落。
      if (Number.isFinite(p._spawnX)) {
        p.x = p._spawnX;
        p.z = p._spawnZ;
      }
      if (Number.isFinite(p._spawnYaw)) p.yaw = p._spawnYaw;
      p.turretYaw = p.yaw;
      p.hp = p.maxHp;
      p.alive = true;
      p.down = false;
      p.downT = 0;
      p.reviveT = 0;
      p.speed = 0;
      p.fireCd = 0;
      p.overheated = false;
      p.heat = 0;
      p.input = null;
      p.aimX = p.x;
      p.aimZ = p.z - 10;
    }

    this.state = 'playing';
    this.tick = 0;
    this.time = 0;
    this.startWave(1);
    return true;
  }

  // ---------------- 输入 ----------------

  setInput(id, input) {
    const p = this.players.find((q) => q.id === id);
    if (!p) return;
    p.input = input;
  }

  // ---------------- 主循环：固定步长 ----------------

  /**
   * 推进一个 tick。
   * @param {number} dt 固定步长（1/30）
   * @returns {object[]} 本 tick 产生的事件
   */
  step(dt) {
    this.events = [];
    this.tick++;
    this.time += dt;

    if (this.state === 'playing') {
      // 注意顺序：玩家先动，再由 updateRevive 判定"血量归零 → 倒地"。
      // 若先调 updateRevive，残血玩家会在这一 tick 里先被判死，再自己去移动，导致输入看起来无效。
      this._updatePlayers(dt);
      this._updateEnemies(dt);
      this._updateZones(dt);
      this._updateBullets(dt);
      this._updateCrates();
      for (const e of updateRevive(this.players, dt)) {
        this._pushEvent({ kind: e.type, id: e.id, by: e.by });
      }
      this._updateWaves(dt);
      this._separate();
      this._checkStuck(dt);
    }

    const ev = this.events;
    this.events = [];
    return ev;
  }

  _pushEvent(e) {
    if (this.events.length < 64) this.events.push(e);
  }

  // ---------------- 玩家 ----------------

  _updatePlayers(dt) {
    for (const p of this.players) {
      if (!p.alive || p.down) continue;
      const inp = p.input || emptyInput();

      // 车体 + 撞墙滑行：实现只有一份，在 core/motion.js，
      // 客户端预测调的是同一个函数（两端各写一套出过两次线上事故）。
      p.turnBase = p.turnBase || 3.0;
      p.speedBase = p.speedBase || 15;
      const ox = p.x;
      const oz = p.z;
      stepBody(p, inp, dt, this.static, HALF);
      // 本 tick 的实际速度（撞墙、地形减速都会体现）。
      // Boss 主炮的提前量必须用它——用输入方向乘最高速会预判到"你以为会到的地方"。
      const invDt = 1 / Math.max(dt, 1e-4);
      p.vx = (p.x - ox) * invDt;
      p.vz = (p.z - oz) * invDt;

      // 炮塔：朝鼠标指向的世界坐标转。
      // 转速与射界都来自车体。现在只有一款豹式：全向 + 瞬间对准。
      if (p.turretRate === undefined) {
        const ct = CHASSIS_TABLE[normalizeChassisId(p.chassis)];
        p.turretRate = ct.turretRate;
        p.turretLimit = ct.turretLimit;
      }
      aimTurret(p, inp.aimX, inp.aimZ, dt, p.turretRate, p.turretLimit);

      // 开火
      p.fireCd = Math.max(0, p.fireCd - dt);
      if (p.overheated) {
        p.heat = Math.max(0, p.heat - dt * 32);
        if (p.heat <= 0) p.overheated = false;
      } else if (inp.fire && p.fireCd <= 0) {
        this._playerFire(p);
      }
    }
  }

  _playerFire(p) {
    // r30：与单机同一套武器解算。damageMul/fireRateMul/bulletSpeedMul/
    // weaponMods/multishot/pierce/explosive 至此全部生效——
    // 以前这里只认 PLAYER_WEAPON 裸数值，玩家拿卡等于拿了个寂寞。
    const w = resolveWeapon(p.stats);
    p.fireCd = w.fireCd;
    p.stats.shots++;
    const base = p.turretYaw;
    // 多联装：与单机 _firePlayer 相同的对称散布
    const n = Math.max(1, Math.round(p.stats.multishot));
    const spread = 0.055;
    for (let i = 0; i < n; i++) {
      const jitter = w.spread ? (this.rng.combat() - 0.5) * w.spread * 2 : 0;
      const yaw = base + (i - (n - 1) / 2) * spread + jitter;
      this.bullets.push({
        id: nextId(),
        x: p.x + Math.sin(yaw) * 2.2,
        z: p.z + Math.cos(yaw) * 2.2,
        yaw,
        vx: Math.sin(yaw) * w.bulletSpeed,
        vz: Math.cos(yaw) * w.bulletSpeed,
        team: 0,
        owner: p.id,
        damage: w.damage,
        life: 2.2,
        pierce: w.pierce,
        explosive: w.explosive,
        splashMul: w.splashMul,
      });
    }
    this._pushEvent({ kind: 'shot', id: p.id, x: p.x, z: p.z, yaw: base });
  }

  // ---------------- 敌人 ----------------

  _updateEnemies(dt) {
    const alivePlayers = this.players.filter((p) => p.alive && !p.down);
    if (alivePlayers.length === 0) return;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.alive) { this.enemies.splice(i, 1); continue; }

      // 目标：最近的存活玩家
      let target = null;
      let bestD = Infinity;
      for (const p of alivePlayers) {
        const d = Math.hypot(p.x - e.x, p.z - e.z);
        if (d < bestD) { bestD = d; target = p; }
      }
      if (!target) continue;

      e.fireCd -= dt;
      const dist = Math.max(0.01, bestD);
      const dx = target.x - e.x;
      const dz = target.z - e.z;
      let aimYaw = Math.atan2(dx, dz);
      // Boss 提前量：炮塔朝"你将要到的地方"转，而不是"你现在在的地方"。
      // 之前就是纯直线瞄准，玩家一横移（15 m/s）就 100% 落空——
      // 线上表现是"破城者主炮一点伤害都没有"。
      let fireYaw = aimYaw;
      if (e.boss) {
        const sol = solveIntercept({
          dx, dz,
          vx: target.vx || 0,
          vz: target.vz || 0,
          speed: e.bulletSpeed,
          lead: 0.92,
        });
        if (sol) fireYaw = Math.atan2(sol.x, sol.z);
      }
      const reach = e.range > 0 ? e.range : 30;

      // ---- 巡逻 / 驻军决策（与单机共用 core/patrol.js）----
      //
      // 没有巡逻状态、或者已经转入追击的，继续走原来的追击 AI。
      // 巡逻中的车不朝玩家开火、炮塔朝行进方向——玩家从背后接近可以先手，
      // 这是"地图上有驻军"和"地图上全是追兵"的区别。
      const pat = e.patrol ? stepPatrol(e.patrol, dt, dist, e) : null;
      const passive = !!pat && pat.mode !== 'chase';
      if (passive) {
        if (pat.mode === 'hold') {
          fireYaw = e.turretYaw;              // 站桩警戒：炮塔保持原朝向
        } else {
          const pdx = (pat.tx ?? e.x) - e.x;
          const pdz = (pat.tz ?? e.z) - e.z;
          if (Math.hypot(pdx, pdz) > 0.1) aimYaw = Math.atan2(pdx, pdz);
          fireYaw = aimYaw;                   // 炮塔跟着行进方向
        }
        aimYaw = fireYaw;
      }

      // ---- Boss 技能接管（r46）----
      // 在普通移动之前：施法/冲刺/硬直期间不能既走位又开火，
      // 否则"预警 1.2 秒"这段时间 Boss 还在疾驰，玩家根本无从判断落点。
      //
      // ⚠ 不能加 !passive：蜂巢本体 speed=0，会被巡逻判定一直认成"驻守"，
      //   技能永远不触发（实测 14 秒零召唤）。Boss 本来也不靠巡逻编成。
      if (e.boss && this._updateBossSkill(e, dt, target)) continue;

      // ---- 移动：远则逼近，中距压上，近则拉开（炮台不动）----
      //
      // 用户反馈："敌方坦克围过来的时候还是无法靠近，只会围绕着我的坦克转圈"。
      // 原来中距（reach*0.45 ~ reach*0.85）是纯侧向游走，径向权重 1.15 只管
      // "别靠太近"，一旦进了这个带，敌人就永远绕着圆心漂——看起来是包围，
      // 实际一步也没进来，而且因为一直在侧移，车头也一直在转。
      //
      // 现在除"太近要退开"之外，径向一律朝里压：侧移只用来找角度，
      // 不允许盖过收拢。同时给转向留出"对准时间"：车头没对准就降速，
      // 避免一边扭一边挪造成的原地画圈观感。
      if (!e.static && !(passive && pat.mode === 'hold')) {
        let mx = 0;
        let mz = 0;
        let moveMul = 1;
        if (passive) {
          // 巡逻 / 回防：朝航点走，不追玩家
          const pdx = (pat.tx ?? e.x) - e.x;
          const pdz = (pat.tz ?? e.z) - e.z;
          const pl = Math.hypot(pdx, pdz) || 1;
          mx = pdx / pl;
          mz = pdz / pl;
          moveMul = pat.speedMul ?? PATROL.routeSpeed;
        } else if (dist > reach * 0.85) {
          mx = dx / dist; mz = dz / dist;                       // 远：直线逼近
        } else if (dist < reach * 0.45) {
          mx = -dx / dist; mz = -dz / dist;                     // 太近：退开
          if (e.type === 'charger' || e.type === 'drone') {
            // 自爆单位不退：它们的伤害就在贴身那一刻
            mx = dx / dist; mz = dz / dist;
          }
        } else {
          // 中距：径向朝里为主，侧向为辅。1.0 : 0.45 的合成角约 24°，
          // 是"斜着压上去"而不是"绕着转"。
          const side = e.strafeSide || 1;
          mx = (dx / dist) * 1.0 + (-dz / dist) * side * 0.45;
          mz = (dz / dist) * 1.0 + (dx / dist) * side * 0.45;
        }

        // 上一 tick 净位移几乎为 0（被墙挡住、或被同伴挤住）：强制加一段侧向，
        // 让它横向挪开再走。线上表现为"几辆坦克在建筑边上排成一列、互相顶死"，
        // 每辆单独看都在"移动"，实际一帧没挪。
        if ((e.blockedT || 0) > 0) {
          const s = e.strafeSide || 1;
          mx += (-dz / dist) * s * 1.2;
          mz += (dx / dist) * s * 1.2;
        }

        // 车头对齐不再影响速度，而是直接纠正朝向：
        //   - 有速度惩罚时，敌人一被玩家绕到侧面就只剩 45% 速度，看起来在磨蹭；
        //   - 而"侧移方向随 blockedT 每 0.6 秒翻转"叠加 3 rad/s 的转向，
        //     车头就会反复左右扭，5 秒能累计转 660°（实测），视觉上就是原地打转。
        // 现在移动方向做了时间平滑（_smoothMove），并且车头按同一方向稳定追随，
        // 只有被墙挡住确实改变方向时才会掉头。
        if (!e._mx) { e._mx = mx / (Math.hypot(mx, mz) || 1); e._mz = mz / (Math.hypot(mx, mz) || 1); }
        {
          const l = Math.hypot(mx, mz) || 1;
          const tx = mx / l;
          const tz = mz / l;
          const k = Math.min(1, dt * 2.5);
          e._mx += (tx - e._mx) * k;
          e._mz += (tz - e._mz) * k;
          const nl = Math.hypot(e._mx, e._mz) || 1;
          e._mx /= nl; e._mz /= nl;
        }

        // 实际行进方向用平滑后的方向，避免每 0.6 秒翻一次侧面导致来回扭
        const len = Math.hypot(e._mx, e._mz) || 1;
        const ux = e._mx / len;
        const uz = e._mz / len;
        // 敌人也吃地表：不然玩家陷在沼泽里爬、敌人不受影响，等于电脑开挂。
        // 注意 _checkStuck 里仍用未减速的期望步长，避免泥地里被误判成卡住。
        const step = e.speed * moveMul * dt * speedAt(this.terrain, e.x, e.z);
        e._moveMul = moveMul;
        const nx = e.x + ux * step;
        const nz = e.z + uz * step;
        const ox = e.x;
        const oz = e.z;

        let mx2;
        let mz2;
        let gained;

        if (e.type === 'drone') {
          mx2 = Math.max(-HALF + e.radius, Math.min(HALF - e.radius, nx));
          mz2 = Math.max(-HALF + e.radius, Math.min(HALF - e.radius, nz));
          gained = Math.hypot(mx2 - ox, mz2 - oz);
          e.x = mx2;
          e.z = mz2;
          e.blockedT = 0;
        } else {
          // 撞墙沿切向滑行（与玩家同一套 core/collide.js）。
          // 原来的"先试 x 再试 z、都失败就不动"在建筑拐角会把敌人钉死，
          // 表现是一群坦克贴着楼边不动、或者绕着楼来回蹭。
          const clampEX = (v) => Math.max(-HALF + e.radius, Math.min(HALF - e.radius, v));
          const mv = this.static.slide(ox, oz, ux * step, uz * step, e.radius);
          mx2 = clampEX(mv.x);
          mz2 = clampEX(mv.z);
          gained = Math.hypot(mx2 - ox, mz2 - oz);

          // 正面顶住建筑时切向分量为 0，车会"一格都不动"。
          // 线上实测：敌人能在一个楼角上静止 20 秒（玩家在 30 米外，
          // 走的是"直冲"分支，strafeSide 根本没有参与方向计算）。
          // 这里补一条绕过：贴着墙沿切线方向走，连续被挡再换另一侧。
          if (gained < step * 0.3) {
            const h = this.static.hit(ox + ux * step, oz + uz * step, e.radius);
            if (h) {
              // 墙面的两个切线方向里，先试与"想去的方向"夹角更小的那个；
              // 贴着拐角时那一侧可能刚好走不动（切线是弦，会压进圆弧），
              // 所以两侧都比一遍，谁走得远用谁。
              const tx = -h.nz;
              const tz = h.nx;
              const along = tx * ux + tz * uz;
              const first = Math.abs(along) > 1e-3 ? Math.sign(along) : (e.strafeSide || 1);
              for (const s of [first, -first]) {
                const mv2 = this.static.slide(ox, oz, tx * s * step, tz * s * step, e.radius);
                const qx = clampEX(mv2.x);
                const qz = clampEX(mv2.z);
                const g2 = Math.hypot(qx - ox, qz - oz);
                if (g2 > gained) {
                  mx2 = qx; mz2 = qz; gained = g2;
                }
              }
            }
          }

          e.x = mx2;
          e.z = mz2;
          // 卡住计时统一放在 _checkStuck（_separate 之后），
          // 因为"被同伴挤回去"发生在这里之后，只有那时才能看到净位移。
        }

        // 车体朝实际行进方向（炮塔另算）。
        // 注意：必须朝"实际移动方向"转，而不是朝玩家转——原来朝玩家转，
        // 身体却在侧移，车头永远追不上，视觉上就是原地画圈。
        // 沿墙绕行时实际方向和期望方向不同，车头也要跟着实际方向走。
        const headYaw = gained > 1e-4 ? Math.atan2(mx2 - ox, mz2 - oz) : Math.atan2(ux, uz);
        const diff = angleDiff(headYaw, e.yaw);
        e.yaw += Math.sign(diff) * Math.min(Math.abs(diff), TURN_RATE * dt);
      }

      // 炮塔跟随目标（Boss 跟随提前量点）
      // 哨戒例外：它的 turretYaw 就是光束角度，被这么一掰（3.2 rad/s）
      // 光束会瞬移到玩家脸上，预警性和"卡节奏"就全没了。
      let tdiff;
      if (!e.laserHold) {
        tdiff = angleDiff(fireYaw, e.turretYaw);
        e.turretYaw += Math.sign(tdiff) * Math.min(Math.abs(tdiff), 3.2 * dt);
      } else {
        tdiff = angleDiff(fireYaw, e.turretYaw);
      }

      // 自爆兵贴近即引爆
      if (e.selfDist && dist < e.selfDist) {
        this._explodeEnemy(e, target);
        continue;
      }

      // 远程开火：射程内且炮塔确实指到"能打中"的位置（弧长判据：
      // 角度 × 距离 < 1.2 米。裸角度 0.35 在 25 米处是 8.8 米偏差，
      // 炮塔差着大半格就开炮，弹永远擦身而过）。
      // 棱镜三连点射：0.1 秒一发共 3 发（与单机 Enemy.js 同参数）。
      // 以前联机棱镜只打单发，Boss 伤害只有单机一半。
      // 巡逻/驻军状态下不开火（与下面主开火条件保持一致）。
      if (!passive && (e.burst || 0) > 0) {
        e.burstT -= dt;
        if (e.burstT <= 0) {
          e.burstT = 0.1;
          e.burst -= 1;
          this._enemyBullet(e, fireYaw + (this.rng.combat() - 0.5) * 0.05);
          this._pushEvent({ kind: 'eshot', id: e.id });
        }
      }
      if (!passive && e.range > 0 && e.fireCd <= 0 && dist < e.range && Math.abs(tdiff) * dist < 1.2) {
        e.fireCd = e.fireCdRange[0] + this.rng.combat() * (e.fireCdRange[1] - e.fireCdRange[0]);
        // 命中率：给子弹一点散布，避免"弹弹必中"变成无解消耗
        const spread = 0.06;
        const yaw0 = e.turretYaw + (this.rng.combat() - 0.5) * spread * 2;
        if (e.type === 'boss_breaker') {
          // 破城者三连发：中间稳定命中、两侧封走位（与单机同散布 ±0.15）
          for (const off of [-0.15, 0, 0.15]) this._enemyBullet(e, yaw0 + off);
        } else if (e.type === 'boss_prism') {
          e.burst = 3;
          e.burstT = 0;
          this._enemyBullet(e, yaw0);
        } else {
          this._enemyBullet(e, yaw0);
        }
        // 敌人开炮事件：只带 id（坐标客户端自己从实体上读，省字节）。
        // 客户端拿它在小地图上闪一下——联机里没有炮口火光也没有音效，
        // 这是玩家唯一能察觉"有人朝我开火"的信号。
        this._pushEvent({ kind: 'eshot', id: e.id });
      }

      // 补给车治疗周围：按最大血量的百分比，两端同一份参数
      // （core/world.js 的 ENEMY_TYPES.support，单机 Enemy.js 也读它）。
      if (e.healAura) {
        const H = ENEMY_TYPES.support;
        for (const o of this.enemies) {
          if (o === e || !o.alive || o.hp >= o.maxHp) continue;
          if (Math.hypot(o.x - e.x, o.z - e.z) >= e.healAura) continue;
          const mul = o.boss ? H.bossHealMul : 1;
          if (mul <= 0) continue;
          o.hp = Math.min(o.maxHp, o.hp + o.maxHp * H.healRate * mul * dt);
        }
      }
    }
  }

  // ---------------- Boss 技能（r46）----------------

  /**
   * 场地标记：预警圈 / 岩浆区 / 冲刺路径 / 冲击波。
   *
   * 全部走一条 { kind, x, z, r, t, ttl, dur }，通过快照 bz 同步。
   * 为什么不用一次性事件：预警圈有 1.2 秒的持续状态，迟入或重连的玩家
   * 错过事件就完全读不懂画面（看到 Boss 突然出现在身后）。
   */
  _addZone(kind, x, z, r, dur) {
    const zone = { kind, x, z, r, t: 0, ttl: dur, dur };
    this.zones.push(zone);
    return zone;
  }

  _updateZones(dt) {
    // 判定写在 core/bosskit.js 的 stepZones 里，单机 Game.js 调同一份——
    // 否则岩浆/炮击的结算时序在两种模式下迟早分叉。
    stepZones(this.zones, dt, this.players,
      (p, amount) => this._damagePlayer(p, amount, 0),
      this.events);
  }

  /** 以 Boss 为中心的范围伤害（落地冲击波、转阶段冲击波共用） */
  _bossShock(e, r, dmg) {
    for (const p of this.players) {
      if (!p.alive || p.down) continue;
      if (Math.hypot(p.x - e.x, p.z - e.z) < r) this._damagePlayer(p, dmg, e.id);
    }
    this._pushEvent({ kind: 'bossShock', id: e.id, x: e.x, z: e.z, r });
  }

  _endBossCast(e, cd) {
    e.castKind = null;
    e.castT = 0;
    e.castDur = 0;
    e.skillT = cd;
  }

  /**
   * Boss 专属技能调度。
   *
   * 返回 true 表示"本 tick 由技能接管"，调用方跳过普通移动与开火。
   *
   * 设计底线：所有技能必须可读——要么有 ≥0.9 秒的预警，要么位移本身
   * 可读（冲刺 0.32 秒走 8 米）。绝对不允许"原地闪现"：r45 删掉棱镜的
   * 相位跃迁，就是因为它落点距离与 AI 保持距离重合，玩家只看到位置突变。
   */
  _updateBossSkill(e, dt, target) {
    const SK = BOSS_SKILLS;
    const kind = (BOSS_META[e.type] || {}).kind;

    // 觉醒"再生"：每秒回 0.5% 最大血量。放在最前面，任何技能分支返回前都已经生效。
    if (e.regen && e.hp < e.maxHp) {
      e.hp = Math.min(e.maxHp, e.hp + e.maxHp * AWAKEN_NUM.regenPerSec * dt);
    }

    // ---- 施法中 ----
    if (e.castKind === 'blinkWarn') {
      e.castT -= dt;
      e.turretYaw = Math.atan2(target.x - e.x, target.z - e.z);
      if (e.castT <= 0) {
        if (e.zone) {
          e.x = e.zone.x;
          e.z = e.zone.z;
          // 让预警圈快速淡出，别停在原地骗人
          e.zone.ttl = Math.min(e.zone.ttl, 0.18);
          e.zone.dur = Math.max(0.01, e.zone.ttl);
        }
        this._bossShock(e, SK.blink.shockR, SK.blink.shockDmg);
        this._pushEvent({ kind: 'bossBlink', id: e.id, x: e.x, z: e.z });
        e.zone = null;
        this._endBossCast(e, SK.blink.cd);
      }
      return true;
    }

    if (e.castKind === 'dash') {
      e.castT -= dt;
      const step = (SK.dash.dist / SK.dash.dur) * dt;
      const nx = e.x + e.dashX * step;
      const nz = e.z + e.dashZ * step;
      // 撞墙就提前结束：不然会贴着建筑一直"冲"，看起来像卡住
      if (this.static.blocked(nx, nz, e.radius)) {
        e.castT = 0;
      } else {
        e.x = nx;
        e.z = nz;
        e.yaw = Math.atan2(e.dashX, e.dashZ);
        e.turretYaw = e.yaw;
      }
      // 冲刺途中撞到玩家只结算一次（否则一帧一次，直接秒人）
      if (!e.hitDone) {
        for (const p of this.players) {
          if (!p.alive || p.down) continue;
          if (Math.hypot(p.x - e.x, p.z - e.z) < SK.dash.hitR) {
            this._damagePlayer(p, SK.dash.dmg, e.id);
            e.hitDone = true;
            break;
          }
        }
      }
      if (e.castT <= 0) {
        // 硬直是给玩家的输出窗口：停火停走 1.5 秒
        e.castKind = 'stun';
        e.castT = SK.dash.stun;
        e.castDur = SK.dash.stun;
        e.zone = null;
        this._pushEvent({ kind: 'bossStun', id: e.id, x: e.x, z: e.z });
      }
      return true;
    }

    if (e.castKind === 'stun') {
      e.castT -= dt;
      if (e.castT <= 0) this._endBossCast(e, SK.dash.cd);
      return true;
    }

    // ---- 铁壁：护盾循环（持续型，不走 castKind）----
    // 动词是"找"：盾在的时候正面打不动，必须先打掉壳，破防 6 秒才是输出窗口。
    // 护盾期间仍然移动/开火——它不是木桩，是个慢速炮台。
    if (kind === 'bulwark') {
      e.breakT = Math.max(0, (e.breakT || 0) - dt);
      if (e.shieldHp > 0) {
        // 护盾环跟着本体走：玩家要能一眼看出"壳还在"
        if (!e.zone) e.zone = this._addZone(ZONE.SHOCK, e.x, e.z, 3.6, 999);
        e.zone.x = e.x;
        e.zone.z = e.z;
        e.zone.ttl = 999;
        e.zone.dur = 999;
        return false;
      }
      if (e.zone) {
        const i = this.zones.indexOf(e.zone);
        if (i >= 0) this.zones.splice(i, 1);
        e.zone = null;
      }
      if (e.breakT > 0) return false;      // 破防中：正常打，这是玩家的窗口
      // 破防结束，重新罩上
      e.shieldHp = Math.round(e.maxHp * SK.generators.hpShare * SK.generators.count);
      this._pushEvent({ kind: 'bossShield', id: e.id });
      return false;
    }

    // ---- 蜂巢：召唤（持续型）----
    // 动词是"分"：本体不动，但场上会一直变多。上限 9 是性能预算，
    // 也是"清不完但也不会瞬间淹掉"的平衡点。
    if (kind === 'hive') {
      e.skillT = (e.skillT || 0) - dt / (e.cdMul || 1);
      if (e.skillT > 0) return false;
      const cap = SK.spawn.cap;
      let mine = 0;
      for (const o of this.enemies) if (o.alive && o.owner === e.id) mine++;
      if (mine >= cap) { e.skillT = 2; return false; }
      const n = Math.min(SK.spawn.count, cap - mine);
      for (let i = 0; i < n; i++) {
        const a = this.rng.combat() * Math.PI * 2;
        const r = 3.5 + this.rng.combat() * 3;
        let x = e.x + Math.sin(a) * r;
        let z = e.z + Math.cos(a) * r;
        if (this.static.blocked(x, z, 1.2)) { x = e.x; z = e.z; }
        this.pending.push({
          t: 0.15 + i * 0.25,
          type: 'drone',
          hp: Math.round((55 + this.wave * 14) * 0.35 * this.scale.hpMul),
          x, z, owner: e.id,
        });
      }
      e.skillT = SK.spawn.cd;
      this._pushEvent({ kind: 'bossSpawn', id: e.id, n });
      return true;      // 召唤那一拍停一下，别一边召一边冲
    }

    // ---- 熔核：铺岩浆（持续型的地面压制）----
    // 动词是"站"：伤害本身不高，但它把可站立的地面一块块切掉，
    // 玩家必须在"躲炮线"和"躲岩浆"之间找落脚点。
    if (kind === 'crucible') {
      e.skillT = (e.skillT || 0) - dt / (e.cdMul || 1);
      // 炮击单独一套计时器（18s）。和铺岩浆共用 skillT 的话两者永远同时发生，
      // 节奏会固定成"一次岩浆 + 一次炮击"，第二次就背下来了。
      e.blastT = (e.blastT ?? SK.barrage.cd * 0.5) - dt;
      if (e.blastT <= 0) {
        e.blastT = SK.barrage.cd;
        // 脚下一发 + 外围两发：站着不动必吃第一发，而躲第一发时
        // 外围那两发正好把"空地"也切掉——这才是"没地方站"。
        const r = 6;
        this._addZone(ZONE.BLAST, target.x, target.z, r, SK.barrage.warn);
        for (let i = 0; i < 2; i++) {
          const a = this.rng.combat() * Math.PI * 2;
          const d2 = 9 + this.rng.combat() * 5;
          const bx = Math.max(-HALF + 6, Math.min(HALF - 6, target.x + Math.sin(a) * d2));
          const bz = Math.max(-HALF + 6, Math.min(HALF - 6, target.z + Math.cos(a) * d2));
          this._addZone(ZONE.BLAST, bx, bz, r, SK.barrage.warn);
        }
        this._pushEvent({ kind: 'bossBarrage', id: e.id });
      }
      if (e.skillT > 0) return false;
      // 围着"当前目标"铺，而不是 players[0]：players[0] 可能是已倒地的那位，
      // 多人的时候岩浆就会全泼在没人站的角落。
      for (let i = 0; i < SK.lava.count; i++) {
        const a = this.rng.combat() * Math.PI * 2;
        const r = 5 + this.rng.combat() * 9;
        const x = Math.max(-HALF + 6, Math.min(HALF - 6, target.x + Math.sin(a) * r));
        const z = Math.max(-HALF + 6, Math.min(HALF - 6, target.z + Math.cos(a) * r));
        if (this.static.blocked(x, z, 2)) continue;
        this._addZone(ZONE.LAVA, x, z, SK.lava.r, SK.lava.dur);
      }
      // 玩家脚下一块大的：逼他立刻挪窝，而不是站着不动等岩浆散
      this._addZone(ZONE.LAVA, target.x, target.z, SK.lava.r * 1.6, SK.lava.dur * 0.75);
      e.skillT = SK.lava.cd;
      this._pushEvent({ kind: 'bossLava', id: e.id, x: e.x, z: e.z });
      return true;
    }

    // ---- 哨戒：双旋转光束（持续型）----
    // 动词是"掐"：两道光束匀速扫，玩家要卡着间隙穿过去。
    // 判定是「角差 × 距离」的连续命中，不是发子弹（理由见 BOSS_SKILLS.laser）。
    if (kind === 'warden') {
      const enr = e.maxHp > 0 && e.hp <= e.maxHp * SK.laser.enrageAt;
      e.laserDir = e.laserDir || 1;
      e.laserYaw = (e.laserYaw ?? e.turretYaw) + (enr ? SK.laser.enragedSpeed : SK.laser.speed) * e.laserDir * dt;
      e.turretYaw = e.laserYaw;        // 客户端靠 turretYaw 画光束，不用动协议

      // 反向：不能靠"一直顺时针跑"混过去
      e.laserFlipT = (e.laserFlipT ?? SK.laser.cd) - dt;
      if (e.laserFlipT <= 0) {
        e.laserDir *= -1;
        e.laserFlipT = SK.laser.cd;
        this._pushEvent({ kind: 'bossFlip', id: e.id });
      }

      // 伤害按 0.2 秒结算：逐帧推 hurt 事件会把客户端音效糊成一片，
      // 而 0.2 秒内光束只转过 0.11 弧度（10 米处约 1.1 米），漏判可以忽略。
      e.laserAcc = (e.laserAcc || 0) + dt;
      if (e.laserAcc >= SK.laser.tick) {
        const per = SK.laser.dps * e.laserAcc;
        e.laserAcc = 0;
        for (const p of this.players) {
          if (!p.alive || p.down) continue;
          if (laserHits(e.x, e.z, e.laserYaw, p.x, p.z)) this._damagePlayer(p, per, e.id);
        }
      }
      // 炮塔角度 = 光束角度。普通 AI 后面会以 3.2 rad/s 把 turretYaw 掰向
      // 瞄准点，光束就会"跳"到脸上——所以整个 warden 期间禁止它追瞄准。
      // 副作用（好的那种）：普通弹只在光束扫过玩家的那一刻才打得出去。
      e.laserHold = true;
      return false;   // 仍然可以慢慢移动
    }

    // ---- 双生：共鸣钳位（持续型）----
    // 动词是"平"：两只的血量差一旦超过 15%，低的那只就被拉回来。
    // 所以只能两边一起压，最后一起收——打死一只再打另一只不是被禁止，
    // 而是"另一只脱离共鸣后反而更好打"，玩家会自己发现该先同步。
    if (kind === 'twin') {
      const other = this.enemies.find((x) => x !== e && x.alive && x.type === 'boss_twin');
      if (other) {
        const add = resonancePull(e.hp, other.hp, e.maxHp, dt);
        if (add > 0) {
          e.hp = Math.min(e.maxHp, e.hp + add);
          e.pullT = (e.pullT || 0) + dt;
          // 每 0.4 秒报一次，客户端据此放一次回血光效——
          // 逐帧报的话，一场共鸣会推几百条事件
          if (e.pullT >= 0.4) {
            e.pullT = 0;
            this._pushEvent({ kind: 'bossResonance', id: e.id, x: e.x, z: e.z });
          }
        }
      }
      return false;
    }

    // ---- 终焉：三阶段 ----
    // 动词是"换"：一条血条分三段，每段换一套动作，把前面九个 Boss 的课重考一遍。
    if (kind === 'terminus') {
      // 转阶段中：无敌 + 站桩，让"阶段变了"这件事被看见
      if (e.castKind === 'phase') {
        e.castT -= dt;
        if (e.castT <= 0) {
          e.castKind = null;
          e.invuln = false;
          this._endBossCast(e, 1.0);
        }
        return true;
      }

      const ratio = e.maxHp > 0 ? e.hp / e.maxHp : 1;
      const want = bossStageFor(ratio);
      if (want > (e.stage || 0)) {
        e.stage = want;
        e.invuln = true;
        e.castKind = 'phase';
        e.castT = SK.phases.invuln;
        e.castDur = SK.phases.invuln;
        // 先把当前阶段的血量记下来，血条靠它算"这一阶段打了多少"
        if (want === 2) e.speed *= SK.phases.stage3SpeedMul;
        this._bossShock(e, SK.phases.shockR, SK.phases.shockDmg);
        this._addZone(ZONE.SHOCK, e.x, e.z, SK.phases.shockR, SK.phases.invuln);
        this._pushEvent({ kind: 'bossPhase', id: e.id, stage: want });
        return true;
      }

      // 阶段一：三连点射（普通 AI 负责主炮）
      if ((e.stage || 0) === 0) {
        e.salvoT = (e.salvoT || 0) - dt;
        if (e.salvoT <= 0) {
          e.salvoT = SK.salvo.cd;
          e.burst = SK.burst.count;
          e.burstT = 0;
        }
        return false;
      }

      // 阶段二：召唤精英 + 岩浆区（复刻熔核的地面压制）
      if (e.stage === 1) {
        e.eliteT = (e.eliteT || SK.phases.stage2EliteCd) - dt;
        if (e.eliteT <= 0) {
          e.eliteT = SK.phases.stage2EliteCd;
          for (let i = 0; i < SK.phases.stage2Elites; i++) {
            const a = this.rng.combat() * Math.PI * 2;
            const r = 4 + this.rng.combat() * 3;
            this.pending.push({
              t: 0.2 + i * 0.3, type: 'elite',
              hp: Math.round((55 + this.wave * 14) * 4 * this.scale.hpMul),
              x: e.x + Math.sin(a) * r, z: e.z + Math.cos(a) * r,
            });
          }
          this._pushEvent({ kind: 'bossSpawn', id: e.id, n: SK.phases.stage2Elites });
        }
        e.lavaT = (e.lavaT || SK.phases.stage2LavaCd) - dt;
        if (e.lavaT <= 0) {
          e.lavaT = SK.phases.stage2LavaCd;
          for (let i = 0; i < SK.lava.count; i++) {
            const a = this.rng.combat() * Math.PI * 2;
            const r = 6 + this.rng.combat() * 9;
            const x = Math.max(-HALF + 6, Math.min(HALF - 6, target.x + Math.sin(a) * r));
            const z = Math.max(-HALF + 6, Math.min(HALF - 6, target.z + Math.cos(a) * r));
            if (this.static.blocked(x, z, 2)) continue;
            this._addZone(ZONE.LAVA, x, z, SK.lava.r, SK.lava.dur);
          }
        }
        return false;
      }

      // 阶段三：冲刺 + 环射，两者各自计时
      e.dashT = (e.dashT ?? SK.phases.stage3DashCd) - dt;
      e.ringT = (e.ringT ?? 1.2) - dt;
      if (e.ringT <= 0) {
        e.ringT = SK.phases.stage3RingCd;
        const n = SK.ring.count;
        for (let i = 0; i < n; i++) this._enemyBullet(e, e.turretYaw + (i / n) * Math.PI * 2);
        this._pushEvent({ kind: 'bossRing', id: e.id });
      }
      if (e.dashT <= 0) {
        e.dashT = SK.phases.stage3DashCd;
        const d = Math.hypot(target.x - e.x, target.z - e.z) || 1;
        e.dashX = (target.x - e.x) / d;
        e.dashZ = (target.z - e.z) / d;
        e.hitDone = false;
        e.castKind = 'dash';
        e.castT = SK.dash.dur;
        e.castDur = SK.dash.dur;
        return true;
      }
      return false;
    }

    // ---- 冷却 ----
    // 狂暴词条不改各技能的 cd 常量，而是让冷却"走得更快"：
    // 一处改动，所有技能自动生效，不会漏掉某个新加的 Boss。
    e.skillT = (e.skillT || 0) - dt / (e.cdMul || 1);
    if (e.skillT > 0) return false;

    // ---- 选技能 ----
    if (kind === 'wraith') {
      // 幽影：先在玩家周围选一个"能站人"的落点，亮 1.2 秒预警圈再跳过去。
      // 距离 12~16m：比 AI 的保持距离（12~20）略近，玩家能看到它真的压上来，
      // 而不是"距离没变只换方向"那种瞬移观感。
      const pt = this._blinkSpot(e, target, SK.blink.minDist, SK.blink.maxDist);
      if (!pt) { e.skillT = 1.0; return false; }
      e.castKind = 'blinkWarn';
      e.castT = SK.blink.warn;
      e.castDur = SK.blink.warn;
      e.zone = this._addZone(ZONE.WARN, pt.x, pt.z, 2.6, SK.blink.warn);
      e.skillT = SK.blink.cd;
      this._pushEvent({ kind: 'bossWarn', id: e.id, x: pt.x, z: pt.z });
      return true;
    }

    if (kind === 'blitz') {
      // 疾风：朝玩家方向直线冲 8 米（0.32 秒），到点后硬直 1.5 秒。
      // 冲刺方向冻结在起手瞬间，玩家往侧向一让就能躲开——这是"可读"的关键：
      // 如果每帧重新对准，就等于必中。
      const d = Math.hypot(target.x - e.x, target.z - e.z) || 1;
      e.dashX = (target.x - e.x) / d;
      e.dashZ = (target.z - e.z) / d;
      e.hitDone = false;
      e.castKind = 'dash';
      e.castT = SK.dash.dur;
      e.castDur = SK.dash.dur;
      e.zone = this._addZone(ZONE.DASH, e.x, e.z, SK.dash.hitR, SK.dash.dur);
      e.skillT = SK.dash.cd;
      this._pushEvent({ kind: 'bossDash', id: e.id, x: e.x, z: e.z });
      return true;
    }

    return false;
  }

  /** 在玩家周围找一个不撞建筑、且离玩家 [minD, maxD] 的落点 */
  _blinkSpot(e, target, minD, maxD) {
    for (let i = 0; i < 20; i++) {
      const a = this.rng.combat() * Math.PI * 2;
      const r = minD + this.rng.combat() * (maxD - minD);
      const x = Math.max(-HALF + 4, Math.min(HALF - 4, target.x + Math.sin(a) * r));
      const z = Math.max(-HALF + 4, Math.min(HALF - 4, target.z + Math.cos(a) * r));
      if (this.static.blocked(x, z, e.radius + 0.4)) continue;
      const d = Math.hypot(x - target.x, z - target.z);
      if (d < minD * 0.85) continue;
      return { x, z };
    }
    return null;
  }

  /**
   * 敌方一发子弹（收拢了三处重复的 push）
   * opts 可选覆盖：{ damage, speed, life }
   * 例：哨戒的旋转激光要「伤害低、弹速快、寿命短」，不能走 Boss 默认的 damage/bulletSpeed
   */
  _enemyBullet(e, yaw, opts) {
    const speed = opts && opts.speed != null ? opts.speed : e.bulletSpeed;
    this.bullets.push({
      id: nextId(),
      x: e.x + Math.sin(yaw) * 1.6,
      z: e.z + Math.cos(yaw) * 1.6,
      yaw,
      vx: Math.sin(yaw) * speed,
      vz: Math.cos(yaw) * speed,
      team: 1,
      owner: e.id,
      damage: opts && opts.damage != null ? opts.damage : e.damage,
      life: opts && opts.life != null ? opts.life : 2.6,
    });
  }

  _explodeEnemy(e, target) {
    const r = e.selfDestruct;
    for (const p of this.players) {
      if (!p.alive || p.down) continue;
      const d = Math.hypot(p.x - e.x, p.z - e.z);
      if (d < r) this._damagePlayer(p, e.damage * (1 - d / r), e.id);
    }
    e.alive = false;
    e.hp = 0;
    this._pushEvent({ kind: 'boom', x: e.x, z: e.z, r });
  }

  // ---------------- 子弹 ----------------

  _updateBullets(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const px = b.x;
      const pz = b.z;
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      b.life -= dt;

      // 扫掠检测：子弹一帧能飞 2.6 米（78m/s ÷ 30Hz），
      // 只测端点会直接穿过敌人（半径才 1.45 米），必须测整条线段。
      const hit = { enemy: null, player: null, wall: false };
      const onSeg = [];

      if (b.team === 0) {
        for (const e of this.enemies) {
          if (!e.alive) continue;
          // 穿透弹已经伤过的目标不再重复判定（同一颗弹只伤同一目标一次）
          if (b.hitIds && b.hitIds.has(e.id)) continue;
          const d = segCircle(px, pz, b.x, b.z, e.x, e.z, e.radius + 0.4);
          if (d >= 0) onSeg.push({ t: d, e });
        }
        onSeg.sort((m, n) => m.t - n.t);
        hit.enemy = onSeg.length ? onSeg[0].e : null;
      } else if (b.team === 1) {
        for (const p of this.players) {
          if (!p.alive || p.down) continue;
          const d = segCircle(px, pz, b.x, b.z, p.x, p.z, 1.9);
          if (d >= 0) onSeg.push({ t: d, p });
        }
        onSeg.sort((m, n) => m.t - n.t);
        hit.player = onSeg.length ? onSeg[0].p : null;
      }

      // 撞墙：取线段上第一个被挡住的采样点
      if (this.static.blocked(b.x, b.z, 0.35)) hit.wall = true;

      let dead = b.life <= 0 || hit.wall
        || Math.abs(b.x) > HALF + 2 || Math.abs(b.z) > HALF + 2;

      if (hit.enemy) {
        this._hitEnemy(hit.enemy, b.damage, b.owner, b);
        // 高爆弹头：命中点溅射，直接命中的目标不重复吃（与单机 _explodeAt 同参）
        if (b.explosive > 0) this._splashAt(b, hit.enemy);
        // 穿透：消耗一次次数后继续飞行（与单机同规则）
        if (b.pierce > 0) {
          b.pierce -= 1;
          (b.hitIds = b.hitIds || new Set()).add(hit.enemy.id);
        } else {
          dead = true;
        }
      } else if (hit.player) {
        this._damagePlayer(hit.player, b.damage, b.owner);
        dead = true;
      }

      if (dead) this.bullets.splice(i, 1);
    }
  }

  /** 高爆溅射：以弹着点为圆心的范围伤害，伤害吃持有者的 splashDamageMul */
  _splashAt(bullet, direct) {
    const radius = 4.2 * (bullet.splashMul || 1);
    const owner = this.players.find((p) => p.id === bullet.owner);
    const mul = owner ? owner.stats.splashDamageMul : 1;
    const damage = 30 * bullet.explosive * mul;
    for (const e of this.enemies) {
      if (!e.alive || e === direct) continue;
      if (Math.hypot(e.x - bullet.x, e.z - bullet.z) < radius) {
        this._hitEnemy(e, damage, bullet.owner, bullet);
      }
    }
    // 客户端复用自爆兵的 boom 事件播爆炸特效
    this._pushEvent({ kind: 'boom', x: bullet.x, z: bullet.z, r: radius });
  }

  _hitEnemy(e, damage, ownerId, bullet) {
    // 终焉转阶段的无敌（2 秒）：这是"阶段变了"的读条窗，也是玩家换位置的时间。
    // 子弹照飞、照有火花，但血量不动——所以客户端要能看到阶段提示，
    // 否则会被当成"打不动 / 卡了"。
    if (e.invuln) {
      this._pushEvent({ kind: 'immune', id: e.id, x: e.x, z: e.z });
      return;
    }
    // 铁壁的护盾：伤害全打在壳上，本体一滴不掉。
    // 打空的那一刻进入破防（breakT），这 6 秒才是真血条在掉。
    // 注意这里要 return —— 不能继续走下面的 frontArmor 与扣血，
    // 否则"打盾"会顺带削本体，绕后找弱点就失去意义了。
    if (e.shieldHp > 0) {
      const absorbed = Math.min(e.shieldHp, damage);
      e.shieldHp -= absorbed;
      this._pushEvent({ kind: 'shieldHit', id: e.id, x: e.x, z: e.z });
      if (e.shieldHp <= 0.001) {
        e.shieldHp = 0;
        e.breakT = BOSS_SKILLS.generators.breakDur;
        this._pushEvent({ kind: 'bossBreak', id: e.id, x: e.x, z: e.z });
      }
      return;
    }

    // 觉醒"装甲"：所有伤害 ×0.75（与"正面减伤"相乘，铁壁+装甲会很硬，
    // 但那是 55 波以后的事）
    if (e.dmgMul && e.dmgMul !== 1) damage *= e.dmgMul;

    // 重盾兵：正面来的伤害减半（打侧后有效）
    if (e.frontArmor) {
      const incoming = Math.atan2(bullet.x - e.x, bullet.z - e.z);
      let d = incoming - e.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) < Math.PI * 0.4) damage *= e.frontArmor;
    }

    e.hp -= damage;
    // 挨打就醒：命中会让这一队（以及 26 米内的同伴）从巡逻转入追击。
    // 没有这条，"打巡逻队"会变成单方面点名——后面的车还在原地绕圈。
    if (e.patrol) {
      wakePatrol(e.patrol);
      for (const o of this.enemies) {
        if (o === e || !o.alive || !o.patrol) continue;
        if (Math.hypot(o.x - e.x, o.z - e.z) < PATROL.callR) wakePatrol(o.patrol);
      }
    }
    const owner = this.players.find((p) => p.id === ownerId);
    if (owner) {
      owner.stats.damage += Math.min(damage, Math.max(0, e.hp + damage));
      owner.stats.hits++;
    }

    if (e.hp <= 0) {
      e.hp = 0;
      e.alive = false;
      const mul = this.scale.scoreMul;
      if (owner) {
        owner.stats.kills++;
        owner.stats.score += Math.round(e.score * mul);
        if (owner.killHeal) owner.hp = Math.min(owner.maxHp, owner.hp + owner.killHeal);
      }
      this._pushEvent({ kind: 'kill', id: e.id, x: e.x, z: e.z, by: ownerId, boss: !!e.boss });

      // 蜂巢倒下，召唤物一起散：否则玩家打完本体还要满地图清 9 只无人机，
      // 波次也永远清不到 0（enemiesLeft 卡住 → 选卡不弹 → 卡死）。
      if (e.type === 'boss_hive') {
        for (const o of this.enemies) {
          if (o.alive && o.owner === e.id) {
            o.hp = 0;
            o.alive = false;
            this._pushEvent({ kind: 'kill', id: o.id, x: o.x, z: o.z, by: ownerId, boss: false });
          }
        }
      }
    }
  }

  _damagePlayer(p, amount, fromId) {
    if (!p.alive || p.down) return;
    p.hp -= amount * (p.takenMul || 1) * PLAYER_TAKEN;
    this._pushEvent({ kind: 'hurt', id: p.id });
    if (p.hp <= 0) {
      p.hp = 0;
      // 复活逻辑交给 updateRevive 统一切换到倒地
    }
  }

  // ---------------- 波次 ----------------

  startWave(n) {
    this.wave = n;
    const bossWave = n % 5 === 0;
    const eliteWave = !bossWave && n % 5 === 3;
    // 数量曲线（r42）：前 7 波不变；第 8 波起增速从 2.5/波 放缓到 1.4/波。
    // 后期波次的卡顿主要来自场上并发对象数（draw call / 实例数都随它涨），
    // 省下的数量按 5%/波 折成单体血量（封顶 +30%），总血量基本持平——
    // 打起来的节奏不变，但同屏坦克少了 20~30%。
    const base = (n <= 7
      ? 2 + n * 2 + Math.min(6, Math.floor(n / 2))
      : Math.round(19 + (n - 7) * 1.4)) - (n % 5 === 3 ? 2 : 0);
    const hpBoost = n <= 7 ? 1 : 1 + Math.min(0.30, (n - 7) * 0.05);
    const count = Math.round(base * this.scale.countMul);
    // hpBoost 只作用于小兵：Boss 本身就是单体，加血不影响性能只延长战斗
    const hp = Math.round((55 + n * 14) * this.scale.hpMul * hpBoost);
    const speed = 8.5 + Math.min(4.5, n * 0.6);

    this.waveActive = true;
    this.pending = [];
    // 残局兜底用：一波打太久、或只剩几只时，把还在巡逻的车全部转成猎杀，
    // 否则玩家要在 200×200 的地图上满地图找最后一辆绕圈的车。
    this.waveClock = 0;
    this.huntSent = false;

    if (bossWave) {
      // 轮换走 bosskit：W5 破城者 → W10 棱镜 → … → W50 终焉；55 波起随机抽取
      // （不与上一波重复）。以前这里只按 floor(n/5) 的奇偶二选一，
      // 加新 Boss 就必须在单机、联机、HUD 三处各改一遍。
      const type = bossTypeForWave(n) || pickLateBoss(() => this.rng.spawn(), this._lastBossType);
      this._lastBossType = type;
      const meta = BOSS_META[type] || BOSS_META.boss_breaker;
      // Boss 血量不吃小兵的 hpBoost（单体加血只会拖长战斗），人数缩服用
      // bossHpMul（c^0.8）：小兵那份 c^0.45 是配合"数量也涨"的，
      // 用在 Boss 上会让四人房比单人还快一倍。
      const bossHp = bossHpFor(n, type, bossHpMul(this.players.length || 1));
      // 55 波起抽觉醒词条（数量随波次：1 / 2 / 3）。抽签用确定性流，
      // 同一房间的双端会抽到同一组——否则"客户端显示装甲、服务端按无装甲算"。
      const awaken = rollAwakens(n, () => this.rng.spawn());
      const twins = meta.twins || 1;
      for (let i = 0; i < twins; i++) {
        this.pending.push({ t: 0.7 + i * 1.6, type, hpScale: bossHp, awaken });
      }
      // Boss 波护卫封顶 8：3 + floor(n/4) 到第 40 波是 13 只，再叠召唤类
      // 会突破"同屏 ≤18"的硬预算（r42 刚因为对象数太多减过量）。
      // "召唤"词条同样受这个上限约束——它加的是压力，不是渲染开销。
      const escort = Math.min(8, Math.round((3 + Math.floor(n / 4))
        * (awaken.includes('summon') ? AWAKEN_NUM.escortMul : 1)));
      for (let i = 0; i < escort; i++) {
        this.pending.push({ t: 1.7 + i * 0.9, type: 'gunner', hp: Math.round(hp * 0.8) });
      }
    } else {
      if (eliteWave) {
        const ec = n >= 13 ? 3 : 2;
        for (let i = 0; i < ec; i++) this.pending.push({ t: 1.2 + i * 2.4, type: 'elite', hp: Math.round(hp * 4) });
      }
      for (let i = 0; i < count; i++) this.pending.push({ t: i * 0.75, type: 'gunner', hp });
      for (let j = 0; j < Math.max(1, Math.round(Math.min(8, Math.floor(n / 2)))); j++) {
        this.pending.push({ t: 2.2 + j * 1.1, type: 'charger', hp: Math.max(30, Math.round(hp * 0.5)) });
      }
      if (n >= 4) for (let i = 0; i < Math.max(1, Math.round(Math.min(6, Math.floor((n - 2) / 2)))); i++) this.pending.push({ t: 3.5 + i * 1.4, type: 'drone', hp: Math.max(18, Math.round(hp * 0.3)) });
      if (n >= 6) for (let i = 0; i < Math.min(2, 1 + Math.floor(n / 12)); i++) this.pending.push({ t: 2.5 + i * 3, type: 'turret', hp: Math.round(hp * 2.2) });
      if (n >= 7) this.pending.push({ t: 4.5, type: 'support', hp: Math.round(hp * 1.4) });
      if (n >= 8) for (let i = 0; i < Math.max(1, Math.round(Math.min(4, Math.floor((n - 4) / 2)))); i++) this.pending.push({ t: 5.5 + i * 2.2, type: 'shield', hp: Math.round(hp * 1.3) });
    }

    // 战场宝箱：每波开局空投（r43）。没被捡的箱子留着，跨波有效。
    this._spawnCrates();

    this._pushEvent({ kind: 'wave', wave: n, boss: bossWave, elite: eliteWave });
  }

  /**
   * 空投宝箱。数量随人数（1~2 人 1~2 个 / 3~4 人 2~3 个），位置远离玩家
   * 与建筑。类别决定箱子的外观标识；内容在**拾取时**才按拾取者开出，
   * 所以两个人抢同一个箱子各得其所，也永远不会开出满级的卡。
   */
  _spawnCrates() {
    const count = crateCount(this.players.length || 1, () => this.rng.spawn(), this.wave);
    const pts = cratePositions({
      half: HALF,
      players: this.players.filter((p) => p.alive),
      blocked: (x, z) => this.static.blocked(x, z, 2.2),
      rnd: () => this.rng.spawn(),
      count,
    });
    if (!pts.length) return;
    for (const pt of pts) {
      this.crates.push({
        id: ++this._crateSeq,
        x: pt.x,
        z: pt.z,
        cat: rollCategory(() => this.rng.spawn()),
      });
    }
    // 不再推 'crates' 事件：宝箱随快照做状态同步（见 protocol.js 的 cr 字段），
    // 一次性事件会被大厅→战场切换中的客户端整个错过。
  }

  /** 拾取判定：活着且没倒地的玩家，开到 3.2m 内自动开箱 */
  _updateCrates() {
    if (!this.crates.length) return;
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      let taker = null;
      for (const p of this.players) {
        if (!p.alive || p.down) continue;
        if (Math.hypot(p.x - c.x, p.z - c.z) < 3.2) { taker = p; break; }
      }
      if (!taker) continue;
      const card = rollCard(taker.stats, taker.stats.counts, c.cat, () => this.rng.spawn());
      const applied = this._applyPickup(taker, card);
      this.crates.splice(i, 1);
      this._pushEvent({
        kind: 'crateGet',
        cid: c.id,
        id: taker.id,
        cat: c.cat,
        card: { id: card.id, name: card.name, icon: card.icon, rarity: card.rarity, desc: card.desc },
        hp: applied.hp,
        maxHp: applied.maxHp,
      });
    }
  }

  /** 把一张卡应用到玩家（applyCard 的 world 内封装，含血量回写） */
  _applyPickup(p, card) {
    const s = p.stats;
    card.apply(s, p);
    s.counts[card.id] = (s.counts[card.id] || 0) + 1;
    p.speedBase = s.speed;
    p.maxHp = s.maxHp;
    p.hp = Math.min(p.hp, p.maxHp);
    p.killHeal = s.killHeal;
    return { hp: Math.round(p.hp), maxHp: p.maxHp };
  }

  _updateWaves(dt) {
    this.waveClock = (this.waveClock || 0) + dt;

    // 待入场
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const it = this.pending[i];
      it.t -= dt;
      if (it.t <= 0) {
        this._spawn(it);
        this.pending.splice(i, 1);
      }
    }

    this.enemiesLeft = this.enemies.length + this.pending.length;

    // 残局兜底：只剩最后几只，或这一波已经打了 75 秒，巡逻队转猎杀
    if (this.waveActive && !this.huntSent && this.enemiesLeft > 0 &&
        (this.enemiesLeft <= 3 || this.waveClock > 75)) {
      this.huntSent = true;
      for (const e of this.enemies) if (e.patrol) sendHunting(e.patrol);
    }

    const anyAlive = this.players.some((p) => p.alive);
    if (!anyAlive) {
      this.state = 'over';
      this._pushEvent({ kind: 'over' });
      return;
    }

    if (this.waveActive && this.enemiesLeft === 0) {
      this.waveActive = false;
      this.waveGap = 4;
      // 清完一波给全员补一口：小局制 + 倒地救援之外的第二层容错
      // r30：纳米修复（waveHeal）卡的固定回血也计入——以前这张卡联机白拿
      for (const p of this.players) {
        if (p.alive && !p.down) {
          p.hp = Math.min(p.maxHp, p.hp + p.maxHp * WAVE_HEAL + (p.stats.waveHeal || 0));
        }
      }
      this._pushEvent({ kind: 'cleared', wave: this.wave });

      // 成长：发卡。cards 事件带"这一波每人能看到哪三张"，客户端负责渲染。
      // 发在 cleared 之后：客户端要先把"第 N 波清除"的横幅播出来，再弹面板。
      const dealt = this._dealCards();
      if (dealt.length) {
        this._pushEvent({ kind: 'cards', wave: this.wave, dealt, window: this.pickWindow });
        // 选卡期间不计 waveGap：人还在看面板，怪就已经冲上来了
        this.waveGap = 999;
      }
    }

    this._updatePicks(dt);

    if (!this.waveActive && !this.picksOpen) {
      this.waveGap -= dt;
      if (this.waveGap <= 0) this.startWave(this.wave + 1);
    }
  }

  /**
   * 这一只敌人是"守/巡逻"还是"猎杀"。
   *
   * 编成目标：60~70% 驻守/巡逻，其余猎杀。全是巡逻会变成清据点，
   * 全是猎杀就是改之前那样"整张图一起追玩家"。
   * 自爆兵/无人机/补给车保留猎杀，炮台原地驻守，Boss 守区域。
   */
  _patrolKindFor(type, tpl) {
    if (tpl.static) return null;
    if (tpl.boss) return 'boss';
    if (type === 'charger' || type === 'drone' || type === 'support') return null;
    if (!this.patrolRoutes.length) return null;
    return this.rng.spawn() < 0.66 ? 'route' : null;
  }

  /** 巡逻队优先在自己航线的锚点附近入场，别全从玩家对面涌过来 */
  _routeSpawnPoint(anchor) {
    for (let i = 0; i < 8; i++) {
      const a = this.rng.spawn() * Math.PI * 2;
      const r = i === 0 ? 0 : 3 + this.rng.spawn() * 9;
      const x = anchor.x + Math.sin(a) * r;
      const z = anchor.z + Math.cos(a) * r;
      if (Math.abs(x) > HALF - 8 || Math.abs(z) > HALF - 8) continue;
      if (this.static.blocked(x, z, 2.4)) continue;
      if (this.players.some((p) => Math.hypot(p.x - x, p.z - z) < 30)) continue;
      return { x, z };
    }
    return null;
  }

  _spawn(it) {
    const tpl = ENEMY_TYPES[it.type];
    if (!tpl) return;

    const kind = this._patrolKindFor(it.type, tpl);
    let route = null;
    // 指定位置优先（蜂巢召唤用）：召唤物要出现在本体身边，
    // 不能走 _spawnPoint 随机撒到地图另一头。
    let pt = (Number.isFinite(it.x) && Number.isFinite(it.z)) ? { x: it.x, z: it.z } : null;
    if (kind === 'route') {
      route = this.patrolRoutes[Math.floor(this.rng.spawn() * this.patrolRoutes.length)];
      pt = this._routeSpawnPoint(route.anchor);
    }
    if (!pt) {
      pt = this._spawnPoint();
      if (kind === 'boss') route = anchorRoute('boss', pt.x, pt.z);
    }
    const hp = it.hpScale || it.hp || 60;

    const e = {
      id: nextId(),
      type: it.type,
      x: pt.x,
      z: pt.z,
      yaw: this.rng.spawn() * Math.PI * 2,
      turretYaw: 0,
      hp,
      maxHp: hp,
      // ⚠ tpl.speed 有两种语义：小兵是**倍率**（gunner=1），Boss 是**绝对速度**
      // （breaker=7.2 m/s）。混乘的后果：第 5 波破城者 = 基础 10 × 7.2 = 72 m/s，
      // 是玩家（15 m/s）的近 5 倍——"跑起来像飞一样"。Boss 直接用绝对值，
      // 与单机 Enemy.js 的行为对齐。
      speed: (tpl.boss ? tpl.speed : (8.5 + Math.min(4.5, this.wave * 0.6)) * tpl.speed)
        * ((it.awaken || []).includes('haste') ? AWAKEN_NUM.speedMul : 1),
      radius: tpl.radius,
      damage: tpl.damage,
      range: tpl.range,
      bulletSpeed: tpl.bulletSpeed,
      score: tpl.score,
      alive: true,
      boss: !!tpl.boss,
      // ---- Boss 技能状态（r46）----
      // skillT：距离下一次技能；castKind/castT/castDur：正在进行的施法；
      // zone：本次施法对应的场地标记（与 this.zones 里同一个对象，算收缩进度用）
      skillT: tpl.boss ? 2.2 + this.rng.combat() * 1.6 : 0,
      castKind: null,
      castT: 0,
      castDur: 0,
      zone: null,
      stage: 0,
      // 觉醒词条（55 波起）：awakenMask 进快照给客户端显示，
      // 数值效果在 _spawn 里一次性折算成乘区，之后每帧只做加法。
      awakenMask: awakenMaskOf(it.awaken || []),
      awaken: it.awaken || [],
      dmgMul: (it.awaken || []).includes('armor') ? AWAKEN_NUM.dmgMul : 1,
      cdMul: skillCdMul(it.awaken || []),
      regen: (it.awaken || []).includes('regen'),
      static: !!tpl.static,
      frontArmor: tpl.frontArmor || 0,
      healAura: tpl.healAura || 0,
      selfDist: tpl.selfDestruct || 0,
      // 召唤物的归属：蜂巢死了要连带清场，也用来数"场上还有几只它的人"
      owner: it.owner || 0,
      fireCd: 1.0 + this.rng.combat() * 1.4,
      fireCdRange: tpl.fireCd || [2, 3],
      strafeSide: this.rng.combat() > 0.5 ? 1 : -1,
      blockedT: 0,
      typeCode: typeCodeOf(it.type),
      // 巡逻状态只存在于服务端模拟里；快照不传航点，客户端也看不到
      patrol: route ? createPatrolState(route, () => this.rng.spawn()) : null,
    };
    e.turretYaw = e.yaw;
    this.enemies.push(e);
  }

  /** 找一个离玩家群最远的空地刷怪（避免贴脸刷） */
  _spawnPoint() {
    const half = HALF;
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < 24; i++) {
      const a = this.rng.spawn() * Math.PI * 2;
      const r = 34 + this.rng.spawn() * 30;
      const cx = this.players.length
        ? this.players.reduce((s, p) => s + p.x, 0) / this.players.length : 0;
      const cz = this.players.length
        ? this.players.reduce((s, p) => s + p.z, 0) / this.players.length : 0;
      const x = Math.max(-half + 8, Math.min(half - 8, cx + Math.sin(a) * r));
      const z = Math.max(-half + 8, Math.min(half - 8, cz + Math.cos(a) * r));
      if (this.static.blocked(x, z, 2.6)) continue;

      let minD = Infinity;
      for (const p of this.players) minD = Math.min(minD, Math.hypot(p.x - x, p.z - z));
      const score = Math.min(minD, 45);
      if (score > bestScore) { bestScore = score; best = { x, z }; }
    }
    return best || { x: -82, z: -82 };
  }

  // ---------------- 卡住检测 ----------------

  /**
   * 净位移检测：一帧下来几乎没挪地方，才算"卡住"。
   *
   * 为什么放在 _separate 之后：
   *   - 只看移动结果会把"被同伴挤回去"当成正常前进，AI 永远不知道自己被堵住；
   *   - 线上表现为几辆坦克在建筑边排成一列互相顶，每辆都在"走"，实际原地踏步。
   * 卡住持续 0.5 秒就翻转绕行方向，配合 _updateEnemies 里的侧向偏置脱困。
   */
  _checkStuck(dt) {
    for (const e of this.enemies) {
      if (e.static || !e.speed) continue;
      const step = e.speed * (e._moveMul ?? 1) * dt;
      const moved = e._px === undefined
        ? step
        : Math.hypot(e.x - e._px, e.z - e._pz);
      e._px = e.x;
      e._pz = e.z;

      if (moved < step * 0.35) {
        e.blockedT = (e.blockedT || 0) + dt;
        if (e.blockedT > 0.5) {
          e.strafeSide = -(e.strafeSide || 1);
          e.blockedT = 0;
        }
      } else {
        e.blockedT = 0;
      }
    }
  }

  // ---------------- 分离：避免敌人叠在一起 ----------------

  _separate() {
    const list = this.enemies;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const min = a.radius + b.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 > min * min || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (min - d) * 0.5;
        const ux = dx / d;
        const uz = dz / d;
        if (!a.static) { a.x -= ux * push; a.z -= uz * push; }
        if (!b.static) { b.x += ux * push; b.z += uz * push; }
      }
    }

    // 互相挤推会把人推进旁边的建筑里（最典型的是"一群坦克围着楼角挤成一团"），
    // 一旦挤进去，AI 之后每个方向都被判撞墙，这颗坦克就永远卡在那里了。
    // 所以分离之后统一做一次推出，保证没有任何单位停在箱体内部。
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const p = pushOut(this.static.boxes, e.x, e.z, e.radius);
      if (p.x !== e.x || p.z !== e.z) {
        e.x = Math.max(-HALF + e.radius, Math.min(HALF - e.radius, p.x));
        e.z = Math.max(-HALF + e.radius, Math.min(HALF - e.radius, p.z));
      }
    }
  }

  // ---------------- 对外 ----------------

  get scale() {
    return scaleForPlayers(this.players.length || 1);
  }

  snapshot() {
    return {
      t: this.tick,
      w: this.wave,
      s: this.state,
      sc: this.players.map((p) => p.stats.score),
    };
  }

  /** 给新加入者用的全量状态（中途加入靠这个重建） */
  fullState() {
    return {
      players: this.players.map((p) => ({
        id: p.id, name: p.name, chassis: p.chassis, x: p.x, z: p.z,
        yaw: p.yaw, turretYaw: p.turretYaw, hp: p.hp, maxHp: p.maxHp,
        alive: p.alive, down: p.down, downT: p.downT, reviveT: p.reviveT,
        score: p.stats.score, kills: p.stats.kills,
        // 成长状态：重连的人要恢复"我已经拿了哪些卡"，
        // 否则他会发现自己变回了第一波的白板车。
        stats: syncedStats(p.stats),
        // 还没选完的卡：重连后必须能继续选，不能让他白丢一波收益
        cards: this.cards.get(p.id) || null,
      })),
      enemies: this.enemies.map((e) => ({
        id: e.id, type: e.type, x: e.x, z: e.z, yaw: e.yaw,
        turretYaw: e.turretYaw, hp: e.hp, maxHp: e.maxHp,
      })),
      wave: this.wave,
      state: this.state,
      tick: this.tick,
      // 地表类型场只下发"种子 + 档位"，客户端自己重建一份。
      // 27×27 的格点阵列塞进 20Hz 快照是纯浪费，而且一旦两边版本不同
      // 就会出现"你看着是公路、他跑的是沼泽"。
      // k 也带上：强度档位变了，客户端要立刻按新档位改颜色，不能等下次重连。
      terrain: {
        seed: this.terrain.seed,
        preset: this.terrainPreset,
        k: this.terrain.k ?? 1,
        tile: this.terrain.tile,
      },
      // 建筑：把服务端这份**权威坐标**直接下发，客户端不自己生成。
      //
      // 曾经两边各生成一份，客户端为了渲染多抽了一个随机数，于是第二个箱子
      // 之后全部错位，玩家一进房就撞假墙。生成算法现在虽然两端同源，
      // 但"同源"只能保证今天一致，改一次生成逻辑、发一次版就会有人踩到
      // 页面缓存没更新的坑。约 44 个箱体 × 7 个数字，只在入场时发一次，值得。
      boxes: this.static.boxes.map(([x, z, w, d]) => ({ x, z, w, d })),
      // 宝箱：重连/中途加入的人要能看见场上还没被捡的箱子
      crates: this.crates.map((c) => ({ id: c.id, x: c.x, z: c.z, cat: c.cat })),
    };
  }
}

export { DOWN_TIME, RESPAWN_DELAY, CHASSIS_TABLE };
