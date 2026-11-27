// 榜单核心逻辑（不依赖任何平台 API）
//
// 为什么单独抽出来：
//   榜单规则与"存哪"无关。这里只认一个极简 KV 接口 { get(key), put(key, value) }，
//   换存储只要再给一个实现：
//     · 线上 / 本地 → server/score-store.js（写 .data/scores.json）
//
// 榜单结构（r59 起三条榜分立，按 POST body.mode 路由）：
//   单人榜  solo:day:<YYYY-MM-DD> / solo:top       Top100，排序 分数>波次>先到
//   组队榜  coop:day:<YYYY-MM-DD> / coop:top       Top100，同上；players 字段只做
//                                                  行内标注（2 人和 4 人同榜混排，
//                                                  不加权——已定方案）
//   战役榜  campaign:top                           不按天。固定图固定布阵，人人打
//                                                  的局一模一样，比的是"打得又狠
//                                                  又快"：通关 > 难度 > 击毁 > 用时
//   旧总榜  lb:<date> / all:top                    历史数据（r59 前的唯一榜）。键冻结
//                                                  不再写入，但 all:top 的历史成绩**并入
//                                                  单人总榜一起展示**（读时合并，见
//                                                  soloAllMerged），不是封存。
//
// 去重键：name#pid（pid 是客户端生成的本机 ID）—— 早期按 name 去重，同名玩家会互相覆盖。
// 例外：组队榜由服务端房间结算上报（见 server/room.js），拿不到客户端 pid，退回按 name。

export const TOP_N = 100;

// ---- 新三榜的键 ----
export const SOLO_DAY_PREFIX = 'solo:day:';
export const SOLO_TOP_KEY = 'solo:top';
export const COOP_DAY_PREFIX = 'coop:day:';
export const COOP_TOP_KEY = 'coop:top';
export const CAMPAIGN_TOP_KEY = 'campaign:top';
export const COOP_DAYS_KEY = 'meta:days:coop';

// ---- 旧榜键：历史数据。不再写入；all:top 读时并入单人总榜（用户要求新旧同榜）----
export const DAY_PREFIX = 'lb:';
export const ALL_KEY = 'all:top';
export const DAYS_KEY = 'meta:days';

export const CHASSIS_IDS = ['balanced', 'light', 'heavy', 'hunter'];

/** 战役难度白名单（与 src/core/villers.js 的 DIFFICULTIES 一致，那边是唯一数据源） */
export const CAMPAIGN_DIFFS = ['novice', 'normal', 'ruthless', 'wittmann'];
/** 战役场上最多 36 个单位（villers.UNITS），超了必是伪造 */
export const CAMPAIGN_MAX_KILLS = 36;
/** 战役时限 15 分钟（OBJECTIVE.timeLimit），放宽 5 秒容忍结算延迟 */
export const CAMPAIGN_MAX_MS = 15 * 60 * 1000 + 5000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 以 UTC+8 计算"今天"，与前端上报的日期键保持一致 */
export const todayKey = (offsetDays = 0) => new Date(
  Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000,
).toISOString().slice(0, 10);

/** 只允许今天（或昨天，容忍跨零点提交）的成绩 */
export const dateAllowed = (date) => date === todayKey(0) || date === todayKey(-1);

export const num = (v, max, def = 0) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : def;
};

/** 单人/组队统一排序：分数 > 波次 > 先到（更早达成者在前） */
export const sortDesc = (a, b) => (b.score || 0) - (a.score || 0)
  || (b.wave || 0) - (a.wave || 0)
  || (a.t || 0) - (b.t || 0);

/** 难度权重：新手 0 < 普通 1 < 冷血 2 < 魏神 3。未知难度按 0。 */
export const campaignRank = (d) => Math.max(0, CAMPAIGN_DIFFS.indexOf(d));

/**
 * 战役榜排序：通关 > 难度 > 击毁 > 用时。
 * 用时方向随结果变：通关者越快越好（升序）；未通关者撑得越久越好（降序，
 * 同击毁数下活到 14 分钟比开局 3 分钟被围死强）。
 */
export const campaignSort = (a, b) => (b.win || 0) - (a.win || 0)
  || campaignRank(b.difficulty) - campaignRank(a.difficulty)
  || (b.kills || 0) - (a.kills || 0)
  || ((a.win ? 1 : -1) * (a.timeMs || 0) - (b.win ? 1 : -1) * (b.timeMs || 0))
  || (a.t || 0) - (b.t || 0);

