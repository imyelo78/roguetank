// 地表类型场测试
//
// 这套测试守的是三条线：
//   1. 确定性 —— 同 seed 两端生成的东西必须逐字节相同（联机的命根子）
//   2. 平滑性 —— 速度场不能有台阶（预测抖动最经典的来源）
//   3. 无地形时不改变任何行为 —— 旧包、旧回放、单测的回归保护线

import {
  buildTerrain, speedAt, weightsInto, dominantAt, scanTerrain,
  TERRAIN, TERRAIN_PRESETS, presetK, TILE,
  T_GRASS, T_ROAD, T_SAND, T_SNOW, T_SWAMP, defaultClearPoints,
} from '../src/core/terrain.js';
import { World, HALF } from '../src/core/world.js';
import { stepBody } from '../src/core/motion.js';
import { SPAWNS } from '../src/core/levelgen.js';

const HALF_MAP = 100;
const SEEDS = [1, 7, 42, 12345, 20261029, 0xdeadbeef];

let pass = 0;
function ok(name, cond, extra = '') {
  if (!cond) {
    console.error(`  ✗ ${name} ${extra}`);
    process.exitCode = 1;
  } else {
    pass++;
  }
}

// ---------------- 1. 确定性 ----------------

{
  for (const seed of SEEDS) {
    const a = buildTerrain(seed, HALF_MAP, { k: 1 });
    const b = buildTerrain(seed, HALF_MAP, { k: 1 });
    let same = a.n === b.n && a.tile === b.tile && a.x0 === b.x0;
    if (same) {
      for (let i = 0; i < a.cells.length; i++) {
        if (a.cells[i] !== b.cells[i]) { same = false; break; }
      }
    }
    ok(`seed ${seed} 两次生成完全一致`, same);
  }

  // 换 seed 必须换图：如果两个 seed 出来一样，说明噪声偏移没生效，
  // 那么"每张图不同"就只是嘴上说说
  const m1 = buildTerrain(1, HALF_MAP, { k: 1 });
  const m2 = buildTerrain(2, HALF_MAP, { k: 1 });
  let diff = 0;
  for (let i = 0; i < m1.cells.length; i++) if (m1.cells[i] !== m2.cells[i]) diff++;
  ok('不同 seed 生成不同地图', diff > m1.cells.length * 0.3, `差异 ${diff}/${m1.cells.length}`);
}

// ---------------- 2. 速度基准 ----------------

{
  ok('map 为 null 时速度恒为 1', speedAt(null, 0, 0) === 1);
  ok('map 为 undefined 时速度恒为 1', speedAt(undefined, 13, -77) === 1);

  const m = buildTerrain(7, HALF_MAP, { k: 1 });
  const off = buildTerrain(7, HALF_MAP, { k: 0 });
  let allOne = true;
  for (let x = -90; x <= 90; x += 7) {
    for (let z = -90; z <= 90; z += 7) {
      if (Math.abs(speedAt(off, x, z) - 1) > 1e-9) allOne = false;
    }
  }
  ok('强度 off(k=0) 时全程速度 1.0（旧手感）', allOne);
  ok('强度 off 仍然保留地表颜色数据', off.cells.length === m.cells.length);
}

// ---------------- 3. 速度值域与档位 ----------------

