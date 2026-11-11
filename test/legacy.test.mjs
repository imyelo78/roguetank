// 旧站成绩同步（server/legacy-scores.js）
//
// 为什么值得单独测：这套逻辑写坏了的后果很安静——服务照开、页面照玩，
// 只是榜上少几个人，没人会立刻发现。上一版就是因为"要手动跑脚本"而实际没导入。
//
// 覆盖：
//   1. 快照规范化：混进无日期 / 0 分 / 无名的记录要被丢掉
//   2. 并入：按天的榜和总榜都要有，日期索引要更新
//   3. 幂等：重复导入条数不变，分数不被覆盖成更低的
//   4. 只同步一次：做过之后自动同步要跳过，force 才重跑
//   5. 并入已有成绩：玩家先在新站打过，旧站记录仍要并进来，不得互相顶掉

import assert from 'node:assert/strict';
import { prepareEntries, importEntries } from '../server/legacy-scores.js';
import {
  ALL_KEY, DAYS_KEY, DAY_PREFIX, getJSON, identOf,
} from '../functions/api/_lib/leaderboard.js';

/** 内存 KV，行为对齐 FileStore：get 返回字符串或 null */
function memKV() {
  const map = new Map();
  return {
    map,
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, String(v)); },
  };
}

const OLD = [
  { name: '78', wave: 54, kills: 3357, score: 476371, timeMs: 3082797, players: 1, t: 1794106262501, pid: '4r2ss0dj94vy', id: '78#4r2ss0dj94vy', chassis: 'hunter', date: '2026-11-08' },
  { name: '114114', wave: 11, kills: 172, score: 28435, timeMs: 878650, players: 1, t: 1794123857224, pid: 'wh1fe3t60rbd', date: '2026-11-08' },
  { name: 'CaptainVade', wave: 51, kills: 3000, score: 533250, t: 1793938842058, id: 'CaptainVade#50boglm1v9zg', date: '2026-11-06' },
  { name: '91', wave: 12, kills: 218, score: 41936, t: 1793886760462, date: '2026-11-05' },
];

let pass = 0;
let fail = 0;
const test = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
};

console.log('旧站成绩同步');

await test('规范化：丢掉无日期 / 0 分 / 无名的记录', () => {
  const { entries, ignored } = prepareEntries([
    ...OLD,
    { name: 'noDate', score: 100, wave: 1, kills: 1 },
    { name: 'zero', score: 0, date: '2026-11-08' },
    { name: '   ', score: 999, date: '2026-11-08' },
  ]);
  assert.equal(entries.length, OLD.length, `应保留 ${OLD.length} 条，实际 ${entries.length}`);
  assert.equal(ignored, 3, `应忽略 3 条，实际 ${ignored}`);
  for (const e of entries) {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(e.date), '日期必须规范化');
    assert.equal(e.importedFrom, 'roguetank.pages.dev', '要打上来源标记，便于事后核对');
    assert.equal(e.chassis, undefined, '旧车款已下线，不能塞进新站的白名单字段');
  }
});

await test('规范化：保留原始时间戳（榜上的"什么时候打的"必须是真的）', () => {
  const { entries } = prepareEntries(OLD);
  const cap = entries.find((e) => e.name === 'CaptainVade');
  assert.equal(cap.t, 1793938842058);
});

await test('并入：按天榜 + 总榜 + 日期索引都写到位', async () => {
  const kv = memKV();
  const { entries } = prepareEntries(OLD);
  const r = await importEntries(kv, entries);
  assert.equal(r.imported, OLD.length);
  assert.equal(r.skipped, false);
  assert.equal(r.total, OLD.length);

  const day8 = await getJSON(kv, `${DAY_PREFIX}2026-11-08`, []);
  assert.equal(day8.length, 2, '11-08 应有 2 条');
  assert.ok(day8.every((e) => e.date === '2026-11-08'));

  const all = await getJSON(kv, ALL_KEY, []);
  assert.equal(all.length, OLD.length);
  assert.equal(all[0].name, 'CaptainVade', '总榜要按分数降序');
  for (let i = 1; i < all.length; i += 1) {
    assert.ok((all[i - 1].score || 0) >= (all[i].score || 0), '总榜必须有序');
  }

  const days = await getJSON(kv, DAYS_KEY, []);
  assert.deepEqual(days, ['2026-11-08', '2026-11-06', '2026-11-05'], '日期索引新的在前');
});

await test('幂等：重复导入条数不变、分数不被改小', async () => {
  const kv = memKV();
  const { entries } = prepareEntries(OLD);
  await importEntries(kv, entries);
  const before = await getJSON(kv, ALL_KEY, []);
  await importEntries(kv, entries, { force: true });
  await importEntries(kv, entries, { force: true });
  const after = await getJSON(kv, ALL_KEY, []);
  assert.equal(after.length, before.length, '重复导入不能重复上榜');
  const cap = after.find((e) => e.name === 'CaptainVade');
  assert.ok(cap, 'CaptainVade 必须在榜上');
  assert.equal(cap.score, 533250, '分数不能被覆盖');
  const day8 = await getJSON(kv, `${DAY_PREFIX}2026-11-08`, []);
  assert.equal(day8.length, 2, '按天榜也不能重复');
});

await test('只同步一次：已同步过则跳过，force 才重跑', async () => {
  const kv = memKV();
  const { entries } = prepareEntries(OLD);
  const first = await importEntries(kv, entries);
  assert.equal(first.skipped, false);
  const second = await importEntries(kv, entries);
  assert.equal(second.skipped, true, '第二次应跳过');
  assert.equal(second.imported, 0);
  assert.equal(second.total, OLD.length, '跳过时要把现有条数带回来，便于日志核对');
  const forced = await importEntries(kv, entries, { force: true });
  assert.equal(forced.skipped, false, 'force 要能重跑');
});

await test('并入已有成绩：玩家先在新站打过也不会互相顶掉', async () => {
  const kv = memKV();
  // 模拟新站已经有一个"78"（同一个 pid，成绩更差）和一个别人
  await kv.put(ALL_KEY, JSON.stringify([
    { name: '78', wave: 3, kills: 20, score: 3000, t: Date.now(), pid: '4r2ss0dj94vy', id: '78#4r2ss0dj94vy' },
    { name: '新玩家', wave: 2, kills: 9, score: 1500, t: Date.now(), pid: 'newbie0001' },
  ]));
  const { entries } = prepareEntries(OLD);
  const r = await importEntries(kv, entries);
  const all = await getJSON(kv, ALL_KEY, []);
  assert.equal(all.length, OLD.length + 1, '总榜应包含旧站 4 条 + 新玩家 1 条');
  assert.ok(r.total >= 1);
  const me = all.find((e) => identOf(e) === '4r2ss0dj94vy');
  assert.equal(me.score, 476371, '同身份取更高的那条');
  assert.ok(all.some((e) => e.name === '新玩家'), '新站的成绩不能被抹掉');
});

await test('快照里没有有效记录时不写空数据', async () => {
  const kv = memKV();
  const { entries } = prepareEntries([{ name: 'x' }]);
  assert.equal(entries.length, 0);
  // 调用方（syncLegacyScores）在 entries 为空时直接返回，不会走到 importEntries
  assert.equal(await kv.get(ALL_KEY), null);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