export async function getJSON(kv, key, fallback) {
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export const putJSON = (kv, key, val) => kv.put(key, JSON.stringify(val));

/** 去重身份：优先 pid（改名不变），老数据没有则退回 id / name */
export const identOf = (e) => e.pid || e.id || e.name;

/** 同身份只保留最高分（单人/组队榜） */
export function mergeEntry(list, entry) {
  const key = identOf(entry);
  const prev = list.find((e) => identOf(e) === key);
  if (prev && (prev.score > entry.score
      || (prev.score === entry.score && (prev.wave || 0) >= (entry.wave || 0)))) {
    return list;
  }
  const rest = list.filter((e) => identOf(e) !== key);
  rest.push(entry);
  rest.sort(sortDesc);
  return rest.slice(0, TOP_N);
}

/** 战役榜合并：同身份保留"排得最前"的那条 */
export function mergeCampaignEntry(list, entry) {
  const key = identOf(entry);
  const prev = list.find((e) => identOf(e) === key);
  if (prev && campaignSort(prev, entry) <= 0) return list;
  const rest = list.filter((e) => identOf(e) !== key);
  rest.push(entry);
  rest.sort(campaignSort);
  return rest.slice(0, TOP_N);
}

/** 多榜合并（周榜用）：同身份取最高，再整体排序截断 */
export function mergeLists(lists) {
  let out = [];
  for (const list of lists) {
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || !e.name) continue;
      out = mergeEntry(out, e);
    }
  }
  return out.sort(sortDesc).slice(0, TOP_N);
}

/**
 * 读-改-写 + 回读校验。
 * Cloudflare KV 没有原子操作，并发提交会互相覆盖；写完回读确认自己在榜上，
 * 不在就重试，能明显降低「成绩提交了却没上榜」的概率。
 * @param {Function} merge 合并函数（单人/组队用 mergeEntry，战役用 mergeCampaignEntry）
 */
export async function commit(kv, key, entry, merge = mergeEntry, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const list = await getJSON(kv, key, []);
    const next = merge(list, entry);
    await putJSON(kv, key, next);
    const check = await getJSON(kv, key, []);
    if (Array.isArray(check) && check.some((e) => identOf(e) === identOf(entry))) return check;
  }
  return null;
}

/**
 * 单人/组队成绩是否算数。
 *
 * 0 分不是"打得很差"，而是**这局根本没发生**：开局就被撞毁、或者点了开始
 * 立刻退出。它上榜有两个害处：占掉名额、让榜尾看起来"有人 0 分也能进"。
 * 线上真的出现过一条 `gunner / 0 分 / 第 1 波 / 0 杀` 压在总榜最后。
 *
 * 只拦 0 分，不设更高的门槛：1 分也是真实打出来的（旧站那条 selftest 就是），
 * 门槛一抬高就会开始误杀真正的残局。
 *
 * 注意：**只在入口和读取处用**，不要塞进 `mergeEntry` —— 那是个纯合并函数，
 * 测试里拿 0 分当序号用（`score: i`），加了过滤会连带改变合并语义。
 */
export const isValidEntry = (e) => !!e && Number(e.score) > 0;

/**
 * 战役成绩是否算数：通关必上榜；未通关至少要击毁一辆。
 * （游戏内的规则是"击毁 22 辆才能撤离"，没车就撤的局不存在。）
 */
export const isValidCampaign = (e) => !!e && e.name && (e.win || Number(e.kills) > 0);

/** 去掉不合格条目（读接口用）。非法输入一律回空数组，不让 undefined 传到前端 */
export const liveEntries = (list) => (Array.isArray(list) ? list.filter(isValidEntry) : []);
export const liveCampaign = (list) => (Array.isArray(list) ? list.filter(isValidCampaign) : []);

/**
 * 单人总榜 = 新榜 solo:top + 旧榜 all:top 合并。
 * 旧数据是 r59 前攒下的真实战绩，用户要求新旧同榜展示，不是封存。
 * 旧键保持只读：合并发生在读取时，写入永远只进新键。
 * 旧条目没有 players 字段 → 客户端按 (players||1) 渲染，单人行不受影响。
 */
export async function soloAllMerged(kv) {
  const [top, legacy] = await Promise.all([
    getJSON(kv, SOLO_TOP_KEY, []),
    getJSON(kv, ALL_KEY, []),
  ]);
  return mergeLists([liveEntries(top), liveEntries(legacy)]);
}

/** 规范化一条单人/组队成绩，过滤非法/越界字段 */
export function normalizeEntry(body) {
  const name = String(body.name || '').trim().slice(0, 12);
  if (!name) return null;

  const pid = String(body.pid || '').replace(/[^\w-]/g, '').slice(0, 16);
  const chassis = CHASSIS_IDS.includes(body.chassis) ? body.chassis : '';
  const weapon = String(body.weapon || '').replace(/[^\w-]/g, '').slice(0, 16);
  const mods = Array.isArray(body.mods)
    ? body.mods
      .filter((m) => typeof m === 'string')
      .map((m) => m.replace(/[^\w-]/g, '').slice(0, 16))
      .slice(0, 6)
    : [];

  const entry = {
    name,
    wave: num(body.wave, 999),
    kills: num(body.kills, 99999),
    score: num(body.score, 99999999),
    timeMs: num(body.timeMs, 24 * 3600 * 1000),
    // 这一局几个人打的：1 = 单人，2~4 = 合作。只做标注不参与排序（已定方案：不加权）
    players: Math.max(1, Math.min(4, num(body.players, 4, 1))),
    t: Date.now(),
  };
  if (pid) { entry.pid = pid; entry.id = `${name}#${pid}`; }
  if (chassis) entry.chassis = chassis;
  if (weapon) entry.weapon = weapon;
  if (mods.length) entry.mods = mods;
  return entry;
}

