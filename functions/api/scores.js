// Cloudflare Pages Function：每日挑战排行榜
// 需要在 Pages 项目设置里绑定 KV 命名空间，变量名 DAILY_SCORES。
// 未绑定 KV 时返回 ok:false，客户端自动回退 localStorage。

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

const todayUTC = () => new Date().toISOString().slice(0, 10);

async function getList(kv, date) {
  if (!kv) return null;
  try {
    const raw = await kv.get(`lb:${date}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return null;
  }
}

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date') || todayUTC();
  const list = await getList(env.DAILY_SCORES, date);
  if (list === null) return json({ ok: false, reason: 'kv-unbound' });
  return json({ ok: true, date, list });
}

export async function onRequestPost({ env, request }) {
  const kv = env.DAILY_SCORES;
  if (!kv) return json({ ok: false, reason: 'kv-unbound' });

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, reason: 'bad-json' }, 400); }

  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayUTC();
  const name = String(body.name || '指挥官').slice(0, 12);
  const wave = Math.max(0, Math.min(999, Number(body.wave) || 0));
  const kills = Math.max(0, Math.min(99999, Number(body.kills) || 0));
  const score = Math.max(0, Math.min(99999999, Number(body.score) || 0));

  const list = (await getList(kv, date)) || [];
  // 同名取最高分
  const filtered = list.filter((e) => e.name !== name || e.score < score);
  filtered.push({ name, wave, kills, score, t: Date.now() });
  filtered.sort((a, b) => b.score - a.score || b.wave - a.wave);
  const top = filtered.slice(0, 50);

  try { await kv.put(`lb:${date}`, JSON.stringify(top)); } catch { return json({ ok: false, reason: 'kv-write' }); }
  return json({ ok: true, date, list: top });
}
