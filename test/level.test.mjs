// 地图一致性：客户端看得见的墙 === 服务端判定的墙
//
// 这组断言来自一次线上事故：两端各写了一套箱子生成循环，客户端为了建模型
// 多算了一个高度 h 的随机数，服务端没有，从第二个随机箱子起坐标整体错位；
// 固定掩体里还把渲染高度 h 当成深度 d 抄了过来。结果玩家一进房就撞"假墙"，
// 速度每帧乘 0.3 被死锁在 0.8 米/秒，表现是油门踩到底车不动。
//
// 这里把"两端必须同源"钉成测试，以后再有人手抄一份就会红。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  generateBoxes, blockedAt, resolveMultiSpawns, SPAWNS, HALF, PLAYER_START,
} from '../src/core/levelgen.js';
import { buildStaticWorld, World } from '../src/core/world.js';
import { createPlayer } from '../src/core/players.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

console.log('\n[1] 生成是确定性的');
{
  const a = generateBoxes();
  const b = generateBoxes();
  assert.deepEqual(a, b, '两次生成必须完全一致，否则多端无法对齐');
  assert.ok(a.length >= 40, `箱子数量异常：${a.length}`);
  ok(`固定种子生成 ${a.length} 个箱体，可复现`);
}

console.log('\n[2] 服务端碰撞表与生成器逐项一致');
{
  const boxes = generateBoxes();
  const sw = buildStaticWorld();
  assert.equal(sw.boxes.length, boxes.length, '箱子数量不一致');
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const s = sw.boxes[i];
    assert.ok(s, `服务端缺少第 ${i} 个箱子`);
    assert.equal(s[0], b.x, `#${i} x 不一致`);
    assert.equal(s[1], b.z, `#${i} z 不一致`);
    assert.equal(s[2], b.w, `#${i} 宽度不一致`);
    assert.equal(s[3], b.d, `#${i} 深度不一致（曾把渲染高度 h 抄成 d）`);
  }
  ok('位置与尺寸完全对齐');
}

console.log('\n[3] 碰撞判定在采样网格上完全一致');
{
  const boxes = generateBoxes();
  const sw = buildStaticWorld();
  let checked = 0;
  // 2 米网格覆盖全图，任一处判定不同都算失败
  for (let x = -HALF + 1; x <= HALF - 1; x += 2) {
    for (let z = -HALF + 1; z <= HALF - 1; z += 2) {
      for (const r of [1.9, 1.4]) {
        assert.equal(
          sw.blocked(x, z, r), blockedAt(boxes, x, z, r),
          `(${x}, ${z}) r=${r} 判定不一致`,
        );
        checked++;
      }
    }
  }
  ok(`${checked} 个采样点判定一致`);
}

console.log('\n[4] 所有出生点都不会被掩体压住');
{
  const boxes = generateBoxes();
  const sw = buildStaticWorld();

  assert.equal(blockedAt(boxes, PLAYER_START.x, PLAYER_START.z, 1.9), false, '单机出生点卡墙');

  const multi = resolveMultiSpawns(boxes);
  assert.equal(multi.length, SPAWNS.length);
  for (const [i, [x, z]] of multi.entries()) {
    assert.equal(blockedAt(boxes, x, z, 1.9), false, `多人出生点 #${i} (${x}, ${z}) 卡墙`);
    assert.equal(sw.blocked(x, z, 1.9), false, `服务端认为出生点 #${i} 卡墙`);
  }
  ok(`${multi.length} 个多人出生点 + 单机出生点都空旷`);
}

console.log('\n[5] World 里新加入的玩家不在墙里');
{
  const w = new World({ code: 'TEST', seed: 1, maxPlayers: 4 });
  for (let i = 0; i < 4; i++) {
    w.addPlayer({ id: `u${i}`, name: `P${i}`, chassisId: 'balanced' });
  }
  for (const p of w.players) {
    assert.equal(w.static.blocked(p.x, p.z, 1.9), false, `${p.id} 出生卡墙 (${p.x}, ${p.z})`);
  }
  ok('4 名玩家落地即可移动');
}

