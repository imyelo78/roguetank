import * as THREE from '../vendor/three.module.js';
import { HALF, PLAYER_START, generateBoxes } from './core/levelgen.js';
import { hitsAny, deepestHit } from './core/collide.js';
import { TERRAIN, weightsInto, dominantAt, speedAt } from './core/terrain.js';

// 地图数据统一由 core/levelgen.js 生成：这里只建 mesh，服务端只建碰撞表。
// 两端共用一份数据，才能保证"你看得见的墙"和"服务端判定的墙"是同一堵。
export { HALF, PLAYER_START };

/**
 * 中性细节贴图。
 *
 * 关键点：底色必须接近白色。地表颜色现在由顶点色决定（草地/公路/沙漠/雪地/沼泽），
 * 这张贴图只负责"再加一层噪点，别让 8 米一格的颜色块看着像塑料"。
 * 如果底色还是旧的 #606a4e，乘上去整张图会偏暗偏绿，
 * 沙地和雪地会被染成脏黄、脏灰，认不出是什么地形。
 */
function detailTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');

  g.fillStyle = '#f4f4f4';
  g.fillRect(0, 0, size, size);

  // 细微噪点：亮度在 ±6% 之间，远了看不见，近了有颗粒感
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = Math.random() * 3.2 + 0.8;
    g.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    g.fillRect(x, y, r, r);
  }

  // 极淡的格线：给人一点"这是土面"的尺度感，但绝不能抢地形颜色
  g.strokeStyle = 'rgba(0,0,0,0.045)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, size - 2, size - 2);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 五种地表的线性色（three 的顶点色按线性空间理解，必须转换） */
const TERRAIN_LINEAR = TERRAIN.map((t) => new THREE.Color(t.color).convertSRGBToLinear());

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

/**
 * 建关卡。
 *
 * @param {THREE.Scene} scene
 * @param {object|null} map 地表类型场（core/terrain.js 的 buildTerrain 结果）。
 *   null = 老地图，整张图按草地渲染，速度恒等 1.0 —— 行为与改造前完全一致。
 */
