// 0 分不入榜
//
// 线上真实出现过：总榜末尾一条 `gunner / 0 分 / 第 1 波 / 0 杀`。
// 来源是"点了开始立刻被撞毁"——这一局确实发生过，但它不是成绩，
// 既占名额，又让榜尾看起来"0 分也能上榜"。
//
// 三层都要拦，少一层就漏：
//   1. 提交（POST）      —— 别把脏数据写进存储
//   2. 读取（GET）        —— 存储里已有的脏数据不该显示
//   3. 存量清洗（启动）    —— 把历史脏数据真正删掉
//
// 另外前端本地榜也要清：老版本会把 0 分写进 localStorage，不清就会一直
// 和远端合并、一直在页面上显示。

import assert from 'node:assert/strict';
import { handleGet, handlePost, __test } from '../functions/api/_lib/leaderboard.js';

// 旧站（Cloudflare Pages）已下线，functions/api/scores.js 壳已删除。
// 测试直接驱动 leaderboard.js 本体，这里补一个行为等价的薄壳：
// 同样处理"未绑定 KV → kv-unbound"，响应带 status 和 json()。
const json = (data, status = 200) => ({ status, json: async () => data });
const kvOf = (env) => (env && env.DAILY_SCORES) || null;
const onRequestGet = ({ env, request }) => {
  const kv = kvOf(env);
  if (!kv) return Promise.resolve(json({ ok: false, reason: 'kv-unbound' }));
  return handleGet(kv, new URL(request.url)).then((r) => json(r.body, r.status));
};
const onRequestPost = ({ env, request }) => {
  const kv = kvOf(env);
  if (!kv) return Promise.resolve(json({ ok: false, reason: 'kv-unbound' }));
  return request.json()
    .then((body) => handlePost(kv, body))
    .then((r) => json(r.body, r.status));
};

import { pruneInvalidScores } from '../server/score-cleanup.js';
import {
  ALL_KEY, DAYS_KEY, DAY_PREFIX, todayKey, getJSON, putJSON, liveEntries, isValidEntry,
} from '../functions/api/_lib/leaderboard.js';

const { mergeEntry } = __test;

class MockKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, String(v)); }
}

const env = () => ({ DAILY_SCORES: new MockKV() });
const req = (body) => ({ url: 'https://x/api/scores', json: async () => body });
const get = (qs) => ({ url: `https://x/api/scores?${qs}` });

const base = (over = {}) => ({
  date: todayKey(), name: '铁骑01', pid: 'abc123', wave: 1, kills: 0, score: 0,
  chassis: 'balanced', weapon: 'assault', players: 1, timeMs: 3000, ...over,
});

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

console.log('0 分不入榜');

await test('规则本身：0 分、负分、缺分都不算数', () => {
  assert.equal(isValidEntry({ score: 0 }), false);
  assert.equal(isValidEntry({ score: -5 }), false);
  assert.equal(isValidEntry({ score: 1 }), true, '1 分是真实残局，不能误杀');
  assert.equal(isValidEntry(null), false);
  assert.deepEqual(liveEntries([{ score: 0 }, { score: 3 }]).map((e) => e.score), [3]);
  assert.deepEqual(liveEntries(undefined), [], '非法输入回空数组，别把 undefined 传下去');
});

await test('提交：0 分被拒，reason 是 no-score（不是 no-name）', async () => {
  const e = env();
  const r = await onRequestPost({ env: e, request: req(base({ score: 0 })) });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.reason, 'no-score', `实际 reason=${body.reason}`);
  assert.equal(body.ok, false);

  // 存储里不该有任何东西
  assert.equal(await e.DAILY_SCORES.get(ALL_KEY), null);
  assert.equal(await e.DAILY_SCORES.get(`${DAY_PREFIX}${todayKey()}`), null);
});

await test('提交：1 分正常上榜（门槛不能抬高）', async () => {
  const e = env();
  const r = await onRequestPost({ env: e, request: req(base({ score: 1, wave: 1, kills: 0 })) });
  assert.equal(r.status, 200);
  const day = await (await onRequestGet({ env: e, request: get(`date=${todayKey()}`) })).json();
  assert.equal(day.list.length, 1);
  assert.equal(day.list[0].score, 1);
});

