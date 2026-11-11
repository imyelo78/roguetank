import * as THREE from '../vendor/three.module.js';
import { aimTurret, angleDiff } from './core/motion.js';
import { TURRET_SNAP_RATE, normalizeChassisId } from './chassis.js';
import { tankSkin } from './teams.js';

// ======================================================================
// 材质 / 几何体缓存
// 所有坦克共享几何体与材质，避免每辆车重复构建（敌人多时开销集中在 draw call）
// ======================================================================
const matCache = new Map();
function mat(color, opts = {}) {
  const key = `${color}|${opts.emissive ?? ''}|${opts.emissiveIntensity ?? ''}|${opts.roughness ?? ''}|${opts.metalness ?? ''}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.18, ...opts });
    matCache.set(key, m);
  }
  return m;
}

const geoCache = new Map();
function geo(key, factory) {
  let g = geoCache.get(key);
  if (!g) {
    g = factory();
    geoCache.set(key, g);
  }
  return g;
}

// 识别灯的灯珠：MeshBasicMaterial 不吃光照，颜色就是色板里的那个值。
// 为什么不用高 emissive 的 Standard 材质：emissiveIntensity 一过 1，经过
// ACES 色调映射会饱和成白点——敌我都是白点，等于没做区分（第一版实测就是这样）。
const basicCache = new Map();
function basicMat(color) {
  let m = basicCache.get(color);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color });
    basicCache.set(color, m);
  }
  return m;
}

const BOX = (w, h, d) => geo(`b:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d));
/** 轴向 X 的圆柱（负重轮） */
const CYLX = (r1, r2, h, seg) => geo(`cx:${r1}:${r2}:${h}:${seg}`, () => {
  const g = new THREE.CylinderGeometry(r1, r2, h, seg);
  g.rotateZ(Math.PI / 2);
  return g;
});
/** 沿 +Z 从 0 延伸到 len 的圆柱（炮管） */
const CYLZ = (r1, r2, len, seg) => geo(`cz:${r1}:${r2}:${len}:${seg}`, () => {
  const g = new THREE.CylinderGeometry(r2, r1, len, seg);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, len / 2);
  return g;
});
/** 轴向 Y 的圆柱（车长塔 / 舱盖 / 机枪座），spin 用于让多边形的一条边朝前 */
const CYLY = (rt, rb, h, seg, spin = 0) => geo(`cy:${rt}:${rb}:${h}:${seg}:${spin}`, () => {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  if (spin) g.rotateY(spin);
  return g;
});
const SPH = (r) => geo(`s:${r}`, () => new THREE.SphereGeometry(r, 8, 6));

function add(parent, geometry, material, x, y, z, rx = 0, ry = 0, rz = 0, shadow = false) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  if (rx) m.rotation.x = rx;
  if (ry) m.rotation.y = ry;
  if (rz) m.rotation.z = rz;
  m.castShadow = shadow;
  parent.add(m);
  return m;
}

// ======================================================================
// 车体尺寸表
// ======================================================================
// 车体尺寸。现在只有一款「豹式」，沿用原均衡型的比例。
// 旧的 light / heavy / hunter 键保留成一模一样的数值别名：
// 老版本客户端或老存档里可能还带这些 id，查不到就会退回第一项，
// 车会凭空变大或变小——玩家看到的是"我的车不认识了"，很难归因。
const PANTHER = { hw: 2.2, hh: 0.9, hl: 3.2, hy: 0.86, tw: 0.58, th: 0.66, tl: 3.45, tx: 1.06, n: 6, wr: 0.26, radius: 1.45 };
const SIZE = {
  panther: PANTHER,
  balanced: PANTHER,
  light: PANTHER,
  heavy: PANTHER,
  hunter: PANTHER,
};

function makeMats({ body, accent, metal }) {
  return {
    body: mat(body),
    accent: mat(accent),
    metal: mat(metal),
    dark: mat(0x181c20, { roughness: 0.94, metalness: 0.1 }),
    wheel: mat(0x252b31, { roughness: 0.86, metalness: 0.3 }),
    glass: mat(0x9fe3f5, { emissive: 0x2d7d99, emissiveIntensity: 0.85, roughness: 0.28, metalness: 0.4 }),
    lamp: mat(0xffe4a6, { emissive: 0xffb347, emissiveIntensity: 0.9, roughness: 0.4 }),
  };
}

