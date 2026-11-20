// Boss 场地标记的渲染（r46）
//
// 服务端在快照的 bz 字段里下发 [kind, x, z, r, t]，这里按 kind 画到地面：
//   0 跃迁预警  —— 紫色环，随 t 收缩（收满就是它落地的那一刻）
//   1 岩浆区    —— 橙色圆盘，边缘亮
//   2 冲刺路径  —— 黄色环（撞击半径），短促
//   3 冲击波    —— 玫红环，向外扩散
//   4 炮击预警  —— 红色圆盘，随 t 变亮（亮到顶就是它砸下来的那一刻）
//
// 为什么不复用 Effects：Effects 是"一次性爆炸"的池子，寿命按毫秒算；
// 预警圈要活 1.2 秒并跟着服务端状态走，必须能被"续命"和"改半径"。
// 这里每个 kind 一个池，对象复用、材质复用，不会泄漏。

import * as THREE from '../vendor/three.module.js';

const RING_GEO = new THREE.RingGeometry(0.9, 1.0, 48);
// 危险区边缘用更细的环：0.9~1.0 那圈在 5 米半径上是半米宽，看着像"沙圈"
const EDGE_GEO = new THREE.RingGeometry(0.955, 1.0, 64);
const DISC_GEO = new THREE.CircleGeometry(1, 40);

const STYLE = {
  0: { geo: RING_GEO, color: 0x9b7bff, alpha: 0.85, pulse: true },
  1: { geo: DISC_GEO, color: 0xff3c00, alpha: 0.42, pulse: false },
  2: { geo: RING_GEO, color: 0xffd23a, alpha: 0.7, pulse: false },
  3: { geo: RING_GEO, color: 0xff3b6b, alpha: 0.8, pulse: false },
  // 4 炮击预警：地面亮红，越接近爆炸越亮——2.5 秒的窗口里玩家只需要
  // 判断"这块地还能不能站"，不需要读秒。
  4: { geo: DISC_GEO, color: 0xff2a1a, alpha: 0.5, pulse: true },
};

// 危险区的边缘线。
//
// 光靠一个半透明圆盘，玩家判断不出"我是不是已经站进去了"——尤其是暗色
// 地形上，圆盘中心和边缘的透明度看不出差别。岩浆和炮击这两个"站错就掉血"
// 的机制必须有一条实线边界，否则玩家只会觉得"莫名其妙在掉血"。
const EDGE = {
  1: { geo: EDGE_GEO, color: 0xff5a00, alpha: 1, pulse: false, shrink: 0 },
  4: { geo: EDGE_GEO, color: 0xff2010, alpha: 0.75, pulse: true, shrink: 0.3 },
};

export class ZoneVisual {
  constructor(scene) {
    this.scene = scene;
    this.pools = new Map();   // key → Mesh[]
    this.mats = new Map();    // key → Material（同 key 共享，只改 opacity）
  }

  _material(key, st) {
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color: st.color, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false,
      });
      this.mats.set(key, m);
    }
    return m;
  }

  /** 取（或新建）池子里的第 idx 个 mesh，并按样式建材质 */
  _mesh(key, idx, st) {
    let pool = this.pools.get(key);
    if (!pool) { pool = []; this.pools.set(key, pool); }
    let mesh = pool[idx];
    if (!mesh) {
      mesh = new THREE.Mesh(st.geo || RING_GEO, this._material(key, st));
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 2;
      this.scene.add(mesh);
      pool[idx] = mesh;
    }
    return mesh;
  }

  /** 每帧同步：zones 是服务端解出来的（已按 kind/x/z/r/t 归一） */
  sync(zones) {
    const list = zones || [];
    const used = new Map();
    const t = performance.now() / 1000;
    // 材质是按 key 共享的，每帧要清零再加权，否则上一帧的高 opacity 会残留
    for (const [, m] of this.mats) m.opacity = 0;

    /** 记录一次"这个池子用到了第 idx 个"，并把它需要的亮度上报给共享材质 */
    const bump = (key, st, want) => {
      const mat = this._material(key, st);
      if (want > mat.opacity) mat.opacity = want;
    };

    for (const z of list) {
      const kind = STYLE[z.kind] ? z.kind : 0;
      const st = STYLE[kind];
      const idx = used.get(kind) || 0;
      used.set(kind, idx + 1);

      const mesh = this._mesh(kind, idx, st);
      mesh.visible = true;
      mesh.position.set(z.x, 0.09, z.z);

      // t = 0→1 的进度
      let radius = z.r;
      if (kind === 0) {
        // 预警圈：从外圈收到中心，收满即落地
        const k = 1 - Math.max(0, Math.min(1, z.t)) * 0.86;
        radius = Math.max(0.2, z.r * k);
      } else if (kind === 3) {
        // 冲击波：向外扩散
        radius = z.r * (0.4 + z.t * 1.6);
      }
      mesh.scale.setScalar(radius);

      // 共享材质：opacity 取当前所有同类中"最需要可见"的那个，
      // 多圈同屏时不会互相把对方调暗。
      // fade：岩浆快消失时变淡、炮击预警越临近爆炸越亮。
      let fade = 1;
      if (kind === 1) fade = Math.max(0.2, 1 - z.t);
      else if (kind === 4) fade = 0.4 + 0.6 * z.t;
      bump(kind, st, st.alpha * fade
        * (st.pulse ? 0.72 + 0.28 * Math.abs(Math.sin(t * 9)) : 1));

      // 边缘线
      const ed = EDGE[kind];
      if (ed) {
        const ekey = 'e' + kind;
        const eidx = used.get(ekey) || 0;
        used.set(ekey, eidx + 1);
        const em = this._mesh(ekey, eidx, ed);
        em.visible = true;
        em.position.set(z.x, 0.11, z.z);
        em.scale.setScalar(radius * (1 - ed.shrink * z.t));
        bump(ekey, ed, ed.alpha * fade
          * (ed.pulse ? 0.72 + 0.28 * Math.abs(Math.sin(t * 9)) : 1));
      }
    }

    // 没被用到的隐藏
    for (const [key, pool] of this.pools) {
      const n = used.get(key) || 0;
      for (let i = n; i < pool.length; i++) pool[i].visible = false;
    }
  }

  clear() {
    for (const [, pool] of this.pools) for (const m of pool) m.visible = false;
  }

  dispose() {
    for (const [, pool] of this.pools) {
      for (const m of pool) this.scene.remove(m);
    }
    this.pools.clear();
    for (const [, m] of this.mats) m.dispose();
    this.mats.clear();
  }
}

