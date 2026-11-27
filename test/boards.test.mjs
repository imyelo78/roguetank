// 三榜分立（r59）：solo / coop / campaign 路由、战役校验、排序与去重
// 运行：node test/boards.test.mjs

import assert from 'node:assert/strict';
import {
  handleGet, handlePost, todayKey,
  SOLO_TOP_KEY, SOLO_DAY_PREFIX, COOP_TOP_KEY, COOP_DAY_PREFIX,
  CAMPAIGN_TOP_KEY, ALL_KEY,
  getJSON, putJSON,
} from '../functions/api/_lib/leaderboard.js';

class MockKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, String(v)); }
}

const env = () => ({ DAILY_SCORES: new MockKV() });
const kv = (e) => e.DAILY_SCORES;
const get = (qs) => new URL(`https://x/api/scores?${qs}`);

let pass = 0;
const ok = (msg) => { pass++; console.log(`  ✓ ${msg}`); };

// ---------------- POST 路由 ----------------

{
  const e = env();
  // 缺省 mode = solo：旧客户端无感续用，但写的是 solo: 键，不再碰旧 all:top
  const r = await handlePost(kv(e), { name: '铁骑', pid: 'p1', wave: 8, kills: 60, score: 9000, players: 1 });
  assert.equal(r.status, 200);
  assert.equal((await getJSON(kv(e), SOLO_TOP_KEY, [])).length, 1, '缺省应写 solo:top');
  assert.equal((await getJSON(kv(e), `${SOLO_DAY_PREFIX}${todayKey()}`, [])).length, 1, '缺省应写 solo 今日榜');
  assert.equal((await getJSON(kv(e), ALL_KEY, [])).length, 0, '旧 all:top 是只读存档，不得写入');
  ok('缺省 mode 落单人榜，旧存档键不再写入');

  // coop：players<2 拒收；players≥2 写 coop: 键
  const bad = await handlePost(kv(e), { mode: 'coop', name: '独狼', pid: 'p2', wave: 3, kills: 10, score: 500, players: 1 });
  assert.equal(bad.body.reason, 'bad-players', '单人成绩不许混进组队榜');
  const good = await handlePost(kv(e), { mode: 'coop', name: '车队', pid: 'p3', wave: 5, kills: 30, score: 4000, players: 2 });
  assert.equal(good.status, 200);
  assert.equal((await getJSON(kv(e), COOP_TOP_KEY, [])).length, 1, '组队成绩写 coop:top');
  assert.equal((await getJSON(kv(e), SOLO_TOP_KEY, [])).length, 1, '组队成绩不进单人榜');
  ok('组队榜只收 players≥2，与单人榜互不污染');
}

// ---------------- 战役：校验 ----------------

{
  const e = env();
  const camp = (over = {}) => ({
    mode: 'campaign', name: '魏特曼', pid: 'pW',
    difficulty: 'normal', win: 0, kills: 10, timeMs: 120000, ...over,
  });
  // 合法：上榜
  const okR = await handlePost(kv(e), camp());
  assert.equal(okR.status, 200);
  assert.equal((await getJSON(kv(e), CAMPAIGN_TOP_KEY, [])).length, 1);
  // 非法：难度白名单 / 击毁上限 / 用时上限 / 零击毁未通关
  for (const [over, reason] of [
    [{ difficulty: 'hellish' }, 'bad-diff'],
    [{ kills: 99 }, 'bad-kills'],
    [{ timeMs: 20 * 60 * 1000 }, 'bad-time'],
    [{ win: 0, kills: 0 }, 'no-kills'],
  ]) {
    const r = await handlePost(kv(e), camp(over));
    assert.equal(r.status, 400, `${reason} 应 400`);
    assert.equal(r.body.reason, reason, `拒绝原因应为 ${reason}`);
  }
  ok('战役校验：难度四档 / 击毁≤36 / 用时≤15min / 零战果拦截');
}

// ---------------- 战役：排序（通关>难度>击毁>用时）----------------

