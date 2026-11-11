// 快照节奏回归测试：相邻快照的 tick 差必须恒定
//
// 为什么值得单独钉一个测试：这个数字（TICKS_PER_SNAP）看起来无关紧要，
// 但它决定了客户端插值段长是否恒定。20Hz 配 30tick 会出现 1/2 锯齿，
// 画面轻微抖动，而这个问题在日志、单测、单人模式里全都看不出来，
// 只有四个人联机、盯着队友坦克看的时候才暴露。钉死它，别再退回去。

import assert from 'node:assert/strict';
import { Room } from '../server/room.js';
import { TICK_RATE, SNAPSHOT_RATE } from '../src/core/protocol.js';

let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

// [1] 整除关系：快照率必须能整除 tick 率
assert.equal(TICK_RATE % SNAPSHOT_RATE, 0,
  `SNAPSHOT_RATE(${SNAPSHOT_RATE}) 必须整除 TICK_RATE(${TICK_RATE})，否则 tick 差会锯齿`);
ok(`${TICK_RATE}Hz tick / ${SNAPSHOT_RATE}Hz 快照 = 整数 ${TICK_RATE / SNAPSHOT_RATE}，段长可恒定`);

// [2] 真实走一遍模拟，统计快照 tick 差
const TICKS_PER_SNAP = TICK_RATE / SNAPSHOT_RATE;
const room = new Room({ code: 'TEST' });
const snaps = [];
room._broadcastSnapshot = function spy() {
  snaps.push(this.world.tick);
};

// 造一个最小 world：直接用 mock 成员，避免依赖完整的玩家生命周期
room.world = { tick: 0 };
room.members = new Map([['x', { id: 'x' }]]);

for (let i = 0; i < 300; i++) {
  room.world.tick = i;
  room._maybeSnapshotAt(i * (1000 / TICK_RATE));
}

assert.ok(snaps.length > 50, `应收到足够多的快照样本，实际 ${snaps.length}`);
const gaps = [];
for (let i = 1; i < snaps.length; i++) gaps.push(snaps[i] - snaps[i - 1]);
const uniq = [...new Set(gaps)];
assert.deepEqual(uniq, [TICKS_PER_SNAP],
  `相邻快照 tick 差必须恒为 ${TICKS_PER_SNAP}，实际出现了 ${JSON.stringify(uniq)}（锯齿会让画面轻微抖）`);
ok(`300 个 tick 内 ${snaps.length} 帧快照，tick 差全部恒为 ${TICKS_PER_SNAP}`);

// [3] 实际发帧率对得上
const spanTicks = snaps[snaps.length - 1] - snaps[0];
const hz = ((snaps.length - 1) / spanTicks) * TICK_RATE;
assert.ok(Math.abs(hz - SNAPSHOT_RATE) < 0.5,
  `发帧率应≈${SNAPSHOT_RATE}Hz，实测 ${hz.toFixed(2)}Hz`);
ok(`实际发帧率 ${hz.toFixed(2)}Hz ≈ 配置的 ${SNAPSHOT_RATE}Hz`);

console.log(`\n快照节奏测试全部通过（${pass} 项）`);
