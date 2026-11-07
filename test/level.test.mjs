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
  assert.ok(/generateBoxes\(\)/.test(src), 'level.js 应当只从 levelgen 取箱体数据');
  ok('渲染层只消费数据，不生成数据');
}

console.log(`\n全部通过：${pass} 项\n`);
