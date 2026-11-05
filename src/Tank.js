import * as THREE from '../vendor/three.module.js';

// 共享几何体，减少显存与构建开销
const G = {
  hull: new THREE.BoxGeometry(2.2, 0.9, 3.2),
  tracks: new THREE.BoxGeometry(0.58, 0.66, 3.45),
  turret: new THREE.BoxGeometry(1.5, 0.72, 1.7),
  plate: new THREE.BoxGeometry(2.24, 0.34, 0.5),
  barrel: (() => {
    const g = new THREE.CylinderGeometry(0.14, 0.18, 2.0, 10);
    g.rotateX(Math.PI / 2);      // 轴向改为 +Z
    g.translate(0, 0, 1.0);      // 从原点向前延伸
    return g;
  })(),
  cupola: new THREE.CylinderGeometry(0.34, 0.38, 0.26, 12),
};

const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + (opts.emissive || '') + (opts.roughness ?? '');
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.18, ...opts });
    matCache.set(key, m);
  }
  return m;
}

export class Tank {
  constructor(scene, opts = {}) {
    this.team = opts.team || 'enemy';
    this.maxHp = opts.hp ?? 100;
    this.hp = this.maxHp;
    this.speed = opts.speed ?? 11;
    this.radius = 1.45;
    this.alive = true;
    this.recoilT = 0;
    this.turretYaw = 0;

    const body = opts.body ?? 0x5f7a3c;
    const accent = opts.accent ?? 0x3a4a24;
    const metal = opts.metal ?? 0x2a2f36;

    this.group = new THREE.Group();
    this.group.position.set(opts.x ?? 0, 0, opts.z ?? 0);
    this.group.rotation.y = opts.rotY ?? 0;
    scene.add(this.group);

    // 车体
    const hull = new THREE.Mesh(G.hull, mat(body));
    hull.position.y = 0.86;
    hull.castShadow = true;
    this.group.add(hull);

    // 前装甲板
    const plate = new THREE.Mesh(G.plate, mat(accent));
    plate.position.set(0, 1.02, 1.52);
    plate.castShadow = true;
    this.group.add(plate);

    // 履带
    for (const sx of [-1.06, 1.06]) {
      const track = new THREE.Mesh(G.tracks, mat(metal));
      track.position.set(sx, 0.4, 0);
      track.castShadow = true;
      this.group.add(track);
    }

    // 炮塔
    this.turret = new THREE.Group();
    this.turret.position.y = 1.46;
    this.group.add(this.turret);

    const turretMesh = new THREE.Mesh(G.turret, mat(body));
    turretMesh.castShadow = true;
    this.turret.add(turretMesh);

    const cupola = new THREE.Mesh(G.cupola, mat(accent));
    cupola.position.set(-0.28, 0.44, -0.2);
    cupola.castShadow = true;
    this.turret.add(cupola);

    const barrel = new THREE.Mesh(G.barrel, mat(metal));
    barrel.position.set(0.12, 0.02, 0.8);
    barrel.castShadow = true;
    this.turret.add(barrel);

    // 炮口锚点（用于子弹与闪光）
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0.12, 0.02, 2.8);
    this.turret.add(this.muzzle);

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
    let moved = false;

    const nx = p.x + dx * step;
    if (!world.blocked(nx, p.z, this.radius)) { p.x = nx; moved = true; }

    const nz = p.z + dz * step;
    if (!world.blocked(p.x, nz, this.radius)) { p.z = nz; moved = true; }

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
    this.turret.position.z = -(this.recoilT / 0.12) * 0.32;
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
    this.group.traverse((o) => {
      if (o.isMesh && o.geometry && !Object.values(G).includes(o.geometry)) {
        o.geometry.dispose();
      }
    });
  }
}