{
  const base = buildTerrain(42, HALF_MAP, { k: 1 });
  let min = Infinity;
  let max = -Infinity;
  for (let x = -100; x <= 100; x += 2) {
    for (let z = -100; z <= 100; z += 2) {
      const s = speedAt(base, x, z);
      if (s < min) min = s;
      if (s > max) max = s;
      if (!Number.isFinite(s)) { min = NaN; break; }
    }
  }
  const slowest = Math.min(...TERRAIN.map((t) => t.speed));
  const fastest = Math.max(...TERRAIN.map((t) => t.speed));
  ok('速度落在地表系数区间内', min >= slowest - 1e-9 && max <= fastest + 1e-9,
    `min=${min} max=${max} 区间=[${slowest},${fastest}]`);
  ok('地图上真能踩到最慢的地表', min < slowest + 0.02, `实测最低 ${min.toFixed(3)}`);

  // 档位缩放：light 档的偏离应该只有 standard 的一半
  let found = null;
  for (let x = -100; x <= 100 && !found; x += 2) {
    for (let z = -100; z <= 100; z += 2) {
      if (speedAt(base, x, z) < 0.7) { found = { x, z }; break; }
    }
  }
  ok('存在明显减速区域（用于验证档位）', !!found, JSON.stringify(found));
  if (found) {
    const light = buildTerrain(42, HALF_MAP, { k: presetK('light') });
    const s1 = speedAt(base, found.x, found.z) - 1;
    const s2 = speedAt(light, found.x, found.z) - 1;
    ok('light 档偏离约为 standard 的一半', Math.abs(s2 - s1 * 0.5) < 0.02,
      `standard ${s1.toFixed(3)} / light ${s2.toFixed(3)}`);
  }
}

// ---------------- 4. 平滑性（预测抖动的根因） ----------------

{
  const m = buildTerrain(12345, HALF_MAP, { k: 1 });
  let worst = 0;
  let where = null;
  // 沿任意方向走 1 厘米，速度变化必须极小。
  // 查表法（跨格突跳）在这里会直接崩：一格之差就是 0.45。
  for (let x = -95; x <= 95; x += 3.1) {
    for (let z = -95; z <= 95; z += 3.1) {
      const s0 = speedAt(m, x, z);
      for (const [dx, dz] of [[0.01, 0], [0, 0.01], [0.007, 0.007]]) {
        const d = Math.abs(speedAt(m, x + dx, z + dz) - s0);
        if (d > worst) { worst = d; where = { x, z, d }; }
      }
    }
  }
  ok('速度场连续（1cm 内变化 < 0.01）', worst < 0.01, `最大跳变 ${worst.toFixed(5)} @ ${JSON.stringify(where)}`);

  // 权重必须归一：不归一的话速度会被系统性放大或缩小
  const w = new Float64Array(5);
  let badW = null;
  for (let x = -100; x <= 100 && !badW; x += 5.3) {
    for (let z = -100; z <= 100; z += 5.3) {
      weightsInto(m, x, z, w);
      let s = 0;
      for (let i = 0; i < 5; i++) s += w[i];
      if (Math.abs(s - 1) > 1e-9) { badW = { x, z, s }; break; }
    }
  }
  ok('双线性权重和为 1', !badW, JSON.stringify(badW));
}

// ---------------- 5. 分布合理性 ----------------

{
  const avg = new Array(5).fill(0);
  const worstMin = new Array(5).fill(1);
  const N = 24;
  for (let s = 1; s <= N; s++) {
    const m = buildTerrain(s * 7919, HALF_MAP, { k: 1 });
    for (let t = 0; t < 5; t++) {
      avg[t] += m.stats[t].ratio;
      worstMin[t] = Math.min(worstMin[t], m.stats[t].ratio);
    }
  }
  for (let t = 0; t < 5; t++) avg[t] /= N;

  ok('草地是最大占比（基准速度不能被挤掉）',
    avg[T_GRASS] > avg[T_ROAD] && avg[T_GRASS] > avg[T_SAND] && avg[T_GRASS] > avg[T_SWAMP],
    `草地 ${(avg[T_GRASS] * 100).toFixed(1)}%`);
  ok('公路平均占比 8%~26%', avg[T_ROAD] > 0.08 && avg[T_ROAD] < 0.26,
    `${(avg[T_ROAD] * 100).toFixed(1)}%`);
  for (const t of [T_SAND, T_SNOW, T_SWAMP]) {
    ok(`${TERRAIN[t].name}平均占比 6%~22%`, avg[t] > 0.06 && avg[t] < 0.22,
      `${(avg[t] * 100).toFixed(1)}%`);
    ok(`${TERRAIN[t].name}在每张图上都存在`, worstMin[t] > 0.004,
      `最小 ${(worstMin[t] * 100).toFixed(1)}%`);
  }
}