export function createLevel(scene, map = null, seed = 0) {
  const matCache = new Map();
  // 障碍物的两个视图必须同步存在：
  //   boxes     —— [x, z, w, d]，模拟/碰撞用，与服务端逐字节同构
  //   obstacles —— { mesh, box:Box3 }，AI 视线与子弹判定用
  // 建筑会随 `setLayout()` 整体替换（换种子 / 联机收服务端布局），所以不能用 const。
  let obstacles = [];
  let boxes = [];
  // 地表场是"可变"的：联机时进房前不知道房间用哪个种子，
  // 要等 WELCOME 才拿到，所以这里留了 setTerrain() 做热重建。
  let terrain = map && map.cells ? map : null;

  const groundMat = new THREE.MeshStandardMaterial({
    map: detailTexture(),
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });
  let ground = null;

  // ---- 地面 ----
  //
  // 顶点色 = 位置一致的地表混合色。
  // 为什么要"按顶点采样"而不是"每格一个色块"：
  //   相邻两格的公共顶点按同一世界坐标采样，得到同一种颜色，
  //   于是格与格之间是连续渐变，不会出现马赛克边。
  //   更要紧的是这张渐变和 speedAt 用的是同一个双线性核，
  //   —— 玩家看到的过渡和手上的速度变化是同一条曲线，不会"看着还在地里、其实已经上路了"。
  const buildGround = () => {
    if (ground) {
      scene.remove(ground);
      ground.geometry.dispose();
    }
    const n = terrain ? terrain.n : 1;
    const size = terrain ? terrain.n * terrain.tile : HALF * 2 + 20;
    const geo = new THREE.PlaneGeometry(size, size, n, n);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    if (terrain) {
      const w = new Float64Array(5);
      for (let i = 0; i < pos.count; i++) {
        // rotation.x = -90° 之后：本地 (x, y) → 世界 (x, -y)
        weightsInto(terrain, pos.getX(i), -pos.getY(i), w);
        let r = 0;
        let g = 0;
        let b = 0;
        for (let t = 0; t < TERRAIN.length; t++) {
          r += w[t] * TERRAIN_LINEAR[t].r;
          g += w[t] * TERRAIN_LINEAR[t].g;
          b += w[t] * TERRAIN_LINEAR[t].b;
        }
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
      // 贴图密度：一张 256px 的噪点铺满 8 米，颗粒感刚好
      groundMat.map.repeat.set(size / 8, size / 8);
    } else {
      colors.fill(1); // 全白 → 材质色 = 只有细节贴图，和改造前一样
      groundMat.map.repeat.set(49, 49);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

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
  //
  // boxes 直接用生成数据（而不是从 mesh 反算 Box3），保证与服务端判定数值一致。
  // 高度 h 与颜色只影响观感，碰撞只认 x/z/w/d —— 服务端下发的建筑只带这四项，
  // 渲染时按坐标算一个稳定的高度，两端不需要为了"长得一样"再传两个数。
  const RANDOM_COLORS = ['#9a8a6c', '#7f9070', '#8e929c', '#a08a70'];

  const hash01 = (x, z) => {
    const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return n - Math.floor(n);
  };

  /** 按数据铺建筑；先拆旧的，再建新的（联机进房时会整体换一次） */
  const applyLayout = (list) => {
    for (const o of obstacles) {
      scene.remove(o.mesh);
      o.mesh.geometry.dispose();
    }
    obstacles = [];
    boxes = [];
    for (const b of list) {
      const h = b.h ?? 2.6 + hash01(b.x, b.z) * 4.5;
      const color = b.color || RANDOM_COLORS[(hash01(b.z, b.x) * RANDOM_COLORS.length) | 0];
      addBox(scene, obstacles, b.x, b.z, b.w, h, b.d, color, matCache);
      boxes.push([b.x, b.z, b.w, b.d]);
    }
  };

  applyLayout(generateBoxes(seed));

  // ---- 出生点 ----
  // 出生点的数组引用要稳定（Game.js 会持有它），所以原地更新而不是重新赋值
  const spawnPoints = [];
  const refillSpawns = () => {
    const pts = [
      [-82, -82], [82, -82], [-82, 82], [82, 82],
      [0, -88], [-88, 0], [88, 0], [0, 88],
    ].map(([sx, sz]) => new THREE.Vector3(sx, 0, sz));
    spawnPoints.length = 0;
    spawnPoints.push(...pts);
  };
  refillSpawns();

  return {
    /** 障碍物视图。注意：数组会被 setLayout 整体替换，不要长期持有旧引用 */
    get obstacles() { return obstacles; },
    get boxes() { return boxes; },
    spawnPoints,
    half: HALF,
    get terrain() { return terrain; },

    /** 调度层读用：地形是否生效（null = 全草地、速度 1.0） */
    get hasTerrain() { return !!terrain; },

    /** 某点的速度倍率。客户端预测 / HUD 都走这里，和服务端同一个函数 */
    speedAt: (x, z) => (terrain ? speedAt(terrain, x, z) : 1),

    /** 脚下的地表类型 id（HUD 显示用，不参与物理） */
    terrainAt: (x, z) => (terrain ? dominantAt(terrain, x, z) : 0),

    /**
     * 运行时切换地表场（联机时 WELCOME 到达后才调）。
     * 只重建地面几何体，碰撞表（2D 的 x/z）一个字节都不动——
     * 所以换地形不会让任何单位穿墙、卡住，也不会突然多出一堵墙。
     * @returns {boolean} 是否真的变了
     */
    /**
     * 换一套建筑布局（联机进房 / 单机重开换图）。
     *
     * 只重建建筑 mesh 与碰撞表，地面与地表场不动 —— 两者是独立的维度：
     * 地表是"脚下的路好不好走"，建筑是"哪里能挡子弹"。混在一起重建会
     * 把地表多余的顶点色计算也跑一遍，而且容易忘记同步其中一边。
     * @param {{x:number,z:number,w:number,d:number,h?:number,color?:string}[]} list
     */
    setLayout(list) {
      if (!Array.isArray(list) || !list.length) return false;
      applyLayout(list);
      return true;
    },

    setTerrain(next) {
      const m = next && next.cells ? next : null;
      const same = terrain && m && terrain.seed === m.seed && terrain.tile === m.tile
        && (terrain.k ?? 1) === (m.k ?? 1);
      terrain = m;
      buildGround(); // 几何尺寸/顶点色全依赖地表场，重建一次最省心（27×27 顶点，很便宜）
      return !same;
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
