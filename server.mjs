// 联机服务器入口
//
// 一个进程干两件事：
//   1. 托管静态文件（和原来的开发服务器一样的逻辑，一条命令就能跑起来）
//   2. 在 /ws 上跑 WebSocket 房间
//
// 为什么不用现成的房间框架：房间逻辑本身只有三百行，手写反而可控，
// 也不会把项目绑死在某个云厂商的运行时上。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { RoomRegistry } from './server/room.js';
import { attachSession } from './server/session.js';
import { FileStore, readBody } from './server/score-store.js';
import { handleGet, handlePost } from './functions/api/_lib/leaderboard.js';
import {
  normalizeRoomCode, MAX_PLAYERS,
} from './src/core/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 5173);

// 本地榜单：与线上 Pages Functions 走同一份规则，只是换成文件存储。
// 这样 `npm start` 就是一个完整环境，单人和组队的成绩都能立刻在榜上看到。
const scores = new FileStore(path.join(root, '.data', 'scores.json'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const registry = new RoomRegistry();

// ---------------- 静态文件 ----------------

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.join(root, rel);
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  const data = await readFile(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    // 开发期禁缓存：改完刷新就能看到
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 房间概览：自测和运维用
  if (url.pathname === '/api/rooms') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ...registry.stats(), codes: [...registry.rooms.keys()] }));
    return;
  }

  // 榜单：与 functions/api/scores.js 同一套逻辑
  if (url.pathname === '/api/scores') {
    const send = (r) => {
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(r.body));
    };
    if (req.method === 'GET') {
      try {
        send(await handleGet(scores, url));
      } catch (e) {
        console.error('[scores] read failed', e);
        send({ status: 500, body: { ok: false, reason: 'kv-read' } });
      }
      return;
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        const reason = e.message === 'body-too-large' ? 'too-large' : 'bad-json';
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reason }));
        return;
      }
      try {
        send(await handlePost(scores, body));
      } catch (e) {
        console.error('[scores] write failed', e);
        send({ status: 500, body: { ok: false, reason: 'kv-write' } });
      }
      return;
    }
    res.writeHead(405, { Allow: 'GET, POST' }).end();
    return;
  }

  try {
    await serveStatic(req, res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
});

// ---------------- WebSocket 房间 ----------------

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  attachSession(socket, {
    join: (msg) => {
      const name = String(msg.name || '').trim().slice(0, 12) || '指挥官';
      const chassis = ['balanced', 'light', 'heavy', 'hunter'].includes(msg.chassis)
        ? msg.chassis : 'balanced';

      let room = null;
      if (msg.code) {
        room = registry.get(normalizeRoomCode(msg.code));
        // 给了房间码但不存在 → 拒绝，别偷偷建个新的（否则朋友永远进不到一起）
        if (!room) return { deny: 'no-room' };
      } else {
        room = registry.create();
      }

      const r = room.join(socket, { name, chassis, seed: msg.seed });
      if (!r.ok) return { deny: r.reason };
      return { ok: true, room, id: r.id, name };
    },
    onLog: (what, code, name) => {
      if (what === 'join') console.log(`[join] ${code} ← ${name} (${registry.get(code)?.size}/${MAX_PLAYERS})`);
      else if (what === 'start') console.log(`[start] ${code} 房主 ${name} 手动开局`);
      else if (what === 'leave') console.log(`[leave] ${code} ← ${name}`);
    },
  });
});

server.listen(port, () => {
  console.log('');
  console.log('  钢铁突击 · 联机服务已启动');
  console.log(`  本地：  http://localhost:${port}/`);
  console.log(`  局域网：http://<你的内网IP>:${port}/`);
  console.log('  榜单数据：.data/scores.json（与线上同一套规则）');
  console.log('');
});
