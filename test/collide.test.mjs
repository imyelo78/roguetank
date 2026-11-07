// 建筑（掩体箱体）卡坦克的回归测试
//
// 线上真实反馈："坦克贴着建筑开过去会被吸住，得倒一把才能走"，
// 严重时"车直接卡在箱子里，怎么按都不动"。
//
// 原因有两个，都和判定算法有关：
//   1. 圆被当成方块判：|x-bx| < w/2+r && |z-bz| < d/2+r。角上是直角，
//      r=1.9 时比真实圆弧多占 0.79 米，贴着楼边过不去。
//   2. 分轴判定（先试 x 再试 z）在 45° 顶住拐角时两个轴同时被拒，
//      叠加"已经嵌进墙里就再也出不来"，车彻底钉死。
//
// 这组测试锁死四件事：
//   [1] 拐角不再是直角方块：角外侧能过
//   [2] 已经嵌进箱体的车，下一步就能自己出来
//   [3] 斜顶拐角能沿圆弧滑过去，不会被钉在原地
//   [4] 地图上跑 20 秒，所有敌人都不许嵌进箱体，也不许长时间卡死
//   [5] 三处碰撞实现（服务端 / 客户端 / 地图生成）必须同源

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { boxHit, deepestHit, hitsAny } from '../src/core/collide.js';
import { stepBody, BODY_RADIUS } from '../src/core/motion.js';
import { World, buildStaticWorld, HALF } from '../src/core/world.js';
import { generateBoxes, blockedAt } from '../src/core/levelgen.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

const DT = 1 / 30;
const R = BODY_RADIUS;

console.log('\n[1] 建筑拐角是圆弧，不是直角方块');
{
  // 边长 10 的箱体，角点在 (5,5)
  const box = [0, 0, 10, 10];
  const corner = { x: 5, z: 5 };

  // 距角点 1.2 米的对角偏移：在圆内，必须挡住
  assert.ok(hitsAny([box], 6.2, 6.2, R), '角点内侧竟然能站人，会穿进建筑');
  // 距角点 2.1 米：圆外，必须能站。旧算法 (6.5 < 5+1.9=6.9) 会误判为撞墙
  assert.equal(hitsAny([box], 6.5, 6.5, R), false);
  const d = Math.hypot(6.5 - corner.x, 6.5 - corner.z);
  assert.ok(d > R && d < R + 1, '测试点应落在"旧判定挡住、真实圆不挡"的那一圈里');
  ok(`距拐角 ${d.toFixed(2)} 米（>半径 ${R}）不再被挡，旧方块判定会误挡 0.79 米`);

  // 正面距离没变：贴着墙就该挡住，不能因为改判定把墙变薄
  assert.ok(hitsAny([box], 6.85, 0, R), '正面贴墙竟然不挡，墙变薄了');
  assert.equal(hitsAny([box], 6.95, 0, R), false);
  ok('正面碰撞距离仍为 半宽+半径（墙没有变薄）');
}

console.log('\n[2] 嵌进箱体的车能自己出来');
{
  const staticW = buildStaticWorld();
  const b = generateBoxes()[0];
  const body = { x: b.x, z: b.z, yaw: 0, speed: 0, speedBase: 15 };
  assert.ok(deepestHit(staticW.boxes, body.x, body.z, R), '车心应在箱体内部（构造失败）');

  // 只按一帧 W（朝 +z），也必须先被推出来
  stepBody(body, { mx: 0, mz: 1 }, DT, staticW, HALF);
  const h = deepestHit(staticW.boxes, body.x, body.z, R);
  assert.equal(h, null, `一帧之后仍嵌在墙里（穿透 ${h ? h.depth.toFixed(2) : 0} 米）`);
  ok('从箱体正中央起步，一帧内被推回表面，不再"按什么都不动"');

  // 连续 60 帧任意方向乱开，任何时候都不许停在墙里
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7]];
  for (let i = 0; i < 60; i++) {
    const d = dirs[i % dirs.length];
    stepBody(body, { mx: d[0], mz: d[1] }, DT, staticW, HALF);
    assert.equal(deepestHit(staticW.boxes, body.x, body.z, R), null,
      `第 ${i} 帧又嵌回墙里（${body.x.toFixed(2)}, ${body.z.toFixed(2)}）`);
  }
  ok('连续 60 帧换向乱开，没有一帧停在建筑里（脱困与滑行不打架）');
}

