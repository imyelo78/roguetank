// 画质档位：纯数据 + 纯函数，离线可测。
// 最值得钉的是降档阶梯（high → mid → low → 停）和触屏检测——
// 检测错了手机会拿桌面档跑到发烫，或者桌面拿手机档糊成马赛克。

import assert from 'node:assert/strict';
import { TIERS, FOG_BASE, detectTier, createQuality } from '../src/core/quality.js';

let pass = 0;
const ok = (name) => { pass++; console.log(`  · ${name}`); };

console.log('\n[1] 档位表自洽');

// 越降越省：像素比、粒子、雾距都单调不增；阴影只关不开
for (const [a, b] of [['high', 'mid'], ['mid', 'low']]) {
  assert.ok(TIERS[a].pixelRatio >= TIERS[b].pixelRatio, `${a}.pixelRatio ≥ ${b}.pixelRatio`);
  assert.ok(TIERS[a].particles >= TIERS[b].particles, `${a}.particles ≥ ${b}.particles`);
  assert.ok(TIERS[a].fogMul >= TIERS[b].fogMul, `${a}.fogMul ≥ ${b}.fogMul（雾距更近）`);
  if (TIERS[a].shadows) assert.ok(TIERS[a].pixelRatio > TIERS[b].pixelRatio || !TIERS[b].shadows);
}
assert.equal(TIERS.low.shadows, false, '低配必须关阴影');
ok('三档单调递减，low 关阴影');

console.log('\n[2] 环境检测');

// Node 里没有 matchMedia / navigator.maxTouchPoints → 当桌面高配
assert.equal(detectTier(), 'high', '无触屏迹象时默认 high');
// 有触屏迹象 → low 起步（宁可先低后调，首帧卡顿比画质糊更劝退）
globalThis.matchMedia = (q) => ({ matches: q === '(pointer: coarse)' });
// Node 22 的 navigator 是只读 getter，只能 defineProperty 覆盖
const setNav = (v) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true });
setNav({ maxTouchPoints: 0 });
assert.equal(detectTier(), 'low', 'coarse 指针应是触屏 → low');
globalThis.matchMedia = () => ({ matches: false });
setNav({ maxTouchPoints: 5 });
assert.equal(detectTier(), 'low', 'maxTouchPoints > 0 也算触屏 → low');
ok('无迹象 → high；coarse / maxTouchPoints → low');

console.log('\n[3] 自动降档阶梯');

const q = createQuality('high');
assert.equal(q.tier, 'high');
assert.equal(q.pixelRatio, 2);
assert.equal(q.stepDown(), 'mid', 'high 降到 mid');
assert.equal(q.pixelRatio, 1.5, '字段要跟着换');
assert.equal(q.shadows, false, 'mid 起关阴影');
assert.equal(q.stepDown(), 'low', 'mid 降到 low');
assert.equal(q.pixelRatio, 1);
assert.equal(q.stepDown(), null, 'low 已是最低，不能再降');
assert.equal(q.stepDown(), null, '重复调用也返回 null');
ok('high → mid → low → null，字段随档位更新');

console.log('\n[4] 雾基准');

assert.ok(FOG_BASE.far > FOG_BASE.near, '雾的 far 必须大于 near');
assert.ok(FOG_BASE.far * TIERS.low.fogMul < FOG_BASE.far, '低配档雾距要收紧');
ok('基准距离合理，低配乘系数后收紧');

console.log(`\n画质档位 ${pass} 项通过\n`);
