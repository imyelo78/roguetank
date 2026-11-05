import * as THREE from '../vendor/three.module.js';
import { Tank } from './Tank.js';

const BAR_W = 2.24;
const LOS_INTERVAL = 0.2;

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
  constructor(scene, { x, z, hp = 60, speed = 9, camera, type = 'gunner', damage }) {
    const charger = type === 'charger';
    const elite = type === 'elite';
    const bossInfo = BOSS_INFO[type];
    const boss = !!bossInfo;
    const scale = boss ? (bossInfo.kind === 'breaker' ? 1.75 : 1.45)
      : charger ? 0.85 : elite ? 1.18 : 1;
    const speedMul = charger ? 1.25 : elite ? 0.85 : 1;
    const bodies = boss
      ? (bossInfo.kind === 'breaker'
        ? { body: 0x7d3a2c, accent: 0x4a1e16, metal: 0x2a2220 }
        : { body: 0x2f6f86, accent: 0x1d4354, metal: 0x223038 })
      : elite
        ? { body: 0xc0963a, accent: 0x6d5018, metal: 0x332b28 }
        : { body: charger ? 0xc25a20 : 0xa8483a, accent: charger ? 0x6d2a0e : 0x5e2318, metal: charger ? 0x2b2522 : 0x332b28 };

    this.tank = new Tank(scene, {
      team: 'enemy',
      body: bodies.body,
      accent: bodies.accent,
      metal: bodies.metal,
      hp,
      speed: speed * speedMul,
      x,
      z,
      rotY: Math.random() * Math.PI * 2,
    });
    this.tank.group.scale.setScalar(scale);
    this.tank.radius = boss ? (bossInfo.kind === 'breaker' ? 2.5 : 2.1) : elite ? 1.65 : 1.45;

    this.type = type;
    this.charger = charger;
    this.isBoss = boss;
    this.isElite = elite;
    this.bossKind = bossInfo ? bossInfo.kind : null;
    this.bossName = bossInfo ? bossInfo.name : null;
    this.damage = damage ?? (boss ? (bossInfo.kind === 'breaker' ? 15 : 8) : elite ? 10 : 7);
    this.baseScale = scale;
    this.camera = camera;

    // ---- Boss 专属状态 ----
    this.enraged = false;
    this.abilityT = boss ? (bossInfo.kind === 'breaker' ? 7 : 6) : Infinity;
    this.blinkT = bossInfo?.kind === 'prism' ? 11 : Infinity;
    this.castT = 0;
    this.castKind = null;
    this.burst = 0;
    this.burstT = 0;
    this.coreT = Math.random() * 6;

    if (boss) {
      this.core = new THREE.Mesh(CORE_GEO, CORE_MATS[bossInfo.kind]);
      this.core.position.set(0, 0.72, -0.2);
      this.core.renderOrder = 5;
      this.tank.turret.add(this.core);
    }

    this.state = 'patrol';
    this.target = null;
    this.fireCd = 1.2 + Math.random() * 1.6;
    this.spawnShield = 0.9;   // 出场保护，避免刚出生就被秒
    this.stuckT = 0;          // 卡住计时
    this.avoidT = 0;          // 脱困方向剩余时间
    this.avoidDir = new THREE.Vector3(0, 0, 1);
    this.strafe = Math.random() > 0.5 ? 1 : -1;

    // 视线：每 0.2s 采样一次，避免每帧做线段检测
    this.los = false;
    this.losTimer = Math.random() * LOS_INTERVAL;
    this.noLosT = 0;

    // 寻路
    this.path = [];
    this.pathGoal = new THREE.Vector3(Infinity, 0, Infinity);
    this.repathT = Math.random() * 0.5;
    this.flankSide = Math.random() > 0.5 ? 1 : -1;
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
    const base = playerYaw + Math.PI + this.flankSide * (0.55 + Math.random() * 0.6);
    for (let i = 0; i < 9; i++) {
      const a = base + (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 0.42;
      const r = 11 + Math.random() * 6;
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
      const a = Math.random() * Math.PI * 2;
      const r = 10 + Math.random() * 5;
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
      this.repathT = 0.8 + Math.random() * 0.4;
      this.pathGoal.set(tx, 0, tz);
      if (nav && !nav.clearWalk(p.x, p.z, tx, tz, 1.55)) {
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
      const side = Math.random() > 0.5 ? 1 : -1;
      const a = Math.atan2(tx - p.x, tz - p.z) + side * Math.PI / 2;
      this.avoidDir.set(Math.sin(a), 0, Math.cos(a));
    }

    return advanced;
  }

  update(dt, ctx) {
    const tank = this.tank;
    if (!tank.alive) return;

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

    // ---- 状态机 ----
    if (this.charger) {
      this.state = this.los ? 'chase' : 'flank';
    } else if (dist < 16 && this.los) this.state = 'attack';
    else if (dist > 58 && this.noLosT > 2) this.state = 'patrol';
    else if (this.los) this.state = 'chase';
    else this.state = 'flank';

    // ---- 移动 ----
    let aimYaw = Math.atan2(dx, dz);
    if (this.state === 'patrol') {
      if (!this.target || Math.hypot(this.target.x - p.x, this.target.z - p.z) < 3) {
        const a = aimYaw + (Math.random() - 0.5) * 1.1;
        const r = 10 + Math.random() * 16;
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
        this.flankT = 1.8 + Math.random() * 1.2;
        this.flankGoal = this._pickFlankGoal(world, player, ctx.player.turretYaw).clone();
      }
      this._navigate(dt, ctx, this.flankGoal.x, this.flankGoal.z, 1);
      aimYaw = Math.atan2(this.flankGoal.x - p.x, this.flankGoal.z - p.z);
    }

    // ---- 冲锋兵：贴脸自爆 ----
    if (this.charger) {
      if (dist < 4.6 && this.los && this.spawnShield <= 0) {
        ctx.chargerBurst(this, 16, 5);
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
        ? 1.35 + Math.random() * 0.7
        : 1.8 + Math.random() * 1.1;
      const dir = new THREE.Vector3(dx, 0, dz).normalize();
      dir.x += (Math.random() - 0.5) * 0.13;
      dir.z += (Math.random() - 0.5) * 0.13;
      dir.normalize();
      ctx.fire(tank, dir, this.damage, 'enemy');
    }

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
    if (!this.los || dist > far) {
      this._navigate(dt, ctx, player.x, player.z, 0.72);
    } else if (dist < near) {
      this._navigate(dt, ctx, p.x - dx / dist * 12, p.z - dz / dist * 12, 0.5);
    } else {
      const a = aimYaw + this.strafe * Math.PI / 2;
      this._navigate(dt, ctx, p.x + Math.sin(a) * 8, p.z + Math.cos(a) * 8, 0.42);
    }

    const aimErr = tank.aimTowards(aimYaw, dt, 4.5);

    // 主武器
    if (this.los && this.fireCd <= 0 && this.spawnShield <= 0 && aimErr < 0.2) {
      if (breaker) {
        this.fireCd = this.enraged ? 2.3 : 3.2;
        const base = Math.atan2(dx, dz);
        for (const off of [-0.08, 0, 0.08]) {
          const a = base + off;
          ctx.fire(tank, new THREE.Vector3(Math.sin(a), 0, Math.cos(a)), this.damage, 'enemy', {
            speed: 44, color: 0xffc9a0, glow: 0xff5a2a, scale: 1.45,
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
        const base = Math.atan2(dx, dz);
        const a = base + (Math.random() - 0.5) * 0.05;
        ctx.fire(tank, new THREE.Vector3(Math.sin(a), 0, Math.cos(a)), this.damage, 'enemy', {
          speed: 66, color: 0x9ff4ff, glow: 0x38d8ff, scale: 0.85,
        });
      }
    }

    // 技能计时
    this.abilityT -= dt;
    if (this.abilityT <= 0) {
      this.abilityT = breaker ? (this.enraged ? 7.5 : 10.5) : (this.enraged ? 6.5 : 9);
      this.castKind = breaker ? 'strike' : 'ring';
      this.castT = breaker ? 1.2 : 0.95;
      ctx.hud.showMessage(
        breaker ? `${this.bossName} · 攻城炮击锁定` : `${this.bossName} · 折射风暴`,
        1.15
      );
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
    const breaker = this.bossKind === 'breaker';
    const count = breaker ? (this.enraged ? 4 : 3) : (this.enraged ? 16 : 12);
    if (breaker) {
      ctx.bossStrike(this, count);
    } else {
      const base = Math.random() * Math.PI * 2;
      const dmg = Math.max(7, this.damage);
      for (let i = 0; i < count; i++) {
        const a = base + (i / count) * Math.PI * 2;
        ctx.fire(this.tank, new THREE.Vector3(Math.sin(a), 0, Math.cos(a)), dmg, 'enemy', {
          speed: 50, color: 0xbff6ff, glow: 0x38d8ff, scale: 1.05,
        });
      }
      ctx.shake = Math.max(ctx.shake, 0.2);
    }
    this.castKind = null;
    this.castT = 0;
  }

  /** 棱镜：跃迁到玩家周围的安全位置 */
  _blink(ctx) {
    const player = ctx.player.group.position;
    const world = ctx.world;
    const p = this.position;
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 17 + Math.random() * 7;
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
