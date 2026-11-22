// 坦克合批（InstancedMesh）的离线回归测试。
//
// 这套东西的正确性只有两条：**画出来的东西和逐个 Mesh 一模一样**，
// 以及**实例容量跟得上车的数量**。前一条在这里用「实例矩阵 == 车体矩阵 × 部件本地矩阵」
// 钉死（渲染出来对不对比图更早发现问题）；后一条钉的是踩过的坑：
// 左右履带共用同一个部件批，一辆车会往同一批里写 2 个实例，
// 容量只按车数算就会写越界，多出来的实例读到缓冲外——画面上是履带乱飞。

import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { Tank } from '../src/Tank.js';
import { batchFor, updateBatches, batchStats } from '../src/TankBatch.js';

let pass = 0;
const ok = (name) => { pass++; console.log(`  · ${name}`); };
const near = (a, b, eps = 1e-5) => Math.abs(a - b) <= eps;

const scene = new THREE.Scene();
const mk = (x, z, extra = {}) => new Tank(scene, {
  team: 'enemy', type: 'gunner', detail: 'low', idLamp: false, hp: 100, x, z, ...extra,
});

console.log('\n[1] 低模车会被接管，玩家车不会');
{
  const e = mk(0, 0);
  let meshes = 0;
  e.group.traverse((o) => { if (o.isMesh) meshes++; });
  assert.equal(meshes, 0, '注册后场景图里不应再留下 Mesh（否则等于没合批）');
  assert.ok(e._parts && e._parts.length > 0, '零件表应记录每个部件的本地矩阵');
  assert.ok(e.turret.parent === e.group, '炮塔节点要保留，muzzle 和尾焰还挂在上面');

  const hi = new Tank(scene, { team: 'player', chassis: 'panther', detail: 'high', hp: 100, x: 200, z: 200 });
  let hiMeshes = 0;
  hi.group.traverse((o) => { if (o.isMesh) hiMeshes++; });
  assert.ok(hiMeshes > 0, '玩家高模不进批：负重轮要逐轮转，留在原路上');
  assert.equal(hi._parts, null);
  ok('敌人合批、玩家不合批，炮塔节点保留');
}

console.log('\n[2] 实例矩阵 == 车体矩阵 × 部件本地矩阵');
{
  const scene2 = new THREE.Scene();
  const a = new Tank(scene2, { team: 'enemy', type: 'gunner', detail: 'low', idLamp: false, x: 3, z: -4, rotY: 0.9 });
  a.setAim(2.1);                       // 炮塔相对车头转开
  a.recoil(); a.update(0.06);          // 后座让炮塔沿 -Z 退一点
  a.group.rotation.z = 0.25;           // 倒地倾斜
  updateBatches();

  scene2.updateMatrixWorld(true);
  const m = new THREE.Matrix4();
  // 实例下标要按写入顺序数：左右履带共用一个批，同一辆车的第二个履带落在 index 1，
  // 不能一律读 index 0（这正是"每车实例数 > 1"的那类部件）。
  const slot = new Map();
  let checked = 0;
  for (const r of a._parts) {
    const idx = slot.get(r.pb) || 0;
    slot.set(r.pb, idx + 1);
    const want = new THREE.Matrix4().multiplyMatrices(
      r.turretPart ? a.turret.matrixWorld : a.group.matrixWorld,
      r.local,
    );
    r.pb.mesh.getMatrixAt(idx, m);
    for (let i = 0; i < 16; i++) {
      assert.ok(near(m.elements[i], want.elements[i]),
        `部件 ${checked} 第 ${i} 项不一致：${m.elements[i]} vs ${want.elements[i]}`);
    }
    checked++;
  }
  // r54 删了斜首上装甲，一辆低模车从 9 件降到 8 件（2 履带 + 车体 + 炮塔 + 炮盾 +
  // 车长塔 + 炮管 + 炮口制退器）。零件数只增不减的那种"顺手加回去"会被这里拦下。
  assert.ok(checked >= 8, '一辆低模车至少 8 个部件都要对上');
  ok(`${checked} 个部件的实例矩阵与场景图完全一致（含炮塔角/后座/倾斜）`);
}

console.log('\n[3] 容量按「车数 × 每车实例数」算，履带不会写越界');
{
  const scene3 = new THREE.Scene();
  const tanks = [];
  for (let i = 0; i < 70; i++) {
    tanks.push(new Tank(scene3, {
      team: 'enemy', type: 'gunner', detail: 'low', idLamp: false, x: i * 3, z: 0,
    }));
  }
  updateBatches();
  const b = batchFor(scene3);
  const track = [...b.parts.values()].find((pb) => pb.perTank === 2);
  assert.ok(track, '左右履带应共用一个部件批，每车 2 个实例');
  assert.equal(track.n, 140, '70 辆车的履带应有 140 个实例');
  assert.ok(track.mesh.instanceMatrix.count >= track.n,
    `实例缓冲必须装得下：${track.mesh.instanceMatrix.count} < ${track.n}`);
  assert.equal(track.mesh.count, track.n, '绘制的实例数要与写入的一致');
  ok(`70 辆车 → 履带 ${track.n} 个实例，缓冲 ${track.mesh.instanceMatrix.count} 装得下`);
}

console.log('\n[4] 移除后自动收尸');
{
  const before = batchStats();
  const until = before.tanks;
  const tank = mk(0, 0);
  updateBatches();
  assert.ok(batchStats().tanks > until, '新建的车应立刻计入');

  tank.dispose(scene);
  updateBatches();
  assert.equal(batchStats().tanks, until, 'dispose 之后应从批里摘掉');

  // 单机里 enemy 是直接 scene.remove(group) 走的，不调 dispose —— 也要收尸
  const ghost = mk(9, 9);
  updateBatches();
  scene.remove(ghost.group);
  updateBatches();
  assert.equal(batchStats().tanks, until, '裸 scene.remove 也要被下一帧自动剔除');
  ok('dispose 与裸 remove 两条路径都能收尸');
}

console.log(`\n坦克合批 ${pass} 项通过`);
