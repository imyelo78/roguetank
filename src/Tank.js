import * as THREE from '../vendor/three.module.js';

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
const SIZE = {
  balanced: { hw: 2.2, hh: 0.9, hl: 3.2, hy: 0.86, tw: 0.58, th: 0.66, tl: 3.45, tx: 1.06, n: 6, wr: 0.26, radius: 1.45 },
  light: { hw: 1.9, hh: 0.7, hl: 2.9, hy: 0.74, tw: 0.46, th: 0.58, tl: 3.1, tx: 0.92, n: 4, wr: 0.3, radius: 1.32 },
  heavy: { hw: 2.6, hh: 1.05, hl: 3.7, hy: 0.95, tw: 0.7, th: 0.74, tl: 3.95, tx: 1.2, n: 7, wr: 0.28, radius: 1.62 },
  hunter: { hw: 2.15, hh: 0.78, hl: 3.3, hy: 0.84, tw: 0.55, th: 0.62, tl: 3.55, tx: 1.02, n: 6, wr: 0.26, radius: 1.45 },
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
// 车体：轻装突击型 —— 低矮车体、大倾角楔形、外露大直径负重轮
// ======================================================================
function buildLight(group, s, mats, hi) {
  const wheels = [];
  addRunningGear(group, s, mats, hi, wheels);

  add(group, BOX(s.hw, s.hh, s.hl), mats.body, 0, s.hy, 0, 0, 0, 0, true);
  // 楔形首上：大倾角，视觉上非常"贴地"
  add(group, BOX(s.hw - 0.06, 0.44, 1.22), mats.accent, 0, s.hy + 0.32, s.hl * 0.24, 0.74, 0, 0, true);
  // 首下楔形
  add(group, BOX(s.hw - 0.22, 0.34, 0.62), mats.accent, 0, s.hy - 0.22, s.hl * 0.44, -0.5);
  // 侧面倾斜翼子板
  for (const sd of [-1, 1]) {
    add(group, BOX(0.3, 0.1, s.hl * 0.9), mats.accent, sd * (s.hw * 0.5 + 0.06), s.hy + s.hh * 0.42, 0, 0, 0, sd * -0.16);
  }

  // ---- 炮塔：六角小型塔，位置偏后 ----
  const turret = new THREE.Group();
  turret.position.set(0, s.hy + s.hh * 0.5 + 0.24, -0.12);
  group.add(turret);

  add(turret, CYLY(0.48, 0.6, 0.44, 6, Math.PI / 6), mats.body, 0, 0.04, 0, 0, 0, 0, true);
  add(turret, CYLY(0.42, 0.48, 0.1, 6, Math.PI / 6), mats.accent, 0, 0.3, 0);
  add(turret, BOX(0.44, 0.34, 0.26), mats.accent, 0, 0.06, 0.5, 0, 0, 0, true);
  add(turret, CYLY(0.19, 0.22, 0.12, 10), mats.metal, -0.2, 0.36, -0.12);
  if (hi) {
    // 栅栏装甲：炮塔两侧细杆
    for (const sd of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        add(turret, BOX(0.03, 0.5, 0.03), mats.metal, sd * 0.5, 0.2, 0.24 - i * 0.42);
      }
      add(turret, BOX(0.03, 0.03, 0.9), mats.metal, sd * 0.5, 0.42, 0);
    }
    // 烟幕弹发射器（斜置 3 联）
    for (let i = 0; i < 3; i++) {
      add(turret, CYLZ(0.05, 0.05, 0.22, 6), mats.dark, -0.5 + i * 0.1, 0.16, -0.28, -0.55, 0, 0);
    }
    // 细长天线（后倾）
    add(turret, CYLZ(0.015, 0.015, 1.1, 5), mats.dark, -0.36, 0.33, -0.3, -0.26, 0, 0.1);
    // 驾驶员潜望镜
    add(group, BOX(0.34, 0.09, 0.12), mats.dark, 0.42, s.hy + s.hh * 0.5 + 0.06, s.hl * 0.3, 0.3);
    add(group, BOX(0.3, 0.05, 0.03), mats.glass, 0.42, s.hy + s.hh * 0.5 + 0.11, s.hl * 0.3 + 0.04, 0.3);
  }

  // ---- 主炮：细长高初速 ----
  const BARREL_LEN = 2.05;
  add(turret, CYLZ(0.085, 0.105, BARREL_LEN, 10), mats.metal, 0, 0.06, 0.42, 0, 0, 0, true);
  add(turret, BOX(0.22, 0.2, 0.24), mats.dark, 0, 0.06, 0.42 + BARREL_LEN - 0.12, 0, 0, 0, true);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.06, 0.42 + BARREL_LEN);
  turret.add(muzzle);

  return { turret, muzzle, wheels, wheelRadius: s.wr };
}

