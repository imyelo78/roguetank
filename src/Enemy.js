import * as THREE from '../vendor/three.module.js';
import { Tank } from './Tank.js';
import { R } from './rng.js';
import { enemySkin } from './teams.js';
import { solveIntercept, AIM_DEFAULTS, flatPitch, dirFrom } from './core/aim.js';
import { createPatrolState, stepPatrol, wakePatrol, sendHunting, PATROL } from './core/patrol.js';

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
const CORE_MATS = {
  breaker: new THREE.MeshBasicMaterial({
    color: 0xff6a2a, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }),
  prism: new THREE.MeshBasicMaterial({
    color: 0x6fe6ff, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }),
};

const BOSS_INFO = {
  boss_breaker: { name: '破城者', kind: 'breaker' },
  boss_prism: { name: '棱镜', kind: 'prism' },
};

const tmpGoal = new THREE.Vector3();

export class Enemy {
  constructor(scene, { x, z, hp = 60, speed = 9, camera, type = 'gunner', damage, patrolRoute = null }) {
    const charger = type === 'charger';
    const elite = type === 'elite';
    const bossInfo = BOSS_INFO[type];
    const boss = !!bossInfo;
    // ---- M3 新敌人 ----
    const drone = type === 'drone';        // 自爆无人机：飞行、无视地形、贴脸自爆
    const turret = type === 'turret';      // 炮台：固定、超远射程、瞄准线预警
    const support = type === 'support';    // 补给车：治疗光环、会逃跑
    const shield = type === 'shield';      // 重盾兵：正面减伤，绕后有戏

    const scale = boss ? (bossInfo.kind === 'breaker' ? 1.75 : 1.45)
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
      body: bodies.body,
      accent: bodies.accent,
      metal: bodies.metal,
      hp,
      speed: speed * speedMul,
      x,
      z,
      rotY: R.combat() * Math.PI * 2,
    });
    this.tank.group.scale.setScalar(scale);
    this.tank.radius = boss ? (bossInfo.kind === 'breaker' ? 2.5 : 2.1)
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
    this.selfDestruct = charger ? { damage: 16, radius: 4.6 }
      : drone ? { damage: 10, radius: 3.5 } : null;
    this.bossKind = bossInfo ? bossInfo.kind : null;
    this.bossName = bossInfo ? bossInfo.name : null;
    this.damage = damage ?? (boss ? (bossInfo.kind === 'breaker' ? 15 : 8)
      : turret ? 12 : shield ? 8 : drone ? 10 : elite ? 10 : support ? 0 : 7);
    this.baseScale = scale;
    this.camera = camera;

    // 补给车：治疗光环指示圈
    if (support) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(7.6, 8.0, 40),
        new THREE.MeshBasicMaterial({
          color: 0x57d877, transparent: true, opacity: 0.4,
          side: THREE.DoubleSide, depthWrite: false,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.07 / scale;
      this.tank.group.add(ring);
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
    this.blinkT = bossInfo?.kind === 'prism' ? 11 : Infinity;
    this.castT = 0;
    this.castKind = null;
    this.burst = 0;
    this.burstT = 0;
    this.coreT = R.combat() * 6;

    if (boss) {
      this.core = new THREE.Mesh(CORE_GEO, CORE_MATS[bossInfo.kind]);
      this.core.position.set(0, 0.72, -0.2);
      this.core.renderOrder = 5;
      this.tank.turret.add(this.core);
    }

    this.state = 'patrol';
    this.target = null;
    // 巡逻/驻军状态。没有路线就是猎杀队，沿用原来的追击 AI。
    // offset 用固定随机流，保证单机每局路线一致（方便复现问题）。
    this.patrol = patrolRoute ? createPatrolState(patrolRoute, () => R.stream('patrol')()) : null;
    // 挨打时叫醒自己和附近同伴。挂在 tank 上，子弹结算不必知道 Enemy。
    this.tank.onDamaged = () => this._onDamaged();
    this._ctx = null;
    this.fireCd = 1.2 + R.combat() * 1.6;
    this.spawnShield = 0.9;   // 出场保护，避免刚出生就被秒
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
  _onDamaged() {
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
    // 治疗光环
    this.healT -= dt;
    if (this.healT <= 0) {
      this.healT = 1.2;
      let healed = 0;
      for (const e of ctx.enemies) {
        if (e === this || !e.alive) continue;
        if (e.position.distanceTo(this.position) < 8 && e.tank.hp < e.tank.maxHp) {
          e.tank.hp = Math.min(e.tank.maxHp, e.tank.hp + 6);
          healed++;
        }
      }
      if (healed > 0) ctx.effects.explosion(this.position.clone().setY(1), 0x57d877, 6, 0.5);
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
      ctx.hud.showMessage(`${this.bossName} · 狂暴`, 1.3);
      ctx.effects.explosion(p.clone().setY(2), breaker ? 0xff6a2a : 0x6fe6ff, 26, 1.3);
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
    const near = breaker ? 13 : 17;
    const far = breaker ? 21 : 27;

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
    this.abilityT -= dt;
    if (this.abilityT <= 0) {
      this.abilityT = this.enraged ? 6.5 : 9;
      if (!breaker) {
        this.castKind = 'ring';
        this.castT = 0.95;
        ctx.hud.showMessage(`${this.bossName} · 折射风暴`, 1.15);
      }
    } else if (!breaker && this.blinkT > 0) {
      this.blinkT -= dt;
      if (this.blinkT <= 0) {
        this.blinkT = this.enraged ? 8 : 11;
        this._blink(ctx);
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

  /** 棱镜：跃迁到玩家周围的安全位置 */
  _blink(ctx) {
    const player = ctx.player.group.position;
    const world = ctx.world;
    const p = this.position;
    for (let i = 0; i < 24; i++) {
      const a = R.combat() * Math.PI * 2;
      const r = 17 + R.combat() * 7;
      const x = THREE.MathUtils.clamp(player.x + Math.sin(a) * r, -world.half + 6, world.half - 6);
      const z = THREE.MathUtils.clamp(player.z + Math.cos(a) * r, -world.half + 6, world.half - 6);
      if (world.blocked(x, z, 2.4)) continue;
      if (Math.hypot(x - player.x, z - player.z) < 15) continue;

      ctx.effects.explosion(p.clone().setY(1.4), 0x6fe6ff, 18, 1);
      p.set(x, 0, z);
      this.path = [];
      this.pathGoal.set(Infinity, 0, Infinity);
      this.repathT = 0;
      ctx.effects.explosion(p.clone().setY(1.4), 0x9ff4ff, 22, 1.15);
      ctx.hud.showMessage('棱镜 · 相位跃迁', 0.8);
      return;
    }
  }

  _updateBar() {
    if (!this.bar.visible) return;
    this.bar.lookAt(this.camera.position);
    const ratio = Math.max(0.001, this.tank.hp / this.tank.maxHp);
    this.fill.scale.x = ratio;
    this.fill.position.x = -(1 - ratio) * (BAR_W / 2);
  }
}