// ---------------- 6. 没有孤立单格 ----------------

{
  // 孤立一格 = 视觉噪点 + 手感"卡一下"。平滑步骤必须清干净。
  // 公路不参与平滑，但它本身是整条线，不会孤。
  let bad = 0;
  const m = buildTerrain(999, HALF_MAP, { k: 1 });
  const NB = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  for (let iz = 1; iz < m.n - 1; iz++) {
    for (let ix = 1; ix < m.n - 1; ix++) {
      const self = m.cells[iz * m.n + ix];
      let same = 0;
      for (const [dx, dz] of NB) if (m.cells[(iz + dz) * m.n + (ix + dx)] === self) same++;
      if (same === 0) bad++;
    }
  }
  ok('没有完全孤立的格子', bad === 0, `${bad} 格孤立`);
}

// ---------------- 7. 公路连通 ----------------

{
  // 一条从地图一边穿到另一边的路，是"公路"这个概念的最低要求。
  // 断成几截的碎路只是灰色的地形块，玩家不会把它当路走。
  //
  // 判定用 4-连通 BFS 从一侧走到另一侧 —— 不能用"某一行连续几格是路"，
  // 那是路的宽度（2 格），跟贯通完全不是一回事。
  const reach = (m, fromSide) => {
    const seen = new Uint8Array(m.n * m.n);
    const q = [];
    for (let k = 0; k < m.n; k++) {
      const idx = fromSide === 'left' ? k * m.n : k;
      const idx2 = fromSide === 'top' ? k : idx;
      const i = fromSide === 'left' || fromSide === 'right'
        ? (fromSide === 'left' ? k * m.n : k * m.n + m.n - 1)
        : (fromSide === 'top' ? k : (m.n - 1) * m.n + k);
      if (m.cells[i] === T_ROAD && !seen[i]) { seen[i] = 1; q.push(i); }
      void idx; void idx2;
    }
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      const iz = (i / m.n) | 0;
      const ix = i % m.n;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = ix + dx;
        const nz = iz + dz;
        if (nx < 0 || nx >= m.n || nz < 0 || nz >= m.n) continue;
        const j = nz * m.n + nx;
        if (seen[j] || m.cells[j] !== T_ROAD) continue;
        seen[j] = 1;
        q.push(j);
      }
    }
    let hit = 0;
    for (let k = 0; k < m.n; k++) {
      if (fromSide === 'left' || fromSide === 'right') {
        const i = fromSide === 'left' ? k * m.n + m.n - 1 : k * m.n;
        if (seen[i]) hit++;
      } else {
        const i = fromSide === 'top' ? (m.n - 1) * m.n + k : k;
        if (seen[i]) hit++;
      }
    }
    return hit;
  };

  for (const seed of [1, 42, 12345, 7, 20261029]) {
    const m = buildTerrain(seed, HALF_MAP, { k: 1 });
    ok(`seed ${seed} 公路横向贯通`, reach(m, 'left') > 0, `到达 ${reach(m, 'left')} 格`);
    ok(`seed ${seed} 公路纵向贯通`, reach(m, 'top') > 0, `到达 ${reach(m, 'top')} 格`);
  }
}

// ---------------- 8. 出生点保护 ----------------

