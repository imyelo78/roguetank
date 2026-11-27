import * as THREE from '../vendor/three.module.js';
import { Tank } from './Tank.js';
import { R } from './rng.js';
import { enemySkin } from './teams.js';
import { solveIntercept, AIM_DEFAULTS, flatPitch, dirFrom } from './core/aim.js';
import { createPatrolState, stepPatrol, wakePatrol, sendHunting, PATROL } from './core/patrol.js';
// Boss 档案（名称 / kind / 核心色 / 尺寸 / 伤害）与联机共用同一份数据源
import { BOSS_META, BOSS_SKILLS, ZONE, laserHits, resonancePull, bossStageFor, stageBarRatio,
  awakenMaskOf, AWAKEN_NUM, skillCdMul } from './core/bosskit.js';
// 补给车的治疗参数（半径 / 百分比 / Boss 是否吃治疗）只在 core/world.js 定义一份，
// 单机这里读同一张表——以前单机固定 +6、联机 6%/秒，同一台车强度差十倍。
import { ENEMY_TYPES } from './core/world.js';
import { HealAura } from './auras.js';

const BAR_W = 2.24;
const LOS_INTERVAL = 0.2;
const ZERO_VEL = { x: 0, z: 0 };

// 血条几何体/材质共享，避免每辆敌人新建导致显存泄漏
const BAR_BG_GEO = new THREE.PlaneGeometry(BAR_W + 0.16, 0.26);
const BAR_FILL_GEO = new THREE.PlaneGeometry(BAR_W, 0.14);
const BAR_BG_MAT = new THREE.MeshBasicMaterial({
  color: 0x0d0a09, transparent: true, opacity: 0.72, depthWrite: false,
});
const BAR_FILL_MAT = new THREE.MeshBasicMaterial({
  color: 0xff5a4a, transparent: true, opacity: 0.96, depthWrite: false,
});
const BAR_FILL_ELITE_MAT = new THREE.MeshBasicMaterial({
  color: 0xffd257, transparent: true, opacity: 0.98, depthWrite: false,
});

// Boss 核心：共享几何体，按类型共享材质
const CORE_GEO = new THREE.SphereGeometry(0.4, 12, 10);

