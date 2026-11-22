import * as THREE from '../vendor/three.module.js';

// ======================================================================
// 坦克合批（InstancedMesh）
// ----------------------------------------------------------------------
// 问题：一辆低模敌人车 = 8 个独立 Mesh（2 履带 + 车体 + 炮塔 + 炮盾 +
// 车长塔 + 炮管 + 炮口制退器）。60 辆就是 480 个 Mesh，每帧要遍历、
// 算世界矩阵、做视锥剔除、发起 480 次 draw call。9~12 波时场上就有这个量级。
//
// 但这些 Mesh 的几何体和材质是全类型共享的 —— 480 个 Mesh 其实只有
// 8 种"部件"。InstancedMesh 允许"同一个几何体 + 同一份材质，一次提交 N 个
// 变换矩阵"，于是 480 次提交变成 8 次（每种敌人配色各一套，通常 2~4 种）。
// 三角面一个不少、材质光照不变，画面逐像素一致 —— 改的只是"怎么通知 GPU"。
//
// 用法：低模车在 Tank 构造时自动注册；每帧渲染前 updateAll() 重算实例矩阵。
// 玩家自己那辆车（高细节）不进批，保持原样。
// ======================================================================

/** 单批初始容量；不够时翻倍重建（重建只丢本帧数据，下一帧就会重写） */
const CAP0 = 32;
const ONE = new THREE.Vector3(1, 1, 1);

/**
 * 一种"部件"（几何体 + 材质）对应的全部实例。
 * 例：所有 gunner 的车体方块共用一份 BoxGeometry 和一份锈红材质。
 */
class PartBatch {
  constructor(scene, geo, mat, cast) {
    this.scene = scene;
    this.geo = geo;
    this.mat = mat;
    this.cast = cast;
    this.mesh = null;
    this.cap = 0;
    this.n = 0;
    // 一辆车会往这一批里写几个实例：左右履带共用同一份几何+材质，所以是 2。
    // 容量必须按「车数 × perTank」算 —— 只按车数算会让履带写越界，
    // 多出来的实例读到缓冲区外，画面上就是履带乱飞。
    this.perTank = 1;
    this._resize(CAP0);
  }

  _resize(cap) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      // 只释放实例矩阵缓冲；几何体与材质来自共享缓存，绝不能在这里 dispose
      if (typeof this.mesh.dispose === 'function') this.mesh.dispose();
    }
    const m = new THREE.InstancedMesh(this.geo, this.mat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.castShadow = this.cast;
    m.receiveShadow = false;
    // 一批横跨整张地图，批级包围盒永远命中 —— 逐批剔除没意义，还容易误剔
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.count = 0;
    m.visible = false;
    this.scene.add(m);
    this.mesh = m;
    this.cap = cap;
    this.n = 0;
  }

  ensure(cap) {
    if (cap > this.cap) this._resize(Math.max(cap, this.cap * 2));
    this.n = 0;
  }
  flush() {
    const m = this.mesh;
    m.count = this.n;
    m.visible = this.n > 0;
    if (this.n > 0) m.instanceMatrix.needsUpdate = true;
  }
}

export class TankBatch {
  constructor(scene) {
    this.scene = scene;
    this.tanks = [];
    this.parts = new Map();     // "geo.uuid|mat.uuid" -> PartBatch
    this._wc = new THREE.Matrix4();
    this._wt = new THREE.Matrix4();
    this._out = new THREE.Matrix4();
  }

  /**
   * 接管一辆车身上的网格：记录每个部件相对车体 / 炮塔的本地矩阵，
   * 然后把 Mesh 从场景图里摘掉（场景图只留 group / turret / muzzle 这些
   * 纯变换节点，名牌、血条、护盾环这类后加的 Mesh 不受影响）。
   */
  register(tank) {
    if (tank._parts) return;
    const refs = [];
    const perTank = new Map();     // 这一辆车往每个批里塞了几个实例
    const take = (parent, turretPart) => {
      // 倒序遍历：remove 会改动 children 数组
      for (let i = parent.children.length - 1; i >= 0; i--) {
        const o = parent.children[i];
        if (!o.isMesh) continue;
        const key = `${o.geometry.uuid}|${o.material.uuid}`;
        let pb = this.parts.get(key);
        if (!pb) {
          pb = new PartBatch(this.scene, o.geometry, o.material, o.castShadow);
          this.parts.set(key, pb);
        }
        perTank.set(pb, (perTank.get(pb) || 0) + 1);
        refs.push({
          pb,
          turretPart,
          local: new THREE.Matrix4().compose(o.position, o.quaternion, o.scale),
        });
        parent.remove(o);
      }
    };
    take(tank.group, false);
    take(tank.turret, true);     // turret 是 group 的子节点，其 Mesh 的相对基准是炮塔
    for (const [pb, c] of perTank) if (c > pb.perTank) pb.perTank = c;
    tank._parts = refs;
    tank._batch = this;
    this.tanks.push(tank);
  }

  unregister(tank) {
    if (!tank._parts) return;
    const i = this.tanks.indexOf(tank);
    if (i !== -1) this.tanks.splice(i, 1);
    tank._parts = null;
    tank._batch = null;
  }

  update() {
    // 单机模式里敌人是直接 scene.remove(group) 走的，不会调 dispose；
    // 这里用 parent 是否还在顺手收尸，省掉每个调用点都要记得注销。
    // （本项目没有"移出场景再加回来"的流程，所以这里可以直接断掉零件表。）
    if (this.tanks.length) {
      let w = 0;
      for (let i = 0; i < this.tanks.length; i++) {
        const t = this.tanks[i];
        if (t._batch === this && t.group.parent) this.tanks[w++] = t;
        else { t._parts = null; t._batch = null; }
      }
      this.tanks.length = w;
    }

    const need = this.tanks.length;
    if (!need) {
      for (const pb of this.parts.values()) { pb.n = 0; pb.flush(); }
      return;
    }

    for (const pb of this.parts.values()) pb.ensure(need * pb.perTank);

    const wc = this._wc, wt = this._wt, out = this._out;
    for (let k = 0; k < need; k++) {
      const t = this.tanks[k];
      // 隐藏的车照常留在列表里（下一帧可能又出现），但本帧不占实例
      if (!t.group.visible) continue;
      wc.compose(t.group.position, t.group.quaternion, t.group.scale);
      wt.compose(t.turret.position, t.turret.quaternion, ONE);
      wt.premultiply(wc);
      const refs = t._pats || t._parts;
      for (let i = 0; i < refs.length; i++) {
        const r = refs[i];
        out.multiplyMatrices(r.turretPart ? wt : wc, r.local);
        r.pb.mesh.setMatrixAt(r.pb.n++, out);
      }
    }

    for (const pb of this.parts.values()) pb.flush();
  }
}

// ======================================================================
// 全局注册表：每个场景一份批，渲染前统一刷新
// ======================================================================
const batches = new Map();

export function batchFor(scene) {
  let b = batches.get(scene);
  if (!b) { b = new TankBatch(scene); batches.set(scene, b); }
  return b;
}

/** 渲染前调用：把所有场景的实例矩阵重算一遍（通常只有主场景一份） */
export function updateBatches() {
  for (const b of batches.values()) b.update();
}

/** 诊断用：当前批的规模（F3 面板 / 临时探针会读） */
export function batchStats() {
  let tanks = 0, inst = 0, draws = 0;
  for (const b of batches.values()) {
    tanks += b.tanks.length;
    for (const pb of b.parts.values()) {
      if (pb.n > 0) { inst += pb.n; draws++; }
    }
  }
  return { tanks, inst, draws };
}
