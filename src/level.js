import * as THREE from '../vendor/three.module.js';
import { HALF, PLAYER_START, generateBoxes } from './core/levelgen.js';
import { hitsAny, deepestHit } from './core/collide.js';

// 地图数据统一由 core/levelgen.js 生成：这里只建 mesh，服务端只建碰撞表。
// 两端共用一份数据，才能保证"你看得见的墙"和"服务端判定的墙"是同一堵。
export { HALF, PLAYER_START };

function groundTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');

  g.fillStyle = '#606a4e';
  g.fillRect(0, 0, size, size);

  // 细微噪点，避免大面积纯色
  for (let i = 0; i < 220; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = Math.random() * 3 + 1;
    g.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.055)';
    g.fillRect(x, y, r, r);
  }

  // 地砖网格
  g.strokeStyle = 'rgba(240,245,225,0.20)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, size - 3, size - 3);
  g.strokeStyle = 'rgba(240,245,225,0.07)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(size / 2, 0); g.lineTo(size / 2, size);
  g.moveTo(0, size / 2); g.lineTo(size, size / 2);
  g.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(49, 49);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function addBox(scene, obstacles, x, z, w, h, d, color, matCache) {
  let mat = matCache.get(color);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0.06 });
    matCache.set(color, mat);
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  const box = new THREE.Box3().setFromObject(mesh);
  obstacles.push({ mesh, box });
  return mesh;
}

function addVisual(scene, x, z, w, h, d, color, matCache) {
  let mat = matCache.get(color);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.08 });
    matCache.set(color, mat);
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

export function createLevel(scene) {
  const obstacles = [];
  const matCache = new Map();

  // ---- 地面 ----
  const groundGeo = new THREE.PlaneGeometry(HALF * 2 + 20, HALF * 2 + 20);
  const groundMat = new THREE.MeshStandardMaterial({
    map: groundTexture(),
    roughness: 1,
    metalness: 0,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- 远景底板：铺到雾里，低视角时不会看到地图"断崖"（去掉高墙后的必要补丁） ----
  const farGround = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    new THREE.MeshStandardMaterial({ color: 0x3b4534, roughness: 1, metalness: 0 })
  );
  farGround.rotation.x = -Math.PI / 2;
  farGround.position.y = -0.08;
  scene.add(farGround);

  // ---- 外围边界：低矮界桩（0.8m，不遮挡视线；也不进碰撞表，边界由坐标钳制） ----
  const edgeH = 0.8;
  const edgeT = 2.2;
  const edgeLen = HALF * 2 + edgeT * 2;
  addVisual(scene, 0, -HALF - edgeT / 2, edgeLen, edgeH, edgeT, '#6d7683', matCache);
  addVisual(scene, 0, HALF + edgeT / 2, edgeLen, edgeH, edgeT, '#6d7683', matCache);
  addVisual(scene, -HALF - edgeT / 2, 0, edgeT, edgeH, edgeLen, '#6d7683', matCache);
  addVisual(scene, HALF + edgeT / 2, 0, edgeT, edgeH, edgeLen, '#6d7683', matCache);

  // 边界顶灯带（暗琥珀，远处能看出战场范围，但完全不挡视线）
  const bevelH = 0.1;
  addVisual(scene, 0, -HALF - edgeT / 2, edgeLen, bevelH, edgeT * 0.6, '#9a7f42', matCache);
  addVisual(scene, 0, HALF + edgeT / 2, edgeLen, bevelH, edgeT * 0.6, '#9a7f42', matCache);
  addVisual(scene, -HALF - edgeT / 2, 0, edgeT * 0.6, bevelH, edgeLen, '#9a7f42', matCache);
  addVisual(scene, HALF + edgeT / 2, 0, edgeT * 0.6, bevelH, edgeLen, '#9a7f42', matCache);

  // ---- 掩体：数据来自 core/levelgen.js，与服务端碰撞表同源 ----
  // boxes 直接用生成数据（而不是从 mesh 反算 Box3），保证与服务端判定数值一致
  const allBoxes = generateBoxes();
  const boxes = allBoxes.map((b) => [b.x, b.z, b.w, b.d]);
  for (const b of allBoxes) {
    addBox(scene, obstacles, b.x, b.z, b.w, b.h, b.d, b.color, matCache);
  }

  // ---- 出生点 ----
  const spawnPoints = [
    new THREE.Vector3(-82, 0, -82),
    new THREE.Vector3(82, 0, -82),
    new THREE.Vector3(-82, 0, 82),
    new THREE.Vector3(82, 0, 82),
    new THREE.Vector3(0, 0, -88),
    new THREE.Vector3(-88, 0, 0),
    new THREE.Vector3(88, 0, 0),
    new THREE.Vector3(0, 0, 88),
  ];

  return {
    obstacles,
    spawnPoints,
    half: HALF,

    /**
     * 圆形碰撞体是否与任意障碍物或边界重叠。
     * 箱体用真实圆-矩形判定（core/collide.js，与服务端/地图生成同一份），
     * 角上是圆弧而不是直角——否则贴着建筑拐角会被多挡 0.79 米。
     */
    blocked(x, z, r) {
      if (x < -HALF + r || x > HALF - r || z < -HALF + r || z > HALF - r) return true;
      return hitsAny(boxes, x, z, r);
    },

    /** 穿透最深的那一个：{ nx, nz, depth } 或 null（撞墙滑行/脱困用，与服务端同源） */
    hit(x, z, r) {
      return deepestHit(boxes, x, z, r);
    },

    /**
     * 2D 线段是否被障碍物挡住（供 AI 视线 / 导航平滑使用）
     * 用 slab 法做线段-AABB 相交，障碍按 pad 外扩
     */
    segmentBlocked(ax, az, bx, bz, pad = 0.45) {
      const dx = bx - ax;
      const dz = bz - az;
      for (let i = 0; i < obstacles.length; i++) {
        const b = obstacles[i].box;
        const minX = b.min.x - pad;
        const maxX = b.max.x + pad;
        const minZ = b.min.z - pad;
        const maxZ = b.max.z + pad;

        let t0 = 0;
        let t1 = 1;

        if (Math.abs(dx) < 1e-8) {
          if (ax < minX || ax > maxX) continue;
        } else {
          let ta = (minX - ax) / dx;
          let tb = (maxX - ax) / dx;
          if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
          if (t0 > t1) continue;
        }

        if (Math.abs(dz) < 1e-8) {
          if (az < minZ || az > maxZ) continue;
        } else {
          let ta = (minZ - az) / dz;
          let tb = (maxZ - az) / dz;
          if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
          if (t0 > t1) continue;
        }

        return true;
      }
      return false;
    },

    /** 子弹是否击中障碍物 */
    hitSolid(point, pad = 0.35) {
      for (let i = 0; i < obstacles.length; i++) {
        if (obstacles[i].box.distanceToPoint(point) < pad) return true;
      }
      return false;
    },
  };
}
