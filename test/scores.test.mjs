// 无头验证：排行榜服务端逻辑（不需要部署、不需要 KV）
// 运行：node test/scores.test.mjs

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


const { mergeEntry, normalizeEntry, todayKey } = __test;

class MockKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, String(v)); }
}

const env = () => ({ DAILY_SCORES: new MockKV() });
const req = (body) => ({ url: 'https://x/api/scores', json: async () => body });
const get = (qs) => ({ url: `https://x/api/scores?${qs}` });

let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

const base = (over = {}) => ({
  date: todayKey(), name: '铁骑01', pid: 'abc123', wave: 5, kills: 40, score: 1000,
  chassis: 'balanced', weapon: 'assault', players: 1, timeMs: 120000, ...over,
});

console.log('\n[1] 字段规范化');
{
  const e = normalizeEntry(base({ wave: -3, kills: 1e9, score: 1e12, chassis: 'hacker', timeMs: -5 }));
  assert.equal(e.wave, 0);
  assert.equal(e.kills, 99999);
  assert.equal(e.score, 99999999);
  assert.equal(e.timeMs, 0);
  assert.equal(e.chassis, undefined, '非法车体必须丢弃');
  assert.equal(normalizeEntry(base({ name: '   ' })), null);
  assert.equal(normalizeEntry(base({ mods: 'nope' })).mods, undefined);
  ok('越界钳制、非法车体/词条被丢弃、空呼号拒收');
}

console.log('\n[2] 人数标记');
{
  assert.equal(normalizeEntry(base({ players: 3 })).players, 3);
  assert.equal(normalizeEntry(base({ players: 0 })).players, 1);
  assert.equal(normalizeEntry(base({ players: 99 })).players, 4);
  assert.equal(normalizeEntry(base({ players: undefined })).players, 1);
  ok('单人/多人标记落在 1~4');
}

console.log('\n[3] 同身份去重（含改名）');
{
  const kv = env();
  await onRequestPost({ env: kv, request: req(base({ score: 500 })) });
  await onRequestPost({ env: kv, request: req(base({ name: '铁骑改名', score: 800 })) });
  const r = await (await onRequestGet({ env: kv, request: get(`date=${todayKey()}`) })).json();
  assert.equal(r.list.length, 1, '同一 pid 改名后不应出现两条');
  assert.equal(r.list[0].score, 800);
  assert.equal(r.list[0].name, '铁骑改名');
  ok('按 pid 去重，改名不重复上榜，高分覆盖低分');
}

console.log('\n[4] 低分不覆盖高分');
{
  const kv = env();
  await onRequestPost({ env: kv, request: req(base({ score: 900, wave: 9 })) });
  await onRequestPost({ env: kv, request: req(base({ score: 300, wave: 3 })) });
  const r = await (await onRequestGet({ env: kv, request: get(`date=${todayKey()}`) })).json();
  assert.equal(r.list[0].score, 900);
  assert.equal(r.list[0].wave, 9);
  ok('刷分失败：只保留个人最好成绩');
}

console.log('\n[5] 单人与多人进同一个榜');
{
  const kv = env();
  await onRequestPost({ env: kv, request: req(base({ pid: 'solo', name: '独狼', score: 500, players: 1 })) });
  await onRequestPost({ env: kv, request: req(base({ pid: 'team', name: '四排', score: 1500, players: 4 })) });
  const r = await (await onRequestGet({ env: kv, request: get(`date=${todayKey()}`) })).json();
  assert.equal(r.list.length, 2, '不再按模式分榜，两种都进同一榜');
  assert.equal(r.list[0].name, '四排');
  assert.equal(r.list[0].players, 4);
  assert.equal(r.list[1].players, 1);
  ok('所有战斗计入同一条榜，条目带人数标记');
}

console.log('\n[6] 今日榜与总榜');
{
  const kv = env();
  await onRequestPost({ env: kv, request: req(base({ score: 777 })) });
  const day = await (await onRequestGet({ env: kv, request: get(`date=${todayKey()}`) })).json();
  const all = await (await onRequestGet({ env: kv, request: get('view=all') })).json();
  assert.equal(day.list.length, 1);
  assert.equal(all.all.length, 1);
  assert.equal(all.all[0].score, 777);
  ok('今日 + 总榜两个视图');
}

console.log('\n[7] 排序：分数 > 波次 > 先到');
{
  let list = [];
  list = mergeEntry(list, { name: 'A', pid: 'a', score: 100, wave: 5, t: 2 });
  list = mergeEntry(list, { name: 'B', pid: 'b', score: 200, wave: 1, t: 9 });
  list = mergeEntry(list, { name: 'C', pid: 'c', score: 100, wave: 9, t: 5 });
  list = mergeEntry(list, { name: 'D', pid: 'd', score: 100, wave: 5, t: 1 });
  assert.deepEqual(list.map((e) => e.name), ['B', 'C', 'D', 'A']);
  ok('同分先比波次，再比达成时间');
}

console.log('\n[8] 非法入参');
{
  const kv = env();
  const stale = await onRequestPost({ env: kv, request: req(base({ date: '2020-01-01' })) });
  assert.equal(stale.status, 400);

  const noKv = await onRequestPost({ env: {}, request: req(base()) });
  assert.equal((await noKv.json()).reason, 'kv-unbound');
  ok('伪造历史日期、未绑定 KV 都被正确拒绝');
}

console.log('\n[9] 榜单容量上限 100');
{
  let list = [];
  for (let i = 0; i < 130; i++) {
    list = mergeEntry(list, { name: `P${i}`, pid: `p${i}`, score: i, wave: 1, t: i });
  }
  assert.equal(list.length, 100);
  assert.equal(list[0].score, 129);
  ok('超出 100 条自动截断，保留最高分');
}

console.log(`\n全部通过：${pass} 项\n`);
