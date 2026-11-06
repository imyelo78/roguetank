// 多人合作模式的渲染与交互（复用单机的模型与特效，不复制一套）
//
// 服务端负责"世界是什么样"，这里只负责"把它画出来 + 把键鼠翻译成意图"。
// 所有判定（谁中弹、谁倒地）都以服务端快照为准。
//
// 三个关键约定：
//   1. 与服务端一致：前进方向 = (sin yaw, cos yaw)，A/D 让 yaw 增大/减小。
//      这样预测不会和服务端"打架"，否则会表现成原地抖动。
//   2. 服务端的子弹有 id：新 id 建实体、消失即回收，不重复建。
//   3. 自己倒地时仍要渲染（躺倒的样子），但不再读输入。

import * as THREE from '../vendor/three.module.js';
import { Tank } from './Tank.js';
import { Bullet } from './Bullet.js';
import { createLevel, PLAYER_START } from './level.js';
import { Effects } from './Effects.js';
import { Sound } from './sound.js';
import { CHASSIS } from './chassis.js';
import { WEAPONS } from './weapons.js';
import { createStats } from './upgrades.js';
import { ENEMY_TYPES } from './core/world.js';
import { NetClient, predict } from './net.js';

const CAM_HEIGHT = 26;
const CAM_BACK = 31;

/** 敌人类型码 → 类型名（与服务端 ENEMY_TYPES 的键顺序一致） */
const TYPE_BY_CODE = Object.keys(ENEMY_TYPES);
const CODE_TO_TYPE = (c) => TYPE_BY_CODE[(c - 1)] || 'gunner';

const BULLET_COLOR = {
  player: { color: 0xfff3c4, glow: 0xffb03a },
  enemy: { color: 0xffd0c0, glow: 0xff4a3a },
};

export class CoopMode {
  constructor(game) {
    this.game = game;
    this.scene = null;
    this.net = null;
    this.active = false;

    this.tanks = new Map();     // id → Tank（含自己的）
    this.enemies = new Map();   // id → Tank（低细节）
    this.bullets = new Map();   // id → Bullet
    this.mates = new Map();     // id → { name, chassis }
    this.me = null;             // 预测用的本地状态
    this.myId = null;

    this.keys = new Set();
    this.firing = false;
    this.mouseNDC = new THREE.Vector2();
    this.aimRay = null;
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.aimPoint = new THREE.Vector3();

    this.camera = null;
    this.renderer = null;
    this.effects = null;
    this.sound = new Sound();

    this.stats = createStats();
    this.runTime = 0;
    this.wave = 1;
    this.score = 0;
    this.kills = 0;
    this.enemiesLeft = 0;
    this.teamScore = 0;

    this._shake = 0;
    this._aimMarker = null;
    this._bound = false;
    this._cd = 0;               // 本地射击冷却（只用于表现）
    this._bossId = null;
  }

  // ---------------- 生命周期 ----------------

  /** 服务端确认加入后进入战场 */
  enter(welcome) {
    this.exit();
    this.active = true;
    this.myId = welcome.you;
    this.net = this.game.net;
    this.code = welcome.code || this.net.room;

    this._initScene();
    this._buildMyTank(welcome);
    this._bindInput();

    this.runTime = 0;
    this.score = 0;
    this.kills = 0;
    this.teamScore = 0;

    const list = welcome.players || [];
    for (const p of list) this.mates.set(p.id, { name: p.name, chassis: p.chassis });

    // HUD：组队没有强化卡，把武器条固定成突击炮，玩家心里有数
    const w = WEAPONS.assault;
    this.game.hud.setWeapon({ icon: w.icon, name: w.name, tag: w.tag, uiColor: w.uiColor, heat: false });
    this.game.hud.setHeat(0, false, false);
    this.game.hud.setModifier({ icon: '👥', name: '多人合作', desc: `${list.length}/4 人 · 房间 ${this.code}` });

    this.game.hud.showMessage(`组队出击 · ${list.length}/4 人 · 房间 ${this.code}`, 3);
    this.sound.unlock();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this._unbindInput();

    for (const t of this.tanks.values()) t.dispose(this.scene);
    for (const t of this.enemies.values()) t.dispose(this.scene);
    for (const b of this.bullets.values()) b.destroy();
    this.tanks.clear();
    this.enemies.clear();
    this.bullets.clear();
    this.mates.clear();

    if (this._aimMarker && this.scene) this.scene.remove(this._aimMarker);
    this._aimMarker = null;
    this.scene = null;
    this.effects = null;
    this.net = null;
  }