{
  const pts = defaultClearPoints();
  ok('默认保护点包含全部多人出生点', pts.length === SPAWNS.length + 2, `${pts.length} 个`);
  for (const seed of [3, 77, 2026]) {
    const m = buildTerrain(seed, HALF_MAP, { k: 1 });
    let worst = 1;
    let at = null;
    for (const [x, z] of SPAWNS.map(([sx, sz]) => [sx * 0.35, sz * 0.35])) {
      const s = speedAt(m, x, z);
      if (s < worst) { worst = s; at = [x, z]; }
    }
    ok(`seed ${seed} 出生点不会被沼泽/雪地拖慢`, worst >= 0.999,
      `最低 ${worst.toFixed(3)} @ ${JSON.stringify(at)}`);
  }
}

// ---------------- 9. dominantAt 与 speedAt 自洽 ----------------

{
  const m = buildTerrain(88888, HALF_MAP, { k: 1 });
  // 格中心处只取本格，dominantAt 必须正好是这一格的类型。
  // （格边界上是双线性混合值，本来就介于两类之间，拿它比对没有意义。）
  let bad = 0;
  for (let iz = 0; iz < m.n; iz++) {
    for (let ix = 0; ix < m.n; ix++) {
      const cx = m.x0 + (ix + 0.5) * m.tile;
      const cz = m.x0 + (iz + 0.5) * m.tile;
      const t = dominantAt(m, cx, cz);
      if (t !== m.cells[iz * m.n + ix]) bad++;
    }
  }
  ok('格中心 dominantAt 等于该格类型', bad === 0, `${bad} 格不符`);

  // 混合后的速度必须始终落在"参与混合那几类"的速度区间内
  let out = 0;
  const lo = Math.min(...TERRAIN.map((t) => t.speed)) - 1e-9;
  const hi = Math.max(...TERRAIN.map((t) => t.speed)) + 1e-9;
  for (let x = -95; x <= 95; x += 2.3) {
    for (let z = -95; z <= 95; z += 2.3) {
      const s = speedAt(m, x, z);
      if (s < lo || s > hi) out++;
    }
  }
  ok('混合速度不越界', out === 0, `${out} 个采样点越界`);
}

// ---------------- 10. World 集成 ----------------

{
  const w1 = new World({ code: 'AAA', seed: 12345, maxPlayers: 4, terrainPreset: 'standard' });
  const w2 = new World({ code: 'BBB', seed: 12345, maxPlayers: 4, terrainPreset: 'standard' });
  ok('同 seed 的房间生成同一张地表', w1.terrain.seed === w2.terrain.seed);
  let same = true;
  for (let i = 0; i < w1.terrain.cells.length; i++) {
    if (w1.terrain.cells[i] !== w2.terrain.cells[i]) { same = false; break; }
  }
  ok('同 seed 逐格一致', same);

  ok('static 碰撞源拿到了地表场', w1.static.terrain === w1.terrain);
  const ts = w1.fullState().terrain;
  ok('WELCOME 只下发种子不下发格点', typeof ts === 'object' && !Array.isArray(ts.cells) && ts.seed > 0);

  const wOff = new World({ code: 'OFF', seed: 12345, maxPlayers: 4, terrainPreset: 'off' });
  ok('off 档 k = 0', wOff.terrain.k === 0);
  let one = true;
  for (let x = -90; x <= 90; x += 11) {
    for (let z = -90; z <= 90; z += 11) if (Math.abs(speedAt(wOff.terrain, x, z) - 1) > 1e-9) one = false;
  }
  ok('off 档全程平速', one);
}

// ---------------- 11. 单位真的会被地形改速 ----------------