// ======================================================================
// 车体：重装堡垒型 —— 宽大车体、附加装甲块、全包厚侧裙、双联机枪塔
// ======================================================================
function buildHeavy(group, s, mats, hi) {
  const wheels = [];
  addRunningGear(group, s, mats, hi, wheels);

  add(group, BOX(s.hw, s.hh, s.hl), mats.body, 0, s.hy, 0, 0, 0, 0, true);
  // 厚首上
  add(group, BOX(s.hw - 0.02, 0.56, 1.1), mats.accent, 0, s.hy + 0.34, s.hl * 0.3, 0.42, 0, 0, true);
  // 前部附加装甲块
  for (const sd of [-1, 1]) {
    add(group, BOX(0.46, 0.4, 0.95), mats.accent, sd * (s.hw * 0.5 - 0.3), s.hy + 0.16, s.hl * 0.36, 0.3);
  }
  // 全包厚侧裙
  for (const sd of [-1, 1]) {
    add(group, BOX(0.12, 0.62, s.hl * 0.92), mats.body, sd * (s.hw * 0.5 + 0.26), 0.7, 0);
    if (hi) {
      // 侧裙铆钉带
      add(group, BOX(0.02, 0.08, s.hl * 0.9), mats.dark, sd * (s.hw * 0.5 + 0.33), 0.44, 0);
    }
  }
  // 尾部配重 / 格栅
  add(group, BOX(s.hw - 0.34, 0.1, 0.44), mats.dark, 0, s.hy + s.hh * 0.5 + 0.02, -s.hl * 0.36);
  add(group, BOX(s.hw - 0.5, 0.3, 0.34), mats.metal, 0, s.hy - 0.1, -s.hl * 0.5, 0, 0, 0, true);

  // ---- 炮塔：大型八角塔 ----
  const turret = new THREE.Group();
  turret.position.y = s.hy + s.hh * 0.5 + 0.32;
  group.add(turret);

  add(turret, CYLY(0.8, 1.04, 0.72, 8, Math.PI / 8), mats.body, 0, 0.06, 0, 0, 0, 0, true);
  add(turret, CYLY(0.74, 0.82, 0.12, 8, Math.PI / 8), mats.accent, 0, 0.48, 0);
  // 塔前脸附加装甲
  add(turret, BOX(1.3, 0.56, 0.26), mats.accent, 0, 0.06, 0.86, 0, 0, 0, true);
  // 尾部储物篮
  add(turret, BOX(1.1, 0.36, 0.22), mats.metal, 0, 0.02, -0.95, 0, 0, 0, true);
  // 双舱盖
  for (const sd of [-1, 1]) {
    add(turret, CYLY(0.24, 0.26, 0.1, 10), mats.accent, sd * 0.3, 0.54, -0.24);
  }
  if (hi) {
    // 12.7 机枪塔
    add(turret, CYLY(0.2, 0.24, 0.26, 10), mats.accent, 0.56, 0.54, 0.02);
    add(turret, CYLZ(0.05, 0.05, 1.0, 7), mats.dark, 0.56, 0.7, 0.02);
    add(turret, CYLZ(0.02, 0.02, 1.2, 5), mats.dark, -0.7, 0.52, -0.46, -0.18, 0, 0.12);
    // 烟幕弹
    for (let i = 0; i < 2; i++) {
      add(turret, CYLZ(0.07, 0.07, 0.28, 6), mats.dark, -0.72 - i * 0.0, 0.24, 0.4 + i * 0.24, -0.4, 0, 0);
    }
    // 探照灯
    add(turret, CYLX(0.15, 0.15, 0.18, 8), mats.lamp, -0.78, 0.3, 0.3);
  }

  // ---- 主炮：粗短大口径 ----
  const BARREL_LEN = 2.35;
  add(turret, CYLZ(0.17, 0.21, BARREL_LEN, 12), mats.metal, 0, 0.08, 0.8, 0, 0, 0, true);
  add(turret, CYLZ(0.235, 0.235, 0.4, 10), mats.dark, 0, 0.08, 1.35);
  // 大型制退器
  add(turret, BOX(0.46, 0.4, 0.42), mats.dark, 0, 0.08, 0.8 + BARREL_LEN - 0.2, 0, 0, 0, true);
  add(turret, BOX(0.52, 0.1, 0.1), mats.dark, 0, 0.08, 0.8 + BARREL_LEN - 0.2);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.08, 0.8 + BARREL_LEN);
  turret.add(muzzle);

  return { turret, muzzle, wheels, wheelRadius: s.wr };
}