/**
 * 规范化一条战役成绩。固定图让服务端第一次可以"懂这一关"：
 * 字段白名单 + 上下界校验，超出即拒——防伪门槛比无尽模式严得多。
 * @returns {object|null} null = 字段非法（no-name / bad-diff / bad-kills / bad-time）
 */
export function normalizeCampaignEntry(body) {
  const name = String(body.name || '').trim().slice(0, 12);
  if (!name) return null;
  const pid = String(body.pid || '').replace(/[^\w-]/g, '').slice(0, 16);

  if (!CAMPAIGN_DIFFS.includes(body.difficulty)) return { reason: 'bad-diff' };
  const kills = num(body.kills, 9999);
  if (kills > CAMPAIGN_MAX_KILLS) return { reason: 'bad-kills' };
  const timeMs = num(body.timeMs, CAMPAIGN_MAX_MS + 1);
  if (timeMs > CAMPAIGN_MAX_MS) return { reason: 'bad-time' };
  const win = body.win ? 1 : 0;

  const entry = {
    name,
    difficulty: body.difficulty,
    win,
    kills,
    timeMs,
    t: Date.now(),
  };
  if (pid) { entry.pid = pid; entry.id = `${name}#${pid}`; }
  return entry;
}

/**
 * GET /api/scores 的公共实现。
 * @param {{get:Function,put:Function}} kv
 * @param {URL} url
 *
 * mode 路由（缺省 = solo，旧客户端无感续用）：
 *   solo/coop   view=day|all
 *   campaign    view=all（可选 difficulty 过滤）
 *   legacy      view=day|all —— 旧总榜只读存档
 */
export async function handleGet(kv, url) {
  const mode = url.searchParams.get('mode') || 'solo';
  const view = url.searchParams.get('view') || 'day';

  // ---- 诊断：各榜条数、最后写入时间 ----
  if (view === 'stats') {
    const [soloDay, soloTop, coopDay, coopTop, campaign, legacyAll, days, coopDays] = await Promise.all([
      getJSON(kv, `${SOLO_DAY_PREFIX}${todayKey()}`, []),
      getJSON(kv, SOLO_TOP_KEY, []),
      getJSON(kv, `${COOP_DAY_PREFIX}${todayKey()}`, []),
      getJSON(kv, COOP_TOP_KEY, []),
      getJSON(kv, CAMPAIGN_TOP_KEY, []),
      getJSON(kv, ALL_KEY, []),
      getJSON(kv, DAYS_KEY, []),
      getJSON(kv, COOP_DAYS_KEY, []),
    ]);
    const stamp = (l) => (l.length ? Math.max(...l.map((e) => e.t || 0)) : 0);
    return {
      status: 200,
      body: {
        ok: true,
        today: todayKey(),
        solo: { day: liveEntries(soloDay).length, all: liveEntries(soloTop).length, lastAt: stamp(soloTop) },
        coop: { day: liveEntries(coopDay).length, all: liveEntries(coopTop).length, lastAt: stamp(coopTop) },
        campaign: liveCampaign(campaign).length,
        legacy: { all: liveEntries(legacyAll).length, days: days.length, coopDays: coopDays.length },
      },
    };
  }

  // ---- 旧榜存档（只读）----
  if (mode === 'legacy') {
    if (view === 'all') {
      return { status: 200, body: { ok: true, all: liveEntries(await getJSON(kv, ALL_KEY, [])) } };
    }
    const date = url.searchParams.get('date') || todayKey();
    if (!DATE_RE.test(date)) return { status: 400, body: { ok: false, reason: 'bad-date' } };
    return {
      status: 200,
      body: { ok: true, date, list: liveEntries(await getJSON(kv, `${DAY_PREFIX}${date}`, [])) },
    };
  }

  // ---- 战役榜（不按天）----
  if (mode === 'campaign') {
    const list = liveCampaign(await getJSON(kv, CAMPAIGN_TOP_KEY, []));
    const diff = url.searchParams.get('difficulty');
    return {
      status: 200,
      body: { ok: true, list: diff ? list.filter((e) => e.difficulty === diff) : list },
    };
  }

  // ---- 单人 / 组队 ----
  const prefix = mode === 'coop' ? COOP_DAY_PREFIX : SOLO_DAY_PREFIX;
  const topKey = mode === 'coop' ? COOP_TOP_KEY : SOLO_TOP_KEY;

  if (view === 'all') {
    // 单人总榜并入旧 all:top 的历史成绩；组队榜没有旧数据（r59 前组队成绩从未上报）
    const all = mode === 'coop'
      ? liveEntries(await getJSON(kv, topKey, []))
      : await soloAllMerged(kv);
    return { status: 200, body: { ok: true, all } };
  }

  // 今日榜（date 参数仅供客户端兜底，正常不传）
  const date = url.searchParams.get('date') || todayKey();
  if (!DATE_RE.test(date)) return { status: 400, body: { ok: false, reason: 'bad-date' } };
  return {
    status: 200,
    body: { ok: true, date, list: liveEntries(await getJSON(kv, `${prefix}${date}`, [])) },
  };
}

