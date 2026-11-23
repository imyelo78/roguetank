// 战区（每 5 波换一张图）回归测试。
//
// 钉住三件事：
//   1. 波次 → 战区的映射：1~5 第一战区、6 起换、55 波后循环回第一个
//   2. 任何战区、任何种子，都不能把出生点压住 —— 这是换图最经典的事故
//      （"更新完一进第 6 波车就卡在墙里"），而且只在换图那一帧出现
//   3. 每个战区都有可走的中央区域，且掩体数量在合理区间
//
// 为什么用多个种子：战区的骨架是手写的，但坐标扰动来自种子。
// 只测一个种子，等于只验了一套扰动——真实开局每次种子都不同。
import assert from 'node:assert/strict';
import {
  ZONES, zoneForWave, zoneIndexForWave, layoutOptsFor, terrainOptsFor, WAVES_PER_ZONE,
} from '../src/core/zones.js';
import {
  generateBoxes, blockedAt, resolveMultiSpawns, PLAYER_START, SPAWNS, HALF,
} from '../src/core/levelgen.js';
import { T_GRASS, T_ROAD } from '../src/core/terrain.js';
import { World } from '../src/core/world.js';

let pass = 0;
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }

// ---- 1) 波次映射 ----
{
  assert.equal(WAVES_PER_ZONE, 5);
  assert.equal(ZONES.length, 10, '一轮 10 个战区，正好对上 10 个 Boss');
  assert.equal(zoneForWave(1).id, 0);
  assert.equal(zoneForWave(5).id, 0);
  assert.equal(zoneForWave(6).id, 1);
  assert.equal(zoneForWave(10).id, 1);
  assert.equal(zoneForWave(50).id, 9);
  // 55 波之后循环：无限模式必须有图可换
  assert.equal(zoneForWave(51).id, 0);
  assert.equal(zoneForWave(55).id, 0);
  assert.equal(zoneForWave(56).id, 1);

  for (let n = 1; n <= 60; n++) {
    assert.equal(zoneIndexForWave(n), Math.floor((n - 1) / WAVES_PER_ZONE) % ZONES.length, `第 ${n} 波`);
  }
  ok('波次 → 战区映射（1~60 波，55 波后循环）');
}

// ---- 2) 出生点保护 ----
{
  const seeds = [1, 777, 20261123, 0xdeadbeef];
  for (const z of ZONES) {
    for (const seed of seeds) {
      const boxes = generateBoxes(seed, { ...layoutOptsFor(z), zoneMix: z.id });

      // 单机出生点：留 2.2 米余量（车体半径 1.9 + 一点缓冲）
      assert.equal(
        blockedAt(boxes, PLAYER_START.x, PLAYER_START.z, 2.2), false,
        `战区「${z.name}」种子 ${seed}：单机出生点被压住`,
      );

      // 多人出生点：先按 0.35 缩放，再让 resolveMultiSpawns 做一次修正——
      // 固定掩体是手写的，抖动后压住某个出生点是常态（联机进房时本来就会
      // 沿径向挪开）。这里要钉的是"修正之后一定可走"，而不是"原坐标不被压"。
      const fixed = resolveMultiSpawns(boxes);
      for (let i = 0; i < fixed.length; i++) {
        const [px, pz] = fixed[i];
        assert.equal(
          blockedAt(boxes, px, pz, 1.9), false,
          `战区「${z.name}」种子 ${seed}：多人出生点 #${i} (${px.toFixed(1)}, ${pz.toFixed(1)}) 修正后仍被压`,
        );
        assert.ok(Math.abs(px) < HALF - 3 && Math.abs(pz) < HALF - 3, '修正后不能越界');
      }
    }
  }
  ok('10 个战区 × 4 个种子：单机与多人出生点全部可走');
}

