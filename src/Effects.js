import * as THREE from '../vendor/three.module.js';

const PARTICLE_GEO = new THREE.SphereGeometry(0.22, 6, 5);
const RING_GEO = new THREE.RingGeometry(0.55, 0.75, 24);

const V = new THREE.Vector3();

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
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
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(
        PARTICLE_GEO,
        new THREE.MeshBasicMaterial({
          color: Math.random() > 0.45 ? color : 0x2b2b2b,
          transparent: true,
          opacity: 1,
        })
      );
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

    const ring = new THREE.Mesh(
      RING_GEO,
      new THREE.MeshBasicMaterial({
        color: 0xffd9a0, transparent: true, opacity: 0.85,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos).setY(0.12);
    this._push(ring, { life: 0.4, grow: 13, fade: true });

    // 火光
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshBasicMaterial({
        color: 0xffcf7a, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    flash.position.copy(pos);
    flash.scale.setScalar(0.6);
    this._push(flash, { life: 0.18, grow: 9 });
  }

  /** 炮口闪光 */
  muzzle(pos, dir) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 8, 6),
      new THREE.MeshBasicMaterial({
        color: 0xffd58a, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    m.position.copy(pos);
    this._push(m, {
      life: 0.09,
      grow: 6,
      vel: dir.clone().multiplyScalar(6),
    });
  }

  /** 装甲被击中的火花 */
  spark(pos) {
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(
        PARTICLE_GEO,
        new THREE.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 1 })
      );
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

  _remove(it, i) {
    this.scene.remove(it.mesh);
    if (it.mesh.material) it.mesh.material.dispose();
    if (it.mesh.geometry && it.mesh.geometry !== PARTICLE_GEO && it.mesh.geometry !== RING_GEO) {
      it.mesh.geometry.dispose();
    }
    this.items.splice(i, 1);
  }

  clear() {
    for (let i = this.items.length - 1; i >= 0; i--) this._remove(this.items[i], i);
  }
}
