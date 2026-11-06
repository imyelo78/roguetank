// 无头验证：随机流隔离与可重放
// 运行：node test/rng.test.mjs
//
// 这是联机与服务端模拟的地基：同名流必须互不干扰、同种子必须能重放，
// 否则改一个数值就可能悄悄破坏可复现性，而界面上完全看不出来。

import assert from 'node:assert/strict';
import { Rng, mulberry32 } from '../src/rng.js';

let pass = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };

console.log('\n[1] mulberry32 确定性');
{
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const seqA = Array.from({ length: 50 }, a);
  const seqB = Array.from({ length: 50 }, b);
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
  ok('同种子序列完全一致，取值落在 [0,1)');
}

console.log('\n[2] 流隔离：combat 被疯狂调用，spawn 序列不受影响');
{
  const seed = 0xC0FFEE;
  const a = new Rng(seed);
  const b = new Rng(seed);

  // a 只取 spawn；b 每次取 spawn 前先打 100 发“子弹”
  const seqA = [];
  const seqB = [];
  for (let i = 0; i < 40; i++) {
    seqA.push(a.spawn());
    for (let k = 0; k < 100; k++) b.combat();
    seqB.push(b.spawn());
  }
  assert.deepEqual(seqA, seqB);
  ok('玩家行为（弹道/抖动）不再带偏刷怪序列');
}

console.log('\n[3] 流隔离：fx 与 spawn 互不干扰');
{
  const a = new Rng(7);
  const b = new Rng(7);
  const s1 = [];
  const s2 = [];
  for (let i = 0; i < 30; i++) {
    s1.push(a.spawn());
    for (let k = 0; k < 37; k++) b.fx();
    s2.push(b.spawn());
  }
  assert.deepEqual(s1, s2);
  ok('相机抖动等表现层随机不影响对局结构');
}

console.log('\n[4] 不同种子必须产生不同序列');
{
  const a = new Rng(1);
  const b = new Rng(2);
  const sa = Array.from({ length: 20 }, () => a.spawn());
  const sb = Array.from({ length: 20 }, () => b.spawn());
  assert.notDeepEqual(sa, sb);
  ok('换种子即换局');
}

console.log('\n[5] setSeed 后缓存必须失效');
{
  const r = new Rng(1);
  const before = Array.from({ length: 5 }, () => r.spawn());
  r.setSeed(1);
  const after = Array.from({ length: 5 }, () => r.spawn());
  assert.deepEqual(before, after);
  ok('重置种子可原地重放同一局');
}

console.log(`\n全部通过：${pass} 项\n`);