  _initScene() {
    const g = this.game;
    this.renderer = g.renderer;
    this.camera = g.camera;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x172430);
    this.scene.fog = new THREE.Fog(0x172430, 95, 215);

    const hemi = new THREE.HemisphereLight(0xcfe4f5, 0x4a5240, 1.25);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3dd, 2.2);
    sun.position.set(46, 78, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -120;
    sun.shadow.camera.right = 120;
    sun.shadow.camera.top = 120;
    sun.shadow.camera.bottom = -120;
    sun.shadow.camera.far = 240;
    this.scene.add(sun);

    // 地图与单机完全同一份（同一个种子、同一套碰撞表），
    // 否则会出现"服务端没墙、你被卡在墙里"的鬼故事。
    this.world = createLevel(this.scene);
    this.effects = new Effects(this.scene);

    // 瞄准环
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.1, 1.5, 28),
      new THREE.MeshBasicMaterial({
        color: 0xffcf8a, transparent: true, opacity: 0.5,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    this.scene.add(ring);
    this._aimMarker = ring;

    this.aimRay = new THREE.Raycaster();
  }

  _buildMyTank(welcome) {
    const list = welcome.players || [];
    const mine = list.find((p) => p.id === this.myId);
    const ch = (mine && mine.chassis) || 'balanced';
    const c = CHASSIS[ch] || CHASSIS.balanced;
    const st = (welcome.world?.players || []).find((p) => p.id === this.myId);

    this.me = {
      id: this.myId,
      chassis: ch,
      x: st ? st.x : PLAYER_START.x,
      z: st ? st.z : PLAYER_START.z,
      yaw: st ? st.yaw : Math.PI,
      turretYaw: st ? st.turretYaw : Math.PI,
      speed: 0,
      hp: st ? st.hp : c.hp,
      maxHp: st ? st.maxHp : c.hp,
      down: false,
      alive: true,
      speedBase: c.speed,
      turnBase: ch === 'light' ? 3.6 : ch === 'heavy' ? 2.4 : 3.0,
    };

    const tank = new Tank(this.scene, {
      team: 'player',
      chassis: ch,
      detail: 'high',
      hp: this.me.maxHp,
      speed: c.speed,
      x: this.me.x,
      z: this.me.z,
      rotY: this.me.yaw,
    });
    this.tanks.set(this.myId, tank);

    // 队友
    for (const p of list) {
      if (p.id === this.myId) continue;
      this._addMate(p, (welcome.world?.players || []).find((q) => q.id === p.id));
    }
    // 敌人（中途加入时世界已经有敌人）
    for (const e of welcome.world?.enemies || []) {
      this._upsertEnemy(e.id, e.type, e.x, e.z, e.yaw);
    }

    this.camera.position.set(this.me.x, CAM_HEIGHT, this.me.z + CAM_BACK);
    this.game.camLook?.set?.(this.me.x, 1, this.me.z);

    // 最后再切成"战斗中"：上面任何一步抛错都不该让房间码消失，
    // 而且这一步会隐藏大厅，必须放在稳定之后。
    this._ready = true;
    this.game.hud.showRoomChip(this.code, list.length);
    this.game.hud.startPlaying();
  }

  _addMate(p, st) {
    if (this.tanks.has(p.id)) return;
    const c = CHASSIS[p.chassis] || CHASSIS.balanced;
    const t = new Tank(this.scene, {
      team: 'player',
      chassis: p.chassis || 'balanced',
      detail: 'low',
      hp: c.hp,
      speed: c.speed,
      x: st ? st.x : 0,
      z: st ? st.z : 0,
      rotY: st ? st.yaw : Math.PI,
    });
    this.tanks.set(p.id, t);

    // 头顶名牌（倒地时隐藏，避免看起来还活着）
    const label = makeLabel(p.name);
    label.position.y = 4.6;
    t.group.add(label);
  }

  _upsertEnemy(id, type, x, z, yaw) {
    let t = this.enemies.get(id);
    if (t) return t;
    const tpl = ENEMY_TYPES[type] || ENEMY_TYPES.gunner;
    t = new Tank(this.scene, {
      team: 'enemy',
      detail: 'low',
      hp: tpl.hp === 1 ? 100 : 100,
      speed: tpl.speed * 8.5,
      x,
      z,
      rotY: yaw || 0,
    });
    t.group.scale.setScalar(tpl.scale || 1);
    this.enemies.set(id, t);
    return t;
  }

  // ---------------- 输入 ----------------

  _bindInput() {
    if (this._bound) return;
    this._bound = true;

    this._onKeyDown = (e) => {
      if (isTyping(e)) return;
      if (this.game.hud.lobby && !this.game.hud.lobby.classList.contains('hidden')) return;
      if (e.code === 'Escape') {
        // Esc 由 Game 统一处理（关大厅 / 退出组队），这里不重复
        return;
      }
      this.keys.add(e.code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onMouseMove = (e) => {
      const el = this.renderer.domElement;
      const r = el.getBoundingClientRect();
      this.mouseNDC.x = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
      this.mouseNDC.y = -((e.clientY - r.top) / Math.max(1, r.height)) * 2 + 1;
      this.game.hud.moveCrosshair(e.clientX, e.clientY);
    };
    this._onMouseDown = (e) => {
      if (e.button === 0) this.firing = true;
    };
    this._onMouseUp = () => { this.firing = false; };
    this._onBlur = () => { this.keys.clear(); this.firing = false; };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('blur', this._onBlur);
  }

  _unbindInput() {
    if (!this._bound) return;
    this._bound = false;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('blur', this._onBlur);
  }

  _readInput() {
    const k = this.keys;
    const canDrive = this.me.alive && !this.me.down;

    const fwd = canDrive ? (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) : 0;
    // 与服务端同向：A → 左转（yaw 增大），D → 右转
    const turn = canDrive ? (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) - (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) : 0;

    // 鼠标 → 世界瞄准点（相机是固定的俯视角，地面平面 y=0）
    this.aimRay.setFromCamera(this.mouseNDC, this.camera);
    const hit = new THREE.Vector3();
    let hasAim = false;
    if (this.aimRay.ray.intersectPlane(this.groundPlane, hit)) {
      this.aimPoint.copy(hit);
      hasAim = true;
    }

    return {
      forward: fwd,
      turn,
      aimX: hasAim ? this.aimPoint.x : this.me.x,
      aimZ: hasAim ? this.aimPoint.z : this.me.z - 10,
      fire: canDrive && (this.firing || k.has('Space')),
    };
  }

  // ---------------- 主循环 ----------------

  update(dt) {
    if (!this.active) return;
    const input = this._readInput();

    // 发意图给服务端
    this.net?.tick(input);

    // 本地预测自己的坦克（跟手的关键）
    if (this.me.alive && !this.me.down) {
      const bx = this.me.x;
      const bz = this.me.z;
      predict(this.me, input, dt);
      // 预测阶段只做"墙体阻挡 + 边界钳制"，真正的判定以服务端为准
      const r = 1.9;
      this.me.x = Math.max(-100 + r, Math.min(100 - r, this.me.x));
      this.me.z = Math.max(-100 + r, Math.min(100 - r, this.me.z));
      if (this.world.blocked(this.me.x, this.me.z, r)) {
        // 单轴回退：贴墙还能滑行
        if (!this.world.blocked(this.me.x, bz, r)) this.me.z = bz;
        else if (!this.world.blocked(bx, this.me.z, r)) this.me.x = bx;
        else { this.me.x = bx; this.me.z = bz; this.me.speed *= 0.3; }
      }
      // 炮塔朝鼠标（本地只做表现，服务端有自己的转速限制）
      const want = Math.atan2(input.aimX - this.me.x, input.aimZ - this.me.z);
      let d = want - this.me.turretYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.me.turretYaw += Math.sign(d) * Math.min(Math.abs(d), 10 * dt);
    }

    // 服务端快照 → 队友 / 敌人 / 子弹
    this._applySnapshot();

    // 自己：柔和校正到服务端位置
    this._reconcile(dt);

    // 相机跟随
    this._updateCamera(dt);

    this.runTime += dt;
    this.effects.update(dt);

    // 射击冷却（只用于 HUD 进度条）
    this._cd = Math.max(0, this._cd - dt);
    this.game.hud.setReload(1 - this._cd / 0.4);

    this.game.hud.setHealth(this.me.hp, this.me.maxHp);
    this.game.hud.setWave(this.wave);
    this.game.hud.setLeft(this.enemiesLeft);
    this.game.hud.setScore(this.score);
    this.game.hud.setKills(this.kills);
    this._syncBoss();

    this.renderer.render(this.scene, this.camera);
  }

  _applySnapshot() {
    const s = this.net?.sample();
    if (!s) return;

    this.wave = s.wave || 1;
    this.enemiesLeft = Math.max(0, s.left || 0);

    // ---- 玩家 ----
    const present = new Set();
    for (const p of s.players) {
      present.add(p.id);
      if (p.id === this.myId) {
        this.me.hp = Math.round((p.hp / 100) * this.me.maxHp);
        this.me.down = !!p.down;
        continue;
      }
      let t = this.tanks.get(p.id);
      if (!t) {
        const meta = (this.net.players || []).find((q) => q.id === p.id);
        if (!meta) continue;
        this._addMate(meta, p);
        t = this.tanks.get(p.id);
        if (!t) continue;
      }
      // 倒地：躺平 + 冒烟，比"突然消失"清楚得多
      t.group.position.set(p.x, p.down ? 0.35 : 0, p.z);
      t.group.rotation.y = p.yaw;
      t.group.rotation.z = p.down ? 0.5 : 0;
      t.setAim(p.turretYaw);
      const label = t.group.getObjectByName('nameplate');
      if (label) label.visible = !p.down;
    }

    // 有人退出：快照里不再出现他，残留的坦克必须一起收掉，
    // 否则走掉的人会在队友屏幕上继续"停"在那里（而且还会被当成活人救）。
    for (const [id, t] of this.tanks) {
      if (id === this.myId || present.has(id)) continue;
      t.dispose(this.scene);
      this.tanks.delete(id);
      this.mates.delete(id);
    }

    // ---- 敌人 ----
    const alive = new Set();
    for (const e of s.enemies) {
      alive.add(e.id);
      const t = this._upsertEnemy(e.id, CODE_TO_TYPE(e.typeCode), e.x, e.z, e.yaw);
      // 快照是 15Hz 插值出来的，位置已经平滑，直接贴
      t.group.position.set(e.x, 0, e.z);
      t.group.rotation.y = e.yaw;
      t.setAim(e.turretYaw);
    }
    for (const [id, t] of this.enemies) {
      if (!alive.has(id)) {
        t.dispose(this.scene);
        this.enemies.delete(id);
      }
    }

    // ---- 子弹：按 id 增量同步 ----
    const live = new Set();
    for (const b of s.bullets || []) {
      live.add(b.id);
      let bullet = this.bullets.get(b.id);
      const side = b.team === 1 ? 'enemy' : 'player';
      if (!bullet) {
        const col = BULLET_COLOR[side];
        bullet = new Bullet(this.scene, {
          pos: new THREE.Vector3(b.x, 1.15, b.z),
          dir: new THREE.Vector3(Math.sin(b.yaw), 0, Math.cos(b.yaw)),
          team: side,
          speed: 0,
          life: 3,
          color: col.color,
          glow: col.glow,
        });
        this.bullets.set(b.id, bullet);
      }
      bullet.pos.set(b.x, 1.15, b.z);
      bullet.mesh.position.copy(bullet.pos);
    }
    for (const [id, bullet] of this.bullets) {
      if (!live.has(id)) {
        bullet.destroy();
        this.bullets.delete(id);
      }
    }

    // ---- 分数：按 players 顺序对应 sc 数组 ----
    const list = s.players || [];
    let team = 0;
    for (let i = 0; i < list.length; i++) {
      const v = (s.scores || [])[i] || 0;
      team += v;
      if (list[i].id === this.myId) this.score = v;
    }
    this.teamScore = team;
  }

  _reconcile(dt) {
    const s = this.net?.lastSnap;
    if (!s) return;
    const p = (s.players || []).find((q) => q.id === this.myId);
    if (!p) return;

    const dx = p.x - this.me.x;
    const dz = p.z - this.me.z;
    const dist = Math.hypot(dx, dz);

    // 偏差小于 4 米时软拉回；超过（被撞 / 复活 / 传送）直接归位
    if (dist > 4) {
      this.me.x = p.x;
      this.me.z = p.z;
      this.me.yaw = p.yaw;
    } else if (dist > 0.02) {
      const k = Math.min(1, dt * 7);
      this.me.x += dx * k;
      this.me.z += dz * k;
    }

    const t = this.tanks.get(this.myId);
    if (t) {
      t.group.position.set(this.me.x, this.me.down ? 0.35 : 0, this.me.z);
      t.group.rotation.y = this.me.yaw;
      t.group.rotation.z = this.me.down ? 0.5 : 0;
      t.setAim(this.me.turretYaw);
    }
  }

  _updateCamera(dt) {
    const cam = this.camera;
    const k = Math.min(1, dt * 6);
    cam.position.x += (this.me.x - cam.position.x) * k;
    cam.position.z += (this.me.z + CAM_BACK - cam.position.z) * k;
    cam.position.y = CAM_HEIGHT;

    // 开炮后座
    if (this._shake > 0) {
      cam.position.x += (Math.random() - 0.5) * this._shake;
      cam.position.y += (Math.random() - 0.5) * this._shake;
      this._shake = Math.max(0, this._shake - dt * 1.2);
    }

    this.game.camLook.set(this.me.x, 1, this.me.z);
    cam.lookAt(this.game.camLook);
    this._aimMarker.position.set(this.aimPoint.x, 0.06, this.aimPoint.z);
  }

  /** BOSS 血条：服务端只给 hp 比例，名字按类型码认 */
  _syncBoss() {
    const s = this.net?.lastSnap;
    if (!s) return;
    let boss = null;
    for (const e of s.enemies || []) {
      const type = CODE_TO_TYPE(e.typeCode);
      if (type.startsWith('boss')) { boss = { e, type }; break; }
    }
    if (!boss) {
      if (this._bossId !== null) {
        this.game.hud.hideBossBar();
        this._bossId = null;
      }
      return;
    }
    this._bossId = boss.e.id;
    const name = boss.type === 'boss_breaker' ? '破城者' : '棱镜之眼';
    this.game.hud.showBossBar(name, boss.type, boss.e.hp, 100, boss.e.hp < 40);
  }

  /** 服务端事件 → 表现（音效、爆炸、飘字） */
  onEvents(list) {
    if (!this.active) return;
    for (const e of list) {
      switch (e.kind) {
        case 'shot':
          if (e.id === this.myId) {
            this.sound.shoot('player');
            this._cd = 0.4;
            this._shake = Math.max(this._shake, 0.14);
            const t = this.tanks.get(this.myId);
            t?.recoil?.();
          } else {
            // 队友开炮：只做后座表现，不叠音效（4 人齐射会吵成一片）
            this.tanks.get(e.id)?.recoil?.();
          }
          break;
        case 'kill': {
          this.effects.explosion(new THREE.Vector3(e.x, 1.1, e.z), e.boss ? 0xff8a3d : 0xffb06a, e.boss ? 46 : 14, e.boss ? 1.8 : 1);
          this.sound.explosion(e.boss ? 1.4 : 0.8);
          if (e.by === this.myId) this.kills += 1;
          break;
        }
        case 'hurt':
          if (e.id === this.myId) {
            this.game.hud.hurt();
            this.sound.hurt();
          }
          break;
        case 'down':
          this.sound.hurt();
          if (e.id === this.myId) {
            this.game.hud.showMessage('你被击毁 · 等待队友救援（30 秒）', 3);
          } else {
            const p = (this.net.players || []).find((q) => q.id === e.id);
            this.game.hud.showMessage(`${p ? p.name : '队友'} 倒地 · 靠近 3 秒可拉起`, 2.4);
          }
          break;
        case 'revive':
          if (e.id === this.myId) this.game.hud.showMessage('已恢复作战', 2);
          else this.game.hud.showMessage('队友已被救起', 1.4);
          break;
        case 'wave':
          this.game.hud.showMessage(e.boss ? `第 ${e.wave} 波 · BOSS 来袭` : `第 ${e.wave} 波 来袭`, 1.8);
          break;
        case 'cleared':
          this.game.hud.showMessage(`第 ${e.wave} 波清除 · 全员补血`, 1.6);
          break;
        case 'boom':
          this.effects.explosion(new THREE.Vector3(e.x, 1, e.z), 0xff5a2a, 18, 1);
          this.sound.explosion(1.2);
          break;
        case 'join':
          if (e.id !== this.myId) this.game.hud.showMessage(`${e.name || '队友'} 加入了战斗`, 2);
          break;
        case 'leave':
          if (e.id !== this.myId) this.game.hud.showMessage('一名队友离开了', 2);
          break;
        default:
          break;
      }
    }
  }
}

// ---------------- 小工具 ----------------

function isTyping(e) {
  const t = e.target;
  if (!t) return false;
  const tag = (t.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable || e.isComposing;
}

/** 头顶名牌：用 canvas 画字，避免引入字体资源 */
function makeLabel(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  g.fillStyle = 'rgba(10,14,18,.72)';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#ffcf8a';
  g.font = 'bold 34px "PingFang SC", "Microsoft YaHei", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(text).slice(0, 8), 128, 34);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.name = 'nameplate';
  sp.scale.set(5, 1.25, 1);
  return sp;
}