{
  const e = env();
  const rows = [
    { name: 'A', pid: 'a', difficulty: 'wittmann', win: 0, kills: 30, timeMs: 600000, t: 1 }, // 魏神未通关
    { name: 'B', pid: 'b', difficulty: 'novice', win: 1, kills: 22, timeMs: 500000, t: 2 },   // 新手通关
    { name: 'C', pid: 'c', difficulty: 'normal', win: 1, kills: 36, timeMs: 400000, t: 3 },   // 普通通关 36
    { name: 'D', pid: 'd', difficulty: 'normal', win: 1, kills: 36, timeMs: 350000, t: 4 },   // 同击毁更快
    { name: 'E', pid: 'e', difficulty: 'ruthless', win: 0, kills: 30, timeMs: 700000, t: 5 }, // 冷血未通关
  ];
  for (const r of rows) await handlePost(kv(e), { mode: 'campaign', ...r });
  const list = (await handleGet(kv(e), get('mode=campaign'))).body.list;
  assert.deepEqual(list.map((x) => x.name), ['D', 'C', 'B', 'A', 'E'],
    '通关>难度>击毁>用时：D(普通36/更快)>C(普通36)>B(新手通关)>A(魏神未通关30毁)>E(冷血未通关30毁)');
  ok('战役排序：D>C>B>E>A（通关优先，同分比难度，同难度比击毁，同击毁通关比快/未通关比久）');

  // 未通关同击毁：撑得久的排前面
  const e2 = env();
  await handlePost(kv(e2), { mode: 'campaign', name: '短命', pid: 'x', difficulty: 'normal', win: 0, kills: 15, timeMs: 60000, t: 1 });
  await handlePost(kv(e2), { mode: 'campaign', name: '坚守', pid: 'y', difficulty: 'normal', win: 0, kills: 15, timeMs: 600000, t: 2 });
  const l2 = (await handleGet(kv(e2), get('mode=campaign'))).body.list;
  assert.equal(l2[0].name, '坚守', '同击毁数未通关，撑得久者在 前');
  ok('未通关同击毁：存活更久者在前');

  // 去重：同 pid 保留更好的一条。通关是第一优先级：新手通关 > 魏神未通关
  const e3 = env();
  await handlePost(kv(e3), { mode: 'campaign', name: '某人', pid: 'z', difficulty: 'novice', win: 1, kills: 22, timeMs: 100000, t: 1 });
  await handlePost(kv(e3), { mode: 'campaign', name: '某人', pid: 'z', difficulty: 'wittmann', win: 0, kills: 30, timeMs: 900000, t: 2 });
  const l3 = (await handleGet(kv(e3), get('mode=campaign'))).body.list;
  assert.equal(l3.length, 1, '同 pid 只留一条');
  assert.equal(l3[0].difficulty, 'novice', '新手通关 > 魏神未通关（通关第一优先）');
  ok('战役去重：同 pid 保留排得最前的一条');

  // 但难度优势在同为通关/同为未通关时生效：魏神通关 > 普通通关
  const e4 = env();
  await handlePost(kv(e4), { mode: 'campaign', name: '再来', pid: 'z', difficulty: 'normal', win: 1, kills: 22, timeMs: 100000, t: 1 });
  await handlePost(kv(e4), { mode: 'campaign', name: '再来', pid: 'z', difficulty: 'wittmann', win: 1, kills: 22, timeMs: 900000, t: 2 });
  const l4 = (await handleGet(kv(e4), get('mode=campaign'))).body.list;
  assert.equal(l4[0].difficulty, 'wittmann', '同为通关，魏神在前');
  ok('战役去重：同为通关时高难度在前');
}

// ---------------- GET 路由 ----------------

{
  const e = env();
  await handlePost(kv(e), { name: '单', pid: 's1', wave: 4, kills: 20, score: 2500, players: 1 });
  await handlePost(kv(e), { mode: 'coop', name: '组', pid: 'c1', wave: 6, kills: 40, score: 6000, players: 3 });
  await handlePost(kv(e), { mode: 'campaign', name: '役', pid: 'k1', difficulty: 'ruthless', win: 1, kills: 25, timeMs: 300000 });

  const solo = (await handleGet(kv(e), get('view=all&mode=solo'))).body;
  const coop = (await handleGet(kv(e), get('view=all&mode=coop'))).body;
  const camp = (await handleGet(kv(e), get('mode=campaign'))).body;
  const campF = (await handleGet(kv(e), get('mode=campaign&difficulty=ruthless'))).body;
  assert.equal(solo.all[0].name, '单');
  assert.equal(coop.all[0].name, '组');
  assert.equal(coop.all[0].players, 3, 'players 字段随行保留（标注用）');
  assert.equal(camp.list.length, 1);
  assert.equal(campF.list.length, 1, 'difficulty 过滤命中');
  assert.equal((await handleGet(kv(e), get('mode=campaign&difficulty=wittmann'))).body.list.length, 0, '过滤未命中为空');
  // 缺省 mode = solo（旧客户端兼容）
  const legacyDefault = (await handleGet(kv(e), get('view=all'))).body;
  assert.equal(legacyDefault.all[0].name, '单', '不带 mode 的旧客户端读到单人榜');
  ok('GET 路由：四类榜互不串、difficulty 过滤、缺省兼容旧客户端');
}

console.log(`\n全部通过：${pass} 项`);
