// Cloudflare Worker 入口：静态站点 + 榜单接口 + 联机房间
//
// 一个域名干三件事，好处是前端不用配任何地址：
//   /            静态资源（dist，由 build.mjs 产出）
//   /api/scores  排行榜（KV 绑定 DAILY_SCORES，没绑也能跑，前端回退本地存储）
//   /ws          联机 WebSocket（转给 Durable Object，一个房间一个实例）
//
// 以前的部署是 Cloudflare Pages：静态页 + Functions 只能读接口，撑不起
// 有状态的房间服务，所以线上组队必然连不上。改成 Worker + DO 之后同源，
// 网页、榜单、联机都在一个部署里。

import { handleGet, handlePost } from '../functions/api/_lib/leaderboard.js';
import { makeRoomCode, normalizeRoomCode } from '../src/core/protocol.js';

export { RoomDurableObject } from './room-do.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') return routeRoom(request, env, url);
    if (url.pathname === '/api/scores') return scores(request, env, url);

    return env.ASSETS.fetch(request);
  },
};

/** 把 WebSocket 请求路由到对应房间的 Durable Object */
async function routeRoom(request, env, url) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return json({ ok: false, reason: 'expected-websocket' }, 426);
  }

  const code = normalizeRoomCode(url.searchParams.get('code') || '');

  // 带房间码：直接找这个房间
  if (code) return forwardToRoom(request, env, url, code, false);

  // 不带码 = 建房：随机生成，撞到已占用的房间就换一个
  for (let i = 0; i < 5; i += 1) {
    const candidate = makeRoomCode();
    const resp = await forwardToRoom(request, env, url, candidate, true);
    if (resp.status !== 409) return resp;
  }
  return json({ ok: false, reason: 'no-code' }, 503);
}

function forwardToRoom(request, env, url, code, create) {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const target = new URL(request.url);
  target.searchParams.set('code', code);
  if (create) target.searchParams.set('create', '1');
  else target.searchParams.delete('create');

  // 重新构造请求：保留 Upgrade / Sec-WebSocket-* 等头，只换 URL
  return stub.fetch(new Request(target.toString(), request));
}

async function scores(request, env, url) {
  const kv = env.DAILY_SCORES;
  if (!kv) return json({ ok: false, reason: 'kv-unbound' });

  if (request.method === 'GET') {
    const r = await handleGet(kv, url);
    return json(r.body, r.status);
  }
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, reason: 'bad-json' }, 400); }
    const r = await handlePost(kv, body);
    return json(r.body, r.status);
  }
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
}
