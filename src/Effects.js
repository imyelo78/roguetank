import * as THREE from '../vendor/three.module.js';

// ---------------- 共享几何体 ----------------
//
// 所有特效几何体都是模块级常量：进程内只建一次，永不 dispose。
// 之前 explosion() 每次都 new SphereGeometry + 每个粒子单独 new 材质，
// 多敌同爆时一帧内几十次分配 + 几十次 dispose，GC 尖峰就是联机卡顿的来源之一。
const PARTICLE_GEO = new THREE.SphereGeometry(0.22, 6, 5);
const RING_GEO = new THREE.RingGeometry(0.55, 0.75, 24);
const FLASH_GEO = new THREE.SphereGeometry(1, 8, 6);
const MUZZLE_GEO = new THREE.SphereGeometry(0.42, 8, 6);

// 各类特效的材质模板（不含颜色：颜色随每次获取时设置）
// 注意：update() 会逐 mesh 改 material.opacity，所以每个 mesh 必须持有
// 自己的材质实例——池化的正是"mesh + 专属材质"这一对，而不是共享材质。
const MATERIAL_SPECS = {
  particle: () => new THREE.MeshBasicMaterial({ transparent: true }),
  ring: () => new THREE.MeshBasicMaterial({
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
  }),
  flash: () => new THREE.MeshBasicMaterial({
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }),
  muzzle: () => new THREE.MeshBasicMaterial({
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }),
};

