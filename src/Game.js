import * as THREE from '../vendor/three.module.js';
import { createLevel, PLAYER_START, HALF } from './level.js';
import { generateBoxes } from './core/levelgen.js';
import { buildTerrain, presetK, TERRAIN } from './core/terrain.js';
import { Tank } from './Tank.js';
import { updateBatches } from './TankBatch.js';
import { Enemy } from './Enemy.js';
import { Bullet } from './Bullet.js';
import { Effects } from './Effects.js';
import { HUD } from './HUD.js';
import { createStats, UPGRADES, rollChoices } from './upgrades.js';
import { WEAPONS, resolveWeapon } from './weapons.js';
import { CHASSIS, CHASSIS_TABLE, normalizeChassisId } from './chassis.js';
import { followStep, validateFollow } from './core/camera.js';
import { HIT_TOP, AIM_BODY_Y, FLAT_SLOPE } from './core/aim.js';
import { rollModifier, MODIFIER_DEFAULTS } from './modifiers.js';
import { Sound } from './sound.js';
import { todayKey, loadCallsign, submitScore, flushPending } from './daily.js';
import { R, Rng, randomSeed } from './rng.js';
import { crateCount, cratePositions, rollCategory, rollCard, CATEGORIES } from './core/crates.js';
import { BOSS_META, BOSS_SKILLS, bossTypeForWave, pickLateBoss, bossHpFor, ZONE, stepZones,
  stageBarRatio, rollAwakens, AWAKEN_NUM, awakenNamesOf } from './core/bosskit.js';
import { ZoneVisual, BeamVisual } from './zone-visual.js';
import { makeCrate } from './crate-visual.js';
import { createNav } from './nav.js';
import { Minimap } from './minimap.js';
import { TouchControls, assistAim, AIM_RANGE } from './input/touch.js';
import { loadAssist } from './input/prefs.js';
import { createQuality, FOG_BASE } from './core/quality.js';
import { CoopMode } from './coop.js';
import { NetClient } from './net.js';
import { angleDiff } from './core/motion.js';
import { screenToNDC } from './core/viewport.js';
import { buildPatrolRoutes, anchorRoute } from './core/patrol.js';

const TMP = new THREE.Vector3();
const TMP2 = new THREE.Vector3();
const TMP3 = new THREE.Vector3();
// 相机：高度 26 / 后拉 31 → 俯角约 39°，比原来的 48° 更低平，压近地面更有临场感
const CAM_HEIGHT = 26;
const CAM_BACK = 31;
const BEST_KEY = 'tank3d.best.v1';
const WARN_GEO = new THREE.RingGeometry(1.68, 2.0, 32);

function segDistXZ(a, b, p) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const apx = p.x - a.x;
  const apz = p.z - a.z;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? (apx * abx + apz * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + abx * t - p.x, a.z + abz * t - p.z);
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function loadBest() {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    if (!raw) return { wave: 0, score: 0 };
    const v = JSON.parse(raw);
    return {
      wave: Number.isFinite(v.wave) ? v.wave : 0,
      score: Number.isFinite(v.score) ? v.score : 0,
    };
  } catch {
    return { wave: 0, score: 0 };
  }
}