// 核心材质按 kind 生成：配色来自 core/bosskit.js 的 BOSS_META.core。
// 以前这里是手写两份（橙 / 青），加 Boss 就得再添一段，且很容易和
// 联机 coop.js 那份对不上——联机的棱镜血条配色至今就是错的。
const CORE_MATS = {};
for (const m of Object.values(BOSS_META)) {
  CORE_MATS[m.kind] = new THREE.MeshBasicMaterial({
    color: m.core, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

// 单机侧只关心"叫什么、属于哪个 kind"；尺寸/伤害/速度都已进 BOSS_META。
const BOSS_INFO = {};
for (const [type, m] of Object.entries(BOSS_META)) {
  BOSS_INFO[type] = m;
}

const tmpGoal = new THREE.Vector3();

export class Enemy {
  constructor(scene, { x, z, hp = 60, speed = 9, camera, type = 'gunner', damage, patrolRoute = null, awaken = null,
    rotY = null, dormant = false, hold = false }) {
    const charger = type === 'charger';
    const elite = type === 'elite';
    const bossInfo = BOSS_INFO[type];
    const boss = !!bossInfo;
    // ---- M3 新敌人 ----
    const drone = type === 'drone';        // 自爆无人机：飞行、无视地形、贴脸自爆
    const turret = type === 'turret';      // 炮台：固定、超远射程、瞄准线预警
    const support = type === 'support';    // 补给车：治疗光环、会逃跑
    const shield = type === 'shield';      // 重盾兵：正面减伤，绕后有戏

    const scale = boss ? bossInfo.scale
      : drone ? 0.62
      : turret ? 0.95
      : support ? 1.05
      : shield ? 1.12
      : charger ? 0.85 : elite ? 1.18 : 1;
    const speedMul = drone ? 1.9 : turret ? 0 : support ? 1.15 : shield ? 0.72
      : charger ? 1.25 : elite ? 0.85 : 1;
    // 敌方配色统一从 teams.js 取（单机与组队同一张表）。
    // 曾经这张表写在这里，补给车是绿的、炮台是灰绿的，和玩家军绿撞色；
    // 而组队那边压根没传颜色，全走默认绿——两处不一致的根源就是"各写一份"。
    const bodies = enemySkin(type);

    this.tank = new Tank(scene, {
      team: 'enemy',
      detail: 'low',
      idLamp: false,
      body: bodies.body,
      accent: bodies.accent,
      metal: bodies.metal,
      hp,
      speed: speed * speedMul,
      x,
      z,
      // 战役布阵要"车头朝历史方向"；无尽模式仍然每辆随机朝向，
      // 否则一开局所有敌人炮口都朝同一个方向，看起来像摆拍。
      rotY: rotY != null ? rotY : R.combat() * Math.PI * 2,
    });
    this.tank.group.scale.setScalar(scale);
    this.tank.radius = boss ? bossInfo.radius
      : drone ? 0.9
      : turret ? 1.3
      : support ? 1.5
      : shield ? 1.55
      : elite ? 1.65 : 1.45;

    this.type = type;
    this.charger = charger;
    this.isBoss = boss;
    this.isElite = elite;
    this.flying = drone;
    this.turretStatic = turret;
    this.support = support;
    if (shield) this.tank.isShielded = true;   // 供子弹结算做正面减伤
    // 铁壁（r46）：正面只吃 30% 伤害。isShielded 让 Game 去做方向判定，
    // armorMul 替换掉重盾兵写死的 0.2——同一套机制，不同强度。
    if (bossInfo && bossInfo.kind === 'bulwark') {
      this.tank.isShielded = true;
      this.tank.armorMul = 0.3;
    }
    // 护盾值挂在 tank 上：Game 的命中结算拿到的就是 tank，不是 Enemy
    this.tank.shieldHp = 0;
    this.breakT = 0;
    this.selfDestruct = charger ? { damage: 16, radius: 4.6 }
      : drone ? { damage: 10, radius: 3.5 } : null;
    // 觉醒词条（55 波起）：与联机 world.js::_spawn 同一套折算。
    // 只在这里算一次乘区，之后每帧只做加法，不会两边算出不同的数。
    this.awaken = awaken || [];
    this.awakenMask = awakenMaskOf(this.awaken);
    this.dmgMul = this.awaken.includes('armor') ? AWAKEN_NUM.dmgMul : 1;
    this.tank.dmgMul = this.dmgMul;
    this.cdMul = skillCdMul(this.awaken);
    this.regen = this.awaken.includes('regen');
    if (this.awaken.includes('haste')) this.tank.speed *= AWAKEN_NUM.speedMul;

    this.bossKind = bossInfo ? bossInfo.kind : null;
    this.bossName = bossInfo ? bossInfo.name : null;
    this.coreColor = bossInfo ? bossInfo.core : 0xff6a2a;
    this.damage = damage ?? (boss ? bossInfo.damage
      : turret ? 12 : shield ? 8 : drone ? 10 : elite ? 10 : support ? 0 : 7);
    this.baseScale = scale;
    this.camera = camera;

    // 补给车：治疗光环。半径、层级、呼吸节奏全部在 auras.js 里，
    // 与联机客户端同一份实现——这个圈必须和判定半径严格对应，
    // 两端各写一份就会出现"站在圈里却不回血"。
    if (support) {
      this.aura = new HealAura(this.tank.group, scale);
      this.healT = 0;
    }

    // 炮台：瞄准线预警（世界空间细线，指向玩家时可见）
    if (turret) {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(0.07, 0.07, 1),
        new THREE.MeshBasicMaterial({
          color: 0xff4a3a, transparent: true, opacity: 0.35, depthWrite: false,
        })
      );
      line.visible = false;
      scene.add(line);
      this.sight = line;
    }

    // ---- Boss 专属状态 ----
    this.enraged = false;
    this.abilityT = boss ? (bossInfo.kind === 'breaker' ? 7 : 6) : Infinity;
    this.castT = 0;
    this.castKind = null;
    this.burst = 0;
    this.burstT = 0;
    this.coreT = R.combat() * 6;

    // ---- Boss 技能状态（r46）----
    // 与联机 core/world.js 的 _updateBossSkill 是同一套状态机与同一份参数
    // （core/bosskit.js 的 BOSS_SKILLS），只是表现层不同：这边直接建特效，
    // 那边把状态写进快照让客户端画。两边逻辑分开写就一定会分叉——
    // 联机棱镜至今没有折射风暴，就是分开写的代价。
    this.skillT = boss ? 2.2 + R.combat() * 1.6 : Infinity;
    this.castKind = null;
    this.castT = 0;
    this.castDur = 0;
    this.castPos = new THREE.Vector3();
    this.dashDir = new THREE.Vector3(0, 0, 1);
    this.hitDone = false;
    this.bossNear = boss ? bossInfo.near : 0;
    this.bossFar = boss ? bossInfo.far : 0;

    if (boss) {
      this.core = new THREE.Mesh(CORE_GEO, CORE_MATS[bossInfo.kind]);
      this.core.position.set(0, 0.72, -0.2);
      this.core.renderOrder = 5;
      this.tank.turret.add(this.core);
    }

    this.state = 'patrol';
    // 未察觉（战役开局）：车组在车外开会 / 在舱口观察，不会主动开火。
    // 无尽模式和联机永远不传这个参数，行为与之前完全一致。
    this.dormant = !!dormant;
    // 驻军（战役纵队）：醒了也不许挪车。波卡基村的英军是停驻纵队、步兵
    // 已下车——醒来只转炮塔还击，不会冲锋围猎。这是"遭遇战"与"围殴"
    // 的分界线，战役模式全员传 hold=true，其余模式不受影响。
    this.hold = !!hold;
    this.target = null;
    // 巡逻/驻军状态。没有路线就是猎杀队，沿用原来的追击 AI。
    // offset 用固定随机流，保证单机每局路线一致（方便复现问题）。
    this.patrol = patrolRoute ? createPatrolState(patrolRoute, () => R.stream('patrol')()) : null;
    // 挨打时叫醒自己和附近同伴。挂在 tank 上，子弹结算不必知道 Enemy。
    this.tank.onDamaged = () => this._onDamaged();
    this._ctx = null;
    this.fireCd = 1.2 + R.combat() * 1.6;
    this.spawnShield = dormant ? 0 : 0.9;   // 战役里的车是"一直在那儿"，不是刚刷出来的
    this.stuckT = 0;          // 卡住计时
    this.avoidT = 0;          // 脱困方向剩余时间
    this.avoidDir = new THREE.Vector3(0, 0, 1);
    this.strafe = R.combat() > 0.5 ? 1 : -1;

    // 视线：每 0.2s 采样一次，避免每帧做线段检测
    this.los = false;
    this.losTimer = R.combat() * LOS_INTERVAL;
    this.noLosT = 0;

    // 寻路
    this.path = [];
    this.pathGoal = new THREE.Vector3(Infinity, 0, Infinity);
    this.repathT = R.combat() * 0.5;
    this.flankSide = R.combat() > 0.5 ? 1 : -1;
    this.flankGoal = null;
    this.flankT = 0;
    this.directGoal = false;

    // ---- 血条 ----
    this.bar = new THREE.Group();
    this.bar.position.y = 2.85;
    this.bar.scale.setScalar(1 / scale);
    const bg = new THREE.Mesh(BAR_BG_GEO, BAR_BG_MAT);
    this.fill = new THREE.Mesh(BAR_FILL_GEO, elite ? BAR_FILL_ELITE_MAT : BAR_FILL_MAT);
    this.fill.position.z = 0.012;
    this.bar.add(bg, this.fill);
    this.bar.renderOrder = 6;
    this.bar.visible = !boss;
    this.tank.group.add(this.bar);
  }

  get position() { return this.tank.group.position; }
  get alive() { return this.tank.alive; }

  /** 在玩家周围找一个“能看见玩家”的侧翼/后方点位 */
  _pickFlankGoal(world, player, playerYaw) {
    const p = this.position;
    const base = playerYaw + Math.PI + this.flankSide * (0.55 + R.combat() * 0.6);
    for (let i = 0; i < 9; i++) {
      const a = base + (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 0.42;
      const r = 11 + R.combat() * 6;
      const x = THREE.MathUtils.clamp(player.x + Math.sin(a) * r, -world.half + 5, world.half - 5);
      const z = THREE.MathUtils.clamp(player.z + Math.cos(a) * r, -world.half + 5, world.half - 5);
      if (world.blocked(x, z, 2.0)) continue;
      // 到达这里后要能直接打到玩家，否则绕过去也没意义
      if (world.segmentBlocked(x, z, player.x, player.z, 0.5)) continue;
      tmpGoal.set(x, 0, z);
      return tmpGoal;
    }

    // 找不到理想侧翼：退化为玩家附近
    for (let i = 0; i < 8; i++) {
      const a = R.combat() * Math.PI * 2;
      const r = 10 + R.combat() * 5;
      const x = THREE.MathUtils.clamp(player.x + Math.sin(a) * r, -world.half + 5, world.half - 5);
      const z = THREE.MathUtils.clamp(player.z + Math.cos(a) * r, -world.half + 5, world.half - 5);
      if (!world.blocked(x, z, 2.0)) {
        tmpGoal.set(x, 0, z);
        return tmpGoal;
      }
    }

    tmpGoal.copy(player);
    return tmpGoal;
  }

  /**
   * 朝目标点移动。直线可达就走直线，被墙挡住就用 A* 路径。
   * @returns {number} 本帧实际前进距离
   */
  _navigate(dt, ctx, tx, tz, rate) {
    const nav = ctx.nav;
    const p = this.position;
    const beforeX = p.x;
    const beforeZ = p.z;

    this.repathT -= dt;
    const goalMoved = this.path.length === 0 ||
      Math.hypot(tx - this.pathGoal.x, tz - this.pathGoal.z) > 4;

    if (this.repathT <= 0 || goalMoved) {
      this.repathT = 0.8 + R.combat() * 0.4;
      this.pathGoal.set(tx, 0, tz);
      if (nav && !nav.clearWalk(p.x, p.z, tx, tz, this.tank.radius)) {
        this.path = nav.findPath(p.x, p.z, tx, tz);
      } else {
        this.path = [];
      }
      this.directGoal = this.path.length === 0;
    }

    if (this.avoidT > 0) {
      this.tank.move(this.avoidDir.x, this.avoidDir.z, dt, ctx.world);
    } else {
      while (this.path.length > 0) {
        const wp = this.path[0];
        if (Math.hypot(wp.x - p.x, wp.z - p.z) < 1.7) this.path.shift();
        else break;
      }

      let mx;
      let mz;
      if (this.path.length > 0) {
        mx = this.path[0].x - p.x;
        mz = this.path[0].z - p.z;
      } else {
        mx = tx - p.x;
        mz = tz - p.z;
      }

      const len = Math.hypot(mx, mz);
      if (len > 0.35) this.tank.move(mx / len, mz / len, dt * rate, ctx.world);
    }

    const advanced = Math.hypot(p.x - beforeX, p.z - beforeZ);
    const expected = this.tank.speed * dt * Math.min(1, rate);

    // ---- 卡死兜底：3 秒几乎没动就换方向 + 强制重算路径 ----
    if (expected > 0 && advanced < expected * 0.25) this.stuckT += dt;
    else this.stuckT = 0;

    if (this.stuckT > 3) {
      this.stuckT = 0;
      this.path = [];
      this.pathGoal.set(Infinity, 0, Infinity);
      this.repathT = 0;
      this.avoidT = 0.8;
      const side = R.combat() > 0.5 ? 1 : -1;
      const a = Math.atan2(tx - p.x, tz - p.z) + side * Math.PI / 2;
      this.avoidDir.set(Math.sin(a), 0, Math.cos(a));
    }

    return advanced;
  }

  /** 残局兜底：巡逻队转猎杀（由 Game 在一波快结束时调用） */
  sendHunting() {
    sendHunting(this.patrol);
  }

  /** 被玩家命中：自己和 26 米内的同伴从巡逻转入追击 */
  /**
   * 惊醒（战役专用）。
   *
   * @param {number} delay 惊醒后多久才能开火（秒）。
   *
   * 为什么要给延迟：真实里第一炮响过之后，英军有几十秒完全没组织起还击
   * ——车组在车外、电台里全是互相询问。如果惊醒即开火，玩家打第二辆时
   * 就已经有十几门炮指着自己，"单车突入"的窗口直接消失。
   * 延迟只推 fireCd（开火判定看它），不影响移动与转向：
   * 车会开始动、炮塔开始转，但第一发要等。
   */
  wake(delay = 0) {
    if (!this.dormant) return false;
    this.dormant = false;
    if (delay > 0) this.fireCd = Math.max(this.fireCd, delay);
    if (this.patrol) wakePatrol(this.patrol);
    return true;
  }

  _onDamaged() {
    // 挨打了当然会醒。这里的延迟比"听见炮声"短：自己车上炸了一下，
    // 车组反应明显快于"隔壁田里有人开炮"。
    if (this.dormant) this.wake(0.8);
    if (!this.patrol) return;
    wakePatrol(this.patrol);
    const ctx = this._ctx;
    if (!ctx || !ctx.enemies) return;
    for (const o of ctx.enemies) {
      if (o === this || !o.alive || !o.patrol) continue;
      if (o.position.distanceTo(this.position) < PATROL.callR) wakePatrol(o.patrol);
    }
  }

  update(dt, ctx) {
    const tank = this.tank;
    if (!tank.alive) return;

    this._ctx = ctx;
    tank.update(dt);
    this.fireCd -= dt;
    this.flankT -= dt;
    if (this.spawnShield > 0) this.spawnShield -= dt;
    if (this.avoidT > 0) this.avoidT -= dt;

    // ---- 未察觉：停着，但仍然是"活的" ----
    //
    // 战役开局英军正在路边等步兵，第一炮之前不会有人朝你冲过来。
    // 这里只更新车体怠速与血条朝向，视线、瞄准、开火一律不跑——
    // 否则玩家还没下土路，十八辆车就已经转头锁定了，"遭遇战"就不成立了。
    if (this.dormant) {
      this._updateBar();
      return;
    }

    const world = ctx.world;
    const p = tank.group.position;
    const player = ctx.player.group.position;
    const dx = player.x - p.x;
    const dz = player.z - p.z;
    const dist = Math.hypot(dx, dz) || 1;

    // ---- 视线采样 ----
    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      this.losTimer = LOS_INTERVAL;
      const nav = ctx.nav;
      this.los = nav
        ? nav.hasLineOfSight(p.x, p.z, player.x, player.z)
        : !world.segmentBlocked(p.x, p.z, player.x, player.z, 0.5);
    }
    if (this.los) this.noLosT = 0;
    else this.noLosT += dt;

    // ---- 驻军（战役纵队）：车钉在原地，只转炮塔还击 ----
    //
    // 波卡基村的核心就是这条：英军停在公路上等步兵，被打醒了也只是
    // 转炮塔开炮——没有一辆车会冲上来。要是开了追击 AI，这一关就从
    // "沿公路逐个点名"变成"被十四辆车围殴"，遭遇战直接不成立。
    // 开火距离 60 m（地图 1:10 压缩后的"公路直射距离"），瞄准误差与
    // 普通攻击态同口径。fireCd 的间隔比追击 AI 略长：停驻车组从发现
    // 到开炮要经车长口令，不是战斗警备状态。
    if (this.hold) {
      const aimYaw = Math.atan2(dx, dz);
      const aimErr = tank.aimTowards(aimYaw, dt, 3.2);
      if (this.los && dist < 60 && this.fireCd <= 0
          && this.spawnShield <= 0 && aimErr < 0.15) {
        this.fireCd = this.isElite
          ? 1.6 + R.combat() * 0.7
          : 2.3 + R.combat() * 1.2;
        const dir = new THREE.Vector3(dx, 0, dz).normalize();
        dir.x += (R.combat() - 0.5) * 0.11;
        dir.z += (R.combat() - 0.5) * 0.11;
        dir.normalize();
        ctx.fire(tank, dir, this.damage, 'enemy');
      }
      this._updateBar();
      return;
    }

    // ---- Boss：独立行为，不参与普通状态机 ----
    if (this.isBoss) {
      this._updateBoss(dt, ctx, dist, dx, dz);
      return;
    }

    // ---- M3 新敌人：独立行为 ----
    if (this.flying) {
      this._updateDrone(dt, ctx, dist, dx, dz);
      return;
    }
    if (this.turretStatic) {
      this._updateTurret(dt, ctx, dist, dx, dz);
      return;
    }
    if (this.support) {
      this._updateSupport(dt, ctx, dist, dx, dz);
      return;
    }

    // ---- 巡逻 / 驻军：警戒圈外走固定路线，不追玩家 ----
    // 和联机服务端调的是同一个 stepPatrol，避免"单机能巡逻、联机还追人"。
    let forcedChase = false;
    if (this.patrol) {
      const dec = stepPatrol(this.patrol, dt, dist, p);
      if (dec && dec.mode !== 'chase') {
        this.state = 'patrol';
        if (dec.mode !== 'hold') {
          this._navigate(dt, ctx, dec.tx, dec.tz, dec.speedMul ?? 0.6);
          // 炮塔朝行进方向：玩家从背后接近可以先手，站着不动的车不再送分
          tank.aimTowards(Math.atan2(dec.tx - p.x, dec.tz - p.z), dt, 3);
        }
        this._updateBar();
        return;
      }
      forcedChase = true;
    }

    // ---- 状态机 ----
    if (this.charger) {
      this.state = this.los ? 'chase' : 'flank';
    } else if (forcedChase) {
      // 已经被巡逻警戒圈唤醒：不再退回"围着玩家绕圈"的旧 patrol 状态
      this.state = dist < 16 && this.los ? 'attack' : 'chase';
    } else if (dist < 16 && this.los) this.state = 'attack';
    else if (dist > 58 && this.noLosT > 2) this.state = 'patrol';
    else if (this.los) this.state = 'chase';
    else this.state = 'flank';

    // ---- 移动 ----
    let aimYaw = Math.atan2(dx, dz);
    if (this.state === 'patrol') {
      if (!this.target || Math.hypot(this.target.x - p.x, this.target.z - p.z) < 3) {
        const a = aimYaw + (R.combat() - 0.5) * 1.1;
        const r = 10 + R.combat() * 16;
        this.target = new THREE.Vector3(
          THREE.MathUtils.clamp(p.x + Math.sin(a) * r, -world.half + 6, world.half - 6),
          0,
          THREE.MathUtils.clamp(p.z + Math.cos(a) * r, -world.half + 6, world.half - 6)
        );
      }
      this._navigate(dt, ctx, this.target.x, this.target.z, 0.85);
    } else if (this.state === 'attack') {
      // 保持 9~13 距离，侧向游走；一旦视线丢失立刻转绕后
      if (dist < 9) this._navigate(dt, ctx, p.x - dx / dist * 12, p.z - dz / dist * 12, 0.6);
      else if (dist > 13) this._navigate(dt, ctx, player.x, player.z, 0.55);
      else {
        const a = Math.atan2(dx, dz) + this.strafe * Math.PI / 2;
        this._navigate(dt, ctx, p.x + Math.sin(a) * 6, p.z + Math.cos(a) * 6, 0.55);
      }
    } else if (this.state === 'chase') {
      this._navigate(dt, ctx, player.x, player.z, 1);
    } else {
      // ---- 绕后：走向玩家视野侧后方，走出掩体重新获得视线 ----
      if (!this.flankGoal || this.flankT <= 0 ||
          Math.hypot(this.flankGoal.x - player.x, this.flankGoal.z - player.z) > 14) {
        this.flankT = 1.8 + R.combat() * 1.2;
        this.flankGoal = this._pickFlankGoal(world, player, ctx.player.turretYaw).clone();
      }
      this._navigate(dt, ctx, this.flankGoal.x, this.flankGoal.z, 1);
      aimYaw = Math.atan2(this.flankGoal.x - p.x, this.flankGoal.z - p.z);
    }

    // ---- 冲锋兵 / 无人机：贴脸自爆 ----
    if (this.charger) {
      if (dist < this.selfDestruct.radius && this.los && this.spawnShield <= 0) {
        ctx.chargerBurst(this, this.selfDestruct.damage, this.selfDestruct.radius);
        return;
      }
      tank.aimTowards(aimYaw, dt, 7);
      this._updateBar();
      return;
    }

    // ---- 炮塔瞄准 ----
    const aimErr = tank.aimTowards(aimYaw, dt, this.state === 'attack' ? 6.5 : 4);

    // ---- 开火：必须有视线 ----
    if (this.state === 'attack' && this.los && this.fireCd <= 0 &&
        this.spawnShield <= 0 && aimErr < 0.16) {
      this.fireCd = this.isElite
        ? 1.35 + R.combat() * 0.7
        : 1.8 + R.combat() * 1.1;
      const dir = new THREE.Vector3(dx, 0, dz).normalize();
      dir.x += (R.combat() - 0.5) * 0.13;
      dir.z += (R.combat() - 0.5) * 0.13;
      dir.normalize();
      ctx.fire(tank, dir, this.damage, 'enemy');
    }

    this._updateBar();
  }

  // ---------------- M3 新敌人 ----------------

  /** 自爆无人机：低空飞行直扑玩家，无视地形与掩体，贴脸自爆 */
  _updateDrone(dt, ctx, dist, dx, dz) {
    const tank = this.tank;
    const p = tank.group.position;
    this.bobT = (this.bobT || 0) + dt;
    tank.aimTowards(Math.atan2(dx, dz), dt, 8);

    // 飞行位移：不做地面碰撞，手动推进 + 边界钳制
    if (dist > 0.2) {
      const step = tank.speed * dt;
      const half = ctx.world.half;
      p.x = THREE.MathUtils.clamp(p.x + (dx / dist) * step, -half + 2, half - 2);
      p.z = THREE.MathUtils.clamp(p.z + (dz / dist) * step, -half + 2, half - 2);
    }
    p.y = 1.05 + Math.sin(this.bobT * 3.2) * 0.3;

    if (dist < this.selfDestruct.radius * 0.9 && this.spawnShield <= 0) {
      p.y = 0;
      ctx.chargerBurst(this, this.selfDestruct.damage, this.selfDestruct.radius);
      return;
    }
    this._updateBar();
  }

  /** 炮台：固定不动，38m 超远射程，开火前有瞄准线预警 */
  _updateTurret(dt, ctx, dist, dx, dz) {
    const tank = this.tank;
    const player = ctx.player.group.position;
    const aimYaw = Math.atan2(dx, dz);
    const aimErr = tank.aimTowards(aimYaw, dt, 2.5);

    // 瞄准线：有视线且进入射程时闪烁预警
    if (this.sight) {
      if (this.los && dist < 40) {
        const p = this.position;
        this.sight.visible = true;
        this.sight.position.set((p.x + player.x) / 2, 1.3, (p.z + player.z) / 2);
        this.sight.scale.set(1, 1, Math.max(0.1, dist));
        this.sight.rotation.y = aimYaw;
        this.sight.material.opacity = 0.2 + 0.16 * Math.abs(Math.sin(performance.now() / 170));
      } else {
        this.sight.visible = false;
      }
    }

    // 开火判据用**弧长**（角度 × 距离）而不是裸角度：
    // 0.2 rad 在 14 米处就是 2.8 米偏差，比 1.45 米的命中半径大一倍——
    // 炮塔还差着大半格就开炮，站桩玩家也照样擦身而过（实测最近 2.1 米）。
    // 弧长 < 1.2 米 = 炮塔确实指到了"能打中"的位置才准开火。
    const aimArc = aimErr * dist;
    if (this.los && dist < 38 && this.fireCd <= 0 && this.spawnShield <= 0 && aimArc < 1.2) {
      this.fireCd = 2.6 + R.combat() * 0.8;
      ctx.fire(tank, new THREE.Vector3(dx, 0, dz).normalize(), this.damage, 'enemy', {
        speed: 46, color: 0xffe2a0, glow: 0xff8a2a, scale: 1.6,
      });
    }
    this._updateBar();
  }

  /** 补给车：治疗 8m 内队友，玩家靠近就跑；击杀有额外分 */
  _updateSupport(dt, ctx, dist, dx, dz) {
    const H = ENEMY_TYPES.support;

    // 光环呼吸 + 治疗脉冲衰减（all in auras.js）
    this.aura.update(dt);

    // 治疗光环：按最大血量的百分比结算（参数见 core/world.js 的 ENEMY_TYPES.support）。
    // 以前这里是固定 +6：对 60 血的枪手是 10%/秒，对 4000 血的精英等于没治。
    this.healT -= dt;
    if (this.healT <= 0) {
      this.healT = 1.2;
      let healed = 0;
      for (const e of ctx.enemies) {
        if (e === this || !e.alive) continue;
        if (e.tank.hp >= e.tank.maxHp) continue;
        if (e.position.distanceTo(this.position) >= H.healAura) continue;
        // Boss 不吃治疗：Boss 血量是按「目标时长 × DPS」反推的，
        // 回血会直接把那条曲线毁掉（详见 ENEMY_TYPES.support 的注释）。
        if (e.isBoss && H.bossHealMul <= 0) continue;
        e.tank.hp = Math.min(e.tank.maxHp, e.tank.hp + e.tank.maxHp * H.healRate * 1.2);
        healed++;
      }
      if (healed > 0) {
        this.aura.hit();
        ctx.effects.explosion(this.position.clone().setY(1), 0x57d877, 6, 0.5);
      }
    }

    // 移动：玩家 15m 内背向逃跑，否则缓慢徘徊
    const p = this.position;
    if (dist < 15) {
      this._navigate(dt, ctx, p.x - (dx / dist) * 12, p.z - (dz / dist) * 12, 1);
    } else {
      if (!this.target || Math.hypot(this.target.x - p.x, this.target.z - p.z) < 3) {
        const half = ctx.world.half;
        this.target = new THREE.Vector3(
          THREE.MathUtils.clamp(p.x + (R.combat() - 0.5) * 20, -half + 6, half - 6),
          0,
          THREE.MathUtils.clamp(p.z + (R.combat() - 0.5) * 20, -half + 6, half - 6)
        );
      }
      this._navigate(dt, ctx, this.target.x, this.target.z, 0.5);
    }
    this.tank.aimTowards(Math.atan2(dx, dz), dt, 4);
    this._updateBar();
  }

  // ---------------- Boss AI ----------------
  _updateBoss(dt, ctx, dist, dx, dz) {
    const tank = this.tank;
    const player = ctx.player.group.position;
    const p = this.position;
    const breaker = this.bossKind === 'breaker';
    const hpRatio = tank.hp / tank.maxHp;

    // 核心脉动
    if (this.core) {
      this.coreT += dt;
      this.core.scale.setScalar(1 + Math.sin(this.coreT * (this.enraged ? 9 : 5)) * 0.16);
    }

    // 40% 以下狂暴
    if (!this.enraged && hpRatio < 0.4) {
      this.enraged = true;
      this.abilityT = Math.min(this.abilityT, 1.5);
      this.skillT = Math.min(this.skillT, 1.2);
      ctx.hud.showMessage(`${this.bossName} · 狂暴`, 1.3);
      ctx.effects.explosion(p.clone().setY(2), this.coreColor, 26, 1.3);
    }

    // ---- Boss 技能接管（r46）----
    // 放在普通 AI 之前：施法 / 冲刺 / 硬直期间不能既走位又开火，
    // 否则"预警 1.2 秒"这段时间 Boss 还在疾驰，玩家根本无从判断落点。
    if (this._updateBossSkill(dt, ctx, dist, dx, dz)) {
      this._updateBar();
      return;
    }

    const aimYaw = Math.atan2(dx, dz);

    // 施法中：停火停走，只转炮塔
    if (this.castT > 0) {
      this.castT -= dt;
      tank.aimTowards(aimYaw, dt, 4);
      if (this.castT <= 0) this._finishCast(ctx);
      this._updateBar();
      return;
    }

    // 保持距离 + 侧移
    // 每种 Boss 的保持距离来自 bosskit（幽影要贴到 8 米才够压迫感）
    const near = this.bossNear;
    const far = this.bossFar;

    // 区域压制：被拉出锚点太远就回防，不再从地图一头追到另一头。
    // Boss 用的是和杂兵同一份 core/patrol.js（kind='boss' 有独立的警戒/leash）。
    if (this.patrol) {
      const dec = stepPatrol(this.patrol, dt, dist, p);
      if (dec && dec.mode !== 'chase') {
        if (dec.mode !== 'hold') {
          this._navigate(dt, ctx, dec.tx, dec.tz, dec.speedMul ?? 0.8);
          tank.aimTowards(Math.atan2(dec.tx - p.x, dec.tz - p.z), dt, 3);
        }
        this._updateBar();
        return;
      }
    }

    if (!this.los || dist > far) {
      this._navigate(dt, ctx, player.x, player.z, 0.72);
    } else if (dist < near) {
      this._navigate(dt, ctx, p.x - dx / dist * 12, p.z - dz / dist * 12, 0.5);
    } else {
      const a = aimYaw + this.strafe * Math.PI / 2;
      this._navigate(dt, ctx, p.x + Math.sin(a) * 8, p.z + Math.cos(a) * 8, 0.42);
    }

    // ---- 提前量解算 ----
    // 以前炮塔朝"玩家现在的位置"转、炮弹也朝那个点飞。玩家横移 15 m/s 时，
    // 18 米距离要飞 0.3 秒，人已经挪了 4.5 米，而命中半径只有 1.45 米——
    // 数学上必空。这就是"破城者主炮一点伤害都没有"的真正原因：
    // 炮没坏，是它只会打你刚才站的地方（原本靠范围炮击锁定兜底，锁定被移除后就露馅了）。
    //
    // ⚠ 解算必须从**炮口**出发，不能用车身中心：
    // 炮口在炮塔前方约 2 米，按中心算出来的角度，落到目标处就整体偏 2 米——
    // 比 1.45 米的命中半径还大，等于白算。（实测：按中心算，48 发只中 1.4 发。）
    const pv = ctx.playerVel || ZERO_VEL;
    const leadSpeed = breaker ? AIM_DEFAULTS.breakerSpeed : AIM_DEFAULTS.prismSpeed;
    const leadMul = breaker ? AIM_DEFAULTS.breakerLead : AIM_DEFAULTS.prismLead;
    const muz = tank.muzzleWorld(this._muzzleTmp || (this._muzzleTmp = new THREE.Vector3()));
    const mdx = player.x - muz.x;
    const mdz = player.z - muz.z;
    const sol = solveIntercept({ dx: mdx, dz: mdz, vx: pv.x, vz: pv.z, speed: leadSpeed, lead: leadMul });
    const fireYaw = sol ? Math.atan2(sol.x, sol.z) : Math.atan2(mdx, mdz);

    const aimErr = tank.aimTowards(fireYaw, dt, 4.5);

    // 俯角：Boss 模型放大后炮口在 2.89 米（破城者）/ 2.39 米（棱镜）高，
    // 而玩家命中判定的上限是 2.3 米。平射出去的炮弹全部从头顶掠过，
    // 伤害恒为 0 —— 这才是"主炮一点伤害都没有"的元凶（不是走位，也不是没瞄准）。
    // 弹道按实际交战距离下落，命中点正好穿过车身中部（1.1 米）。
    const muzzleY = muz.y;
    const horiz = Math.hypot(mdx, mdz);
    const aimPitch = flatPitch(muzzleY, horiz);
    const dirAt = (yaw) => {
      // 方向向量交给 core/aim.js 拼（同一份数学，单机与联机服务端共用），
      // 这里只负责换成 THREE 的向量。
      const d = dirFrom(yaw, aimPitch);
      return new THREE.Vector3(d.x, d.y, d.z);
    };

    // 主武器
    // 同小兵：弧长判据（角度 × 距离 < 1.2 米），否则 0.2 rad 的裸角度
    // 在 14 米处就是 2.8 米的落点偏差，比命中半径还大，站桩都打不中。
    if (this.los && this.fireCd <= 0 && this.spawnShield <= 0 && aimErr * horiz < 1.2) {
      if (breaker) {
        // 4.6 秒一轮（狂暴 3.4）。节奏是被"命中率"按出来的：
        // 高度 bug 修掉之前它每轮都是 0 伤害，现在每轮稳定打中 1 发 = 15 点。
        // 按 120 血、8 轮算，站桩挨 8 轮就是 37 秒——
        // 一场 Boss 战本来就要打那么久，这个数字刚好"站着不动会死、
        // 跑起来能活一段"，不是被秒。
        this.fireCd = this.enraged ? 3.4 : 4.6;
        const base = fireYaw;
        // 散布 0.15 rad：18 米处横向 ±2.7 米，明显大于玩家 1.45 米的命中半径。
        // 这样"中间那发稳定命中，两侧两发只是封走位"——
        // 实测站桩/匀速跑每轮挨 1 发（15 点），想全躲必须变向。
        // 试过 0.095：三发全会中，一轮 45 点，绕圈 10 秒就死，太狠。
        for (const off of [-0.15, 0, 0.15]) {
          ctx.fire(tank, dirAt(base + off), this.damage, 'enemy', {
            speed: leadSpeed, color: 0xffc9a0, glow: 0xff5a2a, scale: 1.45,
          });
        }
        ctx.shake = Math.max(ctx.shake, 0.16);
      } else {
        this.fireCd = this.enraged ? 1.8 : 2.6;
        this.burst = 3;
        this.burstT = 0;
      }
    }

    // 棱镜三连点射
    if (this.burst > 0) {
      this.burstT -= dt;
      if (this.burstT <= 0) {
        this.burstT = 0.1;
        this.burst -= 1;
        const a = fireYaw + (R.combat() - 0.5) * 0.05;
        ctx.fire(tank, dirAt(a), this.damage, 'enemy', {
          speed: leadSpeed, color: 0x9ff4ff, glow: 0x38d8ff, scale: 0.85,
        });
      }
    }

    // 技能计时。
    // 破城者的"攻城炮击锁定"已随反龟缩压制一起移除：难度改由敌人构成与
    // 地形承担，不再用"必须不停跑位"的强制位移考验玩家。破城者只保留主炮。
    // r45：棱镜的"相位跃迁"也删了。它的落点是"玩家周围 17~24m 的随机方位"，
    // 与 AI 的保持距离（near 17 / far 27）几乎重合——距离没变、只换了方向，
    // 玩家的体感就是"刚才在左前方，一转头贴到右后方"，纯瞬移，没有可读的位移过程。
    // 联机版从来就没有这个技能，删掉后两边行为一致，也省掉"单人比联机难"的偏差。
    this.abilityT -= dt;
    if (this.abilityT <= 0) {
      this.abilityT = this.enraged ? 6.5 : 9;
      if (!breaker) {
        this.castKind = 'ring';
        this.castT = 0.95;
        ctx.hud.showMessage(`${this.bossName} · 折射风暴`, 1.15);
      }
    }

    this._updateBar();
  }

  _finishCast(ctx) {
    // 只剩棱镜的折射风暴：全向弹幕
    const count = this.enraged ? 16 : 12;
    const base = R.combat() * Math.PI * 2;
    const dmg = Math.max(7, this.damage);
    // 环射同样要下压：棱镜炮口 2.39 米，高过玩家 2.3 米的命中上限，
    // 平射的弹幕会整整一圈从头顶飞过去（以前就是白放）。
    const muz = this.tank.muzzleWorld(this._muzzleTmp2 || (this._muzzleTmp2 = new THREE.Vector3()));
    const player = ctx.player.group.position;
    // 落角按同一套规则算（不要用"直指脚下"的版本：那会把弹幕整个砸进地面）
    const pitch = flatPitch(muz.y, Math.hypot(player.x - muz.x, player.z - muz.z));
    for (let i = 0; i < count; i++) {
      const a = base + (i / count) * Math.PI * 2;
      // 全向弹幕是"铺开"而不是"追人"：俯角取一半，让它们散成一个向下的锥面，
      // 不然所有弹都会朝玩家所在的那个点收束。
      const d = dirFrom(a, pitch * 0.5);
      ctx.fire(this.tank, new THREE.Vector3(d.x, d.y, d.z), dmg, 'enemy', {
        speed: 50, color: 0xbff6ff, glow: 0x38d8ff, scale: 1.05,
      });
    }
    ctx.shake = Math.max(ctx.shake, 0.2);
    this.castKind = null;
    this.castT = 0;
  }

  // ---------------- Boss 技能（r46） ----------------

  /**
   * 与联机 core/world.js 的 _updateBossSkill 是同一套状态机、同一份参数。
   * 返回 true = 本帧由技能接管，跳过普通 AI。
   */
  _updateBossSkill(dt, ctx, dist, dx, dz) {
    const SKILL = BOSS_SKILLS;
    const kind = this.bossKind;

    // 觉醒"再生"：每秒回 0.5% 最大血量（联机同参数，见 AWAKEN_NUM）
    if (this.regen && this.tank.hp < this.tank.maxHp) {
      this.tank.hp = Math.min(this.tank.maxHp, this.tank.hp + this.tank.maxHp * AWAKEN_NUM.regenPerSec * dt);
    }
    const p = this.position;
    const player = ctx.player.group.position;

    if (this.castKind === 'blinkWarn') {
      this.castT -= dt;
      this.tank.aimTowards(Math.atan2(dx, dz), dt, 6);
      if (this.castT <= 0) {
        const to = this.castPos.clone();
        // 消失点的余波 → 落点的冲击波，"去了哪"看得见
        ctx.effects.explosion(p.clone().setY(1.4), 0x6b4bd8, 16, 1);
        p.set(to.x, 0, to.z);
        this.path = [];
        this.pathGoal.set(Infinity, 0, Infinity);
        this.repathT = 0;
        ctx.effects.explosion(p.clone().setY(1.4), 0x9b7bff, 24, 1.2);
        if (ctx.bossShock) ctx.bossShock(p, SKILL.blink.shockR, SKILL.blink.shockDmg);
        ctx.shake = Math.max(ctx.shake, 0.28);
        this.castKind = null;
        this.skillT = this.enraged ? SKILL.blink.enragedCd : SKILL.blink.cd;
      }
      return true;
    }

    if (this.castKind === 'dash') {
      this.castT -= dt;
      const step = (SKILL.dash.dist / SKILL.dash.dur) * dt;
      const nx = p.x + this.dashDir.x * step;
      const nz = p.z + this.dashDir.z * step;
      const world = ctx.world;
      // 撞墙提前结束：不然会贴着建筑一直"冲"，看起来像卡住
      if (world && world.blocked(nx, nz, this.tank.radius)) {
        this.castT = 0;
      } else {
        p.x = nx;
        p.z = nz;
        this.tank.group.rotation.y = Math.atan2(this.dashDir.x, this.dashDir.z);
      }
      if (!this.hitDone && ctx.bossShock &&
        Math.hypot(player.x - p.x, player.z - p.z) < SKILL.dash.hitR) {
        ctx.bossShock(p, SKILL.dash.hitR, SKILL.dash.dmg);
        this.hitDone = true;
      }
      // 拖尾：只做视觉，不参与判定
      if (Math.random() < 0.5) ctx.effects.explosion(p.clone().setY(0.7), 0xffd23a, 2, 0.4);
      if (this.castT <= 0) {
        // 硬直 = 给玩家的输出窗口
        this.castKind = 'stun';
        this.castT = SKILL.dash.stun;
        this.castDur = SKILL.dash.stun;
        ctx.hud.showMessage(`${this.bossName} · 硬直`, 0.7);
      }
      return true;
    }

    if (this.castKind === 'stun') {
      this.castT -= dt;
      if (this.castT <= 0) {
        this.castKind = null;
        this.skillT = this.enraged ? SKILL.dash.enragedCd : SKILL.dash.cd;
      }
      return true;
    }

    // ---- 铁壁：护盾循环（持续型）----
    if (kind === 'bulwark') {
      this.breakT = Math.max(0, this.breakT - dt);
      if (this.tank.shieldHp > 0) return false;    // 有壳：正常移动开火
      if (this.breakT > 0) return false;            // 破防中：玩家的窗口
      this.tank.shieldHp = Math.round(
        this.tank.maxHp * SKILL.generators.hpShare * SKILL.generators.count);
      ctx.hud.showMessage(`${this.bossName} · 护盾展开`, 0.9);
      return false;
    }

    // ---- 蜂巢：召唤（持续型）----
    if (kind === 'hive') {
      this.skillT -= dt / (this.cdMul || 1);
      if (this.skillT > 0) return false;
      const cap = SKILL.spawn.cap;
      let mine = 0;
      for (const o of ctx.enemies) if (o.alive && o.summoner === this) mine++;
      // 上限到了：返回 true 只是"这一帧不给普通 AI"，避免继续往下
      // 再执行一次通用的 skillT -= dt（那样冷却会以两倍速度走）
      if (mine >= cap) { this.skillT = 2; return true; }
      const n = Math.min(SKILL.spawn.count, cap - mine);
      const hp = Math.round((55 + ctx.wave * 14) * 0.35);
      for (let i = 0; i < n; i++) {
        const a = R.combat() * Math.PI * 2;
        const r = 3.5 + R.combat() * 3;
        if (ctx.spawnDrone) {
          ctx.spawnDrone(this, p.x + Math.sin(a) * r, p.z + Math.cos(a) * r, hp);
        }
      }
      this.skillT = SKILL.spawn.cd;
      ctx.hud.showMessage(`${this.bossName} · 释放无人机`, 0.9);
      return true;
    }

    // ---- 熔核：铺岩浆 + 全屏炮击（持续型）----
    // 动词是"站"：伤害不高，但它一块块切掉能站的地面。只有岩浆的话
    // 玩家走出去就完了，所以配一发"脚下 + 外围两发"的炮击，
    // 逼他在岩浆缝里找落脚点。
    if (kind === 'crucible') {
      this.skillT -= dt / (this.cdMul || 1);
      this.blastT = (this.blastT ?? SKILL.barrage.cd * 0.5) - dt;
      if (this.blastT <= 0) {
        this.blastT = SKILL.barrage.cd;
        const r = 6;
        if (ctx.addZone) {
          ctx.addZone(ZONE.BLAST, player.x, player.z, r, SKILL.barrage.warn);
          for (let i = 0; i < 2; i++) {
            const a = R.combat() * Math.PI * 2;
            const d2 = 9 + R.combat() * 5;
            const bx = THREE.MathUtils.clamp(player.x + Math.sin(a) * d2, -ctx.world.half + 6, ctx.world.half - 6);
            const bz = THREE.MathUtils.clamp(player.z + Math.cos(a) * d2, -ctx.world.half + 6, ctx.world.half - 6);
            ctx.addZone(ZONE.BLAST, bx, bz, r, SKILL.barrage.warn);
          }
        }
        ctx.hud.showMessage(`${this.bossName} · 全屏炮击`, 0.9);
      }
      if (this.skillT > 0) return false;
      if (ctx.addZone) {
        for (let i = 0; i < SKILL.lava.count; i++) {
          const a = R.combat() * Math.PI * 2;
          const rr = 5 + R.combat() * 9;
          const x = THREE.MathUtils.clamp(player.x + Math.sin(a) * rr, -ctx.world.half + 6, ctx.world.half - 6);
          const z = THREE.MathUtils.clamp(player.z + Math.cos(a) * rr, -ctx.world.half + 6, ctx.world.half - 6);
          if (ctx.world.blocked(x, z, 2)) continue;
          ctx.addZone(ZONE.LAVA, x, z, SKILL.lava.r, SKILL.lava.dur);
        }
        // 脚下一块大的：不挪窝就要挨烧
        ctx.addZone(ZONE.LAVA, player.x, player.z, SKILL.lava.r * 1.6, SKILL.lava.dur * 0.75);
      }
      this.skillT = SKILL.lava.cd;
      ctx.hud.showMessage(`${this.bossName} · 熔岩喷发`, 0.9);
      return true;
    }

    // ---- 哨戒：双旋转光束（持续型）----
    // 动词是"掐"：两道光束匀速扫，玩家要卡着间隙穿过去。
    // 判定调 core/bosskit.js 的 laserHits，与联机同一份。
    if (kind === 'warden') {
      this.laserDir = this.laserDir || 1;
      this.laserYaw = (this.laserYaw ?? this.tank.turretYaw) + (this.enraged ? SKILL.laser.enragedSpeed : SKILL.laser.speed) * this.laserDir * dt;
      // 本体要压上来：它的普通弹射程只有 38 米，如果站着不动，
      // 玩家在 45 米外就能把它磨死（光束 40 米够不着）。所以这里自己走位，
      // 不走下面那套 AI——那套会 aimTowards 把炮塔从光束角度掰走。
      if (dist > this.bossFar) this._navigate(dt, ctx, player.x, player.z, 0.6);
      else if (dist < this.bossNear) this._navigate(dt, ctx, p.x - dx / dist * 10, p.z - dz / dist * 10, 0.5);
      this.tank.setAim(this.laserYaw);
      this.laserFlipT = (this.laserFlipT ?? SKILL.laser.cd) - dt;
      if (this.laserFlipT <= 0) {
        this.laserDir *= -1;
        this.laserFlipT = SKILL.laser.cd;
      }
      this.laserAcc = (this.laserAcc || 0) + dt;
      if (this.laserAcc >= SKILL.laser.tick) {
        const per = SKILL.laser.dps * this.laserAcc;
        this.laserAcc = 0;
        if (ctx.hurtPlayer && laserHits(p.x, p.z, this.laserYaw, player.x, player.z)) {
          ctx.hurtPlayer(per, true);
        }
      }
      return true;
    }

    // ---- 双生：共鸣钳位（持续型）----
    // 与联机 world.js 同一条规则（core/bosskit.js::resonancePull）：
    // 两只血量差超过 15%，低的那只被拉回来。所以必须两边一起压。
    if (kind === 'twin') {
      const other = ctx.enemies.find((o) => o !== this && o.alive && o.bossKind === 'twin');
      if (other) {
        const add = resonancePull(this.tank.hp, other.tank.hp, this.tank.maxHp, dt);
        if (add > 0) {
          this.tank.hp = Math.min(this.tank.maxHp, this.tank.hp + add);
          this.pullT = (this.pullT || 0) + dt;
          if (this.pullT >= 0.4) {
            this.pullT = 0;
            ctx.effects.explosion(p.clone().setY(1.8), 0xb388ff, 12, 0.45);
          }
        }
      }
      return false;
    }

    // ---- 终焉：三阶段 ----
    // 一条血条分三段，每段换一套动作。阶段一是普通炮台（普通 AI 自己会打
    // 三连点射），阶段二召唤 + 岩浆，阶段三冲刺 + 环射。
    if (kind === 'terminus') {
      if (this.castKind === 'phase') {
        this.castT -= dt;
        if (this.castT <= 0) {
          this.castKind = null;
          this.tank.invuln = false;
          this.skillT = 1.0;
        }
        return true;
      }

      const ratio = this.tank.hp / this.tank.maxHp;
      const want = bossStageFor(ratio);
      if (want > (this.stage || 0)) {
        this.stage = want;
        this.tank.invuln = true;
        this.castKind = 'phase';
        this.castT = SKILL.phases.invuln;
        this.castDur = SKILL.phases.invuln;
        if (want === 2) this.tank.speed *= SKILL.phases.stage3SpeedMul;
        ctx.bossShock(p, SKILL.phases.shockR, SKILL.phases.shockDmg);
        if (ctx.addZone) ctx.addZone(ZONE.SHOCK, p.x, p.z, SKILL.phases.shockR, SKILL.phases.invuln);
        ctx.effects.explosion(p.clone().setY(2), this.coreColor, 34, 1.4);
        ctx.hud.showMessage(`${this.bossName} · 第 ${want + 1} 阶段`, 1.4);
        ctx.shake = Math.max(ctx.shake, 0.5);
        return true;
      }

      if ((this.stage || 0) === 1) {
        this.eliteT = (this.eliteT ?? SKILL.phases.stage2EliteCd) - dt;
        if (this.eliteT <= 0) {
          this.eliteT = SKILL.phases.stage2EliteCd;
          for (let i = 0; i < SKILL.phases.stage2Elites; i++) {
            const a = R.combat() * Math.PI * 2;
            const r = 4 + R.combat() * 3;
            if (ctx.spawnElite) ctx.spawnElite(p.x + Math.sin(a) * r, p.z + Math.cos(a) * r);
          }
          ctx.hud.showMessage(`${this.bossName} · 召唤护卫`, 0.9);
        }
        this.lavaT = (this.lavaT ?? SKILL.phases.stage2LavaCd) - dt;
        if (this.lavaT <= 0) {
          this.lavaT = SKILL.phases.stage2LavaCd;
          if (ctx.addZone) {
            for (let i = 0; i < SKILL.lava.count; i++) {
              const a = R.combat() * Math.PI * 2;
              const r = 6 + R.combat() * 9;
              const x = THREE.MathUtils.clamp(player.x + Math.sin(a) * r, -ctx.world.half + 6, ctx.world.half - 6);
              const z = THREE.MathUtils.clamp(player.z + Math.cos(a) * r, -ctx.world.half + 6, ctx.world.half - 6);
              if (ctx.world.blocked(x, z, 2)) continue;
              ctx.addZone(ZONE.LAVA, x, z, SKILL.lava.r, SKILL.lava.dur);
            }
          }
        }
        return false;
      }

      if (this.stage === 2) {
        this.ringT = (this.ringT ?? 1.2) - dt;
        if (this.ringT <= 0) {
          this.ringT = SKILL.phases.stage3RingCd;
          const n = SKILL.ring.count;
          const yaw0 = Math.atan2(dx, dz);
          for (let i = 0; i < n; i++) {
            const a = yaw0 + (i / n) * Math.PI * 2;
            ctx.fire(tank, new THREE.Vector3(Math.sin(a), 0, Math.cos(a)), this.damage * 0.7, 'enemy', {
              speed: 42, color: 0xffc9d8, glow: 0xff3b6b, scale: 0.9,
            });
          }
          ctx.hud.showMessage(`${this.bossName} · 环射`, 0.8);
        }
        this.dashT = (this.dashT ?? SKILL.phases.stage3DashCd) - dt;
        if (this.dashT <= 0) {
          this.dashT = SKILL.phases.stage3DashCd;
          const d = Math.hypot(dx, dz) || 1;
          this.dashDir.set(dx / d, 0, dz / d);
          this.hitDone = false;
          this.castKind = 'dash';
          this.castT = SKILL.dash.dur;
          this.castDur = SKILL.dash.dur;
          return true;
        }
        return false;
      }

      return false;   // 阶段一：交给普通 AI 的主炮与三连点射
    }

    // 狂暴词条：不改各技能的 cd 常量，让冷却"走得更快"，一处改动全覆盖
    this.skillT -= dt / (this.cdMul || 1);
    if (this.skillT > 0) return false;

    if (kind === 'wraith') {
      // 落点必须是贴身（5~8m）：预警圈 6m 的冲击波才够得着玩家。
      // 原本按 12~16m 设计，结果"跳到远处放个圈"，等于没有威胁。
      const spot = this._blinkSpot(ctx, player, SKILL.blink.minDist, SKILL.blink.maxDist);
      if (!spot) { this.skillT = 1.0; return false; }
      this.castPos.set(spot.x, 0, spot.z);
      this.castKind = 'blinkWarn';
      this.castT = SKILL.blink.warn;
      this.castDur = SKILL.blink.warn;
      this.skillT = this.enraged ? SKILL.blink.enragedCd : SKILL.blink.cd;
      ctx.effects.warn(this.castPos, 2.6, SKILL.blink.warn, 0x9b7bff);
      ctx.hud.showMessage(`${this.bossName} · 相位跃迁`, 0.9);
      return true;
    }

    if (kind === 'blitz') {
      // 方向在起手瞬间冻结：每帧重新对准就等于必中，玩家没法躲
      const d = Math.hypot(dx, dz) || 1;
      this.dashDir.set(dx / d, 0, dz / d);
      this.hitDone = false;
      this.castKind = 'dash';
      this.castT = SKILL.dash.dur;
      this.castDur = SKILL.dash.dur;
      this.skillT = this.enraged ? SKILL.dash.enragedCd : SKILL.dash.cd;
      ctx.hud.showMessage(`${this.bossName} · 突进`, 0.8);
      return true;
    }

    return false;
  }

  /** 在玩家周围找一个不撞建筑、且落在 [minD, maxD] 的点位 */
  _blinkSpot(ctx, player, minD, maxD) {
    const world = ctx.world;
    for (let i = 0; i < 20; i++) {
      const a = R.combat() * Math.PI * 2;
      const r = minD + R.combat() * (maxD - minD);
      const x = THREE.MathUtils.clamp(player.x + Math.sin(a) * r, -world.half + 6, world.half - 6);
      const z = THREE.MathUtils.clamp(player.z + Math.cos(a) * r, -world.half + 6, world.half - 6);
      if (world.blocked(x, z, this.tank.radius + 0.4)) continue;
      if (Math.hypot(x - player.x, z - player.z) < minD * 0.85) continue;
      return { x, z };
    }
    return null;
  }

  _updateBar() {
    if (!this.bar.visible) return;
    this.bar.lookAt(this.camera.position);
    let ratio = Math.max(0.001, this.tank.hp / this.tank.maxHp);
    // 终焉：三个阶段的血条各算一条满格（见 bosskit 的 stageBarRatio）。
    // 不这么做的话，进二阶段时血条只有 66%，玩家会以为"血条被吃了一段"。
    if (this.bossKind === 'terminus') ratio = Math.max(0.001, stageBarRatio(this.tank.hp / this.tank.maxHp, this.stage || 0));
    this.fill.scale.x = ratio;
    this.fill.position.x = -(1 - ratio) * (BAR_W / 2);
  }
}
