// Cloudflare Pages Function：每日挑战排行榜
// KV 绑定变量名：DAILY_SCORES（项目 Settings → Bindings → KV namespace）
//
// 存储结构：
//   lb:<YYYY-MM-DD>  → 当天 Top50  [{ name, wave, kills, score, t }]
//   all:top          → 历史总榜 Top50（每人只留最高分）
//   meta:days        → 已有战绩的日期数组（倒序，最多 120 天）
//
// 未绑定 KV 时一律返回 ok:false，客户端自动回退 localStorage。

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

/** 以 UTC+8 计算"今天"，与前端每日挑战的日期键保持一致 */
const todayKey = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 只允许今天（或昨天，容忍跨时区/跨零点提交）的成绩 */
function dateAllowed(date) {
  const today = todayKey();
  if (date === today) return true;
  const y = new Date(Date.now() + 8 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  return date === y;
}

const sortDesc = (a, b) => b.score - a.score || b.wave - a.wave || a.t - b.t;

async function getJSON(kv, key, fallback) {
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const putJSON = (kv, key, val) => kv.put(key, JSON.stringify(val));

/** 同呼号只保留最高分 */
function mergeEntry(list, entry) {
  const prev = list.find((e) => e.name === entry.name);
  // 已有更高分（或同分但波次更高）则保留原成绩，避免低分刷榜
  if (prev && (prev.score > entry.score ||
      (prev.score === entry.score && (prev.wave || 0) >= (entry.wave || 0)))) {
    return list;
  }
  const rest = list.filter((e) => e.name !== entry.name);
  rest.push(entry);
  rest.sort(sortDesc);
  return rest.slice(0, 50);
}

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const view = url.searchParams.get('view') || 'day';

  // ---- 总榜 + 历史日期（排行榜面板一次拿全） ----
  if (view === 'all') {
    if (!env.DAILY_SCORES) return json({ ok: false, reason: 'kv-unbound' });
    const all = await getJSON(env.DAILY_SCORES, 'all:top', []);
    const days = await getJSON(env.DAILY_SCORES, 'meta:days', []);
    return json({ ok: true, all, days });
  }

  // ---- 某一天的战绩 ----
  const date = url.searchParams.get('date') || todayKey();
  if (!DATE_RE.test(date)) return json({ ok: false, reason: 'bad-date' }, 400);
  if (!env.DAILY_SCORES) return json({ ok: false, reason: 'kv-unbound' });
  const list = await getJSON(env.DAILY_SCORES, `lb:${date}`, []);
  return json({ ok: true, date, list });
}

export async function onRequestPost({ env, request }) {
  const kv = env.DAILY_SCORES;
  if (!kv) return json({ ok: false, reason: 'kv-unbound' });

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, reason: 'bad-json' }, 400); }

  const date = DATE_RE.test(body.date || '') ? body.date : todayKey();
  // 防伪造历史战绩：只收今天 / 昨天
  if (!dateAllowed(date)) return json({ ok: false, reason: 'stale-date' }, 400);

  const name = String(body.name || '').trim().slice(0, 12);
  if (!name) return json({ ok: false, reason: 'no-name' }, 400);

  const wave = Math.max(0, Math.min(999, Math.floor(Number(body.wave) || 0)));
  const kills = Math.max(0, Math.min(99999, Math.floor(Number(body.kills) || 0)));
  const score = Math.max(0, Math.min(99999999, Math.floor(Number(body.score) || 0)));
  const entry = { name, wave, kills, score, t: Date.now() };

  try {
    // 当日榜
    const dayList = await getJSON(kv, `lb:${date}`, []);
    const nextDay = mergeEntry(dayList, entry);
    await putJSON(kv, `lb:${date}`, nextDay);

    // 历史总榜
    const all = await getJSON(kv, 'all:top', []);
    const nextAll = mergeEntry(all, entry);
    await putJSON(kv, 'all:top', nextAll);

    // 日期索引（倒序，最多保留 120 天）
    const days = await getJSON(kv, 'meta:days', []);
    const nextDays = [date, ...days.filter((d) => d !== date)].slice(0, 120);
    await putJSON(kv, 'meta:days', nextDays);

    return json({ ok: true, date, list: nextDay, all: nextAll, days: nextDays });
  } catch {
    return json({ ok: false, reason: 'kv-write' }, 500);
  }
}