{
  const m = buildTerrain(4242, HALF_MAP, { k: 1 });

  // 找一块最慢的地，把车放上去走 1 秒
  let slow = null;
  for (let x = -95; x <= 95 && !slow; x += 1.7) {
    for (let z = -95; z <= 95; z += 1.7) {
      if (speedAt(m, x, z) < 0.6) { slow = { x, z }; break; }
    }
  }
  ok('地图上存在速度 < 0.6 的区域', !!slow, JSON.stringify(slow));

  if (slow) {
    const col = { terrain: m, hit: () => null };
    const body = { x: slow.x, z: slow.z, yaw: 0, speed: 0, speedBase: 15 };
    const z0 = body.z;
    stepBody(body, { mx: 0, mz: 1 }, 1, col, HALF);
    const moved = body.z - z0;
    const want = 15 * speedAt(m, slow.x, slow.z);
    ok('进沼泽后一步走不到 15 米', moved < 15 && moved > 15 * 0.5,
      `实际 ${moved.toFixed(2)} 米 / 期望 ${want.toFixed(2)}`);
  }

  // 没有地表时必须是精确的 15
  const plain = { x: 0, z: 0, yaw: 0, speed: 0, speedBase: 15 };
  stepBody(plain, { mx: 0, mz: 1 }, 1, { hit: () => null }, HALF);
  ok('无地表时一步正好 15 米（零回归）', Math.abs(plain.z - 15) < 1e-9, `实际 ${plain.z}`);
}

// ---------------- 12. 档位解析 ----------------

{
  ok('presetK(off) === 0', presetK('off') === 0);
  ok('presetK(standard) === 1', presetK('standard') === 1);
  ok('presetK(harsh) === 1.4', presetK('harsh') === 1.4);
  ok('presetK 未配置时按标准档', presetK(undefined) === 1);
  ok('presetK 乱填时退化成 off', presetK('乱填') === 0);
  ok('TERRAIN_PRESETS 四档齐全', Object.keys(TERRAIN_PRESETS).length === 4);
}

// ---------------- 13. 地图尺寸 ----------------

{
  const m = buildTerrain(5, HALF_MAP, { k: 1 });
  ok('格数覆盖整张地图', m.n * m.tile >= HALF_MAP * 2, `${m.n}×${m.tile} >= ${HALF_MAP * 2}`);
  ok('网格以原点为中心', Math.abs(m.x0 + (m.n * m.tile) / 2) < 1e-9, `x0=${m.x0}`);
  ok('格边长与 TILE 一致', m.tile === TILE);

  const sc = scanTerrain(m);
  ok('scanTerrain 返回速度极值', sc && sc.minSpeed <= sc.maxSpeed);
}

// ---------------- 14. 边界与越界安全 ----------------

{
  const m = buildTerrain(6, HALF_MAP, { k: 1 });
  // NaN / undefined 必须退化成 1.0，不能算出 0。
  // 0 会让车彻底定住（残差校正时位置可能短暂是 NaN，那时车就变砖了）。
  ok('NaN 坐标返回 1.0', speedAt(m, NaN, 0) === 1 && speedAt(m, 0, NaN) === 1);
  ok('undefined 坐标返回 1.0', speedAt(m, undefined, 3) === 1);
  ok('Infinity 坐标返回 1.0', speedAt(m, Infinity, -Infinity) === 1);

  for (const [x, z] of [[-1e9, 0], [1e9, 0], [0, -1e9], [0, 1e9], [-108, -108], [108, 108]]) {
    const s = speedAt(m, x, z);
    ok(`越界采样不返回 NaN (${x},${z})`, Number.isFinite(s) && s >= 0.5 && s <= 1.2, `${s}`);
  }
  ok('HALF 与 levelgen 一致', HALF === 100);
}

// ---------------- 15. 类型 id 稳定 ----------------

{
  // cells 是 Uint8Array，存的就是 id。改了 id 顺序等于改了协议语义。
  ok('T_GRASS = 0（默认值就是草地）', T_GRASS === 0);
  ok('T_ROAD = 1', T_ROAD === 1);
  ok('T_SAND = 2', T_SAND === 2);
  ok('T_SNOW = 3', T_SNOW === 3);
  ok('T_SWAMP = 4', T_SWAMP === 4);
  ok('TERRAIN 顺序与 id 一致', TERRAIN.map((t) => t.key).join(',') === 'grass,road,sand,snow,swamp');
  ok('草地速度是 1.00（基准）', TERRAIN[T_GRASS].speed === 1);
  ok('沼泽最慢', TERRAIN[T_SWAMP].speed === Math.min(...TERRAIN.map((t) => t.speed)));
  ok('公路最快', TERRAIN[T_ROAD].speed === Math.max(...TERRAIN.map((t) => t.speed)));
}