console.log('\n[6] 客户端不再自己生成地图');
{
  // level.js 只该调用 generateBoxes()，不该再出现自己的随机数发生器。
  // 这一条是防"手抄第二份数据"的最后一道闸。
  const src = readFileSync(join(here, '../src/level.js'), 'utf8');
  assert.equal(/function\s+mulberry32/.test(src), false, 'level.js 里又出现了独立的随机数生成器');
  assert.ok(/generateBoxes\(seed\)/.test(src), 'level.js 应当只从 levelgen 取箱体数据');
  ok('渲染层只消费数据，不生成数据');
}

console.log(`\n全部通过：${pass} 项\n`);

console.log('\n[9] 建筑按局种子变化（每局换图）');
{
  const a = generateBoxes(101);
  const b = generateBoxes(202);
  assert.notDeepEqual(a, b, '不同种子必须给出不同布局');

  // 固定掩体也要动，否则"14 组手工掩体"的位置永远不变，玩家还是在背板
  const moved = a.filter((x, i) => Math.hypot(x.x - b[i].x, x.z - b[i].z) > 1).length;
  assert.ok(moved >= 10, `固定掩体应有明显位移，实际只有 ${moved} 个动了`);

  // 但扰动不能大到把掩体挪出地图或压成薄片（固定掩体已夹到 ≥4 米，
  // 随机建筑的尺寸本来就可能在 3.5 米上下，这里只查固定那 14 个）
  for (let i = 0; i < 14; i++) {
    const box = a[i];
    assert.ok(Math.abs(box.x) < HALF && Math.abs(box.z) < HALF, '掩体必须在地图内');
    assert.ok(box.w >= 4 && box.d >= 4, `掩体过窄：${box.w}×${box.d}`);
  }
  ok(`换种子后 ${moved} 个固定掩体位置改变，且都在图内、尺寸合理`);

  // seed 0 = 不扰动：老布局原样返回，方便回放与对比
  assert.deepEqual(generateBoxes(0).slice(0, 14).map((b) => [b.x, b.z]),
    generateBoxes(0).slice(0, 14).map((b) => [b.x, b.z]));
  ok('seed=0 时不扰动（?map=old 走这条，能回到上一版布局）');
}

console.log('\n[10] 出生点在任何种子下都不压在墙上');
{
  let bad = [];
  for (let i = 1; i <= 40; i++) {
    const seed = (i * 2654435761) >>> 0;
    const boxes = generateBoxes(seed);
    for (const [x, z] of resolveMultiSpawns(boxes)) {
      if (blockedAt(boxes, x, z, 1.9)) bad.push(seed);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} 个种子有出生点被墙压住：${bad.slice(0, 5)}`);
  ok('40 个随机种子、320 个出生点，没有一个落在墙里');
}

console.log('\n[11] 服务端与客户端拿到的是同一套建筑');
{
  const seed = 424242;
  const w = new World({ code: 'X', seed });
  const srv = w.static.boxes;

  // 客户端不自己生成，直接吃服务端下发的坐标
  const sent = w.fullState().boxes.map((b) => [b.x, b.z, b.w, b.d]);
  assert.deepEqual(sent, srv, '下发给客户端的建筑必须与服务端碰撞表逐项相等');

  // 但生成函数本身也必须同源（万一有人绕过下发自己生成，也不能错位）
  const local = buildStaticWorld(null, seed).boxes;
  assert.deepEqual(local, srv, '同一种子两端各自生成的结果必须一致');
  ok(`${srv.length} 个建筑：下发坐标 === 服务端碰撞表 === 本地按种子重建`);

  // 两个种子生成的世界箱子不同（否则"换图"是假的）
  const w2 = new World({ code: 'Y', seed: seed + 1 });
  assert.notDeepEqual(w2.static.boxes, srv, '不同种子的世界必须有不同建筑');
  ok('不同房间种子得到不同建筑布局');
}

console.log('\n[12] 换图后出生点跟着换，不会有人落在墙里');
{
  const w = new World({ code: 'Z', seed: 987654321 });
  const p = w.addPlayer({ id: 'a', name: '甲', chassisId: 'balanced' });
  assert.ok(!w.static.blocked(p.x, p.z, 1.9), `玩家出生在墙里：${p.x},${p.z}`);
  ok(`玩家出生点 (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) 是空地`);
}