// ---------------- 旋转光束（哨戒） ----------------

// 几何直接建在 XZ 平面上（长边沿本地 +z），这样运行时只需要 rotation.y = yaw，
// 不用去凑 Euler 顺序——凑错了的表现是"光束绕着一条斜轴乱翻"。
const BEAM_GEO = new THREE.PlaneGeometry(1, 1);
BEAM_GEO.rotateX(-Math.PI / 2);

const BEAM_WIDTH = 2.7;      // 与 BOSS_SKILLS.laser.halfWidth × 2 对齐
const BEAM_COLOR = 0x59f0c0; // 与 HUD 上哨戒血条的色一致

/**
 * 沿 yaw 铺在地面上的光带，两条（相差 π）构成哨戒的扫描光束。
 *
 * 为什么不画成"一束竖着的激光柱"：这游戏是俯视偏后的追尾视角，
 * 竖直的柱子一旦正对镜头就退化成一条线，玩家会突然看不出光束在哪——
 * 而地面光带在任何角度都保留"哪里不能站"这个信息。
 *
 * 光束的**判定**在 core/bosskit.js 的 stepZones 之外（world.js 里的角差判据），
 * 这里只负责让玩家看见它。
 */
export class BeamVisual {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    // 两层：宽而暗的辉光 + 窄而亮的核心。
    // 只画一层的话，光带在暗地面上是一块均匀的色块，看不出"这是一道光"，
    // 也判断不出中心线在哪——而判定恰恰是按横向偏移 1.35 米算的。
    this.matGlow = new THREE.MeshBasicMaterial({
      color: BEAM_COLOR, transparent: true, opacity: 0.26,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.matCore = new THREE.MeshBasicMaterial({
      color: 0xd8fff4, transparent: true, opacity: 0.72,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
  }

  /** @param {{x:number,z:number,yaw:number,len:number}[]} beams */
  sync(beams) {
    const list = beams || [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      for (let layer = 0; layer < 2; layer++) {
        const k = i * 2 + layer;
        let mesh = this.pool[k];
        if (!mesh) {
          mesh = new THREE.Mesh(BEAM_GEO, layer === 0 ? this.matGlow : this.matCore);
          mesh.renderOrder = 3;
          this.scene.add(mesh);
          this.pool[k] = mesh;
        }
        mesh.visible = true;
        mesh.rotation.y = b.yaw;
        mesh.scale.set(layer === 0 ? BEAM_WIDTH : BEAM_WIDTH * 0.28, 1, b.len);
        mesh.position.set(
          b.x + Math.sin(b.yaw) * b.len * 0.5,
          layer === 0 ? 0.14 : 0.15,
          b.z + Math.cos(b.yaw) * b.len * 0.5,
        );
      }
    }
    for (let i = list.length * 2; i < this.pool.length; i++) this.pool[i].visible = false;
  }

  clear() {
    for (const m of this.pool) m.visible = false;
  }

  dispose() {
    for (const m of this.pool) this.scene.remove(m);
    this.pool.length = 0;
    this.matGlow.dispose();
    this.matCore.dispose();
  }
}