// ======================================================================
// 行走机构：履带 + 负重轮（负重轮参与滚动动画）
// ======================================================================
function addRunningGear(group, s, mats, hi, wheels) {
  for (const sd of [-1, 1]) {
    const cx = sd * s.tx;
    // 履带主体
    add(group, BOX(s.tw, s.th, s.tl), mats.metal, cx, s.th * 0.5 + 0.07, 0, 0, 0, 0, true);
    if (!hi) continue;
    // 履带内衬（深色，制造厚度感；低细节档省略以省 draw call）
    add(group, BOX(s.tw * 0.7, s.th * 0.9, s.tl * 1.01), mats.dark, cx, s.th * 0.5 + 0.07, 0);

    const wx = sd * (s.tx + s.tw * 0.5 - 0.035);
    const wy = s.wr + 0.12;
    const z0 = -s.tl * 0.5 + 0.44;
    const z1 = s.tl * 0.5 - 0.44;
    for (let i = 0; i < s.n; i++) {
      const zz = s.n === 1 ? 0 : z0 + ((z1 - z0) * i) / (s.n - 1);
      wheels.push(add(group, CYLX(s.wr, s.wr, s.tw * 0.42, 12), mats.wheel, wx, wy, zz));
    }
    // 前后诱导轮（直径更大）
    wheels.push(add(group, CYLX(s.wr * 1.22, s.wr * 1.22, s.tw * 0.42, 12), mats.wheel, wx, wy, z1 + 0.06));
    wheels.push(add(group, CYLX(s.wr * 1.22, s.wr * 1.22, s.tw * 0.42, 12), mats.wheel, wx, wy, z0 - 0.06));
  }
}

// ======================================================================
// 车体：均衡型 —— 标准主战坦克（斜首上 + 侧裙 + 尾部格栅）
// ======================================================================
function buildBalanced(group, s, mats, hi) {
  const wheels = [];
  addRunningGear(group, s, mats, hi, wheels);

  add(group, BOX(s.hw, s.hh, s.hl), mats.body, 0, s.hy, 0, 0, 0, 0, true);
  // 斜首上装甲
  add(group, BOX(s.hw - 0.04, 0.46, 1.05), mats.accent, 0, s.hy + 0.3, s.hl * 0.3, 0.52, 0, 0, true);
  // 首下挡泥板
  add(group, BOX(s.hw + 0.06, 0.14, 0.46), mats.metal, 0, s.hy - 0.18, s.hl * 0.5 - 0.12);
  // 侧裙
  if (hi) {
    for (const sd of [-1, 1]) {
      add(group, BOX(0.06, 0.4, s.hl * 0.86), mats.accent, sd * (s.hw * 0.5 + 0.22), 0.72, 0);
    }
  }
  // 尾部发动机格栅
  add(group, BOX(s.hw - 0.3, 0.06, 0.5), mats.dark, 0, s.hy + s.hh * 0.5 + 0.02, -s.hl * 0.34);
  if (hi) {
    for (let i = -1; i <= 1; i++) {
      add(group, BOX(s.hw - 0.36, 0.04, 0.05), mats.metal, 0, s.hy + s.hh * 0.5 + 0.06, -s.hl * 0.34 + i * 0.14);
    }
    // 尾部排气（朝后伸出）
    add(group, CYLZ(0.11, 0.13, 0.34, 8), mats.dark, -s.hw * 0.28, s.hy + 0.2, -s.hl * 0.5, 0, Math.PI, 0);
  }

  // ---- 炮塔：八角铸造塔 ----
  const turret = new THREE.Group();
  turret.position.y = s.hy + s.hh * 0.5 + 0.3;
  group.add(turret);

  add(turret, CYLY(0.62, 0.86, 0.62, 8, Math.PI / 8), mats.body, 0, 0.06, 0, 0, 0, 0, true);
  add(turret, CYLY(0.58, 0.64, 0.12, 8, Math.PI / 8), mats.accent, 0, 0.42, 0);
  // 炮盾
  add(turret, BOX(0.56, 0.44, 0.34), mats.accent, 0, 0.08, 0.72, 0, 0, 0, true);
  // 车长塔 + 舱盖
  add(turret, CYLY(0.29, 0.33, 0.2, 10), mats.accent, -0.3, 0.5, -0.16);
  add(turret, CYLY(0.21, 0.23, 0.07, 10), mats.metal, -0.3, 0.63, -0.16);
  if (hi) {
    // 高射机枪
    add(turret, CYLY(0.11, 0.13, 0.14, 8), mats.metal, 0.42, 0.5, 0.05);
    add(turret, CYLZ(0.045, 0.045, 0.85, 7), mats.dark, 0.42, 0.62, 0.05);
    // 天线
    add(turret, CYLZ(0.018, 0.018, 0.95, 5), mats.dark, -0.56, 0.44, -0.36, -0.2, 0, 0.14);
    // 烟幕弹发射器
    for (let i = 0; i < 3; i++) {
      add(turret, CYLZ(0.055, 0.055, 0.24, 6), mats.dark, 0.62 - i * 0.11, 0.2, -0.3, -0.5, 0, 0);
    }
    // 探照灯
    add(turret, CYLX(0.13, 0.13, 0.16, 8), mats.lamp, -0.62, 0.28, 0.28, 0, 0, 0);
  }

  // ---- 主炮 ----
  const BARREL_LEN = 2.25;
  add(turret, CYLZ(0.13, 0.16, BARREL_LEN, 12), mats.metal, 0, 0.08, 0.6, 0, 0, 0, true);
  // 抽气装置
  add(turret, CYLZ(0.185, 0.185, 0.36, 10), mats.dark, 0, 0.08, 1.15);
  // 炮口制退器
  add(turret, BOX(0.34, 0.3, 0.3), mats.dark, 0, 0.08, 0.6 + BARREL_LEN - 0.16, 0, 0, 0, true);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.08, 0.6 + BARREL_LEN);
  turret.add(muzzle);

  return { turret, muzzle, wheels, wheelRadius: s.wr };
}

