import * as THREE from '../vendor/three.module.js';
import { createLevel, PLAYER_START, HALF } from './level.js';
import { generateBoxes } from './core/levelgen.js';
import { buildTerrain, presetK, TERRAIN } from './core/terrain.js';
import { Tank } from './Tank.js';
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
import { createNav } from './nav.js';
import { Minimap } from './minimap.js';
import { CoopMode } from './coop.js';
import { NetClient } from './net.js';
import { angleDiff } from './core/motion.js';
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
    document.addEventListener('visibilitychange', () => this.sound.setHidden(document.hidden));

    // 团队邀请链接里带 ?room=XXXX：打开后自动填好人呼号就能一键进房。
    // 只做"预填"，不自动连——朋友可能想先换车体。
    const inviteRoom = new URLSearchParams(location.search).get('room');
    if (inviteRoom && /^[A-Za-z0-9]{4}$/.test(inviteRoom)) {
      this.inviteRoom = inviteRoom.toUpperCase();
      this.hud.inviteRoom = this.inviteRoom;
    }

    this._initRenderer();
    this._initScene();
    this._initInput();
    this._resetPlayer();
  }

  // ------------------------------------------------------------------
  _initRenderer() {
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch (e) {
      // 没有 WebGL（老设备、远程桌面、自动化测试环境）时不要白屏：
      // 降级成"仅界面"，菜单、榜单、组队房间都还能用。
      this.noGL = true;
      this.renderer = makeNullRenderer();
      console.warn('WebGL 不可用，已进入仅界面模式：', e && e.message);
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x172430);
    this.scene.fog = new THREE.Fog(0x172430, 95, 215);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 420);
    this.camera.position.set(0, CAM_HEIGHT + 1, 52);

    const hemi = new THREE.HemisphereLight(0xcfe4f5, 0x4a5240, 1.25);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff3dd, 2.2);
    sun.position.set(46, 78, 30);
    sun.castShadow = true;
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

    // 小地图（静态障碍烘焙一次）
    const mapEl = document.getElementById('minimap');
    this.minimap = mapEl
      ? new Minimap(mapEl, this.world, { size: window.innerWidth < 720 ? 124 : 168 })
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
      this.mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
      this.hud.moveCrosshair(e.clientX, e.clientY);
    });

    window.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.state === 'playing') this.firing = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firing = false;
    });

    window.addEventListener('resize', () => this.resize());

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
    });

    // 进大厅前把网络回调接好（点「组队」时才真正连）
    this.hud.onCoopRequest = (opts) => this.openCoop(opts);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
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
    if (this.mods.fogNear) {
      this.scene.fog.near = this.mods.fogNear;
      this.scene.fog.far = this.mods.fogFar;
    } else {
      this.scene.fog.near = 95;
      this.scene.fog.far = 215;
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
    this.state = 'playing';
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
   * 音效空间化的"耳朵"：相机位置 + 朝向（投到 XZ 平面）。
   * 只交出纯数字，sound.js 因此不必 import THREE，测试里也能直接喂假坐标。
   * 联机模式下 CoopMode 复用同一个相机，直接调 game.listener() 即可。
   */
  listener() {
    const c = this.camera.position;
    const f = this.camLook;
    return { x: c.x, z: c.z, fx: f.x - c.x, fz: f.z - c.z };
  }

  startWave(n) {
    this.wave = n;
    const bossWave = n % 5 === 0;
    const eliteWave = !bossWave && (n % 5 === 3 || this.mods.eliteEveryWave);
    // 战场扩大到 200×200 后，每波追加少量敌人，避免密度被摊薄
    const count = 2 + n * 2 + Math.min(6, Math.floor(n / 2)) - (n % 5 === 3 ? 2 : 0);
    const hp = Math.round((55 + n * 14) * this.mods.enemyHpMul);
    const speed = 8.5 + Math.min(4.5, n * 0.6);
    const chargers = n >= 2 && !bossWave ? Math.min(6, Math.floor(n / 2)) : 0;

    // 配乐随波次加压：开场 0.45，常规波最高 0.72，Boss 波 0.95
    this.sound.setMusicIntensity(bossWave ? 0.95 : Math.min(0.72, 0.42 + n * 0.03));

    this.waveActive = true;
    this.waveTime = 0;
    this.huntSent = false;
    this.pending = [];
    this.playerCd = 0;
    this.heat = 0;
    this.overheated = false;
    this.hud.setHeat(0, false, !!WEAPONS[this.stats.weaponId].heat);

    if (bossWave) {
      this.sound.bossIn();
      const breaker = Math.floor(n / 5) % 2 === 1;
      const type = breaker ? 'boss_breaker' : 'boss_prism';
      const name = breaker ? '破城者' : '棱镜';
      this.pending.push({
        t: 0.7,
        hp: 1300 + n * 300,
        speed: breaker ? 7.2 : 9.2,
        type,
        warn: 1.5,
      });
      const adds = 3 + Math.floor(n / 4);
      for (let i = 0; i < adds; i++) {
        this.pending.push({
          t: 1.7 + i * 0.9,
          hp: Math.round(hp * 0.8),
          speed,
          type: 'gunner',
        });
      }
      this.hud.showMessage(`第 ${n} 波  ·  ${name} 来袭`, 2.2);
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
    this.hud.setWave(n);
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
  _beginSpawn(hp, speed, type = 'gunner', warn = 0.8) {
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
      x: spot.x, z: spot.z, t: warn, hp, speed, type, mesh, radius, dur: warn,
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

  _spawnEnemyAt(hp, speed, x, z, type) {
    const enemy = new Enemy(this.scene, {
      x, z, hp, speed, type,
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
        this._spawnEnemyAt(w.hp, w.speed, w.x, w.z, w.type);
      }
    }
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
    this.aimRay.setFromCamera(this.mouseNDC, this.camera);
    const hit = this.aimRay.ray.intersectPlane(this.groundPlane, TMP);
    if (!hit) return;
    this.aimPoint.copy(TMP);

    // 指示环跟随**炮口实际指向**，不是鼠标。
    // 炮塔转速有限（轻装 / 猎手 170°/s），鼠标已经甩到侧面时炮口还在半路——
    // 环如果挂在鼠标上，玩家会以为"瞄准了却打不中"。
    // 现在环会停在炮口真正能到的位置并变红，转到位后自动变回正常色。
    let mx = TMP.x;
    let mz = TMP.z;
    const p = this.player;
    if (p && p.alive) {
      const dx0 = TMP.x - p.x;
      const dz0 = TMP.z - p.z;
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
      // 重盾兵：命中方向与车头同向（正面）时 80% 减伤，绕后无减伤
      if (hitTarget !== this.player && hitTarget.isShielded) {
        const facing = hitTarget.group.rotation.y;
        const dot = Math.sin(facing) * b.dir.x + Math.cos(facing) * b.dir.z;
        if (dot > 0.25) dmg = Math.max(1, Math.round(dmg * 0.2));
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
    if (boss) {
      this.hud.showBossBar(boss.bossName, boss.bossKind, boss.tank.hp, boss.tank.maxHp, boss.enraged);
    } else {
      this.hud.hideBossBar();
    }
  }

  // ---------------- 肉鸽流程 ----------------
  _onWaveCleared() {
    if (this.state !== 'playing' || !this.player.alive) return;
    this.waveActive = false;
    this.state = 'cleared';
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
        const { hp, speed, type } = this.pending[i];
        this._beginSpawn(hp, speed, type);
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
    this.hud.update(dt);
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
    this.hud.crosshair?.classList.add('hidden');
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
