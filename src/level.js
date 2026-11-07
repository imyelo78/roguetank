import * as THREE from '../vendor/three.module.js';
import { HALF, PLAYER_START, generateBoxes } from './core/levelgen.js';
import { hitsAny, deepestHit } from './core/collide.js';
import { heightAt } from './core/terrain.js';

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

// 楼体统一往下埋 4.5 米当地基。
//
// 为什么这么深：实测山地档（rugged）下建筑落点的坡度最大 41%。
// 一栋 14 米宽的楼站在 41% 的坡上，两端高差 5.7 米——地基浅了就会在坡下侧
// 露出楼底，看起来像楼浮在半空。
//
// 平地时这 4.5 米完全在地面以下，看不见，也不影响任何 2D 碰撞判定。
// 统一给所有楼同样的深度（而不是按实际坡度算）是为了让运行时切换地形
// 只需要改 position.y，不用重建几何体。
const FOUNDATION_SINK = 4.5;

function addBox(scene, obstacles, x, z, w, h, d, color, matCache, groundY = 0) {
  let mat = matCache.get(color);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0.06 });
    matCache.set(color, mat);
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h + FOUNDATION_SINK, d), mat);
  mesh.position.set(x, groundY + h / 2 - FOUNDATION_SINK / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  const box = new THREE.Box3().setFromObject(mesh);
  // x/z/h 留着给 setTerrain 用：地形强度是连上服务器才知道的，
  // 那时候楼已经建好了，只能改高度不能重建。
  obstacles.push({ mesh, box, x, z, h });
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

export function createLevel(scene, terrainScale = 0) {
  const obstacles = [];
  const matCache = new Map();
  // 地形强度是"可变"的：联机时进房前不知道房间开没开地形，
  // 要等 WELCOME 才拿到，所以这里留了 setTerrain() 做热重建。
  let ts = Math.max(0, Number(terrainScale) || 0);

  const SIZE = HALF * 2 + 20;
  const groundMat = new THREE.MeshStandardMaterial({
    map: groundTexture(),
    roughness: 1,
    metalness: 0,
  });
  let ground = null;

  // ---- 地面 ----
  // 地形起伏：平面按 heightAt 位移顶点。分段数只在有地形时提高，
  // 全平地图仍然是一张 1×1 的平面，顶点数和以前完全一样（零回归）。
  const buildGround = () => {
    if (ground) {
      scene.remove(ground);
      ground.geometry.dispose();
    }
    const seg = ts > 0 ? 96 : 1;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, seg, seg);
    if (ts > 0) {
      const pos = geo.attributes.position;
      // rotation.x = -90° 之后：本地 (x, y, z) → 世界 (x, z, -y)。
      // 所以世界高度要按 (localX, -localY) 采样，写到本地 z 上。
      for (let i = 0; i < pos.count; i++) {
        pos.setZ(i, heightAt(pos.getX(i), -pos.getY(i), ts));
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals(); // 不重算法线，光照会是一片死黑
    }
    ground = new THREE.Mesh(geo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
  };
  buildGround();

  // ---- 远景底板：铺到雾里，低视角时不会看到地图"断崖"（去掉高墙后的必要补丁） ----
  const farGround = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    new THREE.MeshStandardMaterial({ color: 0x3b4534, roughness: 1, metalness: 0 })
  );
  farGround.rotation.x = -Math.PI / 2;
  // 有地形时压到最低谷以下，否则会在山脚"切"出一条硬边
  farGround.position.y = ts > 0 ? -14 : -0.08;
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
    addBox(scene, obstacles, b.x, b.z, b.w, b.h, b.d, b.color, matCache, heightAt(b.x, b.z, ts));
  }

  // ---- 出生点 ----
  // 出生点的数组引用要稳定（Game.js 会持有它），所以原地更新而不是重新赋值
  const spawnPoints = [];
  const refillSpawns = () => {
    const pts = [
      [-82, -82], [82, -82], [-82, 82], [82, 82],
      [0, -88], [-88, 0], [88, 0], [0, 88],
    ].map(([sx, sz]) => new THREE.Vector3(sx, heightAt(sx, sz, ts), sz));
    spawnPoints.length = 0;
    spawnPoints.push(...pts);
  };
  refillSpawns();

  return {
    obstacles,
    spawnPoints,
    half: HALF,
    get terrainScale() { return ts; },
    /** 地表高度，渲染层贴地用（服务端不走这里，只走 core/terrain.js） */
    heightAt: (x, z) => heightAt(x, z, ts),

    /**
     * 运行时切换地形强度（联机时 WELCOME 到达后才调）。
     * 只重建地面几何体、抬高建筑和出生点，碰撞表（2D 的 x/z）完全不动——
     * 所以切换地形不会让任何单位穿墙或卡住。
     * @returns {boolean} 是否真的变了
     */
    setTerrain(next) {
      const v = Math.max(0, Number(next) || 0);
      if (Math.abs(v - ts) < 1e-6) return false;
      ts = v;
      buildGround();
      farGround.position.y = ts > 0 ? -14 : -0.08;
      for (const o of obstacles) {
        o.mesh.position.y = heightAt(o.x, o.z, ts) + o.h / 2 - FOUNDATION_SINK / 2;
        o.box.setFromObject(o.mesh); // hitSolid 用到 y，必须同步
      }
      refillSpawns();
      return true;
    },

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