function saveBest(best) {
  try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch { /* 隐私模式下忽略 */ }
}

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = 'menu';
    this.paused = false;
    this.keys = new Set();
    this.firing = false;
    this.mouseNDC = new THREE.Vector2(0, 0);
    this.aimPoint = new THREE.Vector3(0, 0, 30);
    this.aimRay = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.bullets = [];
    this.enemies = [];
    this.pending = [];
    this.warnings = [];
    this.wave = 0;
    this.waveActive = false;
    this.waveTimer = 0;
    this.waveTime = 0;
    this.score = 0;
    this.kills = 0;
    this.runTime = 0;
    this.playerCd = 0;
    this.shake = 0;
    this.overTimer = 0;
    this.clearedTimer = 0;

    this.stats = createStats();
    this.chassisId = 'panther';
    this.mods = { ...MODIFIER_DEFAULTS };
    this.sound = new Sound();
    this.upgradeCounts = {};
    this.choices = [];
    this.weaponChoices = [];
    this.unlocked = ['assault'];
    this.heat = 0;
    this.overheated = false;
    this.best = loadBest();
    // ---- 组队联机 ----
    this.net = new NetClient();
    this.coop = null;          // 进房后实例化为 CoopMode
    this.mode = 'solo';        // solo | coop
    this._booted = false;

    this.hud = new HUD();

    // 浏览器自动播放策略：把"任意一次点击/按键"都当成解锁音频的时机。
    // 联机进房走的是 WebSocket 回调（不是用户手势），只靠"出击"按钮那一次
    // 手势偶尔解不开，表现就是"单机有音乐、组队没有"。
    const unlockAudio = () => this.sound.unlock();
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });

    // 切到后台就停配乐调度并挂起音频时钟（省电，也避免回来时那一串补排的音符）
    document.addEventListener('visibilitychange', () => {
      this.sound.setHidden(document.hidden);
      // 顺手暂停：手机切 App / 桌面切标签页时主循环会被节流，
      // 不暂停的话回来往往已经躺了。pause() 自带"只有单机战斗中才生效"的守卫。
      if (document.hidden) this.pause();
    });

    // ---- 触屏：左半屏走位、右半屏瞄准（浮动方向摇杆）+ 按住连发 ----
    // 触摸不直接进战斗逻辑，先翻译成与键鼠同款的 keys / firing / 瞄准朝向，
    // 这样单机和联机共用一份输入语义，不会出现"组队里触屏没反应"的分叉。
    this.touchMove = { x: 0, z: 0 };
    this.touchAimAngle = null;      // 触屏瞄准朝向（null = 走鼠标那条路）
    this.aimAssist = loadAssist();  // 8° 辅助吸附，开始界面可关
    this._assistBuf = [];           // 吸附用的目标缓冲（每帧复用，避免分配）
    this.touch = new TouchControls();
    this.touch.setTarget(this.soloTouchTarget());
    this.hud.onAimAssist = (on) => { this.aimAssist = on; };

    // 团队邀请链接里带 ?room=XXXX：打开后自动填好人呼号就能一键进房。
    // 只做"预填"，不自动连——朋友可能想先换车体。
    const inviteRoom = new URLSearchParams(location.search).get('room');
    if (inviteRoom && /^[A-Za-z0-9]{4}$/.test(inviteRoom)) {
      this.inviteRoom = inviteRoom.toUpperCase();
      this.hud.inviteRoom = this.inviteRoom;
    }

    // 画质档位要在建 renderer 之前定：antialias / 像素比 / 阴影都是建的时候就生效的
    this.quality = createQuality();

    this._initRenderer();
    this._initScene();
    this._initInput();
    this._resetPlayer();
  }

  /**
   * FPS 巡检：每 2.5 秒算一次平均帧率，连续不达标就自动降一档画质。
   * 只在 high / mid 档生效（low 已是最低），且页面在前台——后台标签页
   * requestAnimationFrame 被浏览器节流，会把"没人看"误判成"跑不动"。
   */
  _qualityWatch(dt) {
    if (this.noGL || this.quality.tier === 'low') return;
    this._fpsT = (this._fpsT || 0) + dt;
    this._fpsN = (this._fpsN || 0) + 1;
    if (this._fpsT < 2.5) return;
    const fps = this._fpsN / this._fpsT;
    this._fpsT = 0;
    this._fpsN = 0;
    if (fps >= 30 || document.visibilityState !== 'visible') return;
    const tier = this.quality.stepDown();
    if (!tier) return;
    this._applyQuality();
    this.hud.showMessage(`已自动降低画质（${Math.round(fps)} fps）`, 2.5);
  }

  /** 把当前画质档位落到渲染器 / 阴影 / 雾 / 粒子上（降档或初始化时调） */
  _applyQuality() {
    const q = this.quality;
    if (!this.noGL) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
      this.renderer.shadowMap.enabled = q.shadows;
      if (this._sun) this._sun.castShadow = q.shadows;
      // 阴影开关变了以后，编译好的材质还带着旧的 shader 变体，
      // 不标记 needsUpdate 的话场景会有一半黑一块白的残留
      this.scene.traverse((o) => {
        if (o.material) {
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
        }
      });
    }
    if (this.effects) this.effects.budget = q.particles;
    if (this.scene?.fog) {
      this.scene.fog.near = FOG_BASE.near * q.fogMul;
      this.scene.fog.far = FOG_BASE.far * q.fogMul;
    }
  }

  // ------------------------------------------------------------------
  _initRenderer() {
    const q = this.quality;
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        // 低配档关抗锯齿：手机上 MSAA 的填充率开销比它省下的锯齿显眼得多
        antialias: q.tier !== 'low',
        powerPreference: 'high-performance',
      });
    } catch (e) {
      // 没有 WebGL（老设备、远程桌面、自动化测试环境）时不要白屏：
      // 降级成"仅界面"，菜单、榜单、组队房间都还能用。
      this.noGL = true;
      this.renderer = makeNullRenderer();
      console.warn('WebGL 不可用，已进入仅界面模式：', e && e.message);
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    // 合批的实例矩阵必须在真正提交绘制之前写好。包一层 render 而不是在
    // update 里插一句：单机在 Game.update 末尾渲染、联机在 coop.update 里
    // 自己渲染，两条路径都要覆盖，包在这里只有一处，也不会漏。
    const rawRender = this.renderer.render.bind(this.renderer);
    this.renderer.render = (scene, camera) => {
      updateBatches();
      rawRender(scene, camera);
    };
  }

  _initScene() {
    const q = this.quality;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x172430);
    // 雾随档位拉近：手机上远处本来就看不清，拉到 150 既省填充率又不影响玩法
    this.scene.fog = new THREE.Fog(0x172430, FOG_BASE.near * q.fogMul, FOG_BASE.far * q.fogMul);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 420);
    this.camera.position.set(0, CAM_HEIGHT + 1, 52);

    const hemi = new THREE.HemisphereLight(0xcfe4f5, 0x4a5240, 1.25);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff3dd, 2.2);
    sun.position.set(46, 78, 30);
    sun.castShadow = q.shadows;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -100;
    sun.shadow.camera.right = 100;
    sun.shadow.camera.top = 100;
    sun.shadow.camera.bottom = -100;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 240;
    sun.shadow.bias = -0.0007;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this._sun = sun;   // 自动降档时要联动 castShadow

    // 单机版没有服务端下发，地形由本局种子派生（每局一张新地表）。
    //   ?terrain=off|light|standard|harsh  改强度档
    //   ?tseed=12345                       钉死地形，用来复现某一局 / 截图 / 调关卡
    // 联机不要读这两个参数：四个人必须是同一张图，那边由服务端统一下发。
    const tq = new URLSearchParams(location.search);
    this.terrainPreset = tq.get('terrain') || 'standard';
    this.terrainSeedFixed = tq.has('tseed') ? ((Number(tq.get('tseed')) || 0) >>> 0) : null;
    // ?map=old 回到"建筑固定"的旧布局（seed 0 = 不扰动），方便对比新旧图
    this.mapSeedFixed = tq.get('map') === 'old' ? 0 : null;
    this.world = createLevel(this.scene, null); // 先建空图，start() 里按种子铺地表
    this.nav = createNav(this.world);
    this.patrolRoutes = [];
    this.effects = new Effects(this.scene);
    this.effects.budget = q.particles;
    // Boss 场地标记（r46）：与联机同一套数据形状和渲染器（src/zone-visual.js）。
    // 单机这边自己维护一份 zones，判定走 core/bosskit.js 的 stepZones，
    // 所以"岩浆多久掉一次血""炮击什么时候炸"两种模式不可能对不上。
    this.zones = [];
    this.zoneVis = new ZoneVisual(this.scene);
    this.beamVis = new BeamVisual(this.scene);
    this._beamList = [];
    // stepZones 要的目标形状（{x,z,alive,down}），复用同一个对象，别每帧新建
    this._zoneTarget = { x: 0, z: 0, alive: true, down: false };
    this._zoneEvents = [];

    // 小地图（静态障碍烘焙一次）
    // 挪到左上角后不需要再给右下的摇杆让位，尺寸整体收一档：
    // 桌面 152（原 168），横屏手机 104（原 124）。按高度再兜一次底，
    // 免得矮窗口里小地图把左上的血量/波次挤掉。
    const mapEl = document.getElementById('minimap');
    const mapSize = Math.max(88, Math.min(
      window.innerWidth < 720 || window.innerHeight < 520 ? 96 : 144,
      Math.round(window.innerHeight * 0.3),
    ));
    // BOSS 血条挂在小地图右边，CSS 必须知道小地图实际多宽。
    // 尺寸是按窗口高度算出来的，CSS 猜不到，所以每局写进 :root 变量。
    // （不在 #hud 上声明同名变量：那样它会盖掉这里的值，继承打不过自身声明）
    document.documentElement.style.setProperty('--map-size', `${mapSize}px`);
    this.minimap = mapEl
      ? new Minimap(mapEl, this.world, { size: mapSize })
      : null;
    this.mapAcc = 0;

    // 瞄准指示环
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.1, 32),
      new THREE.MeshBasicMaterial({
        color: 0xff9a3d, transparent: true, opacity: 0.75,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    ring.visible = false;
    this.aimMarker = ring;
    this.scene.add(ring);

    this.camLook = new THREE.Vector3(0, 1, 26);

    // 玩家真实速度（米/秒，逐帧由位移反推）。
    // 敌方主炮的提前量要用它——不能拿"按键方向 × 最高速度"凑，
    // 那样撞墙、上坡减速时预判会打到不存在的位置。
    this.playerVel = { x: 0, z: 0 };

    // 上次没传成功的成绩，进游戏时静默补传一次
    flushPending().catch(() => {});
  }

  _resetPlayer() {
    if (this.player) {
      this.scene.remove(this.player.group);
      this.player = null;
    }
    const c = CHASSIS[normalizeChassisId(this.chassisId)];
    const ct = CHASSIS_TABLE[normalizeChassisId(this.chassisId)];
    this.player = new Tank(this.scene, {
      team: 'player',
      chassis: this.chassisId,
      detail: 'high',
      body: c.colors.body,
      accent: c.colors.accent,
      metal: c.colors.metal,
      hp: this.stats.maxHp,
      speed: this.stats.speed,
      // 炮塔：与联机端读同一张表，均衡/重装全向瞬间，轻装/猎手全向 170°/s
      turretRate: ct.turretRate,
      turretLimit: ct.turretLimit,
      x: PLAYER_START.x,
      z: PLAYER_START.z,
      rotY: Math.PI,
    });
    this.player.setAim(Math.PI);
    this.player.group.position.y = 0;
  }

  // ------------------------------------------------------------------
  _initInput() {
    const moveKeys = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

    // 焦点在输入框（呼号）时，键盘事件必须完整交还给浏览器，
    // 否则 WASD / 空格 / 数字 会被下面的 preventDefault 吃掉，打不出字。
    const isTyping = (e) => {
      const t = e.target;
      if (!t) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable;
    };

    window.addEventListener('keydown', (e) => {
      // Esc 始终表示"退出当前这一层"。必须放在打字判断之前：
      // 房间码输入框有焦点时，下面的分支会直接 return，Esc 就完全没反应了。
      if (e.key === 'Escape' && this.hud.lobby && !this.hud.lobby.classList.contains('hidden')) {
        // 已经连上房间就按"离开"处理，别把人留在房间里占位
        if (this.net && this.net.state !== 'idle') this.hud._netLeave?.();
        this.hud.closeLobby();
        e.preventDefault();
        return;
      }

      if (isTyping(e) || e.isComposing) {
        // 顺便清掉可能残留的移动状态，避免输入时坦克还在跑
        this.keys.clear();
        this.firing = false;
        return;
      }

      // 单机：Esc = 暂停 / 继续。
      // 放在打字判断之后、其他按键之前：呼号框里按 Esc 应该只是失焦，
      // 不该顺手把仗停下来。
      if (e.key === 'Escape' && this.mode === 'solo') {
        if (this.paused) {
          this.resume();
          e.preventDefault();
          return;
        }
        if (this.state === 'playing') {
          this.pause();
          e.preventDefault();
          return;
        }
      }

      // 暂停期间不收战斗输入：否则 WASD / 空格会攒进 keys 里，
      // 恢复那一刻坦克"自己"动一下、或者直接对着空处开一炮
      if (this.paused) return;

      // F3：联机诊断信息（快照速率 / 抖动 / 停顿）。卡顿时先看这个。
      if (e.key === 'F3') {
        this._toggleNetDebug();
        e.preventDefault();
        return;
      }

      // 组队模式：整个世界交给 CoopMode 驱动，这里只留 Esc 收面板
      if (this.mode === 'coop') {
        if (e.key === 'Escape') {
          if (this.hud.lobby && !this.hud.lobby.classList.contains('hidden')) this.hud.closeLobby();
          else this.leaveCoop();
          e.preventDefault();
        }
        return;
      }

      const k = e.key.toLowerCase();

      // M 键静音
      if (k === 'm' && !e.repeat) {
        const muted = this.sound.toggleMute();
        this.sound.unlock();
        if (this.state === 'playing' || this.state === 'menu') {
          this.hud.showMessage(muted ? '声音 关' : '声音 开', 0.8);
        }
        e.preventDefault();
        return;
      }

      // 开始菜单：1~4 选车体。
      // 焦点在输入框里时不能抢键 —— 呼号允许数字（"铁骑01"），
      // 抢了就等于"想打数字结果换了车体"，而且输入框里还没输进去。
      const typing = document.activeElement?.tagName === 'INPUT';
      if (this.state === 'menu' && !typing && ['1', '2', '3', '4'].includes(k)) {
        this.hud.selectChassis(Number(k) - 1);
        e.preventDefault();
        return;
      }

      // 强化选择：1 / 2 / 3
      if (this.state === 'reward' && (k === '1' || k === '2' || k === '3')) {
        const choice = this.choices[Number(k) - 1];
        if (choice) this.pickUpgrade(choice.id);
        e.preventDefault();
        return;
      }

      // 军械选择：1 / 2 / 3
      if (this.state === 'armory' && (k === '1' || k === '2' || k === '3')) {
        const weapon = this.weaponChoices[Number(k) - 1];
        if (weapon) this.pickWeapon(weapon.id);
        e.preventDefault();
        return;
      }

      // 已解锁武器轮换
      if (k === 'q' && this.state === 'playing' && this.unlocked.length > 1) {
        this.cycleWeapon();
        e.preventDefault();
        return;
      }

      if (moveKeys.has(k)) {
        this.keys.add(k);
        e.preventDefault();
      }
      if (k === ' ') {
        if (this.state === 'playing') this.firing = true;
        e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (k === ' ') this.firing = false;
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
      this.firing = false;
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      // 鼠标一动就把瞄准从触屏手里接回来（平板接鼠标 / 触屏本很常见）
      this.touchAimAngle = null;
      screenToNDC(this.canvas, e.clientX, e.clientY, this.mouseNDC);
    });

    window.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.state === 'playing' && !this.paused) this.firing = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firing = false;
    });

    window.addEventListener('resize', () => this.resize());
    // 手机地址栏伸缩、全屏切换时，部分浏览器（尤其 iOS）不保证触发 window.resize，
    // visualViewport 那条更可靠；没有这个 API 就只靠上面那条。
    window.visualViewport?.addEventListener('resize', () => this.resize());
    // 进出全屏时 canvas 的 CSS 尺寸变了，但不一定伴随 window.resize
    document.addEventListener('fullscreenchange', () => this.resize());

    this.hud.bind({
      onStart: (id, opts) => {
        this.mode = 'solo';
        this.start(id, opts || {});
      },
      onCoop: (id, opts) => this.openCoop({ name: opts?.name, chassis: id }),
      onRestart: () => {
        this.mode = 'solo';
        this.restart();
      },
      onPick: (id) => this._pickCard(id),
      onWeapon: (id) => this.pickWeapon(id),
      onPause: () => this.pause(),
      onResume: () => this.resume(),
      onQuit: () => this.quitToMenu(),
    });

    // 进大厅前把网络回调接好（点「组队」时才真正连）
    this.hud.onCoopRequest = (opts) => this.openCoop(opts);
  }

  resize() {
    // 尺寸以 canvas 的实际矩形为准，不用 window：
    // 手机地址栏伸缩时 innerHeight 与 CSS 的 100dvh 会差几十像素，
    // 用 window 会把画面按错误的长宽比拉伸，准心和手指也会错位。
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------
  _clearHazards() {
    for (const w of this.warnings) {
      this.scene.remove(w.mesh);
      w.mesh.material.dispose();
    }
    this.warnings = [];
  }

  _clearField() {
    for (const e of this.enemies) {
      this.scene.remove(e.tank.group);
      if (e.sight) this.scene.remove(e.sight);
    }
    this.enemies = [];
    for (const b of this.bullets) b.destroy();
    this.bullets = [];
    this.effects.clear();
    this.pending = [];
    this._clearHazards();
  }

  _resetRun() {
    this.stats = createStats(this.chassisId);
    this.upgradeCounts = {};
    this.choices = [];
    this.weaponChoices = [];
    this.unlocked = ['assault'];
    this.heat = 0;
    this.overheated = false;
    this.kills = 0;
    this.runTime = 0;
    this.score = 0;
    this.wave = 0;
    this.waveActive = false;
    this.waveTimer = 0;
    this.waveTime = 0;
    this.clearedTimer = 0;
    this.playerCd = 0;
    this.overTimer = 0;
    this.shake = 0;
    this.firing = false;
    this.keys.clear();

    this.hud.setScore(0);
    this.hud.setKills(0);
    this.hud.setWave(1);
    this.hud.setLeft(0);
    this.hud.setReload(1);
    this.hud.renderChips([]);
    this.hud.setWeapon(WEAPONS.assault);
    this.hud.setHeat(0, false, false);
    this.hud.hideBossBar();
    this.hud.setBest(this.best);

    // 战场宝箱（r43）：上一局的箱子不带回新一局
    this.crates = [];          // { id, x, z, cat, visual }
    this._crateSeq = 0;
    this._clearCrateVisuals();
  }

  /** 摘掉场上所有宝箱模型（重开一局 / 退出到菜单时） */
  _clearCrateVisuals() {
    if (!this._crateRoot) return;
    for (const child of [...this._crateRoot.children]) this._crateRoot.remove(child);
  }

  /**
   * 播种本局随机流。
   *
   * 不再改写全局 Math.random —— 那会让「玩家开火」和「刷怪」共用一条序列，
   * 谁先开枪，后面的刷怪位置就变了，"同一局"根本无从谈起；
   * 一个进程里多开房间时也会互相踩踏。现在改为命名流，见 src/rng.js。
   */
  _applySeed(seed) {
    this.seed = seed >>> 0;
    R.setSeed(this.seed);
    return this.seed;
  }

  /**
   * 按本局种子铺地表。
   *
   * 为什么放在 start() 而不是构造时：重开一局要换一张图（fresh 的地表），
   * 但菜单背景不能每帧重建地面几何体。start 是唯一的"这局开始"的时点。
   *
   * 异或常数与 server/room.js 的做法一致：让"地形图案"和"波次序列"不共用一条流，
   * 否则以后调地形生成算法的步数，整局的出怪顺序会跟着变。
   */
  _applyTerrain(seed) {
    const tseed = this.terrainSeedFixed != null ? this.terrainSeedFixed : ((seed ^ 0x7e3a91) >>> 0);
    const map = buildTerrain(tseed, HALF, { k: presetK(this.terrainPreset) });
    this.terrainMap = map;
    this.world.setTerrain(map);
    this.minimap?.setTerrain?.(map);
    this._terrainTick = 0;
    return map;
  }

  /**
   * 按种子换一套建筑。
   *
   * 建筑是三件东西：碰撞表（world）、导航网格（nav）、小地图底图（minimap）。
   * 三者必须一起换，漏掉一个就会出现"能穿墙"或"AI 对着空气绕路"。
   * nav 是启动时按地图烘焙一次的，换图只能重建；一张 200×200 的网格
   * 大概 1~2ms，只在开局跑一次，不进帧循环。
   */
  _applyLayout(seed) {
    // `?map=old` 可以钉死上一版的固定布局，方便对比新旧图、复现老录像
    const mid = this.mapSeedFixed != null ? this.mapSeedFixed : seed;
    this.world.setLayout(generateBoxes(mid));
    this.nav = createNav(this.world);
    // 巡逻路线：种子生成，单机每局不同；同一局内所有驻军共用这几条线。
    // 用独立的 Rng 实例，不消耗 R 的 spawn/combat 流，刷怪序列不受影响。
    const pr = new Rng((mid ^ 0x2f7a31c5) >>> 0);
    this.patrolRoutes = buildPatrolRoutes(() => pr.spawn(), {
      half: HALF,
      blocked: (x, z, r) => this.world.blocked(x, z, r),
      avoid: [{ ...PLAYER_START, r: 30 }],
      count: 10,
      minGap: 26,
    });
    this.minimap?.invalidate?.();
    return mid;
  }

  start(chassisId, opts = {}) {
    // 出击时收回输入框焦点并清空按键，避免呼号框吃掉游戏按键 / 菜单按键残留
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur?.();
    }
    this.paused = false;
    this.keys.clear();
    this.firing = false;
    this.chassisId = normalizeChassisId(chassisId);
    if (opts.name) this.callsign = opts.name;

    // 普通模式：每局随机（同一天不再固定，玩法本来就允许挑图）
    const seed = opts.seed != null ? opts.seed >>> 0 : randomSeed();
    this._applySeed(seed);
    this._applyTerrain(seed);
    this._applyLayout(seed);
    this.sound.unlock();
    this.sound.startMusic();
    this.sound.fanfare();
    this._clearField();
    this._resetRun();

    // 本局挑战词条
    this.mods = rollModifier();
    this.stats.fireRateMul *= this.mods.fireRateMul;
    // 词条改的是雾的"基准距离"，画质档位再乘系数——两层互不覆盖
    if (this.mods.fogNear) {
      this.scene.fog.near = this.mods.fogNear * this.quality.fogMul;
      this.scene.fog.far = this.mods.fogFar * this.quality.fogMul;
    } else {
      this.scene.fog.near = FOG_BASE.near * this.quality.fogMul;
      this.scene.fog.far = FOG_BASE.far * this.quality.fogMul;
    }
    this.hud.setModifier(this.mods);

    this._resetPlayer();
    this.camera.position.set(PLAYER_START.x, CAM_HEIGHT, PLAYER_START.z + CAM_BACK);
    this.camLook.set(PLAYER_START.x, 1, PLAYER_START.z);
    // 清掉逐帧速度缓存：否则第一帧的"速度"是 (新位置 - 上一局最后位置) / dt，
    // 会是一个荒唐的大值，相机跟着前馈飞出去。
    this._lastPlayerX = null;
    this._lastPlayerZ = null;
    this.playerVel.x = 0;
    this.playerVel.z = 0;
    this.aimPoint.set(PLAYER_START.x, 0, PLAYER_START.z - 10);
    this.hud.setHealth(this.player.hp, this.player.maxHp);

    this.hud.startPlaying();
    // 单人局才给暂停按钮（联机在 coop.js 里显式关掉）
    this.hud.setPausable(true);
    this.state = 'playing';
    // 新一局从"没有触屏朝向"开始：否则上一局最后指的方向会带进来，
    // 开局第一炮就朝一个玩家没选过的角度
    this.touchAimAngle = null;
    this.touch.refresh();
    this.aimMarker.visible = true;
    this.camera.lookAt(this.camLook);
    const c = CHASSIS[this.chassisId];
    this.hud.showMessage(`${c.name} · 出击 ｜ ${this.mods.icon} ${this.mods.name} · ${this.mods.desc}`, 2.6);
    this.startWave(1);
  }

  restart() {
    // 重开换一张图，保持新鲜感
    this.start(this.chassisId, { name: this.callsign });
  }

  /**
   * 暂停（单人局）。
   *
   * 冻结方式是 update() 里直接 return —— 波次计时、敌人、子弹、特效全停，
   * 不是"把速度乘 0"那种半吊子做法（那样计时器还在走，暂停久了会直接跳波）。
   * 画面仍然每帧重画：WebGL 画布默认不保留缓冲，停止渲染会被合成器刷黑。
   *
   * 联机局没有这个入口：世界由服务端 tick 驱动，本地按 Esc 停不了服务器，
   * 单方面"暂停"只会让画面定格、人还在挨打。
   */
  pause() {
    if (this.mode !== 'solo' || this.state !== 'playing' || this.paused) return;
    this.paused = true;
    this.keys.clear();
    this.firing = false;
    // 摇杆立即收起：点击暂停那一下的落点可能正好压住右下摇杆
    this.touch.refresh();
    this.hud.showPause({
      wave: this.wave,
      kills: this.kills,
      score: this.score,
      time: formatTime(this.runTime),
    });
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.hud.hidePause();
    // showPause 摘掉了 playing（要让光标可见），这里补回来
    this.hud.app?.classList.add('playing');
    this.touch.refresh();
    // 暂停期间 THREE.Clock 仍在走，恢复第一帧的 dt 会很大，
    // 主循环里的 Math.min(dt, 0.05) 兜住了：最多往前走 50ms，不会瞬移。
  }

  /**
   * 退出本局回主菜单。
   * 不上传成绩、不写最佳：中途撂下的局不该进排行榜，
   * 否则"打到第 20 波就退"能刷出一个比真打完还漂亮的记录。
   */
  quitToMenu() {
    // 组队有自己的一套（要断线、给服务端清理席位），不要在这里重复实现
    if (this.mode !== 'solo') {
      this.leaveCoop();
      return;
    }
    this.paused = false;
    this.state = 'menu';
    this.keys.clear();
    this.firing = false;
    this.hud.hidePause();
    this.hud.setPausable(false);
    this.touch.refresh();
    this.sound.stopMusic(0.5);

    // 清场：不清的话菜单背景里停着上一局的战场（敌人原地不动、箱子还在闪）
    this._clearField();
    this.crates = [];
    this._clearCrateVisuals();
    this.zones = [];
    this.zoneVis?.sync?.(this.zones);
    this.hud.hideBossBar();
    this.hud.setModifier(null);
    this.hud.setLeft(0);
    this.hud.renderChips([]);

    // 车体回到出生点：菜单后面那辆坦克不该是"打烂在战场上"的样子
    this._resetPlayer();
    this.camera.position.set(PLAYER_START.x, CAM_HEIGHT, PLAYER_START.z + CAM_BACK);
    this.camLook.set(PLAYER_START.x, 1, PLAYER_START.z);
    this.camera.lookAt(this.camLook);
    this.aimMarker.visible = false;
    this._setPeekOff();

    this.hud.overlay?.classList.remove('hidden');
    this.hud.hud?.classList.add('hidden');
    this.hud.gameover?.classList.add('hidden');
    this.hud.reward?.classList.add('hidden');
    this.hud.app?.classList.remove('playing');
    // 榜单与最佳成绩重新拉一次：这局不上榜，但别人可能刚破了纪录
    this.hud.invalidateMenuBoard?.();
  }

  /** 「战况」展开态是 #app 上的类，退出战斗时要收回（HUD 那边私有，这里补一刀） */
  _setPeekOff() {
    this.hud._setPeek?.(false);
    this.hud.app?.classList.remove('peek-on');
  }

  /**
   * 音效空间化的"耳朵"：相机位置 + 朝向（投到 XZ 平面）。
   * 只交出纯数字，sound.js 因此不必 import THREE，测试里也能直接喂假坐标。
   * 联机模式下 CoopMode 复用同一个相机，直接调 game.listener() 即可。
   */
  listener() {
    const c = this.camera.position;
    const f = this.camLook;
    return { x: c.x, z: c.z, fx: f.x - c.x, fz: f.z - c.z };
  }

  /**
   * 单机模式的触屏接收方：只写现有的三个输入字段（keys 之外的 touchMove /
   * mouseNDC / firing），战斗逻辑一行不改。
   *
   * enabled() 卡在"正在战斗"：选卡、结算、菜单里摇杆一律不响应——
   * 否则点卡片那一下会被当成开火，或者手指压在屏幕上就把坦克推走了。
   */
  soloTouchTarget() {
    return {
      enabled: () => this.state === 'playing' && !this.paused,
      move: (x, z) => { this.touchMove.x = x; this.touchMove.z = z; },
      // 只交朝向：瞄准点由 _updateAim 按固定半径算，手指不会挡住目标
      aim: (angle) => { this.touchAimAngle = angle; },
      fire: (on) => { this.firing = on && this.state === 'playing' && !this.paused; },
    };
  }

  /**
   * 触屏瞄准：朝向 + 可选吸附 → 坦克周围固定半径上的世界点。
   * 半径不参与弹道，只决定准心环画在哪，所以 17m 纯粹是个手感数字。
   */
  _aimFromTouch(out) {
    const p = this.player.group.position;
    let ang = this.touchAimAngle;
    if (this.aimAssist && this.enemies.length) {
      // 缓冲每帧复用：一帧几百个敌人也不产生垃圾
      const buf = this._assistBuf;
      let n = 0;
      for (const e of this.enemies) {
        if (!e.alive) continue;
        const q = e.position;
        const t = buf[n] || (buf[n] = { x: 0, z: 0 });
        t.x = q.x;
        t.z = q.z;
        n++;
      }
      ang = assistAim(ang, p.x, p.z, buf, { count: n }).angle;
    }
    out.set(p.x + Math.sin(ang) * AIM_RANGE, 0.06, p.z + Math.cos(ang) * AIM_RANGE);
    return out;
  }

  startWave(n) {
    this.wave = n;
    const bossWave = n % 5 === 0;
    const eliteWave = !bossWave && (n % 5 === 3 || this.mods.eliteEveryWave);
    // 战场扩大到 200×200 后，每波追加少量敌人，避免密度被摊薄。
    // r42：前 7 波不变；第 8 波起增速放缓（2.5/波 → 1.4/波），
    // 省下的数量折成单体血量（5%/波，封顶 +30%）——与联机 (core/world.js) 同一条曲线。
    const base = (n <= 7
      ? 2 + n * 2 + Math.min(6, Math.floor(n / 2))
      : Math.round(19 + (n - 7) * 1.4)) - (n % 5 === 3 ? 2 : 0);
    const hpBoost = n <= 7 ? 1 : 1 + Math.min(0.30, (n - 7) * 0.05);
    const count = base;
    const hp = Math.round((55 + n * 14) * this.mods.enemyHpMul * hpBoost);
    const speed = 8.5 + Math.min(4.5, n * 0.6);
    const chargers = n >= 2 && !bossWave ? Math.min(6, Math.floor(n / 2)) : 0;

    // 配乐随波次加压：开场 0.45，常规波最高 0.72，Boss 波 0.95
    this.sound.setMusicIntensity(bossWave ? 0.95 : Math.min(0.72, 0.42 + n * 0.03));

    this.waveActive = true;
    this.waveTime = 0;
    this.huntSent = false;
    this.pending = [];
    // 岩浆 / 炮击预警属于"上一波那个 Boss 留下的东西"，开新波必须清干净，
    // 否则第 36 波开局脚下还烫着第 35 波的岩浆。
    this.zones.length = 0;
    this.beamVis.clear();
    this.playerCd = 0;
    this.heat = 0;
    this.overheated = false;
    this.hud.setHeat(0, false, !!WEAPONS[this.stats.weaponId].heat);

    if (bossWave) {
      this.sound.bossIn();
      // 轮换与血量都走 bosskit（与联机同一份）：W5 破城者 → W10 棱镜 →
      // W15 幽影 → … → W50 终焉，55 波起随机。以前这里是 floor(n/5) 的
      // 奇偶三元，加一个 Boss 就要在单机、联机、HUD 三处各改一遍。
      const bossType = bossTypeForWave(n) || pickLateBoss(() => R.spawn(), this._lastBossType);
      this._lastBossType = bossType;
      const bossMeta = BOSS_META[bossType] || BOSS_META.boss_breaker;
      const bossHp = bossHpFor(n, bossType, 1);
      // 觉醒词条（55 波起）：与联机同一份池子、同一套数值。
      // 抽签流用 R.stream 而不是 R.combat——词条要可复现，重开同一局不该变。
      const awaken = rollAwakens(n, R.stream('awaken'));
      // 双生要出两只；两只的间隔给 1.6 秒，避免同时落地把玩家夹住
      const twins = bossMeta.twins || 1;
      for (let i = 0; i < twins; i++) {
        this.pending.push({
          t: 0.7 + i * 1.6,
          hp: bossHp,
          speed: bossMeta.speed,
          type: bossType,
          warn: 1.5,
          awaken,
        });
      }
      // 护卫封顶 8 只：3 + floor(n/4) 到第 40 波是 13 只，再叠召唤类会破
      // "同屏 ≤18"的预算（r42 刚因为对象太多减过量）。
      const adds = Math.min(8, Math.round((3 + Math.floor(n / 4))
        * (awaken.includes('summon') ? AWAKEN_NUM.escortMul : 1)));
      for (let i = 0; i < adds; i++) {
        this.pending.push({
          t: 1.7 + i * 0.9,
          hp: Math.round(hp * 0.8),
          speed,
          type: 'gunner',
        });
      }
      this.hud.showMessage(`第 ${n} 波  ·  ${bossMeta.name} 来袭`, 2.2);
    } else {
      if (eliteWave) {
        // 精英小队：2~3 辆错峰入场，单体血量相应下调（5.2x → 4x）
        const eliteCount = this.wave >= 13 ? 3 : 2;
        for (let i = 0; i < eliteCount; i++) {
          this.pending.push({
            t: 1.2 + i * 2.4,
            hp: Math.round(hp * 4),
            speed: speed * 0.8,
            type: 'elite',
            warn: 1.1,
          });
        }
      }
      for (let i = 0; i < count; i++) {
        this.pending.push({ t: i * 0.75, hp, speed, type: 'gunner' });
      }
      for (let j = 0; j < chargers; j++) {
        this.pending.push({
          t: 2.2 + j * 1.1,
          hp: Math.max(30, Math.round(hp * 0.5)),
          speed: speed * 1.05,
          type: 'charger',
        });
      }

      // ---- M3 敌人扩展（仅非 Boss 波） ----
      if (n >= 4) {
        // 自爆无人机：低血高速飞行
        const drones = Math.min(4, Math.floor((n - 2) / 2));
        for (let i = 0; i < drones; i++) {
          this.pending.push({
            t: 3.5 + i * 1.4,
            hp: Math.max(18, Math.round(hp * 0.3)),
            speed: speed * 1.15,
            type: 'drone',
          });
        }
      }
      if (n >= 6) {
        // 炮台：固定远程，必须拔掉
        const turrets = Math.min(2, 1 + Math.floor(n / 12));
        for (let i = 0; i < turrets; i++) {
          this.pending.push({
            t: 2.5 + i * 3,
            hp: Math.round(hp * 2.2),
            speed: 0,
            type: 'turret',
            warn: 1.4,
          });
        }
      }
      if (n >= 7) {
        // 补给车：治疗光环
        this.pending.push({
          t: 4.5,
          hp: Math.round(hp * 1.4),
          speed: speed * 0.95,
          type: 'support',
          warn: 1.2,
        });
      }
      if (n >= 8) {
        // 重盾兵：正面减伤
        const shields = Math.min(3, Math.floor((n - 4) / 2));
        for (let i = 0; i < shields; i++) {
          this.pending.push({
            t: 5.5 + i * 2.2,
            hp: Math.round(hp * 1.3),
            speed: speed * 0.9,
            type: 'shield',
          });
        }
      }
      this.hud.showMessage(
        eliteWave
          ? `第 ${n} 波  ·  精英来袭`
          : `第 ${n} 波  来袭${chargers > 0 ? `  ·  ${chargers} 辆冲锋兵` : ''}`,
        eliteWave ? 2 : 1.7
      );
    }

    this.state = 'playing';
    this.touch.refresh();
    this.hud.setWave(n);
    // 战场宝箱（r43）：每波空投，与联机 (core/world.js) 同一份数量曲线
    this._spawnCratesSolo();
  }

  /**
   * 单机空投。宝箱带类别标识（火力/装甲/机动/维修），内容在拾取时才
   * 按玩家当前成长状态开出——已满级的卡永远不会从箱子里出来。
   */
  _spawnCratesSolo() {
    const p = this.player.group.position;
    const count = crateCount(1, () => R.spawn(), this.wave);
    const pts = cratePositions({
      half: this.world.half || HALF,
      players: [p],
      blocked: (x, z) => this.world.blocked(x, z, 2.2),
      rnd: () => R.spawn(),
      count,
    });
    if (!pts.length) return;
    if (!this._crateRoot) {
      this._crateRoot = new THREE.Group();
      this._crateRoot.name = 'crates';
      this.scene.add(this._crateRoot);
    }
    for (const pt of pts) {
      const cat = rollCategory(() => R.spawn());
      const visual = makeCrate(cat);
      visual.group.position.x = pt.x;
      visual.group.position.z = pt.z;
      this._crateRoot.add(visual.group);
      this.crates.push({ id: ++this._crateSeq, x: pt.x, z: pt.z, cat, visual });
    }
  }

  /** 单机拾取判定 + 宝箱动画。state=playing 时每帧调用 */
  _updateCratesSolo(dt) {
    if (!this.crates.length && !this._crateRoot?.children.length) return;
    for (const c of this.crates) c.visual.update(dt);
    if (this.state !== 'playing' || !this.player.alive) return;
    const p = this.player.group.position;
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      if (Math.hypot(p.x - c.x, p.z - c.z) > 3.2) continue;

      const card = rollCard(this.stats, this.upgradeCounts, c.cat, () => R.spawn());
      card.apply(this.stats, this.player);
      this.upgradeCounts[card.id] = (this.upgradeCounts[card.id] || 0) + 1;
      this.player.speed = this.stats.speed;
      this.player.maxHp = this.stats.maxHp;
      this.player.hp = Math.min(this.player.hp, this.player.maxHp);

      const def = CATEGORIES[c.cat] || CATEGORIES.support;
      this.effects.explosion(
        new THREE.Vector3(c.x, 1.2, c.z), def.color, 10, 0.7,
      );
      this.sound.select();
      this.hud.showMessage(
        `获得强化：${card.icon} ${card.name}  ·  装甲 ${Math.round(this.player.hp)}/${this.player.maxHp}`, 2.2,
      );

      this._renderChips();
      this.hud.setHealth(this.player.hp, this.player.maxHp);

      this._crateRoot.remove(c.visual.group);
      c.visual.dispose();
      this.crates.splice(i, 1);
    }
  }

  /** 在玩家 30~60 米外的环形区域找落点，优先选被掩体挡住视线的位置 */
  _findSpawnPoint(minR = 36, maxR = 60) {
    const p = this.player.group.position;
    const half = this.world.half;
    let fallback = null;

    for (let attempt = 0; attempt < 70; attempt++) {
      const a = R.spawn() * Math.PI * 2;
      const r = minR + R.spawn() * (maxR - minR);
      const x = THREE.MathUtils.clamp(p.x + Math.sin(a) * r, -half + 5, half - 5);
      const z = THREE.MathUtils.clamp(p.z + Math.cos(a) * r, -half + 5, half - 5);

      if (Math.hypot(x - p.x, z - p.z) < Math.min(30, minR)) continue;
      if (this.world.blocked(x, z, 2.4)) continue;
      if (this.enemies.some((e) => Math.hypot(e.position.x - x, e.position.z - z) < 8)) continue;
      if (this.warnings.some((w) => Math.hypot(w.x - x, w.z - z) < 5)) continue;

      if (!this.world.segmentBlocked(x, z, p.x, p.z, 0.5)) {
        return { x, z };
      }
      if (!fallback) fallback = { x, z };
    }
    if (fallback) return fallback;

    // 玩家贴边时的兜底：用最远的固定出生点
    let best = this.world.spawnPoints[0];
    let bestD = -1;
    for (const sp of this.world.spawnPoints) {
      const d = sp.distanceTo(p);
      if (d > bestD) { bestD = d; best = sp; }
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = THREE.MathUtils.clamp(best.x + (R.spawn() - 0.5) * 10, -half + 5, half - 5);
      const z = THREE.MathUtils.clamp(best.z + (R.spawn() - 0.5) * 10, -half + 5, half - 5);
      if (this.world.blocked(x, z, 2.2)) continue;
      if (Math.hypot(x - p.x, z - p.z) < 20) continue;
      return { x, z };
    }
    return {
      x: THREE.MathUtils.clamp(best.x, -half + 5, half - 5),
      z: THREE.MathUtils.clamp(best.z, -half + 5, half - 5),
    };
  }

  /** 落点预警 0.8s（Boss 1.5s）后再真正生成敌人，避免刷在脸上 */
  _beginSpawn(hp, speed, type = 'gunner', warn = 0.8, awaken = null) {
    const boss = type.startsWith('boss_');
    const spot = boss
      ? this._findSpawnPoint(32, 44)
      : this._findSpawnPoint();
    const radius = boss ? 4.6
      : type === 'charger' ? 2.0
      : type === 'drone' ? 1.2
      : type === 'turret' ? 2.0
      : type === 'support' ? 2.2
      : type === 'elite' ? 3.0 : 2.4;
    const color = boss
      ? (type === 'boss_breaker' ? 0xff2a1a : 0x38d8ff)
      : type === 'charger' ? 0xff8a2a
      : type === 'drone' ? 0xc07bff
      : type === 'turret' ? 0xffa03a
      : type === 'support' ? 0x57d877
      : type === 'shield' ? 0x6fa8ff
      : type === 'elite' ? 0xffd257 : 0xff4a3a;
    const mesh = new THREE.Mesh(WARN_GEO, new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(spot.x, 0.07, spot.z);
    mesh.scale.setScalar(radius / 1.85);
    this.scene.add(mesh);

    this.warnings.push({
      x: spot.x, z: spot.z, t: warn, hp, speed, type, mesh, radius, dur: warn, awaken,
    });
  }

  /**
   * 单机编成：约 2/3 的常规敌人是驻守/巡逻，其余猎杀。
   * Boss 用单点锚位（守区域、有限追击）；自爆兵/无人机/补给车保持猎杀。
   */
  _patrolRouteFor(type, x, z) {
    if (type.startsWith('boss_')) return anchorRoute('boss', x, z);
    if (type === 'charger' || type === 'drone' || type === 'support' || type === 'turret') return null;
    if (!this.patrolRoutes || !this.patrolRoutes.length) return null;
    const pr = R.stream('patrolRoles');
    if (pr() >= 0.66) return null;
    return this.patrolRoutes[Math.min(
      this.patrolRoutes.length - 1,
      Math.floor(pr() * this.patrolRoutes.length)
    )];
  }

  _spawnEnemyAt(hp, speed, x, z, type, awaken = null) {
    const enemy = new Enemy(this.scene, {
      x, z, hp, speed, type, awaken,
      camera: this.camera,
      patrolRoute: this._patrolRouteFor(type, x, z),
    });
    this.enemies.push(enemy);
    this.effects.explosion(new THREE.Vector3(x, 1, z), 0xff7a3d, 8, 0.7);
  }

  _updateWarnings(dt) {
    for (let i = this.warnings.length - 1; i >= 0; i--) {
      const w = this.warnings[i];
      w.t -= dt;
      const k = 1 - Math.max(0, w.t) / w.dur;
      w.mesh.material.opacity = 0.35 + 0.45 * Math.abs(Math.sin(k * Math.PI * 3));
      w.mesh.scale.setScalar((w.radius / 1.85) * (0.72 + 0.34 * k));

      if (w.t <= 0) {
        // 生成前的硬校验：距离玩家或任何存活坦克过近就换点，杜绝贴脸刷
        const pp = this.player.group.position;
        const minPlayer = w.type.startsWith('boss_') ? 26 : 24;
        const dPlayer = Math.hypot(pp.x - w.x, pp.z - w.z);
        const dEnemy = this.enemies.some(
          (e) => Math.hypot(e.position.x - w.x, e.position.z - w.z) < 9
        );
        if (dPlayer < minPlayer || dEnemy) {
          const boss = w.type.startsWith('boss_');
          const spot = boss ? this._findSpawnPoint(32, 44) : this._findSpawnPoint();
          w.x = spot.x;
          w.z = spot.z;
          w.t = boss ? 0.9 : 0.6;
          w.dur = w.t;
          w.mesh.position.set(w.x, 0.07, w.z);
          continue;
        }
        this.scene.remove(w.mesh);
        w.mesh.material.dispose();
        this.warnings.splice(i, 1);
        this._spawnEnemyAt(w.hp, w.speed, w.x, w.z, w.type, w.awaken);
      }
    }
  }

  /**
   * 玩家受伤的统一入口（r46）。
   *
   * 以前"玩家掉血"这段（吃抗性卡 + HUD + 音效 + 死亡）在 bossShock、
   * 子弹命中、自爆三处各写一遍；岩浆和激光是持续伤害，每秒要结算好几次，
   * 再复制一遍就别想改了。
   *
   * @param {number} amount 伤害（可以是小数：持续伤害按 dps × dt 累加）
   * @param {boolean} [quiet] 不播音效（持续伤害每 0.2 秒响一次会糊成一片）
   */
  hurtPlayer(amount, quiet = false) {
    if (!this.player.alive || this.state !== 'playing') return;
    const dmg = Math.max(1, Math.round(amount * (this.stats.damageTakenMul ?? 1)));
    const died = this.player.takeDamage(dmg);
    if (!quiet) this.sound.hurt();
    this.hud.hurt();
    this.hud.setHealth(this.player.hp, this.player.maxHp);
    if (!quiet) this.shake = Math.max(this.shake, 0.25);
    if (died) this._onPlayerDeath();
  }

  /**
   * Boss 范围伤害（r46）：幽影的落地冲击波、疾风的冲刺撞击共用。
   *
   * 和联机 World._damagePlayer 保持同样的语义（吃 damageTakenMul），
   * 否则"单人抗性卡"在两种模式下价值不一样。
   */
  bossShock(pos, radius, damage) {
    if (!this.player.alive) return;
    const p = this.player.group.position;
    if (Math.hypot(p.x - pos.x, p.z - pos.z) >= radius) return;
    this.hurtPlayer(damage);
  }

  /**
   * 场地标记（r46）：岩浆区、炮击预警。
   *
   * 与联机 World._addZone 同一条数据结构，渲染走同一个 ZoneVisual，
   * 结算走同一个 core/bosskit.js::stepZones。
   */
  addZone(kind, x, z, r, dur) {
    const zone = { kind, x, z, r, t: 0, ttl: dur, dur };
    this.zones.push(zone);
    return zone;
  }

  _updateZones(dt) {
    const pos = this.player.group.position;
    const t = this._zoneTarget;
    t.x = pos.x;
    t.z = pos.z;
    t.alive = this.player.alive;
    t.down = false;
    const evs = this._zoneEvents;
    evs.length = 0;
    stepZones(this.zones, dt, [t], (_t, amount) => this.hurtPlayer(amount, true), evs);
    // 炮击落地：stepZones 只负责判定和"炸了"这件事，表现留给这边
    for (const ev of evs) {
      const p = new THREE.Vector3(ev.x, 1, ev.z);
      this.effects.explosion(p.clone(), 0xff3b1a, 30, 1.2);
      this.sound.explosionAt(p, 1.5, this.listener());
      this.shake = Math.max(this.shake, 0.5);
    }
  }

  /** 哨戒的两道光束：位置/角度直接读 Boss 本体，判定在 Enemy 那边 */
  _syncBeams() {
    const list = this._beamList;
    list.length = 0;
    for (const e of this.enemies) {
      if (e.bossKind !== 'warden' || !e.alive || e.laserYaw === undefined) continue;
      const p = e.position;
      const len = BOSS_SKILLS.laser.len;
      list.push({ x: p.x, z: p.z, yaw: e.laserYaw, len });
      list.push({ x: p.x, z: p.z, yaw: e.laserYaw + Math.PI, len });
    }
    this.beamVis.sync(list);
  }


  /** 蜂巢召唤的无人机（r46）：绑定召唤者，本体一死就一起清 */
  spawnDrone(summoner, x, z, hp) {
    const enemy = new Enemy(this.scene, {
      x, z, hp, speed: 9, type: 'drone', camera: this.camera, patrolRoute: null,
    });
    enemy.summoner = summoner;
    this.enemies.push(enemy);
    this.effects.explosion(new THREE.Vector3(x, 1, z), 0xc06bd8, 6, 0.6);
  }

  /** 终焉二阶段的精英护卫（r46）：走同一套小兵 AI，只是血更厚 */
  spawnElite(x, z) {
    const hp = Math.round((55 + this.wave * 14) * 4);
    this._spawnEnemyAt(hp, 9, x, z, 'elite');
  }

  /** 冲锋兵贴脸自爆 */
  chargerBurst(enemy, damage, radius) {
    const idx = this.enemies.indexOf(enemy);
    if (idx === -1) return;
    this.enemies.splice(idx, 1);
    const pos = enemy.position.clone();
    this.scene.remove(enemy.tank.group);

    this.kills += 1;
    this.score += 100;
    this.hud.setKills(this.kills);
    this.hud.setScore(this.score);
    this.effects.explosion(pos.clone().setY(1), 0xff9a3d, 26, 1.3);
    this.sound.explosionAt(pos, 1.2, this.listener());
    this.shake = Math.max(this.shake, 0.4);

    const p = this.player.group.position;
    if (this.player.alive && Math.hypot(p.x - pos.x, p.z - pos.z) < radius) {
      const died = this.player.takeDamage(
        Math.max(1, Math.round(damage * (this.stats.damageTakenMul ?? 1)))
      );
      this.hud.hurt();
      this.sound.hurt();
      this.hud.setHealth(this.player.hp, this.player.maxHp);
      if (died) this._onPlayerDeath();
    }
  }

  // ------------------------------------------------------------------
  fire(tank, dir, damage, team, opts = {}) {
    const pos = tank.muzzleWorld(new THREE.Vector3());

    // 高度放行校验：高个子炮口发射的水平弹永远打不到人。
    //
    // 这条曾经是"破城者主炮一点伤害都没有"的元凶：Boss 模型放大后炮口
    // 在 2.89 米（棱镜 2.39 米），而玩家命中判定的上限是 HIT_TOP = 2.3 米，
    // 平射出去的炮弹从头顶掠过、判定永远不成立，玩家只看到它在开炮。
    //
    // 这里只拦**几乎平射**的弹（|俯角| < 1.4°）：
    // Boss 主炮在 Enemy 里已经按实际交战距离算好了俯角（flatPitch，斜率
    // 0.03~0.12），这个兜底绝不能碰它——曾经把"俯角不足"的判据写成了
    // 0.18，又用方向向量的水平长度（≈1）当距离去除高度差，算出 1.8 的
    // 斜率，把好好的弹压成 60° 砸在 Boss 脚下（实测离玩家最近 12 米）。
    let vx = dir.x;
    let vy = dir.y;
    let vz = dir.z;
    let aim = dir;
    const horiz = Math.hypot(vx, vz);
    if (team !== 'player' && horiz > 1e-4 && vy / horiz > -FLAT_SLOPE) {
      // fire() 不知道目标多远，按典型交战距离 18 米补：2.89 米的炮口压出
      // 0.10 的斜率（5.6°），14~25 米全程都在 0~2.3 米的判定带里；
      // 1.6 米的小兵炮口只压 0.03，弹道几乎不变。
      const need = (pos.y - AIM_BODY_Y) / 18;
      aim = TMP3.set(vx, -Math.max(FLAT_SLOPE, need), vz).normalize();
    }

    this.bullets.push(new Bullet(this.scene, {
      pos,
      dir: aim,
      team,
      damage,
      speed: opts.speed ?? (team === 'player' ? 68 : 50),
      life: 3,
      pierce: opts.pierce ?? 0,
      explosive: opts.explosive ?? 0,
      splashMul: opts.splashMul ?? 1,
      color: opts.color,
      glow: opts.glow,
      scale: opts.scale ?? 1,
    }));
    this.effects.muzzle(pos, aim);
    tank.recoil();
    this.sound.shoot(team, opts.weaponKind);
    if (team === 'player') this.shake = Math.max(this.shake, 0.1);
  }

  _firePlayer(dir, w) {
    const s = this.stats;
    const n = s.multishot;
    const base = Math.atan2(dir.x, dir.z);

    // 多联装：左右对称散布；速射机炮额外随机散布
    const spread = 0.055;
    for (let i = 0; i < n; i++) {
      const jitter = w.spread ? (R.combat() - 0.5) * w.spread * 2 : 0;
      const a = base + (i - (n - 1) / 2) * spread + jitter;
      const d = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      this.fire(this.player, d, w.damage, 'player', {
        speed: w.bulletSpeed,
        pierce: w.pierce,
        explosive: w.explosive,
        splashMul: w.splashMul,
        color: w.color,
        glow: w.glow,
        scale: w.scale,
        weaponKind: w.weapon.id,
      });
    }
  }

  _updateAim() {
    // 触屏朝向一旦确立就一直有效，直到鼠标动一下把它接回去（见 _initInput）。
    // 抬手不清朝向，因为炮塔有转速，回弹手感很别扭。
    if (this.touchAimAngle !== null && this.player?.alive) {
      this._aimFromTouch(TMP);
      this._applyAim(TMP.x, TMP.z);
      return;
    }
    this.aimRay.setFromCamera(this.mouseNDC, this.camera);
    const hit = this.aimRay.ray.intersectPlane(this.groundPlane, TMP);
    if (!hit) return;
    this._applyAim(TMP.x, TMP.z);
  }

  _applyAim(x, z) {
    this.aimPoint.set(x, 0, z);

    // 指示环跟随**炮口实际指向**，不是鼠标。
    // 炮塔转速有限（轻装 / 猎手 170°/s），鼠标已经甩到侧面时炮口还在半路——
    // 环如果挂在鼠标上，玩家会以为"瞄准了却打不中"。
    // 现在环会停在炮口真正能到的位置并变红，转到位后自动变回正常色。
    let mx = x;
    let mz = z;
    const p = this.player;
    if (p && p.alive) {
      const dx0 = x - p.x;
      const dz0 = z - p.z;
      const dist = Math.hypot(dx0, dz0);
      if (dist > 1.2) {
        const off = angleDiff(Math.atan2(dx0, dz0), p.turretYaw);
        const clipped = Math.abs(off) > 0.03;
        if (clipped) {
          const r = Math.min(dist, 14);
          mx = p.x + Math.sin(p.turretYaw) * r;
          mz = p.z + Math.cos(p.turretYaw) * r;
        }
        this.aimMarker.material.color.setHex(clipped ? 0xd0553a : 0xff9a3d);
        this.aimMarker.material.opacity = clipped ? 0.55 : 0.75;
      }
    }
    this.aimMarker.position.set(mx, 0.06, mz);

    // 触屏模式下准心跟着这个环走，而不是跟着手指 —— 屏幕上手指压住的位置
    // 通常是"目标所在"，准心再画在那里就等于没有。
  }

  /** 顶部地表指示：0.12 秒刷一次就够，玩家看不出差别，还省 DOM 重排 */
  _updateTerrainChip(dt) {
    this._terrainAcc = (this._terrainAcc || 0) + dt;
    if (this._terrainAcc < 0.12) return;
    this._terrainAcc = 0;
    // 单机 Tank 没有 x/z 字段，位置只存在 group.position 上
    const p = this.player?.group?.position;
    if (!p || !this.world.hasTerrain) { this.hud.setTerrain(null); return; }
    const t = TERRAIN[this.world.terrainAt(p.x, p.z)];
    this.hud.setTerrain({
      name: t.name,
      color: '#' + t.color.toString(16).padStart(6, '0'),
      speed: this.world.speedAt(p.x, p.z),
    });
  }

  _updatePlayer(dt) {
    const player = this.player;
    if (!player.alive) return;

    // 位移前的位置：函数末尾用它反推本帧速度，供敌方主炮算提前量
    const pos = player.group.position;
    const ox = pos.x;
    const oz = pos.z;

    let mx = 0;
    let mz = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) mz -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) mz += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) mx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;

    // 触屏摇杆叠加在键盘之上（平板接键盘 + 触屏可以同时用）。
    // 向量长度就是油门（0~1）：Tank.move / stepBody 按长度缩放步长，
    // 键盘分量是 ±1 所以斜推照样满速。这里只把合成结果钳在单位圆内，
    // 保证"键盘 + 摇杆同方向"不会超速。
    if (this.touchMove.x || this.touchMove.z) {
      mx += this.touchMove.x;
      mz += this.touchMove.z;
      const mlen = Math.hypot(mx, mz);
      if (mlen > 1) { mx /= mlen; mz /= mlen; }
    }

    if (mx || mz) player.move(mx, mz, dt, this.world);

    const p = player.group.position;
    const dx = this.aimPoint.x - p.x;
    const dz = this.aimPoint.z - p.z;
    const aimLen = Math.hypot(dx, dz);
    // 炮塔朝鼠标转，但受射界与转速限制（core/motion.js 的同一份实现）
    if (aimLen > 1.2) player.aimAt(this.aimPoint.x, this.aimPoint.z, dt);

    const w = resolveWeapon(this.stats);

    // 激光散热 / 过热锁定
    if (w.heat) {
      if (this.overheated) {
        this.heat = Math.max(0, this.heat - w.heat.lockCool * dt);
        if (this.heat <= 0.06) {
          this.heat = 0;
          this.overheated = false;
        }
      } else if (!this.firing) {
        this.heat = Math.max(0, this.heat - w.heat.cool * dt);
      }
    }

    this.playerCd -= dt;
    if (this.firing && !this.overheated && this.playerCd <= 0 && aimLen > 1.2) {
      this.playerCd = w.fireCd;
      // 弹道走炮口朝向，不是鼠标朝向。
      // 炮口还在追鼠标（转速上限）时，两者不是一个方向——如果按鼠标方向开火，
      // 屏幕上炮管指着前面、炮弹却横着飞出去。
      const fy = player.turretYaw;
      this._firePlayer(new THREE.Vector3(Math.sin(fy), 0, Math.cos(fy)), w);

      if (w.heat) {
        this.heat += w.heat.perShot;
        if (this.heat >= 1) {
          this.heat = 1;
          this.overheated = true;
          this.sound.overheat();
          this.hud.showMessage('炮管过热 · 停火冷却', 1.1);
        }
      }
    }

    const cd = Math.max(0.01, w.fireCd);
    this.hud.setReload(1 - Math.max(0, this.playerCd) / cd);
    this.hud.setHeat(this.heat, this.overheated, !!w.heat);

    // 本帧实际速度（不是"按了什么键"）：撞墙、坡道减速都会自然反映出来，
    // 这样敌人预判的是"你真正会到的地方"，而不是"你以为自己会到的地方"。
    const inv = 1 / Math.max(dt, 1e-4);
    this.playerVel.x = (pos.x - ox) * inv;
    this.playerVel.z = (pos.z - oz) * inv;
  }

  _separate() {
    const p = this.player.group.position;
    for (const e of this.enemies) {
      if (e.turretStatic) continue;   // 炮台固定不动，不参与推挤
      const ep = e.position;
      let dx = ep.x - p.x;
      let dz = ep.z - p.z;
      let d = Math.hypot(dx, dz);
      const minD = e.isBoss ? (e.bossKind === 'breaker' ? 5.2 : 4.4) : 3.1;
      if (d > 0 && d < minD) {
        const push = (minD - d) * (e.isBoss ? 0.28 : 0.5);
        dx /= d; dz /= d;
        if (!this.world.blocked(ep.x + dx * push, ep.z + dz * push, 1.4)) {
          ep.x += dx * push;
          ep.z += dz * push;
        }
      }
    }
    for (let i = 0; i < this.enemies.length; i++) {
      for (let j = i + 1; j < this.enemies.length; j++) {
        const a = this.enemies[i].position;
        const b = this.enemies[j].position;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        const bossInPair = this.enemies[i].isBoss || this.enemies[j].isBoss;
        const minD = bossInPair ? 4.6 : 3.2;
        if (d > 0 && d < minD) {
          dx /= d; dz /= d;
          const push = (minD - d) * (bossInPair ? 0.1 : 0.25);
          if (!this.world.blocked(b.x + dx * push, b.z + dz * push, 1.4)) {
            b.x += dx * push;
            b.z += dz * push;
          }
        }
      }
    }
  }

  /** 高爆弹头：以命中点为中心的范围伤害 */
  _explodeAt(pos, level, exclude = null, splashMul = 1) {
    const radius = 4.2 * splashMul;
    const damage = 30 * level * this.stats.splashDamageMul;

    const victims = this.enemies.filter(
      (e) => e.alive && e.tank !== exclude && e.position.distanceTo(pos) < radius
    );

    this.effects.explosion(pos.clone().setY(Math.max(0.4, pos.y)), 0xffb040, 16 + level * 6, 1.05 + level * 0.15);
    this.sound.explosionAt(pos, 0.8 + level * 0.25, this.listener());

    for (const e of victims) {
      const died = e.tank.takeDamage(damage);
      if (died) this._onEnemyKilled(e.tank);
    }
  }

  _updateBullets(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.update(dt);

      if (!b.alive) { this.bullets.splice(i, 1); continue; }

      // 障碍物（分段采样，避免高速穿透）
      const mid = TMP.copy(b.prev).add(b.pos).multiplyScalar(0.5);
      if (this.world.hitSolid(b.pos, 0.42) || this.world.hitSolid(mid, 0.42)) {
        this.effects.spark(b.pos);
        b.destroy();
        this.bullets.splice(i, 1);
        continue;
      }

      // 坦克
      let hitTarget = null;
      if (b.team === 'player') {
        for (const e of this.enemies) {
          if (!e.alive || b.hits.has(e.tank)) continue;
          const hitR = Math.max(1.45, e.tank.radius * 0.95);
          const maxY = e.isBoss ? 3.6 : 2.3;
          if (segDistXZ(b.prev, b.pos, e.position) < hitR && b.pos.y < maxY) {
            hitTarget = e.tank;
            break;
          }
        }
      } else if (this.player.alive && !b.hits.has(this.player)) {
        if (segDistXZ(b.prev, b.pos, this.player.group.position) < 1.45 && b.pos.y < HIT_TOP) {
          hitTarget = this.player;
        }
      }

      if (!hitTarget) continue;

      b.hits.add(hitTarget);
      // 玩家受伤走减伤结算（反应装甲 / 壁垒协议）
      let dmg = hitTarget === this.player
        ? Math.max(1, Math.round(b.damage * (this.stats.damageTakenMul ?? 1)))
        : b.damage;
      // 铁壁的护盾（r46）：伤害全打在壳上，本体一滴不掉。
      // 打空那一刻给对应 Enemy 记 6 秒破防——这才是玩家的输出窗口。
      if (hitTarget !== this.player && hitTarget.shieldHp > 0) {
        hitTarget.shieldHp -= dmg;
        this.effects.explosion(b.pos.clone(), 0x9aa2b0, 3, 0.45);
        if (hitTarget.shieldHp <= 0) {
          hitTarget.shieldHp = 0;
          const owner = this.enemies.find((e) => e.tank === hitTarget);
          if (owner) owner.breakT = BOSS_SKILLS.generators.breakDur;
          this.hud.showMessage('护盾破碎 · 输出窗口', 1.1);
          this.shake = Math.max(this.shake, 0.35);
        }
        continue;
      }
      // 重盾兵：命中方向与车头同向（正面）时减伤，绕后无减伤。
      // armorMul 让铁壁用同一套判定但减 70%（0.3），而不是复制一份逻辑。
      if (hitTarget !== this.player && hitTarget.isShielded) {
        const facing = hitTarget.group.rotation.y;
        const dot = Math.sin(facing) * b.dir.x + Math.cos(facing) * b.dir.z;
        if (dot > 0.25) dmg = Math.max(1, Math.round(dmg * (hitTarget.armorMul ?? 0.2)));
      }
      const died = hitTarget.takeDamage(dmg);
      this.effects.spark(b.pos);
      this.sound.hit();

      // 高爆：命中后溅射（不重复伤害直接命中目标）
      if (b.explosive > 0) {
        this._explodeAt(TMP2.copy(b.pos), b.explosive, hitTarget, b.splashMul);
      }

      if (hitTarget === this.player) {
        this.shake = Math.max(this.shake, 0.25);
        this.hud.hurt();
        this.sound.hurt();
        this.hud.setHealth(this.player.hp, this.player.maxHp);
        if (died) this._onPlayerDeath();
      } else if (died) {
        this._onEnemyKilled(hitTarget);
      }

      // 穿透：消耗一次穿透次数后继续飞行
      if (hitTarget !== this.player && b.pierce > 0) {
        b.pierce -= 1;
        continue;
      }

      b.destroy();
      this.bullets.splice(i, 1);
    }
  }

  _onEnemyKilled(tank) {
    const idx = this.enemies.findIndex((e) => e.tank === tank);
    if (idx === -1) return;
    const enemy = this.enemies[idx];
    this.enemies.splice(idx, 1);
    this.effects.explosion(enemy.position.clone().setY(1.1), 0xff8a3d, enemy.isBoss ? 48 : 20, enemy.isBoss ? 1.9 : 1.15);
    this.sound.explosionAt(enemy.position, enemy.isBoss ? 1.9 : enemy.isElite ? 1.2 : 0.9, this.listener());
    this.scene.remove(enemy.tank.group);
    if (enemy.sight) this.scene.remove(enemy.sight);
    this.kills += 1;

    // 击杀回甲（豹式的 perks 为空，这里恒不触发；保留是为了以后做车体变体）
    if (this.stats.killHeal > 0 && this.player.alive && this.player.hp < this.player.maxHp) {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + this.stats.killHeal);
      this.hud.setHealth(this.player.hp, this.player.maxHp);
    }

    if (enemy.isBoss) {
      // 蜂巢倒下，召唤物一起散（与联机同一处理）：否则玩家要满地图清剩下的
      // 无人机，波次永远清不到 0，选卡不弹 → 卡死。
      if (enemy.bossKind === 'hive') {
        for (const o of this.enemies.slice()) {
          if (o.summoner !== enemy) continue;
          this.effects.explosion(o.position.clone().setY(1), 0xc06bd8, 8, 0.7);
          this.scene.remove(o.tank.group);
          this.enemies.splice(this.enemies.indexOf(o), 1);
        }
      }
      this.score += Math.round((1200 + this.wave * 80) * this.mods.killScoreMul);
      this.shake = Math.max(this.shake, 0.85);
      this.hud.showMessage(`${enemy.bossName} 已击破`, 1.8);
      this.hud.hideBossBar();
    } else if (enemy.isElite) {
      this.score += Math.round((450 + this.mods.eliteScoreBonus) * this.mods.killScoreMul);
      this.shake = Math.max(this.shake, 0.3);
      this.hud.showMessage(`精英击破  +${Math.round((450 + this.mods.eliteScoreBonus) * this.mods.killScoreMul)}`, 1.1);
    } else {
      // M3 新敌人基础分：无人机 150 / 炮台 250 / 补给车 250 / 重盾兵 180 / 普通 100
      const base = { drone: 150, turret: 250, support: 250, shield: 180 }[enemy.type] || 100;
      this.score += Math.round(base * this.mods.killScoreMul);
      this.shake = Math.max(this.shake, 0.12);
      if (base >= 180) {
        const names = { drone: '无人机', turret: '炮台', support: '补给车', shield: '重盾兵' };
        this.hud.showMessage(`${names[enemy.type]}击破  +${Math.round(base * this.mods.killScoreMul)}`, 0.9);
      }
    }

    this.hud.setKills(this.kills);
    this.hud.setScore(this.score);
  }

  _onPlayerDeath() {
    this.state = 'over';
    this.touch.refresh();
    this.overTimer = 1.5;
    this.aimMarker.visible = false;
    this.firing = false;
    this._clearHazards();
    this.hud.hideBossBar();
    this.effects.explosion(this.player.group.position.clone().setY(1), 0xffb347, 30, 1.5);
    this.sound.explosionAt(this.player.group.position, 1.6, this.listener());
    this.sound.hurt();
    this.sound.stopMusic(1.4);
    this.shake = 0.8;
    this.hud.showMessage('装甲被击穿', 1.6);
    this.hud.setHealth(0, this.player.maxHp);
  }

  /** 每帧同步顶部 Boss 血条 */
  _syncBossBar() {
    const boss = this.enemies.find((e) => e.isBoss && e.alive);
    if (!boss) {
      this.hud.hideBossBar();
      return;
    }
    let hp = boss.tank.hp;
    let maxHp = boss.tank.maxHp;
    let name = boss.bossName;
    // 终焉：血条按阶段重算（三个阶段各一条满格），名字后加阶段号——
    // 否则玩家只会看到"血条突然退回一大段"，读不出"换阶段了"。
    if (boss.bossKind === 'terminus') {
      const stage = boss.stage || 0;
      hp = stageBarRatio(boss.tank.hp / boss.tank.maxHp, stage) * 1000;
      maxHp = 1000;
      name = `${boss.bossName} · ${['Ⅰ', 'Ⅱ', 'Ⅲ'][stage]}`;
    }
    // 55 波起的觉醒词条：直接标在名字后面。单独做一行 UI 会挤占左上角，
    // 而玩家真正需要的只是"这只和上次不一样，哪里不一样"。
    const words = awakenNamesOf(boss.awakenMask || 0);
    if (words) name = `${name}〔${words}〕`;
    this.hud.showBossBar(name, boss.bossKind, hp, maxHp, boss.enraged);
  }

  // ---------------- 肉鸽流程 ----------------
  _onWaveCleared() {
    if (this.state !== 'playing' || !this.player.alive) return;
    this.waveActive = false;
    this.state = 'cleared';
    this.touch.refresh();
    this.clearedTimer = 1.1;
    this._clearHazards();
    this.hud.hideBossBar();

    const bonus = Math.round((150 + this.wave * 25) * this.mods.waveBonusMul);
    this.score += bonus;

    // 清波回血：基础 6 + 纳米修复加成
    const before = this.player.hp;
    this.player.hp = Math.min(this.player.maxHp, this.player.hp + 6 + this.stats.waveHeal);
    const healed = Math.round(this.player.hp - before);

    this.sound.clear();

    this.hud.setScore(this.score);
    this.hud.setHealth(this.player.hp, this.player.maxHp);
    this.hud.showMessage(
      `第 ${this.wave} 波清除  +${bonus}${healed > 0 ? `  +${healed} 装甲` : ''}`,
      1.4
    );
  }

  _showReward() {
    const allowArmory = this.wave % this.mods.armoryEvery === 0 && this.unlocked.length < Object.keys(WEAPONS).length;
    this.choices = rollChoices(this.upgradeCounts, 3, {
      weaponId: this.stats.weaponId,
      allowArmory,
    });
    this.state = 'reward';
    this.firing = false;
    this.touch.refresh();
    if (this.choices.length === 0) {
      // 所有强化都满级：直接进入下一波
      this.startWave(this.wave + 1);
      return;
    }
    this.sound.clear();
    // 战斗间隙把配乐收一档：连打十波时，一直顶在 0.72 会让"下一波要来了"变得没有对比
    this.sound.setMusicIntensity(0.42);
    this.hud.showRewards(this.wave, this.choices, this.upgradeCounts);
  }

  /**
   * 卡片点击的唯一入口。面板是单机 / 联机共用的，回调却只有这一个，
   * 所以必须在这里按模式分流。
   *
   * 踩过的坑：以前这里直接是 `onPick: (id) => this.pickUpgrade(id)`。
   * 单机没问题，联机时 `pickUpgrade` 第一行就是 `if (this.state !== 'reward') return`——
   * 组队局的 state 是 'coop'，于是**鼠标点卡片完全没反应**，而键盘 1/2/3
   * 走的是 coop 自己绑的监听，反而能用。面板上还写着「点击卡片，或按 1 2 3」，
   * 十个玩家里有九个会去点，然后就卡在选卡界面出不来了。
   */
  _pickCard(id) {
    if (this.mode === 'coop' && this.coop) return this.coop.pickCard(id);
    return this.pickUpgrade(id);
  }

  pickUpgrade(id) {
    if (this.state !== 'reward') return;
    if (id === 'armory') {
      this._openArmory();
      return;
    }
    const upgrade = this.choices.find((u) => u.id === id);
    if (!upgrade) return;

    this.sound.select();
    upgrade.apply(this.stats, this.player);

    this.upgradeCounts[upgrade.id] = (this.upgradeCounts[upgrade.id] || 0) + 1;

    // 把数值型强化同步到实体
    this.player.speed = this.stats.speed;
    this.player.maxHp = this.stats.maxHp;
    this.player.hp = Math.min(this.player.hp, this.player.maxHp);

    this._renderChips();
    this.hud.setHealth(this.player.hp, this.player.maxHp);
    this.hud.hideRewards();
    this.choices = [];
    this.startWave(this.wave + 1);
  }

  // ---------------- 军械库 ----------------
  _openArmory() {
    const options = Object.values(WEAPONS).filter((w) => !this.unlocked.includes(w.id));
    if (options.length === 0) {
      this.hud.hideRewards();
      this.choices = [];
      this.startWave(this.wave + 1);
      return;
    }
    this.weaponChoices = options.slice(0, 3);
    this.state = 'armory';
    this.firing = false;
    this.hud.showArmory(this.wave, this.weaponChoices, this.stats.weaponId);
  }

  pickWeapon(id) {
    if (this.state !== 'armory') return;
    if (!this.weaponChoices.some((w) => w.id === id)) return;
    this.sound.select();
    if (!this.unlocked.includes(id)) this.unlocked.push(id);
    this.equipWeapon(id);
    this.hud.hideRewards();
    this.weaponChoices = [];
    this.choices = [];
    this.startWave(this.wave + 1);
  }

  equipWeapon(id) {
    const w = WEAPONS[id];
    if (!w) return;
    this.stats.weaponId = id;
    this.playerCd = 0;
    this.heat = 0;
    this.overheated = false;
    this.hud.setWeapon(w);
    this.hud.setHeat(0, false, !!w.heat);
  }

  /** Q 键在已解锁主炮之间轮换 */
  cycleWeapon() {
    if (this.unlocked.length < 2) return;
    const i = this.unlocked.indexOf(this.stats.weaponId);
    const next = this.unlocked[(i + 1) % this.unlocked.length];
    this.equipWeapon(next);
    this.hud.showMessage(`主炮 · ${WEAPONS[next].name}`, 0.8);
  }

  _renderChips() {
    const list = [];
    const all = [...UPGRADES, ...Object.values(WEAPONS).flatMap((w) => w.cards)];
    for (const u of all) {
      const level = this.upgradeCounts[u.id] || 0;
      if (level > 0) list.push({ id: u.id, icon: u.icon, name: u.name, level });
    }
    this.hud.renderChips(list);
  }

  _updateWaves(dt) {
    this.waveTime += dt;

    for (let i = this.pending.length - 1; i >= 0; i--) {
      this.pending[i].t -= dt;
      if (this.pending[i].t <= 0) {
        const { hp, speed, type, awaken } = this.pending[i];
        this._beginSpawn(hp, speed, type, undefined, awaken);
        this.pending.splice(i, 1);
      }
    }

    this._updateWarnings(dt);

    // 残局兜底：只剩最后几只、或这一波打了 75 秒，巡逻队全部转猎杀。
    // 否则玩家要在 200×200 的地图上追着最后一辆绕圈的车跑。
    if (this.waveActive && !this.huntSent &&
        (this.enemies.length + this.pending.length + this.warnings.length <= 3 ||
         this.waveTime > 75)) {
      this.huntSent = true;
      for (const e of this.enemies) e.sendHunting?.();
    }

    this.hud.setLeft(this.enemies.length + this.pending.length + this.warnings.length);

    if (this.waveActive && this.enemies.length === 0 &&
        this.pending.length === 0 && this.warnings.length === 0) {
      this._onWaveCleared();
    }
  }

  _gameOverTime() {
    const prev = this.best;
    const isNew = this.wave > prev.wave || (this.wave === prev.wave && this.score > prev.score);
    const best = isNew ? { wave: this.wave, score: this.score } : prev;
    if (isNew) {
      this.best = best;
      saveBest(best);
    }
    return { prev, best, isNew };
  }

  /** 每日挑战结算：上传成绩并拉取今日榜 + 历史总榜 */
  /**
   * 结算上报：所有战斗计入同一榜单，附带人数标记。
   * 上传结果（成功 / 失败原因）会显示在结算页，避免"打了却没上榜"无从判断。
   */
  async _submitRun(base, mode = 'solo', teamSize = 1) {
    const name = this.callsign || loadCallsign() || '指挥官';
    const isCoop = mode === 'coop';
    const chassis = isCoop ? (this.coop?.me?.chassis || this.chassisId) : this.chassisId;

    let res;
    try {
      res = await submitScore({
        date: todayKey(),
        name,
        wave: base.wave,
        kills: base.kills,
        score: base.score,
        timeMs: Math.round((isCoop ? (this.coop?.runTime || 0) : this.runTime) * 1000),
        chassis,
        weapon: isCoop ? 'assault' : (this.stats.weaponId || ''),
        // 人数：让榜单能看出这一局是单人还是 4 人合作
        players: Math.max(1, Math.min(4, isCoop ? teamSize : 1)),
        mode: 'solo',
      });
    } catch {
      res = { list: [], all: [], remote: false, reason: 'error' };
    }

    const syncReason = res.reason;
    this.hud.showGameOver({
      ...base,
      mode: isCoop ? 'coop' : 'solo',
      teamSize,
      teamScore: base.teamScore || 0,
      synced: res.remote,
      syncReason,
      myName: name,
      leaderboard: (res.list || []).slice(0, 5),
      overall: (res.all || []).slice(0, 5),
    });
  }

  _updateCamera(dt) {
    const p = this.player.group.position;
    // 跟随算法与组队共用一份（src/core/camera.js）。见那里的注释：
    // 纯低通会留下 速度/k ≈ 2 米的滞后，且随地形变速前后变，
    // 视距跟着伸缩 = "车一跑起来画面一顿一顿地晃"。
    const v = this.player._camVel || (this.player._camVel = { x: 0, z: 0 });
    v.x = this._lastPlayerX == null ? 0 : (p.x - this._lastPlayerX) / Math.max(dt, 1e-4);
    v.z = this._lastPlayerZ == null ? 0 : (p.z - this._lastPlayerZ) / Math.max(dt, 1e-4);
    this._lastPlayerX = p.x;
    this._lastPlayerZ = p.z;

    const f = followStep(
      { x: this.camera.position.x, z: this.camera.position.z },
      { x: p.x, z: p.z },
      v,
      Math.round(Math.hypot(v.x, v.z)),      // 标量只用来判断"在不在动"
      dt,
      this._followCam || (this._followCam = validateFollow({ back: CAM_BACK, height: CAM_HEIGHT })),
    );
    this.camera.position.x = f.x;
    this.camera.position.z = f.z;
    this.camera.position.y = f.y;

    this.camLook.set(f.lookX, 1.1, f.lookZ);
    this.camera.lookAt(this.camLook);

    if (this.shake > 0) {
      const s = this.shake;
      this.camera.position.x += (R.fx() - 0.5) * s;
      this.camera.position.y += (R.fx() - 0.5) * s;
      this.camera.position.z += (R.fx() - 0.5) * s;
      this.shake = Math.max(0, this.shake - dt * 1.6);
    }
  }

  /** 小地图：12 帧/秒刷新即可，节流降低开销 */
  _updateMinimap(dt) {
    if (!this.minimap) return;
    this.mapAcc += dt;
    if (this.mapAcc < 0.08) return;
    this.mapAcc = 0;

    const p = this.player && this.player.alive ? this.player.group.position : null;
    this.minimap.update({
      player: p ? { x: p.x, z: p.z, rot: this.player.group.rotation.y } : null,
      enemies: this.enemies,
      warnings: this.warnings,
      crates: this.crates,
    });
  }

  // ------------------------------------------------------------------
  /**
   * F3 联机诊断面板。
   *
   * 卡顿的原因可能在三处：服务端发慢了、网络抖了、本机掉帧了。
   * 光看画面分不出来，所以把三组数字直接摆出来：
   *   snap 快照速率（期望 15Hz）、gap 平均间隔、stall 超过 200ms 的停顿
   *   ping 往返、fps 本机帧率
   */
  _toggleNetDebug() {
    this._netDebug = !this._netDebug;
    if (!this._netDebug) {
      this._dbgEl?.remove();
      this._dbgEl = null;
      return;
    }
    if (!this._dbgEl) {
      const el = document.createElement('div');
      el.id = 'net-debug';
      el.style.cssText = 'position:fixed;right:10px;top:10px;z-index:9999;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;'
        + 'color:#b8f0c8;background:rgba(8,14,10,.82);border:1px solid rgba(120,220,150,.35);'
        + 'border-radius:6px;padding:8px 10px;pointer-events:none;white-space:pre';
      document.body.appendChild(el);
      this._dbgEl = el;
    }
    this.hud.showMessage('网络诊断 开（F3 关闭）', 1.2);
  }

  _updateNetDebug(dt) {
    if (!this._dbgEl) return;
    // 每秒刷新一次，避免自己拖慢渲染
    this._dbgAcc = (this._dbgAcc || 0) + dt;
    this._dbgFrames = (this._dbgFrames || 0) + 1;
    if (this._dbgAcc < 0.5) return;

    const fps = this._dbgFrames / this._dbgAcc;
    this._dbgAcc = 0;
    this._dbgFrames = 0;

    const s = this.net?.netstat || {};
    const rtt = this.net?.rtt || 0;
    const hz = s.hz || 0;
    // 低于 12Hz 就标红：15Hz 掉了两成说明服务端或链路在拖
    const warn = hz && hz < 12 ? ' ⚠' : '';
    // 帧率是"卡顿式抖动"的唯一判据：低于 50fps 时，人眼看到的抖是掉帧，
    // 再怎么调插值和预测都没用 —— 得先降画质 / 关阴影。
    const fpsWarn = fps < 50 ? ' ⚠低帧' : '';

    // 插值游标被夹死的次数（每秒增量）。持续 > 0 说明远端实体在定格跳帧，
    // 这是"敌人/队友一跳一跳"的直接证据，和本机帧率无关。
    const frozenNow = this.net?._interpFrozen ?? 0;
    const frozenPerSec = this._dbgFrozenBase == null ? 0 : frozenNow - this._dbgFrozenBase;
    this._dbgFrozenBase = frozenNow;
    const interpTicks = this.net?._interpTicks ?? 0;
    const interpMs = interpTicks * (1000 / 30);

    this._dbgEl.textContent = [
      `fps   ${fps.toFixed(0)}${fpsWarn}     ping ${rtt}ms`,
      `snap  ${hz.toFixed(1)} Hz${warn}  间隔 ${(s.gapMs || 0).toFixed(0)}/${(s.gapMax || 0).toFixed(0)}ms`,
      `插值  ${interpTicks} 格 ${interpMs.toFixed(0)}ms   夹死 ${frozenPerSec}/s`,
      `停顿 ${s.stalls || 0} 次   模式 ${this.mode}   房间 ${this.net?.room || '-'}`,
    ].join('\n');
  }

  update(dt) {
    // 暂停：世界完全冻结，只把最后一帧重画一遍。
    // （WebGL 画布默认不保留绘制缓冲，彻底不渲染会被合成器刷成黑屏）
    if (this.paused) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.hud.update(dt);
    this._qualityWatch(dt);
    this._updateNetDebug(dt);

    // 组队模式下，整个世界由服务端驱动，这里只画
    if (this.mode === 'coop') {
      this.coop?.update(dt);
      return;
    }

    this._updateMinimap(dt);

    if (this.state === 'playing') {
      this.runTime += dt;
      this._updateAim();
      this._updatePlayer(dt);
      this._updateTerrainChip(dt);
      // 倒序：冲锋兵自爆时会从数组中移除自身
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        this.enemies[i].update(dt, this);
      }
      this._separate();
      this._updateBullets(dt);
      this._updateZones(dt);
      this._updateCratesSolo(dt);
      // 玩家可能在同一帧被击毁，避免“死亡后清波”覆盖结算状态
      if (this.state === 'playing') this._updateWaves(dt);
      if (this.state === 'playing') this._syncBossBar();
    } else if (this.state === 'cleared') {
      this._updateBullets(dt);
      this.clearedTimer -= dt;
      if (this.clearedTimer <= 0) this._showReward();
    } else if (this.state === 'reward' || this.state === 'armory') {
      this._updateBullets(dt);
    } else if (this.state === 'over') {
      this._updateBullets(dt);
      if (this.overTimer > 0) {
        this.overTimer -= dt;
        if (this.overTimer <= 0) {
          const { best, isNew } = this._gameOverTime();
          this.hud.setBest(best);
          const base = {
            wave: this.wave,
            kills: this.kills,
            score: this.score,
            time: formatTime(this.runTime),
            best,
            isNew,
          };
          // 每日挑战与训练模式都上传（各自独立榜单），训练模式分数不可比但可围观
          this._submitRun(base, 'solo', 1);
        }
      }
    }

    this.player.update(dt);
    this._updateCamera(dt);
    this.effects.update(dt);
    this.zoneVis.sync(this.zones);
    this._syncBeams();
    this.renderer.render(this.scene, this.camera);
  }

  // ================= 组队联机 =================

  /**
   * 进入组队：把网络层的回调接到大厅与战场上。
   * 大厅只负责"选房 / 报数"，真正开局由服务端的 welcome 消息触发。
   */
  openCoop({ name, chassis }) {
    const hud = this.hud;

    // 大厅里点"创建 / 加入"时走这里。
    // 参数顺序容易踩坑：HUD 在 openLobby 时才知道呼号与车体，网络动作只接房间码，
    // 所以 name/chassis 必须在这里闭包住，不能进 _netAction 里再读。
    this._coopName = name || this.callsign || loadCallsign() || '指挥官';
    this._coopChassis = chassis || this.chassisId;

    hud._netAction = (code, make) => {
      if (hud._joining) return;      // 防连点：一次只连一个房间
      hud._joining = true;
      hud.setLobbyError('');
      // make=1：输入框填了码点「创建房间」→ 用自定义码开新房
      hud.lobbyStatus.textContent = code
        ? (make ? `正在用房间码 ${code} 建房…` : `正在加入 ${code}…`)
        : '正在创建房间…';
      this.net.connect({ code: code || '', name: this._coopName, chassis: this._coopChassis, make: !!make });
      // 回调注册是幂等的；这里再确保一次，防止早退分支导致"_netAction 是 undefined"
      this._bindNet();
      // 兜底：10 秒还没连上就告诉用户，别让"连接中…"一直转
      clearTimeout(this._joinTimer);
      this._joinTimer = setTimeout(() => {
        // 'closed' 也要算：连不上时 onclose 先到，state 已经不是 connecting 了
        if (this.net.state === 'connecting' || this.net.state === 'closed') {
          this.net.close();
          this._coopOffline();
        }
      }, 10000);
    };
    hud._netStart = () => this.net.start();
    hud._netLeave = () => {
      this.leaveCoop();
      this.net.close();
    };
    hud._lobbyNet = this.net;
    hud._reopenLobby = () => {
      if (this.mode !== 'coop') return;
      hud.showRoom(this.net.room, this.net.players, this.net.you, true, this.net.host);
      hud.lobby.classList.remove('hidden');
    };
    hud.chassis = chassis;

    this._bindNet();
  }

  /** 网络回调只注册一次（重复注册会导致快照事件被处理两遍） */
  _bindNet() {
    if (this._netBound) return;
    this._netBound = true;
    const hud = this.hud;

    this.net.on('welcome', (w) => {
      // 先更新房间浮层再开局：开局会关掉大厅，这时房间码只剩浮层这一个入口
      const code = w.code || this.net.room;
      clearTimeout(this._joinTimer);
      this.hud._joining = false;
      this.hud.showRoomChip(code, (w.players || []).length);
      this.hud.roomCode = code;
      this.hud._lastRoom = code;
      this.hud.roomCodeShow.textContent = code;
      if (!this.coop) this.coop = new CoopMode(this);
      this.mode = 'coop';
      this.state = 'coop';
      this.hud.closeLobby();
      try {
        this.coop.enter(w);
      } catch (err) {
        // 进战场失败（极端情况：模型资源异常）也要保证能退回主菜单，而不是卡在黑屏
        console.error('[coop] enter failed', err);
        this.leaveCoop();
        this.hud.showMessage('进入战场失败，请重试', 3);
      }
    });

    this.net.on('roster', (m) => {
      // 已在局内：不弹大厅，只更新左下的房间浮层
      if (this.mode === 'coop') {
        this.hud.showRoomChip(this.net.room, m.players.length);
        return;
      }
      // 服务端下发的自动开局剩余秒数（0 = 没在倒计时），大厅文案按它显示
      if (typeof m.autoStart === 'number') hud._autoStartLeft = m.autoStart;
      hud.showRoom(
        this.net.room || hud.room,
        m.players,
        this.net.you,
        !!(m.started ?? this.net.state === 'playing'),
        this.net.host,
      );
    });

    this.net.on('event', (list) => this.coop?.onEvents(list));

    this.net.on('deny', (m) => {
      let text = m.text || '连接被拒绝';
      // 「房间不存在」九成是两边连的服务器不一样（域名 vs IP、或不同端口），
      // 把实际连的地址摆出来，两个浏览器一对就知道是不是同一个地方
      if (m.reason === 'no-room') {
        text += `（连接的服务器：${location.host}）`;
        // 再顺手问一下这台服务器上现在开着哪些房间：如果房主的码不在列表里，
        // 要么是房主看错了旧房间码，要么是两个人根本连的不是同一台服务器——
        // 一行字把这两种情况都钉死，不用再让用户"多试几次"。
        try {
          fetch('/api/rooms').then((r) => r.json()).then((d) => {
            if (!d?.ok) return;
            const codes = String(d.codes || '').trim();
            const hint = codes ? `；这台服务器上现有的房间：${codes}` : '；这台服务器上现在没有任何房间';
            if (this.mode === 'coop') return;
            hud.setLobbyError(text + hint);
          }).catch(() => { /* 拿不到列表就只显示基础提示 */ });
        } catch { /* 同上 */ }
      }
      // 被拒绝也是一次连接尝试的终点：必须解锁，否则下一次点"加入"会被防连点挡住，
      // 表现就是"输错一次码之后，再输什么都不动了"。
      hud._joining = false;
      clearTimeout(this._joinTimer);
      if (this.mode === 'coop') {
        // 已在局内被拒（房间已散），直接回主菜单并说明原因
        this.leaveCoop();
        this.hud.showMessage(`连接被拒绝：${text}`, 3);
        return;
      }
      hud.setLobbyError(text);
      // 状态栏还留着"正在加入 XXXX…"会和失败提示打架，清掉
      hud.lobbyStatus.textContent = '';
      hud.lobbyChoose.classList.remove('hidden');
      hud.lobbyWait.classList.add('hidden');
      hud.lobby.classList.remove('hidden');
    });

    this.net.on('end', (m) => this._endCoop(m));

    this.net.on('close', () => {
      // 连接尝试中被断开（连不上 / 服务端不存在）：必须给反馈。
      // 之前这里只清了 _joining，界面就永远停在"正在创建房间…"，
      // 用户看到的正是"点了组队没反应"。
      const wasJoining = this.hud._joining;
      this.hud._joining = false;
      clearTimeout(this._joinTimer);
      if (this.mode === 'coop') {
        // 服务端先发 end 再断开，这种情况已经结算过了
        if (this.hud.gameover && !this.hud.gameover.classList.contains('hidden')) return;
        this.hud.showMessage('与服务器断开 · 按 Esc 返回主菜单', 4);
        this.leaveCoop();
        return;
      }
      if (wasJoining && !this.net.lastDeny) this._coopOffline();
    });
  }

  /**
   * 大厅里连不上联机服务时的统一出口。
   *
   * 场景：页面被放到只能托管静态文件的平台（对象存储 / 静态站点），
   * 没有常驻的 WebSocket 房间服务器 —— 这时点击必然连不上，界面必须说清楚，
   * 而不是停在"正在创建房间…"。
   */
  _coopOffline() {
    const hud = this.hud;
    hud._joining = false;
    clearTimeout(this._joinTimer);
    if (this.mode === 'coop') return;
    if (this.net && this.net.state !== 'idle') this.net.close();

    const custom = new URLSearchParams(location.search).get('ws');
    // 把实际尝试的地址写进提示：排障时第一句话就能看出连的是哪个服务器，
    // 不用再猜"它到底连了哪里"。
    const target = custom || `${location.host}/ws`;
    const hint = custom
      ? `连不上联机服务（${target}）：确认服务端已启动，且该端口可从外网访问`
      : `连不上联机服务（${target}）：这个地址上没有房间服务。本机请 npm start；线上请确认 Nginx 已启动并把 /ws 转发到 Node`;
    hud.setLobbyError(hint);
    hud.lobbyStatus.textContent = '';
    hud.lobbyChoose.classList.remove('hidden');
    hud.lobbyWait.classList.add('hidden');
    hud.lobby.classList.remove('hidden');
  }

  /** 主动退出组队，回到主菜单 */
  leaveCoop() {
    if (this.mode !== 'coop') {
      this.hud.closeLobby();
      return;
    }
    // 先切模式再断线：net 的 close 回调看到 mode==='solo' 就不会再弹"与服务器断开"
    this.mode = 'solo';
    this.state = 'menu';
    this.touch.refresh();
    this.sound.stopMusic(0.5);
    this.coop?.exit();
    // 必须真的断开。早期只切了本地状态，人还留在房间里：
    // 队友那边会一直看到一台"幽灵坦克"，本机也会继续收快照与事件。
    if (this.net && this.net.state !== 'idle') this.net.close();
    this.hud.closeLobby();
    this.hud.hideRoomChip?.();
    this.hud.hideBossBar?.();
    this.hud.setModifier(null);
    // 回到主菜单：显示开局面板，收起 HUD
    this.hud.overlay?.classList.remove('hidden');
    this.hud.hud?.classList.add('hidden');
    this.hud.gameover?.classList.add('hidden');
    this.hud.app?.classList.remove('playing');
    this.keys.clear();
    this.firing = false;
  }

  /** 本局结束：展示结算并上传成绩（人数计入榜单） */
  async _endCoop(msg) {
    // 房间被服务端回收（空闲超时）：不是"打完一局"，不能走结算页。
    // 以前服务端静默删索引，房主这边毫无察觉，界面上房间码还挂着，
    // 朋友按码进来报"房间不存在"，房主一脸茫然。现在立刻退回主菜单并说清原因。
    if (msg?.expired) {
      const wasCoop = this.mode === 'coop';
      this.leaveCoop();
      this.net.close();
      this.hud.roomCode = '';
      this.hud._lastRoom = '';
      this.hud.hideRoomChip?.();
      this.hud.closeLobby();
      this.hud.showMessage(msg.text || '房间已回收，请重新创建房间', 5);
      if (wasCoop) this.state = 'menu';
      return;
    }

    const me = this.coop?.me;
    if (!me) return;
    const myId = this.coop.myId;
    const runTime = this.coop.runTime;
    const waveNow = this.coop.wave;
    const teamScore = this.coop.teamScore;
    if (this.mode === 'coop') {
      this.mode = 'solo';
      this.state = 'over';
      this.coop.exit();
    }
    this.hud.hideBossBar?.();
    this.hud.setModifier(null);

    const row = (msg.results || []).find((r) => r.id === myId) || { kills: 0, score: 0 };
    const teamSize = (this.net.players || []).length || 1;

    // 组队局不上榜（已定方案）。
    //
    // 两个口径没法混排：单人一只枪手 100 分，组队是 ENEMY_TYPES.score 的 10 分 × √人数，
    // 同一张榜上组队永远垫底，排名也就不传递任何信息了。
    // 所以这里不调 _submitRun、不拉榜，直接给结算页 —— 少一次网络往返，也少一条会失败的路径。
    this.hud.showGameOver({
      wave: msg.wave || waveNow || 1,
      kills: row.kills || 0,
      score: row.score || 0,
      time: formatTime(runTime || 0),
      // 组队不计个人最佳（最佳是单人榜口径），传 null 让界面隐藏这一行
      best: null,
      isNew: false,
      teamScore,
      mode: 'coop',
      teamSize,
      ranked: false,
      myName: loadCallsign() || '指挥官',
      leaderboard: [],
      overall: [],
    });
    this.hud.closeLobby();
    this.net.close();
  }

  mount() {
    this.resize();
    this.hud.setHealth(this.player.hp, this.player.maxHp);
    this.hud.setReload(1);
    this.hud.setBest(this.best);
    const clock = new THREE.Clock();
    const loop = () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      this.update(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

/**
 * 无 WebGL 时的兜底渲染器。
 * 只实现被调用到的几个方法，让 UI 层能照常工作，并在画布上给一句提示。
 */
function makeNullRenderer() {
  const noop = () => {};
  return {
    domElement: document.getElementById('scene'),
    shadowMap: { enabled: false },
    setPixelRatio: noop,
    setSize: noop,
    render: () => {
      const c = document.getElementById('scene');
      if (!c || c.dataset.notice) return;
      c.dataset.notice = '1';
      const tip = document.createElement('div');
      tip.className = 'gl-fallback';
      tip.innerHTML = '<b>这台设备没能启动 3D 画面</b><span>请用支持 WebGL 的浏览器打开，或关闭省电模式后刷新。</span>';
      c.parentElement?.appendChild(tip);
    },
  };
}
