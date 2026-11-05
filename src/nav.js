import * as THREE from '../vendor/three.module.js';

/**
 * 导航网格 + A* 寻路
 * - 2 米一格，按坦克半径膨胀障碍
 * - 8 方向 A*，禁止贴角斜穿
 * - 路径用视线采样做平滑
 */
const CELL = 2;
const TANK_RADIUS = 1.9;

class MinHeap {
  constructor() {
    this.items = [];
    this.keys = [];
  }

  get size() { return this.items.length; }

  push(item, key) {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      [this.keys[parent], this.keys[i]] = [this.keys[i], this.keys[parent]];
      i = parent;
    }
  }

  pop() {
    const top = this.items[0];
    const lastItem = this.items.pop();
    const lastKey = this.keys.pop();
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      const n = this.items.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && this.keys[l] < this.keys[smallest]) smallest = l;
        if (r < n && this.keys[r] < this.keys[smallest]) smallest = r;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
        [this.keys[smallest], this.keys[i]] = [this.keys[i], this.keys[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

export function createNav(world) {
  const half = world.half;
  const n = Math.ceil((half * 2) / CELL);
  const origin = -half;

  const cellIndex = (cx, cz) => cz * n + cx;
  const toCell = (v) => Math.max(0, Math.min(n - 1, Math.floor((v - origin) / CELL)));
  const cellCenter = (c) => origin + (c + 0.5) * CELL;

  // 可走判定：格子矩形按坦克半径整体膨胀后与障碍 AABB 求交。
  // 只采样中心点会让格角压进障碍、路径斜穿墙角，导致坦克卡在墙缝。
  function cellRectBlocked(x0, x1, z0, z1) {
    if (x0 < -half || x1 > half || z0 < -half || z1 > half) return true;
    for (let i = 0; i < world.obstacles.length; i++) {
      const b = world.obstacles[i].box;
      if (x0 < b.max.x && x1 > b.min.x && z0 < b.max.z && z1 > b.min.z) return true;
    }
    return false;
  }

  const walkable = new Uint8Array(n * n);
  for (let cz = 0; cz < n; cz++) {
    for (let cx = 0; cx < n; cx++) {
      const x0 = origin + cx * CELL - TANK_RADIUS;
      const x1 = origin + (cx + 1) * CELL + TANK_RADIUS;
      const z0 = origin + cz * CELL - TANK_RADIUS;
      const z1 = origin + (cz + 1) * CELL + TANK_RADIUS;
      walkable[cellIndex(cx, cz)] = cellRectBlocked(x0, x1, z0, z1) ? 0 : 1;
    }
  }

  // A* 复用缓冲区（大地图下每帧寻路可省去大量临时分配）
  const gScore = new Float32Array(n * n);
  const cameFrom = new Int32Array(n * n);
  const closed = new Uint8Array(n * n);

  function isWalkableCell(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= n || cz >= n) return false;
    return walkable[cellIndex(cx, cz)] === 1;
  }

  function isWalkable(x, z) {
    return !world.blocked(x, z, TANK_RADIUS);
  }

  /** 在目标格附近螺旋搜索最近的可走格 */
  function nearestWalkable(cx, cz) {
    if (isWalkableCell(cx, cz)) return [cx, cz];
    for (let r = 1; r <= 8; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (isWalkableCell(cx + dx, cz + dz)) return [cx + dx, cz + dz];
        }
      }
    }
    return null;
  }

  /** 两点之间是否可以直线通过（供平滑与 AI 视线使用） */
  function clearWalk(ax, az, bx, bz, radius = TANK_RADIUS) {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(dist / 0.6));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (world.blocked(ax + (bx - ax) * t, az + (bz - az) * t, radius)) return false;
    }
    return true;
  }

  function smoothPath(points, sx, sz) {
    if (points.length <= 1) return points;
    const out = [];
    let curX = sx;
    let curZ = sz;
    let i = 0;
    while (i < points.length) {
      // 尽量跳到最远的、可以直线走到的路点
      let next = i;
      for (let j = points.length - 1; j > i; j--) {
        if (clearWalk(curX, curZ, points[j].x, points[j].z)) {
          next = j;
          break;
        }
      }
      out.push(points[next]);
      curX = points[next].x;
      curZ = points[next].z;
      i = next + 1;
    }
    return out;
  }

  /**
   * 从 (sx,sz) 到 (tx,tz) 的路径，返回 Vector3 数组（不含起点）
   * 找不到时返回空数组，上层可回退为直线移动
   */
  function findPath(sx, sz, tx, tz) {
    const start = nearestWalkable(toCell(sx), toCell(sz));
    const goal = nearestWalkable(toCell(tx), toCell(tz));
    if (!start || !goal) return [];

    const startIdx = cellIndex(start[0], start[1]);
    const goalIdx = cellIndex(goal[0], goal[1]);
    if (startIdx === goalIdx) {
      return clearWalk(sx, sz, tx, tz) ? [new THREE.Vector3(tx, 0, tz)] : [];
    }

    const total = n * n;
    gScore.fill(Infinity);
    cameFrom.fill(-1);
    closed.fill(0);

    const h = (cx, cz) => {
      const dx = Math.abs(cx - goal[0]);
      const dz = Math.abs(cz - goal[1]);
      const min = Math.min(dx, dz);
      const max = Math.max(dx, dz);
      return (max - min) + min * Math.SQRT2;
    };

    const open = new MinHeap();
    gScore[startIdx] = 0;
    open.push(startIdx, h(start[0], start[1]));

    const DIRS = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ];

    let found = false;
    let guard = 0;
    while (open.size > 0 && guard++ < 20000) {
      const current = open.pop();
      if (current === goalIdx) { found = true; break; }
      if (closed[current]) continue;
      closed[current] = 1;

      const cx = current % n;
      const cz = (current / n) | 0;

      for (const [dx, dz, cost] of DIRS) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (!isWalkableCell(nx, nz)) continue;
        // 禁止贴角斜穿
        if (dx !== 0 && dz !== 0) {
          if (!isWalkableCell(cx + dx, cz) || !isWalkableCell(cx, cz + dz)) continue;
        }
        const ni = cellIndex(nx, nz);
        if (closed[ni]) continue;
        const tentative = gScore[current] + cost;
        if (tentative < gScore[ni]) {
          gScore[ni] = tentative;
          cameFrom[ni] = current;
          open.push(ni, tentative + h(nx, nz));
        }
      }
    }

    if (!found) return [];

    const cells = [];
    let cur = goalIdx;
    let guard2 = 0;
    while (cur !== startIdx && cur !== -1 && guard2++ < total) {
      cells.push(cur);
      cur = cameFrom[cur];
    }
    cells.reverse();

    const raw = cells.map((ci) => new THREE.Vector3(
      cellCenter(ci % n),
      0,
      cellCenter((ci / n) | 0)
    ));

    // 终点补一个精确目标（若可走且能直线到达）
    if (raw.length === 0 || clearWalk(raw[raw.length - 1].x, raw[raw.length - 1].z, tx, tz)) {
      raw.push(new THREE.Vector3(tx, 0, tz));
    }

    return smoothPath(raw, sx, sz);
  }

  return {
    n,
    cellSize: CELL,
    isWalkable,
    isWalkableCell,
    findPath,
    clearWalk,
    /** AI 视线：不被掩体挡住 */
    hasLineOfSight(ax, az, bx, bz) {
      return !world.segmentBlocked(ax, az, bx, bz, 0.45);
    },
  };
}
