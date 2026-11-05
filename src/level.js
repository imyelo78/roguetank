import * as THREE from '../vendor/three.module.js';

export const HALF = 100;         // 可行驶半边长（200×200 战场）
export const PLAYER_START = new THREE.Vector3(0, 0, 26);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

  // ---- 手工摆放：中央掩体群 ----
  const fixed = [
    [-16, -2, 12, 7, 5, '#8b95a3'],
    [16, -2, 12, 7, 5, '#8b95a3'],
    [0, -20, 6, 8, 6, '#96a1b0'],
    [-34, 24, 8, 5, 8, '#818b99'],
    [34, 24, 8, 5, 8, '#818b99'],
    [0, 44, 18, 3.5, 4, '#8a8a6a'],
    // 外围掩体群（扩大战场后的战术点）
    [-64, -36, 14, 6, 6, '#8b95a3'],
    [64, -36, 14, 6, 6, '#8b95a3'],
    [-70, 52, 10, 4.5, 10, '#818b99'],
    [70, 52, 10, 4.5, 10, '#818b99'],
    [0, -72, 22, 5, 4, '#8a8a6a'],
    [-30, 78, 8, 3.2, 8, '#858f7a'],
    [30, -50, 6, 4, 12, '#929aa6'],
    [-6, 62, 10, 2.8, 8, '#7f8b7c'],
  ];
  for (const [x, z, w, h, d, c] of fixed) addBox(scene, obstacles, x, z, w, h, d, c, matCache);

  // ---- 随机箱体（确定性） ----
  const rnd = mulberry32(20261029);
  const colors = ['#9a8a6c', '#7f9070', '#8e929c', '#a08a70'];
  const placed = [];
  let guard = 0;
  while (placed.length < 30 && guard++ < 700) {
    const x = (rnd() * 2 - 1) * (HALF - 12);
    const z = (rnd() * 2 - 1) * (HALF - 12);
    // 玩家出生点与中央通路保持空旷
    if (Math.hypot(x - PLAYER_START.x, z - PLAYER_START.z) < 16) continue;
    if (Math.hypot(x, z) < 12) continue;
    if (fixed.some(([fx, fz, fw, , fd]) => Math.hypot(x - fx, z - fz) < Math.max(fw, fd) / 2 + 9)) continue;
    if (placed.some(([px, pz]) => Math.hypot(x - px, z - pz) < 11)) continue;

    const w = 3.5 + rnd() * 4;
    const h = 2.6 + rnd() * 4.5;
    const d = 3.5 + rnd() * 4;
    addBox(scene, obstacles, x, z, w, h, d, colors[(rnd() * colors.length) | 0], matCache);
    placed.push([x, z, w, d]);
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

    /** 圆形碰撞体是否与任意障碍物或边界重叠 */
    blocked(x, z, r) {
      if (x < -HALF + r || x > HALF - r || z < -HALF + r || z > HALF - r) return true;
      for (let i = 0; i < obstacles.length; i++) {
        const b = obstacles[i].box;
        if (x + r > b.min.x && x - r < b.max.x && z + r > b.min.z && z - r < b.max.z) return true;
      }
      return false;
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