await test('读取：存储里已有的 0 分不显示（老数据兜底）', async () => {
  const e = env();
  // 模拟"升级前就已经写进去"的脏数据：绕过 handlePost 直接写存储
  await putJSON(e.DAILY_SCORES, ALL_KEY, [
    { name: 'gunner', score: 0, wave: 1, kills: 0, t: 1, pid: 'p0' },
    { name: '真玩家', score: 500, wave: 5, kills: 30, t: 2, pid: 'p1' },
  ]);
  await putJSON(e.DAILY_SCORES, `${DAY_PREFIX}${todayKey()}`, [
    { name: 'gunner', score: 0, wave: 1, kills: 0, t: 1, pid: 'p0' },
    { name: '真玩家', score: 500, wave: 5, kills: 30, t: 2, pid: 'p1' },
  ]);

  const all = await (await onRequestGet({ env: e, request: get('view=all') })).json();
  assert.equal(all.all.length, 1, `总榜应只剩 1 条，实际 ${all.all.length}`);
  assert.equal(all.all[0].name, '真玩家');

  const day = await (await onRequestGet({ env: e, request: get(`date=${todayKey()}`) })).json();
  assert.equal(day.list.length, 1, `今日榜应只剩 1 条，实际 ${day.list.length}`);

  const stats = await (await onRequestGet({ env: e, request: get('view=stats') })).json();
  assert.equal(stats.all.count, 1, 'stats 的条数也要按过滤后算');
  assert.equal(stats.day.count, 1);
});

await test('清洗：历史 0 分被真正从存储里删掉', async () => {
  const e = env();
  const kv = e.DAILY_SCORES;
  const d0 = '2026-11-05';
  const d1 = '2026-11-06';
  await putJSON(kv, ALL_KEY, [
    { name: 'gunner', score: 0, wave: 1, kills: 0, t: 1, pid: 'p0' },
    { name: '91', score: 41936, wave: 12, kills: 218, t: 2, pid: 'p2' },
    { name: 'selftest', score: 1, wave: 1, kills: 0, t: 3, pid: 'p3' },
  ]);
  await putJSON(kv, DAYS_KEY, [d1, d0]);
  await putJSON(kv, `${DAY_PREFIX}${d0}`, [
    { name: 'gunner', score: 0, wave: 1, kills: 0, t: 1, pid: 'p0' },
    { name: '91', score: 41936, wave: 12, kills: 218, t: 2, pid: 'p2' },
  ]);
  await putJSON(kv, `${DAY_PREFIX}${d1}`, [
    { name: 'selftest', score: 1, wave: 1, kills: 0, t: 3, pid: 'p3' },
  ]);

  const r = await pruneInvalidScores(kv, { log: () => {} });
  assert.equal(r.removed, 2, `应删 2 条（总榜 1 + 当日 1），实际 ${r.removed}`);
  assert.equal(r.total, 2, '总榜剩 2 条（91 与 selftest）');

  const all = await getJSON(kv, ALL_KEY, []);
  assert.equal(all.length, 2);
  assert.ok(!all.some((x) => x.score === 0), '0 分必须消失');
  assert.ok(all.some((x) => x.name === 'selftest'), '1 分要留着');

  const day0 = await getJSON(kv, `${DAY_PREFIX}${d0}`, []);
  assert.equal(day0.length, 1);
  assert.equal(day0[0].name, '91');

  const day1 = await getJSON(kv, `${DAY_PREFIX}${d1}`, []);
  assert.equal(day1.length, 1, '没有脏数据的日期不能被清空');
  assert.equal(day1[0].name, 'selftest');
});

await test('清洗：幂等，第二次什么都不删', async () => {
  const e = env();
  const kv = e.DAILY_SCORES;
  await putJSON(kv, ALL_KEY, [
    { name: 'a', score: 0, wave: 1, kills: 0, t: 1, pid: 'p0' },
    { name: 'b', score: 9, wave: 2, kills: 3, t: 2, pid: 'p1' },
  ]);
  await putJSON(kv, DAYS_KEY, []);
  const first = await pruneInvalidScores(kv, { log: () => {} });
  const second = await pruneInvalidScores(kv, { log: () => {} });
  assert.equal(first.removed, 1);
  assert.equal(second.removed, 0, '第二次不该再有可删的');
  assert.equal(second.total, 1);
});

await test('清洗：空存储不报错', async () => {
  const kv = new MockKV();
  const r = await pruneInvalidScores(kv, { log: () => {} });
  assert.equal(r.removed, 0);
  assert.equal(r.total, 0);
});

await test('合并语义没被污染：mergeEntry 不管 0 分', () => {
  // mergeEntry 是纯合并函数，测试/内部会拿 0 分当序号用（score: i），
  // 过滤只该发生在入口和读取处。这条断言防的是"顺手把过滤加进 mergeEntry"。
  const list = mergeEntry([], { name: 'zero', pid: 'z', score: 0, wave: 1, t: 1 });
  assert.equal(list.length, 1);
  assert.equal(list[0].score, 0);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