// ======================================================================
// 通用（敌方）车体：介于均衡型与简化之间，保证多敌人时开销可控
// ======================================================================
function buildStandard(group, s, mats, hi) {
  const wheels = [];
  addRunningGear(group, s, mats, hi, wheels);

  add(group, BOX(s.hw, s.hh, s.hl), mats.body, 0, s.hy, 0, 0, 0, 0, true);
  add(group, BOX(s.hw - 0.05, 0.44, 0.95), mats.accent, 0, s.hy + 0.28, s.hl * 0.32, 0.5, 0, 0, true);

  const turret = new THREE.Group();
  turret.position.y = s.hy + s.hh * 0.5 + 0.28;
  group.add(turret);

  add(turret, CYLY(0.58, 0.8, 0.58, 8, Math.PI / 8), mats.body, 0, 0.05, 0, 0, 0, 0, true);
  add(turret, BOX(0.5, 0.4, 0.3), mats.accent, 0, 0.06, 0.66, 0, 0, 0, true);
  add(turret, CYLY(0.24, 0.27, 0.18, 10), mats.accent, -0.28, 0.4, -0.16);

  const BARREL_LEN = 2.1;
  add(turret, CYLZ(0.12, 0.15, BARREL_LEN, 10), mats.metal, 0, 0.06, 0.55, 0, 0, 0, true);
  add(turret, BOX(0.3, 0.26, 0.26), mats.dark, 0, 0.06, 0.55 + BARREL_LEN - 0.14, 0, 0, 0, true);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.06, 0.55 + BARREL_LEN);
  turret.add(muzzle);

  return { turret, muzzle, wheels, wheelRadius: s.wr };
}

// 只有一款车：豹式。
//
// ⚠ 这里踩过一个很贵的坑：BUILDERS 原来只有 balanced/light/heavy/hunter 四个键，
//   而合并车体后客户端传的是 'panther'，查不到就落到 buildStandard（敌人用的极简模型）。
//   结果"合并成豹式"在数据层是对的，玩家看到的却是一辆没有侧裙、没有炮盾、
//   没有车长塔的简模——看起来就像"根本没人处理这件事"。
//   现在键就是 'panther'，并且缺失时**必须报错式回退到豹式**，别再静默降级。
const BUILDERS = {
  panther: buildBalanced,
};

// ======================================================================
// 射界扇面：无炮塔车在地上画出"炮口能扫到的那 30°"
//
// 为什么值得单独画：轻装/猎手是四台车里玩法差异最大的两台，但限制本身
// 看不见——玩家只会觉得"准星对着人却不掉血"。把扇面铺在地上，
// 一眼就能读懂"炮口只能在这个锥形里，要打车就得转车身"。
// 全向炮塔不画（没有边界可画）。
// ======================================================================
const FAN_RADIUS = 6;

function makeTraverseFan(limit) {
  const g = new THREE.Group();

  // CircleGeometry 在 XY 平面、theta 从 +X 起算；绕 X 转 -90° 后 +Y 落到 -Z。
  // 想让扇面中心指向局部 +Z（车头），theta 基准要放在 -PI/2。
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(FAN_RADIUS, 26, -Math.PI / 2 - limit, limit * 2),
    new THREE.MeshBasicMaterial({
      color: 0xffc266, transparent: true, opacity: 0.07,
      depthWrite: false, side: THREE.DoubleSide,
    })
  );
  fill.rotation.x = -Math.PI / 2;
  fill.position.y = 0.05;
  g.add(fill);

  const pts = [];
  for (const a of [-limit, limit]) {
    const th = -Math.PI / 2 + a;
    pts.push(0, 0, 0, Math.cos(th) * FAN_RADIUS, 0, -Math.sin(th) * FAN_RADIUS);
  }
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({
    color: 0xffc266, transparent: true, opacity: 0.24, depthWrite: false,
  }));
  lines.position.y = 0.06;
  g.add(lines);

  return g;
}

