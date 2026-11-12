// 多人合作模式的渲染与交互（复用单机的模型与特效，不复制一套）
//
// 服务端负责"世界是什么样"，这里只负责"把它画出来 + 把键鼠翻译成意图"。
// 所有判定（谁中弹、谁倒地）都以服务端快照为准。
//
// 三个关键约定：
//   1. 与服务端一致：WASD 是八方向平移（世界坐标 mx/mz），车体以 8 rad/s 追移动方向。
//      与单机 Game.js + Tank.move 同一套模型——单机是横移，联机就不能是方向盘，
//      否则同一个玩家进房后会觉得"左右键坏了、车开不动"。
//   2. 服务端的子弹有 id：新 id 建实体、消失即回收，不重复建。
//   3. 自己倒地时仍要渲染（躺倒的样子），但不再读输入。

import * as THREE from '../vendor/three.module.js';
import { Tank } from './Tank.js';
import { Bullet } from './Bullet.js';
import { createLevel, PLAYER_START, HALF } from './level.js';
import { Effects } from './Effects.js';
import { Sound } from './sound.js';
import { CHASSIS, CHASSIS_TABLE, normalizeChassisId } from './chassis.js';
import { SELF_SKIN, MATE_SKIN, enemySkin } from './teams.js';
import { followStep, validateFollow } from './core/camera.js';
import { WEAPONS } from './weapons.js';
import { createStats } from './upgrades.js';
import { ENEMY_TYPES } from './core/world.js';
import { aimTurret, angleDiff } from './core/motion.js';
import { createNav } from './nav.js';
import { NetClient, predict, TICK_RATE } from './net.js';
import { buildTerrain, TERRAIN } from './core/terrain.js';
import { NetDebug } from './debug.js';

/** 服务端的模拟步长。预测必须按这个节奏走，不能按渲染帧（见 update） */
const TICK_DT = 1 / TICK_RATE;

const CAM_HEIGHT = 26;
const CAM_BACK = 31;

/**
 * 残差追赶速度（米/秒）。
 *
 * 服务端 30Hz 推进、客户端同样 30Hz 预测，两者"应该"同速，残差只来自
 * 快照时刻的 quantization。追赶速度只要略大于网络抖动带来的偏差就够了；
 * 给太大（比如每帧 8%）会在两帧快照之间冲过头，下一帧又要往回走——
 * 就是"整个场景在抖"。1.2 米/秒 ≈ 每 tick 4 cm，比车身抖动阈值低一档。
 */
const CATCHUP_PER_SEC = 1.2;

/**
 * 残差死区（米）：小于它就不追，否则会追过头再往回走。
 *
 * 0.3 米是从"转向"这个最常见的场景倒推出来的：服务端位置天然落后一个
 * tick（0.5 米），客户端已经转向了，这个落后的位移在新速度方向上就有一段
 * 横向分量。取 6cm/12cm 的死区都挡不住它，于是每帧横推 2cm、方向还随速度
 * 转——玩家看到的是"车一开动就左右摆"。0.3 米把这类正常滞后全部吃掉，
 * 只剩真正的错位（撞墙分叉）才校正。0.3 米在 4 米车身上看不出来。
 */
const RESIDUAL_DEADZONE = 0.3;

/**
 * 逻辑位置离最新权威快照的硬上限（米），见 `_clampToSnap`。
 *
 * 这是唯一一条"硬"的位置约束。其它地方（残差消化）都是软的、有死区的，
 * 因为软约束偶尔收不住就会积累成"车飘出去"；有了这条天花板，无论 `_vel`
 * 怎么偏、不管一帧补了几格，画面位置最多领先 1.2 米，一定能被拉回来。
 */
const HARD_CAP = 1.2;

/**
 * 单帧校正位移上限（米/秒）。
 *
 * 管的是"软追赶 + `_clampToSnap` 硬贴"叠在一帧里的**总**位移。
 * 这两条路径以前各管各的：软追赶有 1.2 m/s 上限，硬贴没有，
 * 于是一帧里能走出十几厘米 —— 观感就是"车被推了一下"。
 *
 * 取值：0.55 m/s。实测（test/idle.test.mjs，偏差 2 米）
 *   30fps 11.8cm/帧、60fps 5.9cm/帧、144fps 2.5cm/帧，0.45 秒收敛到死区。
 * 之所以定得比 `CATCHUP_PER_SEC`（1.2 m/s）还小：硬贴之后 `_shift` 会被
 * 清空，下一帧软追赶的 2cm 又叠进来，两者共用同一个预算。按 60fps 5.9cm
 * 算，差不多是一辆车身长（4.5 米）的 1.3%，眼睛看不出来；
 * 再往上（试过 0.82 / 0.7 / 0.62 / 0.6）就会落在 6cm 以上，
 * 那是"每帧都能察觉的位移"。
 */
const MAX_STEP_PER_SEC = 0.55;

/**
 * 客户端允许领先权威位置的纵向距离（米），超过就贴回去。见 `_absorbResidual`。
 *
 * 预测领先一个 RTT + 1 tick：15 m/s × (30ms + 33ms) ≈ 0.95 米，
 * 但那是"客户端还在朝那个方向开"的时候，服务端马上会追上来。
 * 真正需要封顶的是**网络抖动导致快照忽早忽晚**：这时领先量会一路
 * 攒到保险丝上顶着，`me` 每帧被轻微推动，画面就一顿一顿。
 *
 * 0.85 米：高于正常行驶的 0.4~0.6 米，不干扰预测手感；低于保险丝 1.2 米，
 * 留出横向残差的空间，两个机制不会互相打架。
 */
const LEAD_CAP = 1.15;

/**
 * 选卡面板的本地关闭宽限（毫秒）。
 *
 * 正常路径由服务端 `picksClosed` 事件触发关闭；这个宽限只用于"消息没到"
 * 的兜底。服务端 `pickWindow` 是 12 秒，比它晚 1.5 秒关，玩家感觉不到差别，
 * 但足够容忍一次网络抖动。
 */
const CARD_CLOSE_GRACE = 1500;

/** 敌人类型码 → 类型名（与服务端 ENEMY_TYPES 的键顺序一致） */
const TYPE_BY_CODE = Object.keys(ENEMY_TYPES);
const CODE_TO_TYPE = (c) => TYPE_BY_CODE[(c - 1)] || 'gunner';

const BULLET_COLOR = {
  player: { color: 0xfff3c4, glow: 0xffb03a },
  enemy: { color: 0xffd0c0, glow: 0xff4a3a },
};

