import * as THREE from '../vendor/three.module.js';
import { createLevel, PLAYER_START } from './level.js';
import { Tank } from './Tank.js';
import { Enemy } from './Enemy.js';
import { Bullet } from './Bullet.js';
import { Effects } from './Effects.js';
import { HUD } from './HUD.js';
import { createStats, UPGRADES, rollChoices } from './upgrades.js';
import { WEAPONS, resolveWeapon } from './weapons.js';
import { createNav } from './nav.js';

const TMP = new THREE.Vector3();
const TMP2 = new THREE.Vector3();
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
    this.strikes = [];
    this.wave = 0;
    this.waveActive = false;
    this.waveTimer = 0;
    this.waveTime = 0;
    this.strikeT = 18;
    this.score = 0;
    this.kills = 0;
    this.runTime = 0;
    this.playerCd = 0;
    this.shake = 0;
    this.overTimer = 0;
    this.clearedTimer = 0;

    this.stats = createStats();
    this.upgradeCounts = {};
    this.choices = [];
    this.weaponChoices = [];
    this.unlocked = ['assault'];
    this.heat = 0;
    this.overheated = false;
    this.best = loadBest();

    this.hud = new HUD();

    this._initRenderer();
    this._initScene();
    this._initInput();
    this._resetPlayer();
  }

  // ------------------------------------------------------------------
  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
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
    this.camera.position.set(0, 28, 52);

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

    this.world = createLevel(this.scene);
    this.nav = createNav(this.world);
    this.effects = new Effects(this.scene);

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
  }

  _resetPlayer() {
    if (this.player) {
      this.scene.remove(this.player.group);
      this.player = null;
    }
    this.player = new Tank(this.scene, {
      team: 'player',
      body: 0x8fae5c,
      accent: 0x53682f,
      metal: 0x3a4048,
      hp: this.stats.maxHp,
      speed: this.stats.speed,
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

    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();

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
      onStart: () => this.start(),
      onRestart: () => this.restart(),
      onPick: (id) => this.pickUpgrade(id),
      onWeapon: (id) => this.pickWeapon(id),
    });
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
    for (const s of this.strikes) {
      this.scene.remove(s.mesh);
      s.mesh.material.dispose();
    }
    this.strikes = [];
  }

  _clearField() {
    for (const e of this.enemies) this.scene.remove(e.tank.group);
    this.enemies = [];
    for (const b of this.bullets) b.destroy();
    this.bullets = [];
    this.effects.clear();
    this.pending = [];
    this._clearHazards();
  }

  _resetRun() {
    this.stats = createStats();
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
    this.strikeT = 18;
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

  start() {
    this._clearField();
    this._resetRun();

    this._resetPlayer();
    this.camera.position.set(PLAYER_START.x, 28, PLAYER_START.z + 26);
    this.camLook.set(PLAYER_START.x, 1, PLAYER_START.z);
    this.aimPoint.set(PLAYER_START.x, 0, PLAYER_START.z - 10);
    this.hud.setHealth(this.player.hp, this.player.maxHp);

    this.hud.startPlaying();
    this.state = 'playing';
    this.aimMarker.visible = true;
    this.startWave(1);
  }

  restart() {
    this.start();
  }

  startWave(n) {
    this.wave = n;
    const bossWave = n % 5 === 0;
    const eliteWave = !bossWave && n % 5 === 3;
    const count = 2 + n * 2 - (eliteWave ? 2 : 0);
    const hp = 55 + n * 14;
    const speed = 8.5 + Math.min(4.5, n * 0.6);
    const chargers = n >= 2 && !bossWave ? Math.min(6, Math.floor(n / 2)) : 0;

    this.waveActive = true;
    this.waveTime = 0;
    this.strikeT = 18;
    this.pending = [];
    this.playerCd = 0;
    this.heat = 0;
    this.overheated = false;
    this.hud.setHeat(0, false, !!WEAPONS[this.stats.weaponId].heat);

    if (bossWave) {
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
        this.pending.push({
          t: 1.2,
          hp: Math.round(hp * 5.2),
          speed: speed * 0.8,
          type: 'elite',
          warn: 1.1,
        });
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
      const a = Math.random() * Math.PI * 2;
      const r = minR + Math.random() * (maxR - minR);
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
      const x = THREE.MathUtils.clamp(best.x + (Math.random() - 0.5) * 10, -half + 5, half - 5);
      const z = THREE.MathUtils.clamp(best.z + (Math.random() - 0.5) * 10, -half + 5, half - 5);
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
    const radius = boss ? 4.6 : type === 'charger' ? 2.0 : type === 'elite' ? 3.0 : 2.4;
    const color = boss
      ? (type === 'boss_breaker' ? 0xff2a1a : 0x38d8ff)
      : type === 'charger' ? 0xff8a2a : type === 'elite' ? 0xffd257 : 0xff4a3a;
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

  _spawnEnemyAt(hp, speed, x, z, type) {
    const enemy = new Enemy(this.scene, {
      x, z, hp, speed, type,
      camera: this.camera,
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
        // 预警期间玩家可能开过来了：重新找远处落点，避免贴脸生成
        const pp = this.player.group.position;
        if (Math.hypot(pp.x - w.x, pp.z - w.z) < 20) {
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

  /** 炮击压制：18 秒后每 7 秒锁定玩家附近，1.6 秒预警 */
  _startStrike() {
    const p = this.player.group.position;
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 4;
    const x = p.x + Math.sin(a) * r;
    const z = p.z + Math.cos(a) * r;
    const radius = 5;
    const mesh = new THREE.Mesh(WARN_GEO, new THREE.MeshBasicMaterial({
      color: 0xff3322,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.075, z);
    mesh.scale.setScalar(radius / 1.85);
    this.scene.add(mesh);
    this.strikes.push({ x, z, t: 1.6, dur: 1.6, radius, mesh });
    this.hud.showMessage('炮击锁定 · 立刻转移', 0.9);
  }

  /** Boss 破城者：围绕玩家落下一组炮击 */
  bossStrike(enemy, count = 3) {
    const p = this.player.group.position;
    const half = this.world.half;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2 + (i / count) * Math.PI * 2;
      const r = 1.5 + Math.random() * 7;
      const x = THREE.MathUtils.clamp(p.x + Math.sin(a) * r, -half + 4, half - 4);
      const z = THREE.MathUtils.clamp(p.z + Math.cos(a) * r, -half + 4, half - 4);
      const radius = 4.2;
      const mesh = new THREE.Mesh(WARN_GEO, new THREE.MeshBasicMaterial({
        color: 0xff2a1a,
        transparent: true,
        opacity: 0.75,
        side: THREE.DoubleSide,
        depthWrite: false,
      }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 0.078, z);
      mesh.scale.setScalar(radius / 1.85);
      this.scene.add(mesh);
      this.strikes.push({ x, z, t: 1.25, dur: 1.25, radius, damage: 18, mesh });
    }
    this.hud.showMessage('攻城炮击 · 离开红圈', 1.1);
  }

  _updateStrikes(dt) {
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.t -= dt;
      const k = 1 - Math.max(0, s.t) / s.dur;
      s.mesh.material.opacity = 0.4 + 0.4 * Math.abs(Math.sin(k * Math.PI * 4));
      s.mesh.scale.setScalar((s.radius / 1.85) * (0.9 + 0.1 * k));

      if (s.t > 0) continue;

      this.scene.remove(s.mesh);
      s.mesh.material.dispose();
      this.strikes.splice(i, 1);

      const hit = new THREE.Vector3(s.x, 1.2, s.z);
      this.effects.explosion(hit, 0xffb040, 34, 1.5);
      this.shake = Math.max(this.shake, 0.55);

      const p = this.player.group.position;
      if (this.player.alive && Math.hypot(p.x - s.x, p.z - s.z) < s.radius) {
        const died = this.player.takeDamage(s.damage ?? 22);
        this.hud.hurt();
        this.hud.setHealth(this.player.hp, this.player.maxHp);
        if (died) this._onPlayerDeath();
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
    this.shake = Math.max(this.shake, 0.4);

    const p = this.player.group.position;
    if (this.player.alive && Math.hypot(p.x - pos.x, p.z - pos.z) < radius) {
      const died = this.player.takeDamage(damage);
      this.hud.hurt();
      this.hud.setHealth(this.player.hp, this.player.maxHp);
      if (died) this._onPlayerDeath();
    }
  }

  // ------------------------------------------------------------------
  fire(tank, dir, damage, team, opts = {}) {
    const pos = tank.muzzleWorld(new THREE.Vector3());
    this.bullets.push(new Bullet(this.scene, {
      pos,
      dir,
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
    this.effects.muzzle(pos, dir);
    tank.recoil();
    if (team === 'player') this.shake = Math.max(this.shake, 0.1);
  }

  _firePlayer(dir, w) {
    const s = this.stats;
    const n = s.multishot;
    const base = Math.atan2(dir.x, dir.z);

    // 多联装：左右对称散布；速射机炮额外随机散布
    const spread = 0.055;
    for (let i = 0; i < n; i++) {
      const jitter = w.spread ? (Math.random() - 0.5) * w.spread * 2 : 0;
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
      });
    }
  }

  _updateAim() {
    this.aimRay.setFromCamera(this.mouseNDC, this.camera);
    const hit = this.aimRay.ray.intersectPlane(this.groundPlane, TMP);
    if (hit) {
      this.aimPoint.copy(TMP);
      this.aimMarker.position.set(TMP.x, 0.06, TMP.z);
    }
  }

  _updatePlayer(dt) {
    const player = this.player;
    if (!player.alive) return;

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
    if (aimLen > 1.2) player.setAim(Math.atan2(dx, dz));

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
      this._firePlayer(new THREE.Vector3(dx, 0, dz).normalize(), w);

      if (w.heat) {
        this.heat += w.heat.perShot;
        if (this.heat >= 1) {
          this.heat = 1;
          this.overheated = true;
          this.hud.showMessage('炮管过热 · 停火冷却', 1.1);
        }
      }
    }

    const cd = Math.max(0.01, w.fireCd);
    this.hud.setReload(1 - Math.max(0, this.playerCd) / cd);
    this.hud.setHeat(this.heat, this.overheated, !!w.heat);
  }

  _separate() {
    const p = this.player.group.position;
    for (const e of this.enemies) {
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
        if (segDistXZ(b.prev, b.pos, this.player.group.position) < 1.45 && b.pos.y < 2.3) {
          hitTarget = this.player;
        }
      }

      if (!hitTarget) continue;

      b.hits.add(hitTarget);
      const died = hitTarget.takeDamage(b.damage);
      this.effects.spark(b.pos);

      // 高爆：命中后溅射（不重复伤害直接命中目标）
      if (b.explosive > 0) {
        this._explodeAt(TMP2.copy(b.pos), b.explosive, hitTarget, b.splashMul);
      }

      if (hitTarget === this.player) {
        this.shake = Math.max(this.shake, 0.25);
        this.hud.hurt();
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
    this.scene.remove(enemy.tank.group);
    this.kills += 1;

    if (enemy.isBoss) {
      this.score += 1200 + this.wave * 80;
      this.shake = Math.max(this.shake, 0.85);
      this.hud.showMessage(`${enemy.bossName} 已击破`, 1.8);
      this.hud.hideBossBar();
    } else if (enemy.isElite) {
      this.score += 450;
      this.shake = Math.max(this.shake, 0.3);
      this.hud.showMessage('精英击破  +450', 1.1);
    } else {
      this.score += 100;
      this.shake = Math.max(this.shake, 0.12);
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

    const bonus = 150 + this.wave * 25;
    this.score += bonus;

    // 清波回血
    const before = this.player.hp;
    this.player.hp = Math.min(this.player.maxHp, this.player.hp + 6);
    const healed = Math.round(this.player.hp - before);

    this.hud.setScore(this.score);
    this.hud.setHealth(this.player.hp, this.player.maxHp);
    this.hud.showMessage(
      `第 ${this.wave} 波清除  +${bonus}${healed > 0 ? `  +${healed} 装甲` : ''}`,
      1.4
    );
  }

  _showReward() {
    const allowArmory = this.wave % 3 === 0 && this.unlocked.length < Object.keys(WEAPONS).length;
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
    this.hud.showRewards(this.wave, this.choices, this.upgradeCounts);
  }

  pickUpgrade(id) {
    if (this.state !== 'reward') return;
    if (id === 'armory') {
      this._openArmory();
      return;
    }
    const upgrade = this.choices.find((u) => u.id === id);
    if (!upgrade) return;

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
    this.strikeT -= dt;
    if (this.wave >= 2 && this.strikeT <= 0) {
      this.strikeT = 7;
      this._startStrike();
    }

    for (let i = this.pending.length - 1; i >= 0; i--) {
      this.pending[i].t -= dt;
      if (this.pending[i].t <= 0) {
        const { hp, speed, type } = this.pending[i];
        this._beginSpawn(hp, speed, type);
        this.pending.splice(i, 1);
      }
    }

    this._updateWarnings(dt);
    this._updateStrikes(dt);

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

  _updateCamera(dt) {
    const p = this.player.group.position;
    const target = TMP.set(p.x, 27, p.z + 23);
    const k = 1 - Math.exp(-5.5 * dt);
    this.camera.position.lerp(target, k);

    this.camLook.lerp(new THREE.Vector3(p.x, 1.1, p.z), 1 - Math.exp(-8 * dt));
    this.camera.lookAt(this.camLook);

    if (this.shake > 0) {
      const s = this.shake;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
      this.shake = Math.max(0, this.shake - dt * 1.6);
    }
  }

  // ------------------------------------------------------------------
  update(dt) {
    this.hud.update(dt);

    if (this.state === 'playing') {
      this.runTime += dt;
      this._updateAim();
      this._updatePlayer(dt);
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
          this.hud.showGameOver({
            wave: this.wave,
            kills: this.kills,
            score: this.score,
            time: formatTime(this.runTime),
            best,
            isNew,
          });
        }
      }
    }

    this.player.update(dt);
    this._updateCamera(dt);
    this.effects.update(dt);
    this.renderer.render(this.scene, this.camera);
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