// ======================================================================
export class Tank {
  constructor(scene, opts = {}) {
    this.team = opts.team || 'enemy';
    this.maxHp = opts.hp ?? 100;
    this.hp = this.maxHp;
    this.speed = opts.speed ?? 11;
    this.alive = true;
    this.recoilT = 0;
    this.turretYaw = 0;
    this.wheelSpin = 0;
    this.odometer = 0;
    this._lastOdo = 0;

    // 炮塔参数：与联机端 core/motion.js 的 aimTurret 共用一套语义
    //   rate  —— 角速度上限（rad/s），TURRET_SNAP_RATE 等于"瞬间对准"
    //   limit —— 相对车头的射界半角（rad），π 为全向
    // 默认值保持旧行为（全向瞬间），不传的车（敌人、队友）不受影响。
    this.turretRate = opts.turretRate ?? TURRET_SNAP_RATE;
    this.turretLimit = opts.turretLimit ?? Math.PI;
    // 传了 chassis = 玩家车（含老客户端发来的 balanced/light/heavy/hunter），
    // 一律归一化成豹式；没传 = 敌人，用它们自己的低模。
    const chassisId = opts.chassis ? normalizeChassisId(opts.chassis) : 'standard';
    this.chassisId = chassisId;
    const s = SIZE[chassisId] || SIZE.panther || SIZE.balanced || Object.values(SIZE)[0];
    this.radius = opts.radius ?? s.radius;

    // 阵营配色统一从 teams.js 取：显式传的优先，没传按 team 落到阵营色。
    // 这里以前是 body ?? 0x5f7a3c —— "缺省绿"让组队模式的玩家和敌人同色。
    const skin = tankSkin({
      team: this.team,
      type: opts.type,
      body: opts.body,
      accent: opts.accent,
      metal: opts.metal,
      lamp: opts.lamp,
    });
    this.skin = skin;
    const mats = makeMats({ body: skin.body, accent: skin.accent, metal: skin.metal });

    this.group = new THREE.Group();
    this.group.position.set(opts.x ?? 0, 0, opts.z ?? 0);
    this.group.rotation.y = opts.rotY ?? 0;
    scene.add(this.group);

    // 细节档位：玩家 high（负重轮、机枪、天线、烟幕弹等），敌人 low
    const hi = opts.detail !== 'low';
    // 敌人（chassisId === 'standard'）走低模；其余一律豹式。
    // 注意兜底是 buildBalanced 而不是 buildStandard：宁可多画几个零件，
    // 也不能让玩家的车悄悄变成一个"不是设计稿里那辆"的简模。
    const builder = chassisId === 'standard' ? buildStandard : (BUILDERS[chassisId] || BUILDERS.panther);
    const parts = builder(this.group, s, mats, hi);

    this.turret = parts.turret;
    this.muzzle = parts.muzzle;
    this.wheels = parts.wheels;
    this.wheelRadius = parts.wheelRadius || 0.26;
    // 炮塔静止位置（后座动画以此为基准；猎手型战斗室本身有 z 偏移）
    this.turretBaseZ = this.turret.position.z;

    // ---- 阵营识别灯 ----
    // 车体色负责"大色块敌我"，但草绿地形 + 黄昏侧光下，敌军铁锈红有时会
    // 读成"深绿"。炮塔顶这根灯杆是自发光的（emissive 不吃光照），
    // 远距离就是一个色点：青绿=自己、青蓝=队友、血红=敌人。
    //
    // 用一根短杆而不是浮空球：玩家高模炮塔顶在 0.48、敌人低模在 0.34，
    // 固定高度的球会在一半车上悬空；杆子从 0.17 起，两种车都是"插在顶上"。
    // 材质走共享缓存，N 辆敌人也只多两个 draw call（杆 + 灯头）。
    this.lampColor = skin.lamp;
    add(this.turret, CYLY(0.05, 0.05, 0.46, 6), mats.metal, 0, 0.40, -0.48);
    this.lamp = add(this.turret, SPH(0.19), basicMat(skin.lamp), 0, 0.60, -0.48);

    // 有射界的车（轻装 / 猎手）在地上铺一层扇面，让"炮口只能扫这么宽"看得见
    this.traverseFan = null;
    if (this.turretLimit < Math.PI - 1e-3) {
      this.traverseFan = makeTraverseFan(this.turretLimit);
      this.group.add(this.traverseFan);
    }

    this.tmpV = new THREE.Vector3();
  }