const V = new THREE.Vector3();

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    // 对象池：按特效类型回收 mesh（连同伴生材质）。
    // 池自然收敛到"历史同时存在的最大数量"，游戏内同时存在的特效就几十个，无泄漏风险。
    this._pool = { particle: [], ring: [], flash: [], muzzle: [] };
    // 粒子预算（0~1）：由画质档位设置。低配设备同一次爆炸只发一半碎片——
    // 爆炸的观感主要靠火环和闪光，碎片减半几乎看不出，省下的填充率很实在。
    this.budget = 1;
  }

  /** 从池里取一个 mesh；池空才新建。颜色由调用方随后设置。 */
  _acquire(kind) {
    let m = this._pool[kind].pop();
    if (!m) {
      const geo = { particle: PARTICLE_GEO, ring: RING_GEO, flash: FLASH_GEO, muzzle: MUZZLE_GEO }[kind];
      m = new THREE.Mesh(geo, MATERIAL_SPECS[kind]());
      m._fxKind = kind;
    }
    m.visible = true;
    return m;
  }

  _push(mesh, opts) {
    this.scene.add(mesh);
    this.items.push({
      mesh,
      vel: opts.vel || new THREE.Vector3(),
      life: opts.life,
      maxLife: opts.life,
      gravity: opts.gravity ?? 0,
      grow: opts.grow ?? 0,
      shrink: opts.shrink ?? 0,
      fade: opts.fade ?? true,
    });
  }

  /** 爆炸：碎片 + 冲击环 */
  explosion(pos, color = 0xffa040, count = 14, power = 1) {
    count = Math.max(4, Math.round(count * this.budget));
    for (let i = 0; i < count; i++) {
      const m = this._acquire('particle');
      m.material.color.setHex(Math.random() > 0.45 ? color : 0x2b2b2b);
      m.material.opacity = 1;
      const s = 0.6 + Math.random() * 1.5 * power;
      m.scale.setScalar(s);
      m.position.copy(pos).add(V.set(
        (Math.random() - 0.5) * 1.2,
        Math.random() * 0.8,
        (Math.random() - 0.5) * 1.2
      ));
      const sp = (5 + Math.random() * 11) * power;
      const a = Math.random() * Math.PI * 2;
      const up = 2 + Math.random() * 7;
      this._push(m, {
        vel: new THREE.Vector3(Math.cos(a) * sp, up, Math.sin(a) * sp),
        life: 0.55 + Math.random() * 0.45,
        gravity: 22,
        shrink: 1.6,
      });
    }

    const ring = this._acquire('ring');
    ring.material.color.setHex(0xffd9a0);
    ring.material.opacity = 0.85;
    ring.rotation.x = -Math.PI / 2;
    ring.scale.setScalar(1); // 池化复用：清掉上一轮 grow 累积的缩放
    ring.position.copy(pos).setY(0.12);
    this._push(ring, { life: 0.4, grow: 13, fade: true });

    // 火光
    const flash = this._acquire('flash');
    flash.material.color.setHex(0xffcf7a);
    flash.material.opacity = 0.9;
    flash.position.copy(pos);
    flash.scale.setScalar(0.6);
    this._push(flash, { life: 0.18, grow: 9 });
  }

  /**
   * Boss 技能的地面预警圈（r46）：从半径收拢到中心，收满即触发。
   *
   * 复用爆炸用的环形池子，所以不会泄漏；靠 grow 传负值做收缩。
   * 真正的判定时机在 Enemy 的 castT 上，这里的圈只负责"让玩家看懂"——
   * 观感差半帧没关系，但**不能没有**：r45 删掉的棱镜跃迁就是栽在
   * "只有结果、没有预告"上。
   */
  warn(pos, radius = 6, dur = 1.2, color = 0x9b7bff) {
    const ring = this._acquire('ring');
    ring.material.color.setHex(color);
    ring.material.opacity = 0.85;
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos).setY(0.1);
    ring.scale.setScalar(radius);
    // 指数收缩：1.5 的速率在 1.2 秒后约剩 16%，正好是"收拢到中心"的观感
    this._push(ring, { life: dur, grow: -1.5, fade: true });
  }

  /** 炮口闪光 */
  muzzle(pos, dir) {
    const m = this._acquire('muzzle');
    m.material.color.setHex(0xffd58a);
    m.material.opacity = 0.95;
    m.scale.setScalar(1); // 池化复用：清掉上一轮 grow 累积的缩放
    m.position.copy(pos);
    this._push(m, {
      life: 0.09,
      grow: 6,
      vel: dir.clone().multiplyScalar(6),
    });
  }

  /** 装甲被击中的火花 */
  spark(pos) {
    const n = Math.max(3, Math.round(6 * this.budget));
    for (let i = 0; i < n; i++) {
      const m = this._acquire('particle');
      m.material.color.setHex(0xffe6a8);
      m.material.opacity = 1;
      m.scale.setScalar(0.22 + Math.random() * 0.25);
      m.position.copy(pos);
      const a = Math.random() * Math.PI * 2;
      const sp = 4 + Math.random() * 7;
      this._push(m, {
        vel: new THREE.Vector3(Math.cos(a) * sp, 1.5 + Math.random() * 4, Math.sin(a) * sp),
        life: 0.22 + Math.random() * 0.2,
        gravity: 18,
        shrink: 2,
      });
    }
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life -= dt;
      if (it.life <= 0) {
        this._remove(it, i);
        continue;
      }
      const t = it.life / it.maxLife;

      if (it.vel.lengthSq() > 0) {
        it.vel.y -= it.gravity * dt;
        it.mesh.position.addScaledVector(it.vel, dt);
        if (it.mesh.position.y < 0.1) {
          it.mesh.position.y = 0.1;
          it.vel.y *= -0.35;
          it.vel.x *= 0.7;
          it.vel.z *= 0.7;
        }
      }
      if (it.grow) it.mesh.scale.multiplyScalar(1 + it.grow * dt);
      if (it.shrink) it.mesh.scale.multiplyScalar(Math.max(0, 1 - it.shrink * dt));

      if (it.fade && it.mesh.material) {
        it.mesh.material.opacity = Math.max(0, t);
      }
    }
  }

  /**
   * 回收到池里，而不是 dispose。
   * 几何体是模块共享的（绝不能 dispose），材质跟着 mesh 一起复用——
   * 复用时会重设颜色和 opacity，所以池化不影响任何视觉效果。
   */
  _remove(it, i) {
    this.scene.remove(it.mesh);
    it.mesh.visible = false;
    this._pool[it.mesh._fxKind].push(it.mesh);
    this.items.splice(i, 1);
  }

  clear() {
    for (let i = this.items.length - 1; i >= 0; i--) this._remove(this.items[i], i);
  }

  /**
   * 彻底销毁：清空活动特效，并释放池里所有 mesh 的材质。
   * 只释放材质（池里每份 mesh 都有独立材质）；几何体是模块级共享的，绝不能动。
   * 场景整体废弃时（如退出组队局）调用——池随实例被 GC 并不会自动释放显存。
   */
  dispose() {
    this.clear();
    for (const kind in this._pool) {
      for (const m of this._pool[kind]) m.material?.dispose();
      this._pool[kind].length = 0;
    }
  }
}