// ---- 3) 中央区域与掩体数量 ----
{
  for (const z of ZONES) {
    const boxes = generateBoxes(20261123, { ...layoutOptsFor(z), zoneMix: z.id });

    // 中央必须至少有一块可走地（Boss 落地、宝箱兜底都靠它）。
    // island 是唯一的例外：中央就是那座堡垒本身。
    if (z.layout !== 'island') {
      let free = false;
      for (let a = 0; a < 8 && !free; a++) {
        const th = (a / 8) * Math.PI * 2;
        for (let r = 0; r <= 8; r += 2) {
          if (!blockedAt(boxes, Math.cos(th) * r, Math.sin(th) * r, 2.2)) { free = true; break; }
        }
      }
      assert.equal(free, true, `战区「${z.name}」中央没有一块可走地`);
    }

    assert.ok(boxes.length >= 8, `战区「${z.name}」掩体太少（${boxes.length}）`);
    assert.ok(boxes.length <= 70, `战区「${z.name}」掩体太多（${boxes.length}），后期会卡`);

    // 掩体不能越过边界（越界的话车会被墙挤到 clamp 外面）
    for (const b of boxes) {
      assert.ok(Math.abs(b.x) < HALF && Math.abs(b.z) < HALF, `战区「${z.name}」掩体越界`);
    }
  }
  ok('每个战区中央可走、掩体数量在 8~70 之间、无越界');
}

// ---- 4) 地形主题合法 ----
{
  for (const z of ZONES) {
    const opts = terrainOptsFor(z);
    if (z.types) {
      assert.equal(z.types.length >= 3, true, `战区「${z.name}」需要三种地形`);
      for (const t of z.types) {
        // 草地/公路不能当主题色：草地是默认底（涂了看不出来），
        // 公路是 carveRoad 挖出来的，塞进 paint 会额外造出一片柏油
        assert.notEqual(t, T_GRASS, `战区「${z.name}」不能用草地当主题`);
        assert.notEqual(t, T_ROAD, `战区「${z.name}」不能用公路当主题`);
      }
      assert.equal(opts.types.length, 3);
    }
    assert.ok(opts.mainMul >= 0.7 && opts.mainMul <= 1.6, `战区「${z.name}」主地形倍率越界`);
  }
  ok('地形主题合法（不含草地/公路，倍率 0.7~1.6）');
}

// ---- 5) 布局不重复：每 5 波换的不只是种子，是骨架 ----
{
  const kinds = new Set(ZONES.map((z) => z.layout));
  assert.equal(kinds.size, ZONES.length, `10 个战区应该有 10 种骨架，实际 ${kinds.size} 种`);
  ok('10 个战区的骨架互不重复');
}

// ---- 6) 换图 / 暂离归队：不能把人留在新墙里 ----
//
// 这一条是合并两条开发线（战区 r49 ＋ 多人暂离 r48~r54）之后才存在的场景：
// 第 4 波按暂停、第 6 波才回来，中间换了图，原位可能正好被新墙占住。
// 两个入口都必须兜住：World._enterZone（换图那一刻在场的人）、
// Room._restorePlayer → World.nudgeToFree（归队那一刻放回去的人）。
{
  const w = new World({ code: 'ZONE', seed: 0x51ed, maxPlayers: 2 });

  // 找一个确实被墙占住的点（按玩家半径 1.9 算）
  let hut = null;
  for (let x = -HALF + 6; x < HALF - 6 && !hut; x += 3) {
    for (let z = -HALF + 6; z < HALF - 6; z += 3) {
      if (w.static.blocked(x, z, 1.9)) { hut = { x, z }; break; }
    }
  }
  assert.ok(hut, '这张图应该有墙，否则这条测试没有意义');

  const stuck = { x: hut.x, z: hut.z };
  assert.equal(w.nudgeToFree(stuck), true, '卡在墙里的单位必须被挪走');
  assert.equal(w.static.blocked(stuck.x, stuck.z, 1.9), false, '挪完必须站得下');

  // 站得下的人一毫米都不动 —— 归队不能把人瞬移走
  const free = { x: 0, z: 0 };
  if (!w.static.blocked(free.x, free.z, 1.9)) {
    assert.equal(w.nudgeToFree(free), false, '已经站得下就不该动');
    assert.deepEqual([free.x, free.z], [0, 0], '位置不能被改写');
  }

  // 换战区那一刻：场上的人被塞进墙里（模拟旧图坐标），换完必须可走
  const w2 = new World({ code: 'ZONE', seed: 0x51ed, maxPlayers: 2 });
  const p = w2.addPlayer({ id: 'u1', name: '甲', chassisId: 'panther' });
  p.x = hut.x; p.z = hut.z;
  w2._enterZone(1);
  assert.equal(w2.static.blocked(p.x, p.z, 1.9), false, '换图后场上的人不能留在墙里');
  ok('换战区 / 归队都不会把人留在新墙里');
}

console.log(`\n战区系统：${pass} 项通过`);