  /** 车头朝向（弧度，局部 +Z 为前） */
  get yaw() { return this.group.rotation.y; }

  /** 世界坐标（模拟层 aimTurret 要读 body.x / body.z） */
  get x() { return this.group.position.x; }
  get z() { return this.group.position.z; }

  /** 直接指定炮塔世界朝向（快照/服务端权威值，不做平滑也不夹射界） */
  setAim(yaw) {
    this.turretYaw = yaw;
    // 同步基准车头角：aimTurret 靠这个差值算"车体带炮塔转了多少"。
    // 不同步的话，下一帧会把"服务端给的角度 - 旧车头"当成一次车体转向，
    // 炮口会凭空多转一段，射击方向就飘了。
    this._aimYaw = this.group.rotation.y;
    this._syncTurret();
  }

  /**
   * 朝世界坐标瞄准，走 core/motion.js 的 aimTurret —— 与联机端**同一份实现**。
   *
   * 两端各写一套炮塔逻辑的后果和运动学一样：单机瞬狙、联机 10 rad/s，
   * 同一个玩家换个模式就得重新练一遍手感；加了射界之后还会出现
   * "单机能打到、联机打不到"这种更难查的不一致。
   */
  aimAt(aimX, aimZ, dt) {
    aimTurret(this, aimX, aimZ, dt, this.turretRate, this.turretLimit);
    this.turret.rotation.y = angleDiff(this.turretYaw, this.group.rotation.y);
  }

  /** 把炮塔相对车头的角度收进射界，并刷到可视对象上 */
  _syncTurret() {
    // 直接借 core 的实现做"车体带动 + 射界夹紧"，不在这里再写一遍：
    // 两份夹紧逻辑一旦有一行不同，单机炮口和联机炮口就会对不上。
    aimTurret(this, undefined, undefined, 0, this.turretRate, this.turretLimit);
    this.turret.rotation.y = angleDiff(this.turretYaw, this.group.rotation.y);
  }

  /** 炮塔平滑转向目标（用于 AI） */
  aimTowards(yaw, dt, rate = 5.5) {
    let diff = yaw - this.turretYaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const step = Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
    this.setAim(this.turretYaw + step);
    return Math.abs(diff);
  }

  muzzleWorld(out = this.tmpV) {
    return this.muzzle.getWorldPosition(out);
  }

  recoil() { this.recoilT = 0.12; }

  /**
   * 沿方向移动，带轴向分离的碰撞处理
   * @returns {boolean} 是否实际移动
   */
  move(dx, dz, dt, world) {
    if (!this.alive) return false;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) return false;
    dx /= len; dz /= len;

    const step = this.speed * dt;
    const p = this.group.position;
    const ox = p.x, oz = p.z;
    let moved = false;

    const nx = p.x + dx * step;
    if (!world.blocked(nx, p.z, this.radius)) { p.x = nx; moved = true; }

    const nz = p.z + dz * step;
    if (!world.blocked(p.x, nz, this.radius)) { p.z = nz; moved = true; }

    if (moved) this.odometer += Math.hypot(p.x - ox, p.z - oz);
    this.turnTo(Math.atan2(dx, dz), dt * 8);
    return moved;
  }

  turnTo(yaw, rate) {
    let diff = yaw - this.group.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.group.rotation.y += Math.sign(diff) * Math.min(Math.abs(diff), rate);
    // 炮塔是世界空间朝向，车体转动后要跟着补偿，并夹回射界
    this._syncTurret();
  }

  update(dt) {
    if (this.recoilT > 0) {
      this.recoilT = Math.max(0, this.recoilT - dt);
    }
    this.turret.position.z = this.turretBaseZ - (this.recoilT / 0.12) * 0.32;

    // 负重轮随行驶里程滚动
    if (this.wheels.length && this.odometer !== this._lastOdo) {
      const d = this.odometer - this._lastOdo;
      this._lastOdo = this.odometer;
      this.wheelSpin += d / this.wheelRadius;
      for (let i = 0; i < this.wheels.length; i++) this.wheels[i].rotation.x = this.wheelSpin;
    }
  }

  takeDamage(amount) {
    if (!this.alive) return false;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) {
      this.alive = false;
      return true;
    }
    return false;
  }

  dispose(scene) {
    scene.remove(this.group);
    // 几何体与材质全部来自共享缓存，不在此释放
  }
}
