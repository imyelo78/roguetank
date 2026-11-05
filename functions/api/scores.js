// Cloudflare Pages Function：排行榜（每日挑战 + 训练模式）
// KV 绑定变量名：DAILY_SCORES（项目 Settings → Bindings → KV namespace）
//
// 存储结构：
//   lb:<YYYY-MM-DD>  → 当日榜（每日挑战）Top50
//   tr:<YYYY-MM-DD>  → 当日榜（训练模式）Top50
//   all:top          → 每日挑战历史总榜 Top50
//   tr:top           → 训练模式历史总榜 Top50
//   meta:days        → 每日挑战有战绩的日期（倒序，最多 120 天）
//   meta:trdays      → 训练模式有战绩的日期
//
// 去重键：name#pid（pid 为客户端生成的本机 ID）
//   —— 早期版本按 name 去重，导致同名玩家（例如都用默认「指挥官」）互相覆盖，
//      榜上只剩一条。现在不同设备即使同名也能各自保留。
//
// 未绑定 KV 时一律返回 ok:false，客户端自动回退 localStorage。

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

/** 以 UTC+8 计算"今天"，与前端每日挑战的日期键保持一致 */
const todayKey = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const KEYS = {
  daily: { day: 'lb:', all: 'all:top', days: 'meta:days' },
  normal: { day: 'tr:', all: 'tr:top', days: 'meta:trdays' },
};

const modeOf = (v) => (v === 'normal' ? 'normal' : 'daily');

/** 只允许今天（或昨天，容忍跨零点提交）的成绩 */
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

/** 去重身份：优先 id（name#pid），老数据没有则退回 name */
const identOf = (e) => e.id || e.name;

/** 同身份只保留最高分 */
function mergeEntry(list, entry) {
  const key = identOf(entry);
  const prev = list.find((e) => identOf(e) === key);
  // 已有更高分（或同分但波次更高）则保留原成绩，避免低分刷榜
  if (prev && (prev.score > entry.score ||
      (prev.score === entry.score && (prev.wave || 0) >= (entry.wave || 0)))) {
    return list;
  }
  const rest = list.filter((e) => identOf(e) !== key);
  rest.push(entry);
  rest.sort(sortDesc);
  return rest.slice(0, 50);
}

/**
 * 读-改-写 + 回读校验。
 * Cloudflare KV 没有原子操作，并发提交可能互相覆盖；写完回读确认自己在榜上，
 * 不在就重试，能显著降低「成绩提交了却没上榜」的概率。
 */
async function commit(kv, key, entry, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const list = await getJSON(kv, key, []);
    const next = mergeEntry(list, entry);
    await putJSON(kv, key, next);
    const check = await getJSON(kv, key, []);
    if (Array.isArray(check) && check.some((e) => identOf(e) === identOf(entry))) return check;
  }
  return null;
}

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const view = url.searchParams.get('view') || 'day';
  const mode = modeOf(url.searchParams.get('mode'));
  const k = KEYS[mode];
  const kv = env.DAILY_SCORES;

  // ---- 诊断：各榜条数与最近更新时间，用于判断写入是否真的生效 ----
  if (view === 'stats') {
    if (!kv) return json({ ok: false, reason: 'kv-unbound' });
    const [dayList, allList, days, trDayList, trAll, trDays] = await Promise.all([
      getJSON(kv, `${k.day}${todayKey()}`, []),
      getJSON(kv, k.all, []),
      getJSON(kv, k.days, []),
      getJSON(kv, `${KEYS.normal.day}${todayKey()}`, []),
      getJSON(kv, KEYS.normal.all, []),
      getJSON(kv, KEYS.normal.days, []),
    ]);
    const stamp = (l) => (l.length ? Math.max(...l.map((e) => e.t || 0)) : 0);
    return json({
      ok: true,
      today: todayKey(),
      daily: { today: dayList.length, all: allList.length, days: days.length, lastAt: stamp(dayList) },
      normal: { today: trDayList.length, all: trAll.length, days: trDays.length, lastAt: stamp(trDayList) },
    });
  }

  // ---- 总榜 + 历史日期（排行榜面板一次拿全） ----
  if (view === 'all') {
    if (!kv) return json({ ok: false, reason: 'kv-unbound' });
    const [all, days] = await Promise.all([getJSON(kv, k.all, []), getJSON(kv, k.days, [])]);
    return json({ ok: true, mode, all, days });
  }

  // ---- 某一天的战绩 ----
  const date = url.searchParams.get('date') || todayKey();
  if (!DATE_RE.test(date)) return json({ ok: false, reason: 'bad-date' }, 400);
  if (!kv) return json({ ok: false, reason: 'kv-unbound' });
  const list = await getJSON(kv, `${k.day}${date}`, []);
  return json({ ok: true, mode, date, list });
}

export async function onRequestPost({ env, request }) {
  const kv = env.DAILY_SCORES;
  if (!kv) return json({ ok: false, reason: 'kv-unbound' });

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, reason: 'bad-json' }, 400); }

  const mode = modeOf(body.mode);
  const k = KEYS[mode];

  const date = DATE_RE.test(body.date || '') ? body.date : todayKey();
  // 防伪造历史战绩：只收今天 / 昨天
  if (!dateAllowed(date)) return json({ ok: false, reason: 'stale-date' }, 400);

  const name = String(body.name || '').trim().slice(0, 12);
  if (!name) return json({ ok: false, reason: 'no-name' }, 400);

  const pid = String(body.pid || '').replace(/[^\w-]/g, '').slice(0, 16);
  const wave = Math.max(0, Math.min(999, Math.floor(Number(body.wave) || 0)));
  const kills = Math.max(0, Math.min(99999, Math.floor(Number(body.kills) || 0)));
  const score = Math.max(0, Math.min(99999999, Math.floor(Number(body.score) || 0)));

  // pid 缺失（老客户端）时退回按呼号去重
  const entry = { name, wave, kills, score, t: Date.now() };
  if (pid) entry.id = `${name}#${pid}`;

  try {
    const nextDay = await commit(kv, `${k.day}${date}`, entry);
    const nextAll = await commit(kv, k.all, entry);

    const days = await getJSON(kv, k.days, []);
    const nextDays = [date, ...days.filter((d) => d !== date)].slice(0, 120);
    await putJSON(kv, k.days, nextDays);

    if (!nextDay) return json({ ok: false, reason: 'kv-write' }, 500);
    return json({ ok: true, mode, date, list: nextDay, all: nextAll || [], days: nextDays });
  } catch {
    return json({ ok: false, reason: 'kv-write' }, 500);
  }
}