// ---------------- 16. 位置残差不会在速度场上被放大 ----------------

{
  // 这是整个特性的核心风险：
  //   客户端预测位置和服务端权威位置永远有几厘米的差（网络抖动、浮点）。
  //   如果速度场是"查所在格"，跨格线时两端的速度差能到 45%，
  //   每帧 0.1 米的位移差会滚成本可见的拖拽，然后被硬校正拉回来 —— 手感崩掉。
  //   双线性下速度差随位置差线性变化，残差有界。
  const m = buildTerrain(2024, HALF_MAP, { k: 1 });

  // 找一条会穿过地形边界的直路
  let route = null;
  for (let z = -80; z <= 80 && !route; z += 4.7) {
    let mn = 1;
    let mx = 0;
    for (let x = -80; x <= 80; x += 1.3) {
      const s = speedAt(m, x, z);
      mn = Math.min(mn, s);
      mx = Math.max(mx, s);
    }
    if (mx - mn > 0.35) route = { z, mn, mx };
  }
  ok('存在穿过多种地形的直线（用于残差测试）', !!route, JSON.stringify(route));

  if (route) {
    // 两端从同一位置出发，但客户端位置先偏 5 厘米（模拟一次校正残差）
    const col = { terrain: m, hit: () => null };
    const srv = { x: -70, z: route.z, yaw: 0, speed: 0, speedBase: 15 };
    const cli = { x: -70 + 0.05, z: route.z, yaw: 0, speed: 0, speedBase: 15 };
    for (let i = 0; i < 300; i++) {
      stepBody(srv, { mx: 1, mz: 0 }, 1 / 30, col, HALF);
      stepBody(cli, { mx: 1, mz: 0 }, 1 / 30, col, HALF);
    }
    const drift = Math.abs(cli.x - srv.x);
    ok('两端位置残差跑 10 秒不放大到 1 米', drift < 1,
      `残差从 0.05 米变成 ${drift.toFixed(3)} 米`);
  }

  // 同一位置、同一输入，两端必须走出完全相同的位置（逐位相等）
  {
    const a = { x: 12.345, z: -6.789, yaw: 0.3, speed: 0, speedBase: 15 };
    const b = { x: 12.345, z: -6.789, yaw: 0.3, speed: 0, speedBase: 15 };
    const col = { terrain: m, hit: () => null };
    for (let i = 0; i < 200; i++) {
      stepBody(a, { mx: 0.7, mz: 0.7 }, 1 / 30, col, HALF);
      stepBody(b, { mx: 0.7, mz: 0.7 }, 1 / 30, col, HALF);
    }
    ok('同起点同输入两端逐位一致', a.x === b.x && a.z === b.z && a.speed === b.speed,
      `${a.x} vs ${b.x}`);
  }
}

// ---------------- 17. 速度曲线没有台阶 ----------------

{
  const m = buildTerrain(314, HALF_MAP, { k: 1 });
  // 沿一条横线密集采样，任意相邻 2 厘米的速度差都必须很小。
  // 这条断言如果挂了，玩家感受到的就是"车被什么绊了一下"。
  let worst = 0;
  for (let z = -80; z <= 80; z += 13.7) {
    let prev = speedAt(m, -95, z);
    for (let x = -95 + 0.02; x <= 95; x += 0.02) {
      const s = speedAt(m, x, z);
      worst = Math.max(worst, Math.abs(s - prev));
      prev = s;
    }
  }
  ok('2cm 采样的最大速度跳变 < 0.02', worst < 0.02, `实测 ${worst.toFixed(4)}`);
}

console.log(`terrain: ${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