// ======================================================================
// 车体：猎手型 —— 无炮塔式坦克歼击车（后置固定战斗室 + 超长身管）
// ======================================================================
function buildHunter(group, s, mats, hi) {
  const wheels = [];
  addRunningGear(group, s, mats, hi, wheels);

  add(group, BOX(s.hw, s.hh, s.hl), mats.body, 0, s.hy, 0, 0, 0, 0, true);
  // 大倾角首上
  add(group, BOX(s.hw - 0.04, 0.5, 1.25), mats.accent, 0, s.hy + 0.26, s.hl * 0.26, 0.66, 0, 0, true);
  // 侧裙
  for (const sd of [-1, 1]) {
    add(group, BOX(0.06, 0.42, s.hl * 0.88), mats.accent, sd * (s.hw * 0.5 + 0.21), 0.7, 0);
  }
  // 前部备用履带板
  for (let i = 0; i < 3; i++) {
    add(group, BOX(0.5, 0.07, 0.16), mats.dark, -0.5 + i * 0.5, s.hy + 0.42, s.hl * 0.44, 0.66);
  }

  // ---- 战斗室（作为炮塔组，可随瞄准转动）----
  const turret = new THREE.Group();
  turret.position.set(0, s.hy + s.hh * 0.5 + 0.2, -0.3);
  group.add(turret);

  add(turret, BOX(1.42, 0.56, 1.5), mats.body, 0, 0.06, 0, 0, 0, 0, true);
  // 顶盖斜甲
  add(turret, BOX(1.46, 0.12, 1.42), mats.accent, 0, 0.38, -0.04, -0.1);
  // 前脸倾斜装甲
  add(turret, BOX(1.3, 0.46, 0.3), mats.accent, 0, 0.02, 0.78, 0.42, 0, 0, true);
  // 炮盾
  add(turret, BOX(0.5, 0.34, 0.32), mats.accent, 0, 0.06, 0.86, 0, 0, 0, true);
  if (hi) {
    // 车顶潜望镜
    add(turret, BOX(0.28, 0.1, 0.16), mats.dark, -0.34, 0.48, 0.1);
    add(turret, BOX(0.24, 0.05, 0.02), mats.glass, -0.34, 0.5, 0.19);
    // 天线
    add(turret, CYLZ(0.016, 0.016, 1.15, 5), mats.dark, -0.62, 0.42, -0.58, -0.15, 0, 0.12);
    // 伪装沙袋（车体前部）
    for (let i = 0; i < 3; i++) {
      const bag = add(group, SPH(0.2), mats.accent, -0.42 + i * 0.42, s.hy + 0.48, s.hl * 0.42 + (i % 2) * 0.06);
      bag.scale.set(1.5, 0.6, 1.1);
    }
    // 观察镜（战斗室侧后方）
    add(turret, BOX(0.14, 0.1, 0.14), mats.glass, 0.62, 0.42, -0.2);
  }

  // ---- 超长身管 ----
  const BARREL_LEN = 2.95;
  add(turret, CYLZ(0.1, 0.12, BARREL_LEN, 12), mats.metal, 0, 0.06, 0.8, 0, 0, 0, true);
  add(turret, CYLZ(0.155, 0.155, 0.42, 10), mats.dark, 0, 0.06, 1.55);
  add(turret, BOX(0.26, 0.24, 0.26), mats.dark, 0, 0.06, 0.8 + BARREL_LEN - 0.13, 0, 0, 0, true);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.06, 0.8 + BARREL_LEN);
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

const BUILDERS = {
  balanced: buildBalanced,
  light: buildLight,
  heavy: buildHeavy,
  hunter: buildHunter,
};

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

    const chassisId = opts.chassis && BUILDERS[opts.chassis] ? opts.chassis : 'standard';
    this.chassisId = chassisId;
    const s = SIZE[chassisId] || SIZE.balanced;
    this.radius = opts.radius ?? s.radius;

    const mats = makeMats({
      body: opts.body ?? 0x5f7a3c,
      accent: opts.accent ?? 0x3a4a24,
      metal: opts.metal ?? 0x2a2f36,
    });

    this.group = new THREE.Group();
    this.group.position.set(opts.x ?? 0, 0, opts.z ?? 0);
    this.group.rotation.y = opts.rotY ?? 0;
    scene.add(this.group);

    // 细节档位：玩家 high（负重轮、机枪、天线、烟幕弹等），敌人 low
    const hi = opts.detail !== 'low';
    const builder = BUILDERS[chassisId] || buildStandard;
    const parts = builder(this.group, s, mats, hi);

    this.turret = parts.turret;
    this.muzzle = parts.muzzle;
    this.wheels = parts.wheels;
    this.wheelRadius = parts.wheelRadius || 0.26;
    // 炮塔静止位置（后座动画以此为基准；猎手型战斗室本身有 z 偏移）
    this.turretBaseZ = this.turret.position.z;

    this.tmpV = new THREE.Vector3();
  }

  /** 车头朝向（弧度，局部 +Z 为前） */
  get yaw() { return this.group.rotation.y; }

  setAim(yaw) {
    this.turretYaw = yaw;
    this.turret.rotation.y = yaw - this.group.rotation.y;
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
    // 炮塔是世界空间朝向，车体转动后需要补偿
    this.turret.rotation.y = this.turretYaw - this.group.rotation.y;
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
