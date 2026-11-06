// Cloudflare Pages Function：排行榜接口
// KV 绑定变量名：DAILY_SCORES（项目 Settings → Bindings → KV namespace）
//
// 这里只做平台适配，规则全在 ./_lib/leaderboard.js —— 同一份代码也被
// 本地 `node server.mjs` 使用，避免"线上和本地行为不一致"。
//
// 未绑定 KV 时一律返回 ok:false，客户端自动回退 localStorage。

import { handleGet, handlePost, __test } from './_lib/leaderboard.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export async function onRequestGet({ env, request }) {
  const kv = env.DAILY_SCORES;
  if (!kv) return json({ ok: false, reason: 'kv-unbound' });

  const r = await handleGet(kv, new URL(request.url));
  return json(r.body, r.status);
}

export async function onRequestPost({ env, request }) {
  const kv = env.DAILY_SCORES;
  if (!kv) return json({ ok: false, reason: 'kv-unbound' });

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, reason: 'bad-json' }, 400); }

  const r = await handlePost(kv, body);
  return json(r.body, r.status);
}

// 测试仍从这里取（保持原有引用路径不变）
export { __test };