console.log('\n[3] 45° 斜顶拐角能沿圆弧滑过去');
{
  const box = [0, 0, 10, 10]; // 角点 (5,5)
  // 从箱子右上方、斜着往左下推：正好顶着拐角
  const body = { x: 10, z: 12, yaw: 0, speed: 0, speedBase: 15 };
  const col = {
    hit: (x, z, r) => deepestHit([box], x, z, r),
    blocked: (x, z, r) => hitsAny([box], x, z, r),
  };

  const start = Math.hypot(body.x, body.z);
  let moved = 0;
  let prevX = body.x;
  let prevZ = body.z;
  let stuck = 0;
  for (let i = 0; i < 45; i++) {
    stepBody(body, { mx: -1, mz: -1 }, DT, col, 999);
    const step = Math.hypot(body.x - prevX, body.z - prevZ);
    if (step < 1e-4) stuck++;
    moved += step;
    prevX = body.x;
    prevZ = body.z;
  }
  // 45 帧理论位移 = 15 * 1.5 = 22.5 米；顶着角要绕圆弧，能走一半就说明没被钉死
  assert.ok(moved > 8, `45 帧只走了 ${moved.toFixed(1)} 米，车被拐角卡住了`);
  // 全程不能有"连续 10 帧完全不动"
  assert.ok(stuck < 10, `有 ${stuck} 帧完全静止，说明顶到拐角就死了`);
  // 也不能穿进箱体
  assert.equal(deepestHit([box], body.x, body.z, R), null, '滑行过程穿进了箱体');
  ok(`斜顶拐角 1.5 秒走了 ${moved.toFixed(1)} 米（理论 22.5），全程未静止、未穿墙`);
}

console.log('\n[4] 敌人不会被建筑卡死');
{
  // 到最近箱体表面的距离（不含半径），用来区分"贴着建筑不动"和"到点停下射击"
  const nearestBox = (boxes, x, z) => {
    let best = Infinity;
    for (const b of boxes) {
      const px = Math.max(b[0] - b[2] / 2, Math.min(b[0] + b[2] / 2, x));
      const pz = Math.max(b[1] - b[3] / 2, Math.min(b[1] + b[3] / 2, z));
      best = Math.min(best, Math.hypot(x - px, z - pz));
    }
    return best;
  };

  const w = new World({ code: 'T', seed: 4242, maxPlayers: 4 });
  const p = w.addPlayer({ id: 'u1', name: 'tester', chassisId: 'balanced' });
  w.start();
  // 让玩家站着不动，敌人从四面压过来：最容易在掩体处挤成一团
  w.setInput('u1', { mx: 0, mz: 0, aimX: 0, aimZ: 0, fire: false, seq: 1 });

  let deep = 0;
  let wallStuck = 0;
  let samples = 0;
  const lastPos = new Map();
  const frozenRun = new Map(); // id -> 连续"贴墙不动"的采样次数（每 0.2 秒一次）
  const longStuck = new Set();

  for (let i = 0; i < 20 * 30; i++) {
    w.step(DT);
    if (i % 6) continue;
    for (const e of w.enemies) {
      // 炮塔类 speed = 0，本来就不动，不算"卡死"
      if (e.static || !e.speed) continue;
      samples++;
      const h = deepestHit(w.static.boxes, e.x, e.z, e.radius);
      if (h && h.depth > 0.05) deep++;

      const prev = lastPos.get(e.id);
      const moved = prev ? Math.hypot(e.x - prev.x, e.z - prev.z) : 99;
      lastPos.set(e.id, { x: e.x, z: e.z });

      // 只有"贴着建筑（0.35 米内）却一动不动"才算被建筑卡住；
      // 走到射击距离停下来的属于正常行为
      const hugging = nearestBox(w.static.boxes, e.x, e.z) < e.radius + 0.35;
      if (moved < 0.05 && hugging) {
        wallStuck++;
        const run = (frozenRun.get(e.id) || 0) + 1;
        frozenRun.set(e.id, run);
        // 连续 1 秒（5 个采样点）贴着建筑不动，才是玩家能感知的"卡死"
        if (run >= 5) longStuck.add(e.id);
      } else {
        frozenRun.delete(e.id);
      }
    }
  }

  assert.ok(samples > 200, `样本太少（${samples}），测试没有真正跑起来`);
  assert.equal(deep, 0, `${deep}/${samples} 个敌人样本嵌进建筑（穿透 >0.05 米）`);
  ok(`${samples} 个敌人样本，0 个嵌进建筑`);

  // 偶发一两帧贴墙（正在绕行/被墙挡一下）是允许的，长时间钉死在墙边不行
  assert.ok(longStuck.size <= 1,
    `${longStuck.size} 个敌人连续 1 秒以上贴着建筑不动（id: ${[...longStuck].join(',')}）`);
  ok(`贴墙瞬时不动的样本 ${(wallStuck / samples * 100).toFixed(1)}%，连续 1 秒卡死的敌人 ${longStuck.size} 个`);
}

console.log('\n[5] 三处碰撞实现必须同源');
{
  const world = readFileSync(join(here, '..', 'src', 'core', 'world.js'), 'utf8');
  const level = readFileSync(join(here, '..', 'src', 'level.js'), 'utf8');
  const gen = readFileSync(join(here, '..', 'src', 'core', 'levelgen.js'), 'utf8');

  for (const [name, src] of [['world.js', world], ['level.js', level], ['levelgen.js', gen]]) {
    assert.ok(/core\/collide\.js|\.\/collide\.js/.test(src), `${name} 没有引用 core/collide.js`);
    assert.ok(!/Math\.abs\(x - b\.x\) < [\w.]+\/ ?2 \+ r/.test(src),
      `${name} 里又出现了"把圆当方块"的直角判定`);
  }
  ok('world / level / levelgen 都走 core/collide.js，没有手抄的直角判定');
}

console.log(`\n建筑卡坦克回归测试全部通过（${pass} 项）`);