/** 更新某条日期索引（最近 120 天，运营用） */
async function touchDays(kv, key, date) {
  const days = await getJSON(kv, key, []);
  await putJSON(kv, key, [date, ...days.filter((d) => d !== date)].slice(0, 120));
}

/**
 * POST /api/scores 的公共实现。
 * body.mode: 'solo'（缺省）| 'coop' | 'campaign'。
 * 旧榜键（lb: 前缀与 all:top）不再写入；all:top 的历史数据读时并入单人总榜。
 */
export async function handlePost(kv, body) {
  if (!body || typeof body !== 'object') return { status: 400, body: { ok: false, reason: 'bad-json' } };

  const mode = body.mode === 'campaign' || body.mode === 'coop' ? body.mode : 'solo';

  // ---- 战役：字段白名单校验，不写日期榜 ----
  if (mode === 'campaign') {
    const entry = normalizeCampaignEntry(body);
    if (!entry || entry.reason) {
      return { status: 400, body: { ok: false, reason: entry?.reason || 'no-name' } };
    }
    if (!isValidCampaign(entry)) return { status: 400, body: { ok: false, reason: 'no-kills' } };
    try {
      const next = await commit(kv, CAMPAIGN_TOP_KEY, entry, mergeCampaignEntry);
      if (!next) return { status: 500, body: { ok: false, reason: 'kv-write' } };
      return { status: 200, body: { ok: true, list: next } };
    } catch {
      return { status: 500, body: { ok: false, reason: 'kv-write' } };
    }
  }

  // ---- 单人 / 组队 ----
  const entry = normalizeEntry(body);
  if (!entry) return { status: 400, body: { ok: false, reason: 'no-name' } };
  // 0 分不是一局成绩（开局即毁 / 直接退），不上榜。
  // 与读取处的过滤同一条规则，避免"提交成功但榜上没有"这种更难看的情况。
  if (!isValidEntry(entry)) return { status: 400, body: { ok: false, reason: 'no-score' } };
  // 组队榜只收 2 人以上的局：单人成绩走 solo，别混进来
  if (mode === 'coop' && entry.players < 2) {
    return { status: 400, body: { ok: false, reason: 'bad-players' } };
  }

  const date = DATE_RE.test(body.date || '') ? body.date : todayKey();
  // 防止伪造历史战绩：只收今天 / 昨天
  if (!dateAllowed(date)) return { status: 400, body: { ok: false, reason: 'stale-date' } };

  const dayPrefix = mode === 'coop' ? COOP_DAY_PREFIX : SOLO_DAY_PREFIX;
  const topKey = mode === 'coop' ? COOP_TOP_KEY : SOLO_TOP_KEY;
  const daysKey = mode === 'coop' ? COOP_DAYS_KEY : DAYS_KEY;

  try {
    const nextDay = await commit(kv, `${dayPrefix}${date}`, entry);
    const nextTop = await commit(kv, topKey, entry);
    await touchDays(kv, daysKey, date);

    if (!nextDay) return { status: 500, body: { ok: false, reason: 'kv-write' } };
    // 单人的 all 响应同样并入旧榜历史：客户端提交后拿这个字段刷新本地缓存，
    // 少了旧数据总榜会"闪没"一截。组队无旧数据，直接用新榜。
    const all = mode === 'coop' ? nextTop || [] : await soloAllMerged(kv);
    return { status: 200, body: { ok: true, date, list: nextDay, all } };
  } catch {
    return { status: 500, body: { ok: false, reason: 'kv-write' } };
  }
}

export const __test = {
  mergeEntry, mergeLists, mergeCampaignEntry, normalizeEntry, normalizeCampaignEntry,
  sortDesc, campaignSort, campaignRank, identOf, dateAllowed, todayKey,
  isValidEntry, isValidCampaign, liveEntries, liveCampaign, soloAllMerged,
};
