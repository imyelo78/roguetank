// 榜单核心逻辑（不依赖任何平台 API）
//
// 为什么单独抽出来：
//   榜单规则与"存哪"无关。这里只认一个极简 KV 接口 { get(key), put(key, value) }，
//   换存储只要再给一个实现：
//     · 线上 / 本地 → server/score-store.js（写 .data/scores.json）
//
// 榜单结构（只有一条榜，单人/多人同榜）：
//   今日榜  lb:<YYYY-MM-DD>   Top100
//   总榜    all:top           Top100
//   日期索引 meta:days        最近 120 天（给运营看，前端已不再按日期查）
//
// 去重键：name#pid（pid 是客户端生成的本机 ID）—— 早期按 name 去重，同名玩家会互相覆盖。

export const TOP_N = 100;

export const DAY_PREFIX = 'lb:';
export const ALL_KEY = 'all:top';
export const DAYS_KEY = 'meta:days';

export const CHASSIS_IDS = ['balanced', 'light', 'heavy', 'hunter'];

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

/** 统一排序：分数 > 波次 > 先到（更早达成者在前） */
export const sortDesc = (a, b) => (b.score || 0) - (a.score || 0)
  || (b.wave || 0) - (a.wave || 0)
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

/** 同身份只保留最高分 */
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
 */
export async function commit(kv, key, entry, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const list = await getJSON(kv, key, []);
    const next = mergeEntry(list, entry);
    await putJSON(kv, key, next);
    const check = await getJSON(kv, key, []);
    if (Array.isArray(check) && check.some((e) => identOf(e) === identOf(entry))) return check;
  }
  return null;
}

/** 规范化一条成绩，过滤非法/越界字段 */
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
    // 这一局几个人打的：1 = 单人，2~4 = 合作
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
 * GET /api/scores 的公共实现。
 * @param {{get:Function,put:Function}} kv
 * @param {URL} url
 * @returns {Promise<{status:number, body:object}>}
 */
export async function handleGet(kv, url) {
  const view = url.searchParams.get('view') || 'day';

  // ---- 诊断：今日榜与总榜条数、最后写入时间 ----
  if (view === 'stats') {
    const [dayList, allList, days] = await Promise.all([
      getJSON(kv, `${DAY_PREFIX}${todayKey()}`, []),
      getJSON(kv, ALL_KEY, []),
      getJSON(kv, DAYS_KEY, []),
    ]);
    const stamp = (l) => (l.length ? Math.max(...l.map((e) => e.t || 0)) : 0);
    return {
      status: 200,
      body: {
        ok: true,
        today: todayKey(),
        day: { count: dayList.length, lastAt: stamp(dayList) },
        all: { count: allList.length, lastAt: stamp(allList) },
        days: days.length,
      },
    };
  }

  // ---- 总榜 ----
  if (view === 'all') {
    return { status: 200, body: { ok: true, all: await getJSON(kv, ALL_KEY, []) } };
  }

  // ---- 今日榜（date 参数仅供客户端兜底，正常不传）----
  const date = url.searchParams.get('date') || todayKey();
  if (!DATE_RE.test(date)) return { status: 400, body: { ok: false, reason: 'bad-date' } };
  return {
    status: 200,
    body: { ok: true, date, list: await getJSON(kv, `${DAY_PREFIX}${date}`, []) },
  };
}

/**
 * POST /api/scores 的公共实现。
 * @param {{get:Function,put:Function}} kv
 * @param {object} body 已解析的请求体
 * @returns {Promise<{status:number, body:object}>}
 */
export async function handlePost(kv, body) {
  if (!body || typeof body !== 'object') return { status: 400, body: { ok: false, reason: 'bad-json' } };

  const entry = normalizeEntry(body);
  if (!entry) return { status: 400, body: { ok: false, reason: 'no-name' } };

  const date = DATE_RE.test(body.date || '') ? body.date : todayKey();
  // 防止伪造历史战绩：只收今天 / 昨天
  if (!dateAllowed(date)) return { status: 400, body: { ok: false, reason: 'stale-date' } };

  try {
    const nextDay = await commit(kv, `${DAY_PREFIX}${date}`, entry);
    const nextAll = await commit(kv, ALL_KEY, entry);

    const days = await getJSON(kv, DAYS_KEY, []);
    const nextDays = [date, ...days.filter((d) => d !== date)].slice(0, 120);
    await putJSON(kv, DAYS_KEY, nextDays);

    if (!nextDay) return { status: 500, body: { ok: false, reason: 'kv-write' } };
    return { status: 200, body: { ok: true, date, list: nextDay, all: nextAll || [] } };
  } catch {
    return { status: 500, body: { ok: false, reason: 'kv-write' } };
  }
}

export const __test = {
  mergeEntry, mergeLists, normalizeEntry, sortDesc, identOf, dateAllowed, todayKey,
};
