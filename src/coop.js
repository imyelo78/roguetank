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
import { createLevel, PLAYER_START, HALF } from './level.js';
import { Effects } from './Effects.js';
import { Sound } from './sound.js';
import { CHASSIS } from './chassis.js';
import { WEAPONS } from './weapons.js';
import { createStats } from './upgrades.js';
import { ENEMY_TYPES } from './core/world.js';
import { aimTurret, angleDiff, lerpAngle } from './core/motion.js';
import { NetClient, predict, TICK_RATE } from './net.js';

/** 服务端的模拟步长。预测必须按这个节奏走，不能按渲染帧（见 update） */
const TICK_DT = 1 / TICK_RATE;

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

    // 预测 / 校正相关的内部状态
    this._predAcc = 0;                                  // 预测累加器（见 update）
    this._shift = { x: 0, z: 0 };                       // 待消化的位置残差
    this._prevPos = null;                               // 渲染插值用
    this._disp = { x: 0, z: 0, yaw: 0 };                // 本帧画在哪
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

    // 初始化渲染插值与残差状态，避免第一帧画在原点
    this._prevPos = { x: this.me.x, z: this.me.z, yaw: this.me.yaw };
    this._disp = { x: this.me.x, z: this.me.z, yaw: this.me.yaw };
    this._shift = { x: 0, z: 0 };
    this._predAcc = 0;

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
      // 预测必须按服务端 tick 走，不能按渲染帧走。
      // 服务端固定 30Hz 推进，60fps 下如果每帧都 predict 一次，
      // 本地就比权威模拟快一倍——车头会不断"跑过头"，被 _reconcile 拽回来，
      // 表现就是"操作有粘滞感"。这里用累加器把 dt 切成一格一格 1/30 秒。
      // 运动学本身来自 core/motion.js，与服务端逐帧完全一致（有测试钉着）。
      this._predAcc = (this._predAcc || 0) + dt;
      let guard = 0;
      while (this._predAcc >= TICK_DT && guard++ < 8) {
        this._predAcc -= TICK_DT;
        predict(this.me, input, TICK_DT, this.world, HALF);
      }
      // 炮塔朝鼠标（本地只做表现，服务端有自己的转速限制）
      aimTurret(this.me, input.aimX, input.aimZ, dt, 10);
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

    // 位置：不硬拽，交给 _absorbResidual 慢慢消化
    this._absorbResidual(dt, p);

    // 朝向校正：偏差超过 0.35 弧度（约 20°）才拉，且每秒最多追 3 弧度。
    // 本地预测出来的 yaw 只要没被墙挡，通常和服务端只差几个 tick 的量，
    // 完全不需要校正；一旦真的偏了（比如被人顶开），再慢慢对上去。
    const yawErr = angleDiff(p.yaw, this.me.yaw);
    if (Math.abs(yawErr) > 2.2) {
      // 兜底：差得多半是复活 / 重生传送，直接对齐，不然会永远朝着老方向跑
      this.me.yaw = p.yaw;
      this.me.speed = 0;
    } else if (Math.abs(yawErr) > 0.35) {
      this.me.yaw += yawErr * (1 - Math.exp(-3 * dt));
    }

    // 画出来的位置：在"上一 tick"和"这一 tick"之间按剩余时间插值。
    // 逻辑位置本身就是 30Hz 网格，直接贴到 mesh 上，60fps 下每两帧才动一次，
    // 看起来就是"一卡一卡的"。插值只影响观感，不参与任何判定。
    const a = Math.max(0, Math.min(1, (this._predAcc || 0) / TICK_DT));
    if (!this._prevPos) this._prevPos = { x: this.me.x, z: this.me.z, yaw: this.me.yaw };
    if (Math.hypot(this.me.x - this._prevPos.x, this.me.z - this._prevPos.z) > 3) {
      // 刚被归位 / 复活，不插值，否则会看到一道"冲刺"
      this._prevPos.x = this.me.x;
      this._prevPos.z = this.me.z;
      this._prevPos.yaw = this.me.yaw;
    }
    this._prevPos.x += (this.me.x - this._prevPos.x) * a;
    this._prevPos.z += (this.me.z - this._prevPos.z) * a;
    this._prevPos.yaw = lerpAngle(this._prevPos.yaw, this.me.yaw, a);
    this._disp.x = this._prevPos.x;
    this._disp.z = this._prevPos.z;
    this._disp.yaw = this._prevPos.yaw;

    const t = this.tanks.get(this.myId);
    if (t) {
      t.group.position.set(this._disp.x, this.me.down ? 0.35 : 0, this._disp.z);
      t.group.rotation.y = this._disp.yaw;
      t.group.rotation.z = this.me.down ? 0.5 : 0;
      t.setAim(this.me.turretYaw);
    }
  }

  /**
   * 消化"权威位置 - 本地预测"的残差。
   *
   * 残差永远存在：服务端按 30Hz 网格推进，快照 20Hz 才发一次，
   * 客户端必然领先 0~1.5 个 tick。以前的做法是在渲染帧里直接把位置往
   * 权威值拽 7*dt，等于每帧都往后拽一点、下一帧又被预测推回来——
   * 车看起来"一直在打滑"，也就是用户说的"迟钝"。
   *
   * 现在把残差记进 _shift，每帧只消化一小口，并且优先在"停车/撞墙"这类
   * 没人会注意的时刻消化完；行驶中则只消化一半，剩下的靠预测自己收敛。
   */
  _absorbResidual(dt, snapPos) {
    if (!snapPos) return;
    this._shift.x += snapPos.x - this.me.x;
    this._shift.z += snapPos.z - this.me.z;

    const mag = Math.hypot(this._shift.x, this._shift.z);
    if (mag < 1e-4) { this._shift.x = 0; this._shift.z = 0; return; }

    // 偏差过大（被撞飞 / 复活 / 传送）不磨，直接归位
    if (mag > 3) {
      this.me.x += this._shift.x;
      this.me.z += this._shift.z;
      this._shift.x = 0;
      this._shift.z = 0;
      return;
    }

    // 静止时整口吞掉（完全看不出来），行驶中每帧只吃 8%
    const rate = Math.abs(this.me.speed) < 1 ? 1 : 1 - Math.exp(-8 * dt);
    const take = mag * rate;
    const ux = this._shift.x / mag;
    const uz = this._shift.z / mag;
    this.me.x += ux * take;
    this.me.z += uz * take;
    this._shift.x -= ux * take;
    this._shift.z -= uz * take;
  }

  _updateCamera(dt) {
    const cam = this.camera;
    // 相机跟手要"稳"而不是"快"：用固定时间常数做指数趋近，
    // 这样 30fps 和 120fps 的跟手感受一致。
    // 原来写死 dt*6，等于每帧追 6*n 的比例——帧率一掉（三人同屏 + 阴影）
    // 相机就明显落后，人会觉得"车动了但画面半天才跟上"，也就是"反应迟钝"。
    const k = 1 - Math.exp(-7.5 * dt);
    // 跟随"画出来的位置"（_disp，已做 tick 插值），相机和车体才不会互相拉锯
    cam.position.x += (this._disp.x - cam.position.x) * k;
    cam.position.z += (this._disp.z + CAM_BACK - cam.position.z) * k;
    cam.position.y = CAM_HEIGHT;

    // 开炮后座
    if (this._shake > 0) {
      cam.position.x += (Math.random() - 0.5) * this._shake;
      cam.position.y += (Math.random() - 0.5) * this._shake;
      this._shake = Math.max(0, this._shake - dt * 1.2);
    }

    this.game.camLook.set(this._disp.x, 1, this._disp.z);
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
