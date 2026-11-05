import * as THREE from '../vendor/three.module.js';

const CORE_GEO = new THREE.SphereGeometry(0.17, 10, 8);
const GLOW_GEO = new THREE.SphereGeometry(0.46, 10, 8);

// 按颜色缓存材质，避免不同武器切换时反复创建
const CORE_CACHE = new Map();
const GLOW_CACHE = new Map();

function coreMat(color) {
  let m = CORE_CACHE.get(color);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color });
    CORE_CACHE.set(color, m);
  }
  return m;
}

function glowMat(color) {
  let m = GLOW_CACHE.get(color);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.42,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    GLOW_CACHE.set(color, m);
  }
  return m;
}

export class Bullet {
  constructor(scene, {
    pos, dir, team = 'player', speed = 62, damage = 25, life = 2.4,
    pierce = 0, explosive = 0, splashMul = 1,
    color, glow, scale = 1,
  }) {
    this.scene = scene;
    this.team = team;
    this.damage = damage;
    this.speed = speed;
    this.life = life;
    this.pierce = pierce;         // 剩余可穿透次数
    this.explosive = explosive;   // 溅射等级
    this.splashMul = splashMul;   // 溅射范围倍率
    this.hits = new Set();        // 已命中目标，避免穿透时重复结算
    this.alive = true;
    this.radius = 0.4;
    this.pos = pos.clone();
    this.dir = dir.clone().normalize();
    this.prev = this.pos.clone();

    const isPlayer = team === 'player';
    const coreColor = color ?? (isPlayer ? 0xfff3c4 : 0xffd0c0);
    const glowColor = glow ?? (isPlayer ? 0xffb03a : 0xff4a3a);

    this.mesh = new THREE.Group();
    const core = new THREE.Mesh(CORE_GEO, coreMat(coreColor));
    const glowMesh = new THREE.Mesh(GLOW_GEO, glowMat(glowColor));
    const s = (explosive > 0 ? 1 + explosive * 0.18 : 1) * scale;
    glowMesh.scale.setScalar(s);
    core.scale.setScalar(scale);
    this.mesh.add(core, glowMesh);
    this.mesh.position.copy(pos);
    scene.add(this.mesh);
  }

  update(dt) {
    if (!this.alive) return false;
    this.prev.copy(this.pos);
    this.pos.addScaledVector(this.dir, this.speed * dt);
    this.mesh.position.copy(this.pos);
    this.life -= dt;
    if (this.life <= 0 || this.pos.y < -2) {
      this.destroy();
      return false;
    }
    return true;
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    this.scene.remove(this.mesh);
  }
}
