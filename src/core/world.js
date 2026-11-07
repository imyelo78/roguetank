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
import {
  createPlayer, updateRevive, scaleForPlayers,
  emptyInput, DOWN_TIME, RESPAWN_DELAY,
} from './players.js';
import { R, Rng } from '../rng.js';

export { HALF };

// ---------------- 数值表（与单机保持一致） ----------------

/** 敌人车体转向速率（rad/s）。给足 3.0，否则急转时车头追不上行进方向就一直原地打圈 */
const TURN_RATE = 3.0;

const CHASSIS_TABLE = {
  balanced: { hp: 120, speed: 15, turn: 3.0, dmgMul: 1, takenMul: 1 },
  light: { hp: 90, speed: 19.5, turn: 3.6, dmgMul: 1, takenMul: 1 },
  heavy: { hp: 170, speed: 11.5, turn: 2.4, dmgMul: 1, takenMul: 0.85 },
  hunter: { hp: 110, speed: 14, turn: 3.2, dmgMul: 1, takenMul: 1, killHeal: 3 },
};

/** 敌人模板：只保留模拟需要的字段，渲染层按 type 自己建模型 */
export const ENEMY_TYPES = {
  gunner: { hp: 1, speed: 1, radius: 1.45, damage: 5, range: 26, fireCd: [2.0, 3.6], bulletSpeed: 42, score: 10, scale: 1 },
  charger: { hp: 0.5, speed: 1.25, radius: 1.35, damage: 12, range: 4, selfDestruct: 4.6, score: 12, scale: 0.85 },
  elite: { hp: 4, speed: 0.85, radius: 1.65, damage: 8, range: 30, fireCd: [1.5, 2.6], bulletSpeed: 48, score: 40, scale: 1.18 },
  drone: { hp: 0.3, speed: 2.2, radius: 0.9, damage: 7, range: 3.5, selfDestruct: 3.5, score: 14, scale: 0.62 },
  turret: { hp: 2.2, speed: 0, radius: 1.3, damage: 9, range: 46, fireCd: [2.4, 3.2], bulletSpeed: 55, score: 25, scale: 0.95, static: true },
  support: { hp: 1.4, speed: 0.95, radius: 1.5, damage: 0, range: 0, healAura: 8, score: 30, scale: 1.05 },
  shield: { hp: 1.3, speed: 0.9, radius: 1.55, damage: 6, range: 28, fireCd: [2.2, 3.6], bulletSpeed: 44, score: 20, scale: 1.12, frontArmor: 0.45 },
  boss_breaker: { hp: 24, speed: 7.2, radius: 2.5, damage: 11, range: 34, fireCd: [1.8, 3.0], bulletSpeed: 46, score: 300, scale: 1.75, boss: true },
  boss_prism: { hp: 20, speed: 9.2, radius: 2.1, damage: 6, range: 40, fireCd: [1.3, 2.2], bulletSpeed: 52, score: 300, scale: 1.45, boss: true },
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
export function buildStaticWorld() {
  // 地图数据只在 core/levelgen.js 生成一次，客户端建 mesh、这里建碰撞表。
  //
  // 为什么不再手抄一份：线上出过事故——两边各写一套生成循环，客户端为了建
  // 模型多算了一个高度 h 的随机数，服务端没有，从第二个随机箱子开始坐标整体
  // 错位；固定掩体里还把渲染高度 h 当成深度 d 抄了过来。结果是"客户端有墙、
  // 服务端没有"，玩家一进房就撞假墙，速度每帧乘 0.3 压到 0.8 米/秒，
  // 表现就是油门踩到底车不动，同时服务端位置正常推进又被拽回去。
  const boxes = generateBoxes().map((b) => [b.x, b.z, b.w, b.d]);

  return {
    half: HALF,
    boxes,
    /**
     * 圆形与箱体的碰撞。
     * 注意：这里不判边界——边界由各调用方 clamp 处理，保证"贴边能走"，
     * 与客户端 Tank.move 的轴向分离手感一致。
     */
    blocked(x, z, r) {
      for (const [bx, bz, bw, bd] of boxes) {
        if (Math.abs(x - bx) < bw / 2 + r && Math.abs(z - bz) < bd / 2 + r) return true;
      }
      return false;
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

/** 4 人出生点：生成地图后立刻校验，避免被固定掩体压住 */
const MULTI_SPAWNS = resolveMultiSpawns(generateBoxes());

let NEXT_ID = 1;
const nextId = () => NEXT_ID++;

/**
 * 一局多人合作 PvE。
 *
 * 与单机最大的结构差异：玩家是数组，所有"谁受伤""谁开火"都由 id 定位。
 * 规则本身（波次公式、敌人类型、伤害数值）与单机一致。
 */
export class World {
  constructor({ code, seed = 1, maxPlayers = 4 } = {}) {
    this.code = code || 'LOCAL';
    this.seed = seed >>> 0;
    this.maxPlayers = Math.max(1, Math.min(4, maxPlayers));

    this.rng = new Rng(this.seed);
    this.static = buildStaticWorld();

    this.players = [];
    this.enemies = [];
    this.bullets = [];
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
  }

  // ---------------- 玩家进出 ----------------

  /** 加人。返回 player 或 null（满了） */
  addPlayer({ id, name, chassisId }) {
    if (this.players.length >= this.maxPlayers) return null;
    const c = CHASSIS_TABLE[chassisId] || CHASSIS_TABLE.balanced;
    const pid = id || `p${nextId()}`;
    const idx = this.players.length;
    // 出生点由 levelgen 校验过，保证不与掩体重叠（否则一落地就卡墙）
    const [sx, sz] = MULTI_SPAWNS[idx % MULTI_SPAWNS.length];

    const p = createPlayer({
      id: pid,
      name,
      chassisId,
      x: sx,
      z: sz,
      hp: c.hp,
      maxHp: c.hp,
    });
    p.speedBase = c.speed;
    p.turnBase = c.turn;
    p.takenMul = c.takenMul;
    p.killHeal = c.killHeal || 0;
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
   */
  start() {
    if (this.state === 'playing') return false;
    if (this.players.length === 0) return false;
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
      this._updateBullets(dt);
      for (const e of updateRevive(this.players, dt)) {
        this._pushEvent({ kind: e.type, id: e.id, by: e.by });
      }
      this._updateWaves(dt);
      this._separate();
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
      stepBody(p, inp, dt, this.static, HALF);

      // 炮塔：朝鼠标指向的世界坐标转（转速 10 rad/s ≈ 0.6 秒转 180°）
      aimTurret(p, inp.aimX, inp.aimZ, dt, 10);

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
    const w = PLAYER_WEAPON;
    p.fireCd = w.fireCd;
    p.stats.shots++;
    const yaw = p.turretYaw;
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
    });
    this._pushEvent({ kind: 'shot', id: p.id, x: p.x, z: p.z, yaw });
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
      const aimYaw = Math.atan2(dx, dz);
      const reach = e.range > 0 ? e.range : 30;

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
      if (!e.static) {
        let mx = 0;
        let mz = 0;
        if (dist > reach * 0.85) {
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
        const step = e.speed * dt;
        const nx = e.x + ux * step;
        const nz = e.z + uz * step;

        if (e.type === 'drone' || !this.static.blocked(nx, nz, e.radius)) {
          e.x = Math.max(-HALF + e.radius, Math.min(HALF - e.radius, nx));
          e.z = Math.max(-HALF + e.radius, Math.min(HALF - e.radius, nz));
          e.blockedT = 0;
        } else {
          // 被挡住：沿墙滑行；连续卡住就换一侧绕
          e.blockedT = (e.blockedT || 0) + dt;
          if (e.blockedT > 0.6) { e.strafeSide = -(e.strafeSide || 1); e.blockedT = 0; }
          const slideX = e.x + ux * step;
          const slideZ = e.z + uz * step;
          if (!this.static.blocked(slideX, e.z, e.radius)) e.x = slideX;
          else if (!this.static.blocked(e.x, slideZ, e.radius)) e.z = slideZ;
        }

        // 车体朝实际行进方向（炮塔另算）。
        // 注意：必须朝"实际移动方向"转，而不是朝玩家转——原来朝玩家转，
        // 身体却在侧移，车头永远追不上，视觉上就是原地画圈。
        const diff = angleDiff(Math.atan2(ux, uz), e.yaw);
        e.yaw += Math.sign(diff) * Math.min(Math.abs(diff), TURN_RATE * dt);
      }

      // 炮塔跟随目标
      const tdiff = angleDiff(aimYaw, e.turretYaw);
      e.turretYaw += Math.sign(tdiff) * Math.min(Math.abs(tdiff), 3.2 * dt);

      // 自爆兵贴近即引爆
      if (e.selfDist && dist < e.selfDist) {
        this._explodeEnemy(e, target);
        continue;
      }

      // 远程开火：射程内且炮塔大致对准
      if (e.range > 0 && e.fireCd <= 0 && dist < e.range && Math.abs(tdiff) < 0.35) {
        e.fireCd = e.fireCdRange[0] + this.rng.combat() * (e.fireCdRange[1] - e.fireCdRange[0]);
        // 命中率：给子弹一点散布，避免"弹弹必中"变成无解消耗
        const spread = 0.06;
        const yaw = e.turretYaw + (this.rng.combat() - 0.5) * spread * 2;
        this.bullets.push({
          id: nextId(),
          x: e.x + Math.sin(yaw) * 1.6,
          z: e.z + Math.cos(yaw) * 1.6,
          yaw,
          vx: Math.sin(yaw) * e.bulletSpeed,
          vz: Math.cos(yaw) * e.bulletSpeed,
          team: 1,
          owner: e.id,
          damage: e.damage,
          life: 2.6,
        });
      }

      // 补给车治疗周围
      if (e.healAura) {
        for (const o of this.enemies) {
          if (o === e || !o.alive) continue;
          if (Math.hypot(o.x - e.x, o.z - e.z) < e.healAura) {
            o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.06 * dt);
          }
        }
      }
    }
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
        dead = true;
      } else if (hit.player) {
        this._damagePlayer(hit.player, b.damage, b.owner);
        dead = true;
      }

      if (dead) this.bullets.splice(i, 1);
    }
  }

  _hitEnemy(e, damage, ownerId, bullet) {
    // 重盾兵：正面来的伤害减半（打侧后有效）
    if (e.frontArmor) {
      const incoming = Math.atan2(bullet.x - e.x, bullet.z - e.z);
      let d = incoming - e.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) < Math.PI * 0.4) damage *= e.frontArmor;
    }

    e.hp -= damage;
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
    const base = 2 + n * 2 + Math.min(6, Math.floor(n / 2)) - (n % 5 === 3 ? 2 : 0);
    const count = Math.round(base * this.scale.countMul);
    const hp = Math.round((55 + n * 14) * this.scale.hpMul);
    const speed = 8.5 + Math.min(4.5, n * 0.6);

    this.waveActive = true;
    this.pending = [];

    if (bossWave) {
      const breaker = Math.floor(n / 5) % 2 === 1;
      this.pending.push({ t: 0.7, type: breaker ? 'boss_breaker' : 'boss_prism', hpScale: 1300 + n * 300 });
      for (let i = 0; i < 3 + Math.floor(n / 4); i++) {
        this.pending.push({ t: 1.7 + i * 0.9, type: 'gunner', hp });
      }
    } else {
      if (eliteWave) {
        const ec = n >= 13 ? 3 : 2;
        for (let i = 0; i < ec; i++) this.pending.push({ t: 1.2 + i * 2.4, type: 'elite', hp: Math.round(hp * 4) });
      }
      for (let i = 0; i < count; i++) this.pending.push({ t: i * 0.75, type: 'gunner', hp });
      for (let j = 0; j < Math.min(8, Math.floor(n / 2)); j++) {
        this.pending.push({ t: 2.2 + j * 1.1, type: 'charger', hp: Math.max(30, Math.round(hp * 0.5)) });
      }
      if (n >= 4) for (let i = 0; i < Math.min(6, Math.floor((n - 2) / 2)); i++) this.pending.push({ t: 3.5 + i * 1.4, type: 'drone', hp: Math.max(18, Math.round(hp * 0.3)) });
      if (n >= 6) for (let i = 0; i < Math.min(2, 1 + Math.floor(n / 12)); i++) this.pending.push({ t: 2.5 + i * 3, type: 'turret', hp: Math.round(hp * 2.2) });
      if (n >= 7) this.pending.push({ t: 4.5, type: 'support', hp: Math.round(hp * 1.4) });
      if (n >= 8) for (let i = 0; i < Math.min(4, Math.floor((n - 4) / 2)); i++) this.pending.push({ t: 5.5 + i * 2.2, type: 'shield', hp: Math.round(hp * 1.3) });
    }

    this._pushEvent({ kind: 'wave', wave: n, boss: bossWave, elite: eliteWave });
  }

  _updateWaves(dt) {
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
      for (const p of this.players) {
        if (p.alive && !p.down) {
          p.hp = Math.min(p.maxHp, p.hp + p.maxHp * WAVE_HEAL);
        }
      }
      this._pushEvent({ kind: 'cleared', wave: this.wave });
    }

    if (!this.waveActive) {
      this.waveGap -= dt;
      if (this.waveGap <= 0) this.startWave(this.wave + 1);
    }
  }

  _spawn(it) {
    const tpl = ENEMY_TYPES[it.type];
    if (!tpl) return;

    const pt = this._spawnPoint();
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
      speed: (8.5 + Math.min(4.5, this.wave * 0.6)) * tpl.speed,
      radius: tpl.radius,
      damage: tpl.damage,
      range: tpl.range,
      bulletSpeed: tpl.bulletSpeed,
      score: tpl.score,
      alive: true,
      boss: !!tpl.boss,
      static: !!tpl.static,
      frontArmor: tpl.frontArmor || 0,
      healAura: tpl.healAura || 0,
      selfDist: tpl.selfDestruct || 0,
      fireCd: 1.0 + this.rng.combat() * 1.4,
      fireCdRange: tpl.fireCd || [2, 3],
      strafeSide: this.rng.combat() > 0.5 ? 1 : -1,
      blockedT: 0,
      typeCode: Object.keys(ENEMY_TYPES).indexOf(it.type) + 1,
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
      })),
      enemies: this.enemies.map((e) => ({
        id: e.id, type: e.type, x: e.x, z: e.z, yaw: e.yaw,
        turretYaw: e.turretYaw, hp: e.hp, maxHp: e.maxHp,
      })),
      wave: this.wave,
      state: this.state,
      tick: this.tick,
    };
  }
}

export { DOWN_TIME, RESPAWN_DELAY, CHASSIS_TABLE };