// 联机敌人用的是 Tank（不是单机的 Enemy 类），Enemy 里那套血条不会自动出现。
// 这里按 Enemy.js 同样的尺寸 / 配色补一份，几何与材质共享，避免每辆敌人新建
// 导致显存泄漏（Tank.dispose 只 remove 节点、不释放共享资源，正好配套）。
//
// 尺寸比单机放大一圈（2.24×0.14 → 2.9×0.3）：联机视角更高更远，
// 原尺寸在 1080p 下只有三四个像素高，满血时是一条细红线，玩家会以为"没有血条"。
const BAR_W = 2.9;
const BAR_BG_GEO = new THREE.PlaneGeometry(BAR_W + 0.24, 0.46);
const BAR_FILL_GEO = new THREE.PlaneGeometry(BAR_W, 0.3);
const BAR_BG_MAT = new THREE.MeshBasicMaterial({
  color: 0x0b0908, transparent: true, opacity: 0.82, depthWrite: false,
});
const BAR_FILL_MAT = new THREE.MeshBasicMaterial({
  color: 0xff4a3a, transparent: true, opacity: 0.98, depthWrite: false,
});
const BAR_FILL_ELITE_MAT = new THREE.MeshBasicMaterial({
  color: 0xffd257, transparent: true, opacity: 0.98, depthWrite: false,
});
/** 血条外描边：深色独立于底色，保证浅色地面（沙地、雪地）上也能看清 */
const BAR_EDGE_GEO = new THREE.PlaneGeometry(BAR_W + 0.36, 0.58);
const BAR_EDGE_MAT = new THREE.MeshBasicMaterial({
  color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false,
});

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
    this._shakeOff = { x: 0, y: 0 };   // 已加进相机的震屏偏移，下一帧先撤掉
    this._aimMarker = null;

    // 预测 / 校正相关的内部状态
    this._predAcc = 0;                                  // 预测累加器（见 update）
    this._shift = { x: 0, z: 0 };                       // 待消化的位置残差
    this._vel = { x: 0, z: 0 };                         // 本 tick **实际**位移速度（外推用）
    this._predFrom = null;                              // 本帧预测前的起点（渲染插值用）
    this._disp = { x: 0, z: 0, yaw: 0 };                // 本帧画在哪
    this._moveDir = null;                               // 最近一次的移动方向（车头外推夹紧用）
    this._bound = false;
    this._cd = 0;               // 本地射击冷却（只用于表现）
    this._bossId = null;
    // F3 诊断面板（纯只读，不开销渲染性能；见 src/debug.js 顶部说明）
    this.debug = new NetDebug();
  }

  // ---------------- 生命周期 ----------------

  /** 服务端确认加入后进入战场 */
  enter(welcome) {
    this.exit();
    this.active = true;
    this.myId = welcome.you;
    this.net = this.game.net;
    this.code = welcome.code || this.net.room;

    // 自己的成长状态（重连时服务端一并带回）：选卡面板要显示"已经 Lv.x"
    const meState = (welcome.world?.players || []).find((p) => p.id === this.myId);
    this.myStats = meState?.stats || null;
    // 重连时如果这一波还没选完，服务端会补发 CARDS；这里先准备好面板数据
    if (this.myStats) this._counts = this.myStats.counts || {};

    // _initScene 里 createLevel(this.scene, this._buildTerrain()) 已经按种子铺了地表，
    // world 从这一行起才存在 —— 上面任何依赖 world 的代码都会炸（真实事故见 git）。
    this._initScene();
    // 建筑以服务端为准（中途加入也能拿到完整布局，重开一局也是新的）
    this._applyServerLayout(welcome);
    // 敌人寻路网格按新地图重烘一次（进房只做一次，不进帧循环）
    this.game.nav = createNav(this.world);
    this._buildMyTank(welcome);
    this._bindInput();

    this.runTime = 0;
    this.score = 0;
    this.kills = 0;
    this.teamScore = 0;

    const list = welcome.players || [];
    for (const p of list) this.mates.set(p.id, { name: p.name, chassis: normalizeChassisId(p.chassis) });

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
    // 特效对象池里的材质要显式释放（GC 不会回收 WebGL 显存）
    this.effects?.dispose();
    this.debug?.destroy();
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
    // 地表场只收到"种子 + 档位"，本地重建一份；进房前不知道，所以只在此时建图。
    this.world = createLevel(this.scene, this._buildTerrain());
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
    const ch = normalizeChassisId((mine && mine.chassis) || 'panther');
    const c = CHASSIS[ch];
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
      turnBase: c.turn,
      turretRate: CHASSIS_TABLE[ch].turretRate,
      turretLimit: CHASSIS_TABLE[ch].turretLimit,
    };

    const tank = new Tank(this.scene, {
      team: 'player',
      chassis: ch,
      detail: 'high',
      hp: this.me.maxHp,
      speed: c.speed,
      // 自己：军绿 + 青绿灯（以前这里什么都不传，落到 Tank 的默认绿，
      // 和敌人同色——满场绿车是这次修复的起因）
      body: SELF_SKIN.body,
      accent: SELF_SKIN.accent,
      metal: SELF_SKIN.metal,
      lamp: SELF_SKIN.lamp,
      // 射界扇面只画给自己：队友/敌人铺一地扇面会糊成一片，
      // 而且"我的炮口扫多宽"才是玩家需要立刻读到的信息。
      turretRate: this.me.turretRate,
      turretLimit: this.me.turretLimit,
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

    this.camera.position.set(
      this.me.x,
      CAM_HEIGHT,
      this.me.z + CAM_BACK
    );
    this.game.camLook?.set?.(this.me.x, 1, this.me.z);
    this.camera.lookAt(this.game.camLook);
    // 速度喂给相机前馈，进房第一帧必须是 0，不能是"从单机相机位置滑过来"
    this._vel.x = 0;
    this._vel.z = 0;

    // 初始化渲染插值与残差状态，避免第一帧画在原点
    this._predFrom = { x: this.me.x, z: this.me.z, yaw: this.me.yaw };
    this._disp = { x: this.me.x, z: this.me.z, yaw: this.me.yaw };
    this._shift = { x: 0, z: 0 };
    this._predAcc = 0;
    this._moveDir = null;

    // 最后再切成"战斗中"：上面任何一步抛错都不该让房间码消失，
    // 而且这一步会隐藏大厅，必须放在稳定之后。
    this._ready = true;
    this.game.hud.showRoomChip(this.code, list.length);
    this.game.hud.startPlaying();
  }

  _addMate(p, st) {
    if (this.tanks.has(p.id)) return;
    const c = CHASSIS[normalizeChassisId(p.chassis)];
    const t = new Tank(this.scene, {
      team: 'player',
      chassis: normalizeChassisId(p.chassis),
      detail: 'low',
      hp: c.hp,
      speed: c.speed,
      // 队友：同阵营的暗一档军绿 + 青蓝灯，和自己的亮绿分开
      body: MATE_SKIN.body,
      accent: MATE_SKIN.accent,
      metal: MATE_SKIN.metal,
      lamp: MATE_SKIN.lamp,
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
    // 按类型取敌方暖色（普通红 / 冲锋橙 / 精英金 / 无人机品红 / 炮台灰褐 /
    // 补给沙黄 / 重盾暗红 / BOSS），与单机 Enemy.js 共用同一张色板。
    // 以前这里一个字都没传 → 全体默认绿，和玩家、队友一模一样。
    const skin = enemySkin(type);
    t = new Tank(this.scene, {
      team: 'enemy',
      type,
      detail: 'low',
      hp: tpl.hp === 1 ? 100 : 100,
      speed: tpl.speed * 8.5,
      body: skin.body,
      accent: skin.accent,
      metal: skin.metal,
      x,
      z,
      rotY: yaw || 0,
    });
    const scale = tpl.scale || 1;
    t.group.scale.setScalar(scale);
    // 小地图按类型上色（boss 前缀会被识别成红色大点）
    t.minimapType = type;

    // 头顶血条。快照里 e.hp 是 0~100 的百分比，_applySnapshot 每帧更新 fill；
    // bar.lookAt(camera) 保证侧看时不会退化成一条线。BOSS 用 HUD 顶部长条，
    // 这里不重复挂（与单机 Enemy.js 一致）。
    const bar = new THREE.Group();
    // 高度要**除以**车体缩放：group.scale 会把子节点的局部坐标一起放大，
    // 血条挂在 group 下，位置得先除回来才是"离地固定高度"。
    // （血条自身的尺寸用反向缩放抵消，见下一行。）
    bar.position.y = 3.1 / scale;
    bar.scale.setScalar(1 / scale);   // 抵消车体缩放，血条尺寸四车一致
    const edge = new THREE.Mesh(BAR_EDGE_GEO, BAR_EDGE_MAT);
    edge.position.z = -0.006;
    const bg = new THREE.Mesh(BAR_BG_GEO, BAR_BG_MAT);
    const fill = new THREE.Mesh(
      BAR_FILL_GEO, type === 'elite' ? BAR_FILL_ELITE_MAT : BAR_FILL_MAT,
    );
    fill.position.z = 0.012;
    bar.add(edge, bg, fill);
    bar.renderOrder = 6;
    bar.visible = !tpl.boss;
    t.group.add(bar);
    t.bar = bar;
    t.barFill = fill;
    // 血条**不参与车体的受击闪白 / 烟尘动画**：材质是共享的，
    // 一旦被 Tank 的反馈逻辑改到就会让所有敌人一起变色。
    t.bar.traverse((o) => { o.userData.noFlash = true; });

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
      // F3：抖动诊断面板开关（preventDefault 挡掉浏览器默认的"查找"）
      if (e.code === 'F3') {
        e.preventDefault();
        this.debug?.toggle();
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

    // 与单机 Game.js 完全一致：WASD / 方向键是"八方向平移"，不是方向盘。
    // 之前这里映射成 forward + turn，按 A/D 只会原地打转，用户进房第一反应
    // 就是"左右键没用、车开不动"。单机是横移，联机必须也是横移。
    let mx = 0;
    let mz = 0;
    if (canDrive) {
      if (k.has('KeyW') || k.has('ArrowUp')) mz -= 1;
      if (k.has('KeyS') || k.has('ArrowDown')) mz += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    }

    // 鼠标 → 世界瞄准点（相机是固定的俯视角，地面平面 y=0）
    this.aimRay.setFromCamera(this.mouseNDC, this.camera);
    const hit = new THREE.Vector3();
    let hasAim = false;
    if (this.aimRay.ray.intersectPlane(this.groundPlane, hit)) {
      this.aimPoint.copy(hit);
      hasAim = true;
    }

    return {
      mx,
      mz,
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
    // 阵亡 / 被击倒时不推进预测，但**必须把速度清零**：
    // speed 是上一次 predict 写下的，倒下后没人清它，渲染外推还拿它当
    // "仍在行驶"，于是车每帧被往前画 0.3~0.5 米、下一帧又被拉回来——
    // 用户看到的就是"不按方向键，坦克自己在抖动着移动"。
    if (!this.me.alive || this.me.down) {
      this.me.speed = 0;
      // ⚠ _vel 也必须清零。渲染外推（_disp 前馈）和残差消化都用它，
      // 倒下后 predict 不再执行，_vel 会残留倒下前的行驶速度：
      // _disp 每帧按旧速度前冲 → 软约束拉回 → 再前冲，倒下的车（以及
      // 跟着它的相机）就自己"滑来滑去"。上面只清 speed 是修了一半。
      this._vel.x = 0;
      this._vel.z = 0;
      this._yawVel = 0;
    }
    if (this.me.alive && !this.me.down) {
      // 预测必须按服务端 tick 走，不能按渲染帧走。
      // 服务端固定 30Hz 推进，60fps 下如果每帧都 predict 一次，
      // 本地就比权威模拟快一倍——车头会不断"跑过头"，被 _reconcile 拽回来，
      // 表现就是"操作有粘滞感"。这里用累加器把 dt 切成一格一格 1/30 秒。
      // 运动学本身来自 core/motion.js，与服务端逐帧完全一致（有测试钉着）。
      this._predAcc = (this._predAcc || 0) + dt;
      // 先记下本帧预测前的起点，供渲染插值用（见 _reconcile 尾部）
      this._predFrom = { x: this.me.x, z: this.me.z, yaw: this.me.yaw };
      // 记住移动方向：车头朝它转。渲染外推要用它夹紧（见 _reconcile），
      // 松开方向键后也保留，因为服务端还有 1~2 个 tick 在按旧输入转。
      if (input.mx || input.mz) this._moveDir = Math.atan2(input.mx, input.mz);
      let guard = 0;
      let ticksThisFrame = 0;
      while (this._predAcc >= TICK_DT && guard++ < 8) {
        this._predAcc -= TICK_DT;
        ticksThisFrame++;
        predict(this.me, input, TICK_DT, this.world, HALF);
        // 炮塔也按 tick 推进：服务端每 tick 用"移动后的位置"重算瞄准角，
        // 本地如果按渲染帧算，累计转速会比服务端快 60/30 = 2 倍，
        // 两边炮口差 15° 射界那么大时，会出现"屏幕对着人、子弹打偏"。
        aimTurret(this.me, input.aimX, input.aimZ, TICK_DT, this.me.turretRate, this.me.turretLimit);
      }
      // 本帧转过多少角速度：渲染外推要用（见 _reconcile）
      if (ticksThisFrame > 0) {
        this._yawVel = angleDiff(this.me.yaw, this._predFrom.yaw) / (ticksThisFrame * TICK_DT);
        // ---- 本 tick 的真实位移速度 ----
        //
        // ⚠ 不要用"车头 yaw + 速度"去反推渲染外推方向。车头是 8 rad/s 追
        //   移动方向的，按下新方向后要 0.1~0.2 秒才转齐；这期间位移已经沿
        //   输入方向走了，车头还没到。拿 yaw 外推，画出来的位置会偏离真实
        //   轨迹最多 speed×tick×sin(角度差) ≈ 0.5 米，而且在每个 tick 边界
        //   被清零重来 —— 一开动就左右抖，正是用户说的"车一开动就抖"。
        //
        //   直接量"这一步实际走了多远"，方向、撞墙滑行、地形减速全都自动
        //   正确，不需要任何额外判断。
        this._vel.x = (this.me.x - this._predFrom.x) / (ticksThisFrame * TICK_DT);
        this._vel.z = (this.me.z - this._predFrom.z) / (ticksThisFrame * TICK_DT);
      }
      // 这一帧没有推进 tick（高刷屏上常见）也要补夹紧：车体转了，炮塔必须跟着转，
      // 否则炮口会短暂飘出射界，看起来像炮塔松脱。
      aimTurret(this.me, undefined, undefined, 0, this.me.turretRate, this.me.turretLimit);
    }

    // 选卡面板：服务端发 CARDS 就弹，别人选完/超时服务端会继续推进波次
    this._syncCards();

    // 服务端快照 → 队友 / 敌人 / 子弹
    this._applySnapshot();

    // 自己：柔和校正到服务端位置
    this._reconcile(dt);

    // 相机跟随
    this._updateCamera(dt);

    this.runTime += dt;
    this.effects.update(dt);

    // ---- 坦克表现层动画 ----
    //
    // Tank.update 驱动炮管后座与负重轮，是纯表现（recoilT 递减 + 轮子按里程
    // 滚动），不碰物理。组队曾经**从不调用它**：onEvents 里 recoil() 设了
    // recoilT=0.12，但没人递减、没人把值写进炮管位置——炮管纹丝不动，
    // 只剩震屏。这就是"多人开炮炮塔不动、只有画面抖"的完整成因。
    for (const [, t] of this.tanks) {
      // 组队没有本地 move()，odometer 不会累加；按渲染位置的位移喂给它，
      // 负重轮就能跟着车滚（单机是 move() 里加的，这里用画面位移近似）。
      const lx = t._lastPx ?? t.group.position.x;
      const lz = t._lastPz ?? t.group.position.z;
      const d = Math.hypot(t.group.position.x - lx, t.group.position.z - lz);
      if (d > 0.001) t.odometer += d;
      t._lastPx = t.group.position.x;
      t._lastPz = t.group.position.z;
      t.update(dt);
    }
    for (const [, t] of this.enemies) t.update(dt);

    // 射击冷却（只用于 HUD 进度条）
    this._cd = Math.max(0, this._cd - dt);
    this.game.hud.setReload(1 - this._cd / 0.4);

    this.game.hud.setHealth(this.me.hp, this.me.maxHp);
    this.game.hud.setWave(this.wave);
    this.game.hud.setLeft(this.enemiesLeft);
    this.game.hud.setScore(this.score);
    this.game.hud.setKills(this.kills);
    this._syncBoss();
    this._updateTerrainChip(dt);
    this._updateMinimap(dt);

    // 诊断面板：只读快照，4Hz 刷 DOM，不参与任何游戏逻辑
    this.debug?.frame(dt, {
      net: this.net,
      me: this.me,
      myId: this.myId,
      disp: this._disp,
      vel: this._vel,
    });

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 小地图（组队）。
   *
   * 以前组队**根本没有小地图**：canvas 一直在页面上、单机也一直在画，
   * 组队却是空的——一堆人找不到敌人、也不知道队友在哪。
   * 现在按 12Hz 刷一次（和单机同频，DOM 画布每帧重绘会白掉帧）。
   */
  _updateMinimap(dt) {
    const mm = this.game.minimap;
    if (!mm || !this.me) return;
    this._mapAcc = (this._mapAcc || 0) + dt;
    if (this._mapAcc < 0.08) return;
    this._mapAcc = 0;

    const enemies = [];
    for (const [, t] of this.enemies) {
      enemies.push({ position: t.group.position, type: t.minimapType || 'gunner' });
    }
    const mates = [];
    for (const [id, t] of this.tanks) {
      if (id === this.myId) continue;
      const p = t.group.position;
      mates.push({ x: p.x, z: p.z });
    }
    const bullets = [];
    for (const [, b] of this.bullets) {
      bullets.push({ x: b.pos.x, z: b.pos.z, team: b.team });
    }
    mm.update({
      player: { x: this._disp.x, z: this._disp.z, rot: this._disp.yaw },
      enemies,
      mates,
      bullets,
    });
  }

  /** 顶部地表指示：和服务端同一个 speedAt，显示的就是真正的速度倍率 */
  _updateTerrainChip(dt) {
    this._terrainAcc = (this._terrainAcc || 0) + dt;
    if (this._terrainAcc < 0.12) return;
    this._terrainAcc = 0;
    const me = this.me;
    if (!me || !this.world.hasTerrain) { this.game.hud.setTerrain(null); return; }
    const t = TERRAIN[this.world.terrainAt(me.x, me.z)];
    this.game.hud.setTerrain({
      name: t.name,
      color: '#' + t.color.toString(16).padStart(6, '0'),
      speed: this.world.speedAt(me.x, me.z),
    });
  }

  /**
   * 波间选卡面板。
   *
   * 联机以前是"清波 → 4 秒喘息 → 下一波"，第 8 波和第 1 波操作完全一样。
   * 现在每波结束每人抽三张各自选，服务端发 CARDS 才弹，选完（或超时）
   * 由服务端关窗并继续推波次——客户端不做任何"什么时候该开面板"的判断。
   */
  _syncCards() {
    const c = this.net?.cards;
    const open = this._cardsShown === true;

    if (c && !open) {
      this._cardsShown = true;
      this.firing = false;
      this.keys.clear();
      // 先对齐成长，再渲染卡片：卡片上的 Lv.N 取自 counts，
      // 慢一步就会一直显示 "NEW → Lv.1"（哪怕已经拿了三级）。
      if (c.stats) this._adoptStats(c.stats);
      // 面板直接用单机那套强化卡 UI：同一套视觉、同一套键位（1/2/3）
      this.game.hud.showRewards(c.wave, c.options, this._myCounts());
      this._cardDeadline = c.until;
      this._onPickKey = (e) => {
        if (this.net?.cards !== c) return;
        if (isTyping(e)) return;
        const i = ['1', '2', '3', '4'].indexOf(e.key);
        if (i < 0) return;
        const opt = c.options[i];
        if (!opt) return;
        e.preventDefault();
        this.pickCard(opt.id);
      };
      if (typeof window !== 'undefined') window.addEventListener('keydown', this._onPickKey);
      this._cardsLeft = -1;
    }

    // 倒计时：每满一秒刷一次（DOM 每帧改会掉帧，而且没必要）
    if (c && open) {
      const left = Math.max(0, Math.ceil((this._cardDeadline - performance.now()) / 1000));
      if (left !== this._cardsLeft) {
        this._cardsLeft = left;
        // 归零后不要停在那句「0 秒后自动选择」上：服务端已经替他选完、
        // 正在开下一波，还写着"0 秒后"会让人以为卡住了。
        this.game.hud.setRewardSub?.(left > 0
          ? `组队局 · 各自选卡 · ${left} 秒后自动选择`
          : '组队局 · 正在进入下一波…');
      }

      // 兜底：正常情况服务端关窗会发 picksClosed，但消息丢了（老服务端、
      // 极端丢包）面板也不能永远挂着。服务端 12 秒关窗，这里给一点宽限。
      if (performance.now() > this._cardDeadline + CARD_CLOSE_GRACE) {
        this._closeCards();
        return;
      }
    }

    if (!c && open) this._closeCards();
  }

  /**
   * 关掉选卡面板并把状态清干净。三条路都汇到这里：
   * 自己选了、服务端说窗口关了、本地超时兜底。
   */
  _closeCards() {
    if (this.net) this.net.cards = null;
    this._cardsShown = false;
    this.game.hud.hideRewards();
    if (this._onPickKey) {
      // 无头环境（单测）里没有 window：这里不抛，免得"关个面板"反而炸掉主循环
      if (typeof window !== 'undefined') window.removeEventListener('keydown', this._onPickKey);
      this._onPickKey = null;
    }
  }

  /** 自己已经选了哪些卡（面板上显示 Lv.N → Lv.N+1 用） */
  _myCounts() {
    return this.myStats?.counts || this._counts || {};
  }

  /**
   * 把服务端权威的成长数值同步到本地。
   *
   * 为什么需要：快照每帧只发位置和血量，成长（伤害倍率、速度、最大装甲、
   * 卡牌等级）不在里面。客户端不主动对齐的话会有两个后果：
   *   · 卡片上一直显示 NEW → Lv.1，看起来像"选了没生效"
   *   · 选了速度卡之后服务端跑得更快，本地预测还按旧速度，每帧被校正拉回
   *
   * 入口有两个：中途加入的 welcome（CoopMode.enter 里已经处理）和每波发卡
   * 附带的 stats（这里）。用服务端那份整体覆盖，所以中途掉线、超时替选、
   * 别人先选完这些分支都不会累积误差。
   */
  _adoptStats(s) {
    const me = this.me;
    if (!me || !s) return;
    me.stats = { ...(me.stats || {}), ...s, counts: { ...(s.counts || {}) } };
    this.myStats = me.stats;
    this._counts = me.stats.counts;
    // 预测用的运动学字段（core/motion.js 读的是 speedBase）
    if (Number.isFinite(s.speed)) me.speedBase = s.speed;
    if (Number.isFinite(s.maxHp)) me.maxHp = s.maxHp;
  }

  /** 点卡片 / 按数字键 → 交给服务端裁决 */
  pickCard(id) {
    if (!this.net) return false;
    const ok = this.net.pick(id);
    if (ok) {
      this.sound.select();
      this._closeCards();
    }
    return ok;
  }

  _applySnapshot() {
    const s = this.net?.sample();
    if (!s) return;

    this.wave = s.wave || 1;
    this.enemiesLeft = Math.max(0, s.left || 0);

    // ---- 开局前（state=lobby）的可见反馈 ----
    // 服务端进来后还会等 3 秒才开局，这段时间快照照发、画面照渲染，
    // 但输入被服务端整包丢弃：车不动、炮不响，玩家只会觉得"游戏坏了"。
    // 主炮"打不出来"的反馈里有一半是这种，所以必须明说。
    const worldLive = s.state === 'playing';
    if (worldLive !== this._wasLive) {
      this._wasLive = worldLive;
      if (!worldLive) {
        this.game.hud.showMessage('战斗准备中… 3 秒后开始', 2.6);
        this.firing = false;      // 归位，别让开局瞬间自己打一炮
      } else {
        this.game.hud.showMessage('开战！', 1.2);
      }
    }

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
      // 快照是插值出来的，位置已经平滑，直接贴
      t.group.position.set(e.x, 0, e.z);
      t.group.rotation.y = e.yaw;
      t.setAim(e.turretYaw);

      // 血条：协议里 e.hp 是 0~100 的百分比（encodeSnapshot 已归一化）。
      // 12/13 版完全没消费这个字段，所以联机敌人的血条既没创建也不掉血。
      if (t.bar && t.bar.visible) {
        const ratio = Math.max(0.001, Math.min(1, (e.hp ?? 100) / 100));
        t.barFill.scale.x = ratio;
        t.barFill.position.x = -(1 - ratio) * (BAR_W / 2);
        if (this.camera) t.bar.lookAt(this.camera.position);
      }
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
      // 炮弹贴着地面高度飞：不改弹道，只是让低洼处的曳光不被地面切掉
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

    // 位置：不硬拽。校正量记在 _shift 里，由 _absorbResidual 逐步消化。
    this._absorbResidual(dt, p);

    // 朝向校正：车头不参与位移计算（位移用 mx/mz），所以小偏差纯属观感，
    // 每帧去拽反而一顿一顿。分叉 >70° 才慢慢对，>126° 视为复活/传送直接归位。
    const yawErr = angleDiff(p.yaw, this.me.yaw);
    if (Math.abs(yawErr) > 2.2) {
      this.me.yaw = p.yaw;
      this.me.speed = 0;
      if (this._predFrom) this._predFrom.yaw = p.yaw;
    } else if (Math.abs(yawErr) > 1.2) {
      this.me.yaw += yawErr * (1 - Math.exp(-4 * dt));
    }

    // ---- 画出来的位置：连续积分 + 软约束 ----
    //
    // 逻辑位置是 30Hz 的格子，每格跳 0.5 米；渲染必须在两格之间补出中间的帧。
    // 但"每帧重新算 me + 速度×已过时间"有一个致命缺陷：**输入一变方向，
    // 上一帧已经沿旧方向画出去的最多 0.5 米就作废了**，这一帧的 me 跳到新
    // 方向，画面就会在一次刷新里横跳 0.4 米。实测 144Hz 下正好在按下 A/D
    // 的那一帧跳 43 厘米——这就是"车一开动就开始抖"。
    //
    // 改成"速度前馈 + 软约束"：
    //   1) 前馈：_disp 每帧按速度走 dt，稳态与逻辑位置零误差（不会拖后腿）；
    //   2) 软约束：再以 25ms 时间常数把 _disp 拉向理想外推位置。
    // 输入突变时，那 0.4 米的修正被摊到 4~5 帧里消化（每帧 ~9cm 递减），
    // 看起来是"车快速转过去"，而不是"跳一下"。撞墙时速度归零，前馈停止，
    // 软约束把位置拉回，也不会穿墙。
    const acc = Math.max(0, Math.min(TICK_DT, this._predAcc || 0));
    // 外推用**实测速度向量**（上一 tick 真正走了多远 / 时长），不用车头朝向。
    // 车头追移动方向有延迟，拿它外推会画出一条与真实轨迹不同的弧线。
    // 撞墙时实测位移会变小，外推也跟着变小，不会"预支"一段穿墙的路。
    let vx = this._vel.x;
    let vz = this._vel.z;
    // 速度上限兜底：复活 / 传送 / 一帧补多格时 _vel 可能异常大
    const vlen = Math.hypot(vx, vz);
    if (vlen > 30) { vx = (vx / vlen) * 30; vz = (vz / vlen) * 30; }
    if (vlen < 0.05) { vx = 0; vz = 0; }
    const dtc = Math.min(dt, 0.05);
    // 理想外推位置（时间轴上连续，但在输入突变时会跳）
    const wantX = this.me.x + vx * acc;
    const wantZ = this.me.z + vz * acc;
    // ---------------- 前馈项 ----------------
    //
    // ⚠ 前馈用 **dtc**，不要改成 acc。这一条是踩过坑的，写清楚免得再有人"优化"：
    //
    //   _disp 是画面的位置，它必须按**真实流逝的时间**走（dt），
    //   而不是按"本帧结算了几个 tick"走。tick 是 30Hz 的台阶，用它前馈
    //   等于把移动量化到 30Hz，高刷屏上那种"一顿一顿"就是这么来的。
    //   实测（含帧间隔抖动，120Hz）：前馈用 dt → 速度变异 0.0%；
    //   前馈用 (dt - acc) → 速度变异 21%（每帧忽快忽慢）。
    //
    //   重算多出来的那点推进量由下面的软约束吸收，不会累积成漂移：
    //   本帧推进了 k 个 tick 时 want 一次走 k 格，_disp 只走 1 帧的量，
    //   差值被 kDisp 在几十毫秒里摊平。
    this._disp.x += vx * dtc;
    this._disp.z += vz * dtc;
    // 2) 软约束（一阶低通，τ = 25ms）
    const kDisp = 1 - Math.exp(-40 * dtc);
    this._disp.x += (wantX - this._disp.x) * kDisp;
    this._disp.z += (wantZ - this._disp.z) * kDisp;
    let rx = this._disp.x;
    let rz = this._disp.z;
    let ry = this.me.yaw + (this._yawVel || 0) * acc;
    // 车头外推的"到位夹紧"：
    //
    // 松方向键 / 车头追齐移动方向的那一个 tick 之后，_yawVel 还挂着上一格的
    // 角速度，直接外推会让车头多转最多半格（8rad/s × 33ms ≈ 15°），下一格
    // 预测跟上又弹回来——这就是"转完一下车头抖一下"。夹紧规则：
    //   · 车头已追齐移动方向 → 一度都不许多转；
    //   · 外推方向与目标方向相反（刚改了输入）→ 不外推；
    //   · 会转过目标 → 最多转到目标为止。
    // 显示值永远落在"当前朝向 → 目标方向"这一段里，夹紧本身就是连续的，不会跳。
    if (this._moveDir !== null && (this._yawVel || 0) !== 0) {
      const room = angleDiff(this._moveDir, this.me.yaw);
      let extra = this._yawVel * acc;
      if (room === 0 || (extra > 0) !== (room > 0)) extra = 0;
      else if (Math.abs(extra) > Math.abs(room)) extra = room;
      ry = this.me.yaw + extra;
    }
    // 逻辑位置和画出来的位置差超过 3 米（复活 / 传送 / 被撞飞）：直接贴，不外推
    if (Math.hypot(this.me.x - rx, this.me.z - rz) > 3) {
      rx = this.me.x;
      rz = this.me.z;
      ry = this.me.yaw;
      this._yawVel = 0;
    }
    this._disp.x = rx;
    this._disp.z = rz;
    this._disp.yaw = ry;

    const t = this.tanks.get(this.myId);
    if (t) {
      t.group.position.set(rx, this.me.down ? 0.35 : 0, rz);
      t.group.rotation.y = ry;
      t.group.rotation.z = this.me.down ? 0.5 : 0;
      t.setAim(this.me.turretYaw);
    }
  }

  /**
   * 消化"权威位置 - 本地预测"的残差。
   *
   * 残差分两种，处理方式必须分开：
   *   纵向（沿速度方向）：预测领先量。客户端按键立刻动，服务端要等输入走完
   *     半个 RTT + 1 个 tick 才动，开车时客户端天然领先 0.2~0.4 米。这不是
   *     错误，是预测的正常代价——行驶中**追都不许追**，否则每帧把车往后拽。
   *   横向（垂直于速度）：真正的偏差（碰撞判定分叉之类），沿垂直方向慢慢追，
   *     不改前进速度，画面无感。
   *
   * 三条硬约束，都是踩过坑换来的：
   *   1) **幂等**：本方法每个渲染帧都调，快照只有 15Hz，同一份数据会被消费
   *      4~9 次。以前用 `_shift += 差值`，等于把同一个错误累加好几遍，
   *      1cm 的偏差被放大成 3cm，然后来回冲——"不按方向键车自己在抖"。
   *      现在一律用赋值，同样的快照算多少遍结果一样。
   *   2) **静止不追**：偏差 0.4 米以内一律不动。这个量级就是预测领先量，
   *      追它只会让松键后的车倒着溜一小段。
   *   3) **只收敛超出部分**：真要收敛时，收到 0.4 米就停手，不追求零偏差。
   *      零偏差的代价是永远在动，而"松手即停"玩家一秒就能感觉到。
   */
  _absorbResidual(dt, snapPos) {
    if (!snapPos) return;
    const rx = snapPos.x - this.me.x;
    const rz = snapPos.z - this.me.z;
    const moving = Math.abs(this.me.speed) > 0.5;

    // ⚠ 残差必须**设置**，不能累加。
    //
    // 这个方法每个渲染帧都调用（60~144Hz），而快照只有 15Hz —— 同一条快照会被
    // 重复消费 4~9 次。以前这里是 `this._shift += rx`，等于把同一个差值累加
    // 好几遍：差值 1cm 会被放大成 2~3cm，而且客户端一移动，rx 立刻跟着变，
    // 越加越大直到撞上保险丝，然后来回冲——这就是用户说的
    // 「不按方向键，坦克自己在抖动着移动」。
    //
    // 改成设置后整段逻辑是幂等的：同一份快照算多少遍结果都一样，只有真正
    // 移动的位置差才会被记下来。
    if (moving) {
      // ---- 运动方向必须用**实测位移方向**，不是车头朝向 ----
      //
      // 踩过的坑（19 版定位到的核心抖动源）：这里原来是
      //     vx = sin(yaw) * speed;  vz = cos(yaw) * speed;
      // 即"车头指哪算哪"。但车头是 8 rad/s 追移动方向的，而位移是
      // **立即生效**的（见 core/motion.js：先转 yaw，位移直接沿输入方向走）。
      // 两个必然分叉的场景：
      //   · 撞墙沿墙滑行：车头朝输入方向（可能 70°），位移却沿墙面走；
      //   · 刚改方向：车头还要 0.1~0.2 秒才转齐。
      // 这时"纵向"被算错，"横向"多出一大截，横向追赶每帧推 me 2cm，
      // 而 want = me + v*acc 的 me 带着这 2cm，软约束逐帧抄给 _disp。
      // 实测直行时残差一直顶在保险丝 1.19 米上，画面上就是匀速前进却一顿一顿。
      //
      // 直接用 `_vel`（上一 tick 真实走了多远 / 时长）：方向、撞墙滑行、
      // 地形减速全都自动正确，和渲染外推用的是同一个量，两边不会打架。
      let vx = this._vel.x;
      let vz = this._vel.z;
      let vlen = Math.hypot(vx, vz);
      if (vlen < 0.5) {
        // 刚起步 / 刚转身，_vel 还没测出来：退回车头方向
        vx = Math.sin(this.me.yaw) * this.me.speed;
        vz = Math.cos(this.me.yaw) * this.me.speed;
        vlen = Math.hypot(vx, vz) || 1;
      }
      const ux = vx / vlen;
      const uz = vz / vlen;
      const along = rx * ux + rz * uz;      // 纵向分量（有符号）
      // 只把横向记进待消化残差；纵向留着（见上）
      this._shift.x = rx - ux * along;
      this._shift.z = rz - uz * along;
      // 服务端反超客户端 0.75 米以上（卡顿恢复 / 漏了模拟）：这是真错位，
      // 直接向前贴，否则整局都跟服务端错开一大截。
      if (along > 0.75) {
        this.me.x += ux * along;
        this.me.z += uz * along;
      }
      // ---- 纵向领先量必须**有界**，否则会在保险丝上打转 ----
      //
      // 纵向残差平时不追是对的：客户端按键立刻走、服务端要等半个 RTT，
      // 领先 0.2~0.4 米是预测的正常代价。但"不追"不等于"不封顶"。
      //
      // 19 版实测到的现象：网络有抖动时，快照到达忽早忽晚，`rx/rz` 相对
      // 客户端每帧都在变；纵向分量被整段丢弃、从不补偿，误差就这样一路
      // 攒到保险丝 1.2 米上顶着。于是 `me` 每帧都在被横向追赶推动，
      // 而 `want = me + v*acc` 里的 `me` 带着这个微动，软约束把它逐帧
      // 抄给 `_disp` —— 画面上就是"匀速直行，车却一顿一顿"。
      //
      // 修法：领先量超过 CAP 就把超出部分吃回去。普通行驶 0.4 米左右，
      // 根本不触发；只有真的攒起来（抖动 / 卡顿 / 快照稀疏）才拉回，
      // 而且是**一次贴齐**，不是每帧磨一点——磨出来的正是抖动。
      if (along < -LEAD_CAP) {
        const back = along + LEAD_CAP;      // 负数，即需要往回拉的距离
        this.me.x += ux * back;
        this.me.z += uz * back;
      }
    } else {
      // 静止：整段残差（主要是停车那一下的领先量）记进来，下面按速率滑。
      //
      // 死区 0.4 米：这是"预测领先量"的量级（客户端按了立刻就动，服务端
      // 要等输入走完半个 RTT 才动），它不是错误，是预测的正常代价。
      // 以前把它一丝不差地滑回去，松键后车会**倒着溜** 0.2~0.3 米，
      // 玩家看到的是"松手了车还在动"。现在只要偏差在 0.4 米以内就不动它：
      // 视觉上 0.4 米放在 4.5 米长的车身上看不出来，但"松手即停"很明显。
      //
      // 超过 0.4 米（高延迟 / 卡顿 / 被推）才收敛，且只收敛到 0.4 米为止。
      const mag0 = Math.hypot(rx, rz);
      if (mag0 <= 0.4) { this._shift.x = 0; this._shift.z = 0; return; }
      this._shift.x = rx;
      this._shift.z = rz;
    }

    // 保险丝：待消化残差最多 1.2 米，防止异常情况下无界增长
    const m0 = Math.hypot(this._shift.x, this._shift.z);
    if (m0 > 1.2) {
      this._shift.x -= (this._shift.x / m0) * (m0 - 1.2);
      this._shift.z -= (this._shift.z / m0) * (m0 - 1.2);
    }

    const mag = Math.hypot(this._shift.x, this._shift.z);
    if (mag < 1e-4) { this._shift.x = 0; this._shift.z = 0; return; }

    // 偏差过大（被撞飞 / 复活 / 传送）不磨，直接归位。
    if (mag > 3) {
      this.me.x += this._shift.x;
      this.me.z += this._shift.z;
      this._shift.x = 0;
      this._shift.z = 0;
      return;
    }

    let takeX = 0;
    let takeZ = 0;
    if (moving) {
      // 行驶中：只追横向分量（严格垂直于速度方向，不动前进速度）。
      // 追赶速度固定 2.4 米/秒：太小了偏差收不回来，太大又会冲过头再往回走。
      //
      // 速度方向同样用实测 `_vel`，和上面拆分残差时保持一致 ——
      // 两边用不同方向会让"横向"的定义自相矛盾，追的是一段不属于横向的量。
      let vx = this._vel.x;
      let vz = this._vel.z;
      let vlen = Math.hypot(vx, vz);
      if (vlen < 0.5) {
        vx = Math.sin(this.me.yaw) * this.me.speed;
        vz = Math.cos(this.me.yaw) * this.me.speed;
        vlen = Math.hypot(vx, vz) || 1;
      }
      const ux = vx / vlen;
      const uz = vz / vlen;
      const along = this._shift.x * ux + this._shift.z * uz;
      const latX = this._shift.x - ux * along;
      const latZ = this._shift.z - uz * along;
      const latMag = Math.hypot(latX, latZ);
      // 主追赶量 + 硬约束贴回量合并成一次位移，再统一按上限截断。
      //
      // 主追赶（1.2 m/s）和 `_clampToSnap` 的硬贴是两条独立路径，叠起来
      // 没有共同上界。测试里就撞见过：桩没给 `_vel`，方向判据退化，
      // 主追赶推 2cm、clamp 又追加 8cm，一帧 10cm。所以下面统一截断。
      if (latMag > RESIDUAL_DEADZONE) {
        const take = Math.min(latMag, CATCHUP_PER_SEC * Math.min(dt, 0.05));
        takeX = (latX / latMag) * take;
        takeZ = (latZ / latMag) * take;
      }
    } else {
      // 静止：只收敛"超过死区的那部分"，收到 0.4 米就停手（否则又会一直溜）
      const over = mag - 0.4;
      if (over <= 0) { this._shift.x = 0; this._shift.z = 0; return; }
      const rate = Math.max(3.0, over * 3);
      const take = Math.min(over, rate * Math.min(dt, 0.05));
      takeX = (this._shift.x / mag) * take;
      takeZ = (this._shift.z / mag) * take;
    }
    this.me.x += takeX;
    this.me.z += takeZ;
    this._shift.x -= takeX;
    this._shift.z -= takeZ;

    // 单帧校正位移的唯一出口。
    //
    // 之所以在这里再截一刀：上面主追赶有 1.2 m/s 的上限、`_clampToSnap`
    // 是"逐帧硬贴"没有上限，两条路径叠起来就可能一帧走十几厘米 ——
    // 画面上就是"车被弹了一下"。这一刀保证无论哪条判据失真，单帧位移
    // 都不超过 MAX_STEP_PER_SEC（4.2 m/s，仍远快于正常行驶 15 m/s 的
    // 一半以上，所以真错位照样一帧内就跟上，只是不会瞬移）。
    const beforeX = this.me.x;
    const beforeZ = this.me.z;
    this._clampToSnap(snapPos);
    const cap = dt > 0 ? MAX_STEP_PER_SEC * Math.min(dt, 0.05) + 1e-6 : Infinity;
    const sx = this.me.x - beforeX;
    const sz = this.me.z - beforeZ;
    const sl = Math.hypot(sx, sz);
    if (sl > cap) {
      const k = cap / sl;
      this.me.x = beforeX + sx * k;
      this.me.z = beforeZ + sz * k;
    }
  }

  /**
   * 硬约束：逻辑位置不许离最新快照超过 HARD_CAP 米。
   *
   * 为什么必须有这一条：`_disp`（画出来的位置）每帧按 `_vel` 前馈积分，
   * 如果 `_vel` 因为撞墙判定分叉、残差消化、或者一帧补了多格而偏大，
   * 画面位置会一路跑在逻辑位置前面几米，再被软约束慢慢拽回来——玩家看到的
   * 就是"车飘出去又弹回来"。有了这条上界，误差有确定的天花板，收的时候
   * 也有确定的距离可算。
   *
   * 阈值取 1.2 米：正常预测领先量 0.2~0.4 米，快照 15Hz 时半个间隔再走
   * 0.3 米，1.2 米足够容纳抖动余量，但看着已经偏了——所以只在真分叉时触发。
   */
  _clampToSnap(p) {
    if (!p) return;
    const dx = this.me.x - p.x;
    const dz = this.me.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d <= HARD_CAP) return;
    const k = HARD_CAP / d;
    this.me.x = p.x + dx * k;
    this.me.z = p.z + dz * k;
  }

  /**
   * 按服务端下发的种子本地重建地表场。
   *
   * 不传格点数组：27×27 的 Uint8 数组在手写协议里要么 base64、要么数组展开，
   * 而"种子 + 同一个纯函数"已经能保证两端一字不差，还省掉一条协议字段的兼容负担。
   */
  _buildTerrain() {
    const t = this.net?.terrain;
    if (!t || !t.seed) return null;
    return buildTerrain(t.seed >>> 0, HALF, { k: Number(t.k ?? 1) });
  }

  /**
   * 建筑：**直接用服务端下发的坐标**，不自己按种子生成。
   *
   * 地表可以两端各自重建（纯函数、无状态、错一格只影响脚下速度），
   * 建筑不行：它是碰撞的真身，两边差一厘米就是一堵假墙。
   * 以前两边各生成一份出过事（见 core/levelgen.js 顶部的事故记录），
   * 现在连"同源"都不依赖了 —— 服务端说什么就是什么。
   */
  _applyServerLayout(welcome) {
    const list = welcome?.world?.boxes;
    if (!Array.isArray(list) || !list.length) return;
    this.world.setLayout(list);
    this.game.minimap?.invalidate?.();
  }

  _updateCamera(dt) {
    const cam = this.camera;
    // 先撤掉上一帧的震屏偏移。震屏是**纯视觉附加量**，如果直接加进
    // cam.position，下一帧的跟随算法就把它当成"相机真实的落后量"去追，
    // 越震越偏，停止震动时相机还要花几帧漂回来——看着就是"开炮后镜头晃半天"。
    if (this._shakeOff) {
      cam.position.x -= this._shakeOff.x;
      cam.position.y -= this._shakeOff.y;
      this._shakeOff.x = 0;
      this._shakeOff.y = 0;
    }

    // 跟随算法只有一份（src/core/camera.js，单机也用这个）。
    //
    // 以前这里是"相机对车体做一阶低通"：cam += (disp - cam) * (1 - exp(-7.5dt))。
    // 纯比例控制有稳态滞后 速度/7.5 ≈ 2 米，而且**这个滞后会随速度变**——
    // 踩上公路（1.12×）变 2.2 米、进沼泽（0.55×）缩到 1.1 米、撞墙急停缩到 0。
    // 每一次变化整屏都推拉一次，配合 camLook 也是低通，俯角在 35°~40° 之间摆，
    // 玩家看到的就是"车一开动，画面一顿一顿地晃"。
    //
    // 现在：速度前馈（稳态零误差）+ 位置纠偏（只处理真误差）+ 视线钉在车体上。
    const f = followStep(
      { x: cam.position.x, z: cam.position.z },
      { x: this._disp.x, z: this._disp.z },
      this._vel,                      // 上一 tick 实测速度（与渲染外推同源）
      Math.abs(this.me?.speed || 0),
      dt,
      this._follow || (this._follow = validateFollow({ back: CAM_BACK, height: CAM_HEIGHT })),
    );
    cam.position.x = f.x;
    cam.position.z = f.z;
    cam.position.y = f.y;
    // 视线目标直接取车体位置：相机与目标之间没有一阶动态差，
    // 俯角 = atan(26 / 31) 恒定，不会随车速俯仰。
    this.game.camLook.set(f.lookX, 1, f.lookZ);
    cam.lookAt(this.game.camLook);

    // 开炮后座：只平移，且必须用平滑的衰减振荡而不是逐帧随机数。
    // 逐帧 Math.random() 在 144Hz 下等价于高频噪声，人眼读作"画面在抖"。
    if (this._shake > 0) {
      const t = (this._shakeT = (this._shakeT || 0) + dt);
      const amp = this._shake * 0.5;
      // 两个互质频率的正弦叠加：看起来是不规则的震动，但每帧连续
      const ox = Math.sin(t * 61.7) * amp;
      const oy = Math.sin(t * 47.3 + 1.7) * amp * 0.7;
      cam.position.x += ox;
      cam.position.y += oy;
      this._shakeOff.x = ox;
      this._shakeOff.y = oy;
      this._shake = Math.max(0, this._shake - dt * 1.6);   // 与单机同衰减速率
      if (this._shake === 0) { this._shakeT = 0; this._shakeOff.x = 0; this._shakeOff.y = 0; }
    }

    // 指示环跟炮口实际指向（射界卡住时停在能打到的位置并变红），
    // 与单机 Game._updateAim 同一套表现，换模式不用重新学看判读。
    let mx = this.aimPoint.x;
    let mz = this.aimPoint.z;
    if (this.me && this.me.alive && !this.me.down) {
      const dx = this.aimPoint.x - this.me.x;
      const dz = this.aimPoint.z - this.me.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1.2) {
        const off = angleDiff(Math.atan2(dx, dz), this.me.turretYaw);
        const clipped = Math.abs(off) > 0.03;
        if (clipped) {
          const r = Math.min(dist, 14);
          mx = this.me.x + Math.sin(this.me.turretYaw) * r;
          mz = this.me.z + Math.cos(this.me.turretYaw) * r;
        }
        if (this._aimMarker.material) {
          this._aimMarker.material.color.setHex(clipped ? 0xd0553a : 0xff9a3d);
          this._aimMarker.material.opacity = clipped ? 0.55 : 0.75;
        }
      }
    }
    this._aimMarker.position.set(mx, 0.06, mz);
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
            // 震屏与单机同参数（0.1 / 衰减 1.6）：曾经 0.14 / 1.2，
            // 又叠加"后座动画不播"，手感只剩抖没有后座，观感就是"画面抖"。
            this._shake = Math.max(this._shake, 0.1);
            const t = this.tanks.get(this.myId);
            t?.recoil?.();
          } else {
            // 队友开炮：只做后座表现，不叠音效（4 人齐射会吵成一片）
            this.tanks.get(e.id)?.recoil?.();
          }
          break;
        case 'eshot': {
          // 敌人开炮：屏幕上它离你很远、没有炮口火光，唯一能给出的
          // "它在打你"的提示就是小地图上那一下红圈。
          const t = this.enemies.get(e.id);
          if (t) this.game.minimap?.pulse?.([{ x: t.group.position.x, z: t.group.position.z }]);
          break;
        }
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
        case 'picksClosed':
          // 服务端关窗（全员选完 / 超时替选）。以前没有这条消息，没在 12 秒内
          // 点卡的人面板会永久停在「0 秒后自动选择」，只能刷新页面。
          this._closeCards();
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
