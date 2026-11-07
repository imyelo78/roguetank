// 联机服务器入口
//
// 一个进程干两件事：
//   1. 托管静态文件（和原来的开发服务器一样的逻辑，一条命令就能跑起来）
//   2. 在 /ws 上跑 WebSocket 房间
//
// 为什么不用现成的房间框架：房间逻辑本身只有三百行，手写反而可控，
// 也不会把项目绑死在某个云厂商的运行时上。

import http from 'node:http';
import https from 'node:https';
import { readFile, stat as stat_ } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { RoomRegistry } from './server/room.js';
import { PROTOCOL_VERSION } from './src/core/protocol.js';
import { attachSession } from './server/session.js';
import { FileStore, readBody } from './server/score-store.js';
import { handleGet, handlePost } from './functions/api/_lib/leaderboard.js';
import {
  normalizeRoomCode, MAX_PLAYERS,
} from './src/core/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 5173);

/**
 * 监听地址。
 *
 * 线上（阿里云 + Nginx）由 systemd 传 HOST=127.0.0.1：Node 只服务本机的反代，
 * 公网流量统一走 443，这样 TLS、限流、健康检查才是唯一入口，端口也不会被扫描器直接打。
 * 本地开发保持默认 0.0.0.0，方便手机在同一 WiFi 下用 http://<内网IP>:5173 访问。
 */
const host = process.env.HOST || '0.0.0.0';

// 榜单：规则在 functions/api/_lib/leaderboard.js，这里只给它挂一个文件存储。
// 所以 `npm start` 就是一个完整环境，单人和组队的成绩都能立刻在榜上看到。
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

/**
 * 静态资源缓存策略。
 *
 * 早期这里是全局 no-cache，开发时方便，但生产上每次刷新都要把 three.module.js
 * （压缩后仍有 150KB+）整个重传一遍，首屏明显偏慢。
 * 现在改成协商缓存：带 ETag，命中就回 304（几十字节）。
 *
 * HTML 仍然 no-cache —— 发版后必须立刻生效，否则用户会拿着旧 HTML 去引用旧 JS。
 */
function cacheHeaders(filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (ext === '.html' || ext === '') {
    return { 'Cache-Control': 'no-cache', ETag: etag };
  }
  return {
    // 5 分钟内直接用本地缓存；超过就用 ETag 找服务器确认（通常回 304）
    'Cache-Control': 'public, max-age=300, must-revalidate',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
  };
}

/**
 * 允许对外访问的路径白名单。
 *
 * 为什么要白名单而不是黑名单：这个进程的根目录就是站点目录，里面同时躺着
 * server/、deploy/、test/、.data/scores.json。黑名单一旦漏一个名字（比如以后
 * 加了 scripts/），源码和榜单就直接可下载了。白名单的默认结论是"不给看"，
 * 新加目录不会自动暴露。
 */
const PUBLIC_FILES = new Set([
  '/index.html', '/styles.css', '/preview.jpg',
  '/favicon.ico', '/robots.txt', '/site.webmanifest',
]);
const PUBLIC_DIRS = ['/src/', '/vendor/', '/assets/'];

/** rel 是已解码、已归一化的绝对路径 */
const isPublicPath = (rel) => PUBLIC_FILES.has(rel) || PUBLIC_DIRS.some((d) => rel.startsWith(d));

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    // 畸形转义（比如 %E0%A4%A）会让 decodeURIComponent 抛异常，
    // 早期这里没兜住，直接变成 500 而不是 400
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('400 Bad Request');
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  // 必须在白名单判断之前归一化：否则 /src/../.data/scores.json 会因为
  // 前缀是 /src/ 而被放行，join 之后却正好指向榜单文件。
  rel = path.posix.normalize(rel);
  if (!isPublicPath(rel)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }

  const filePath = path.join(root, rel);
  // 路径穿越防护：必须有分隔符边界，否则 /srv/roguetank-evil 也能通过前缀判断
  if (!filePath.startsWith(root + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = await stat_(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }

  const headers = {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    ...cacheHeaders(filePath, stat),
  };

  // 协商缓存命中：直接 304，不读文件、不传输
  const inm = req.headers['if-none-match'];
  if (inm && inm === headers.ETag) {
    res.writeHead(304, headers).end();
    return;
  }
  const ims = req.headers['if-modified-since'];
  if (!inm && ims && Date.parse(ims) >= Math.floor(stat.mtimeMs / 1000) * 1000) {
    res.writeHead(304, headers).end();
    return;
  }

  const data = await readFile(filePath);
  // HEAD 请求只要头，不传内容（探活/预检常用）
  res.writeHead(200, { ...headers, 'Content-Length': data.length });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/**
 * 可选的 TLS 终结（TLS_CERT / TLS_KEY）。
 *
 * 线上不用它：证书与 TLS 都交给 Nginx，Node 只监听回环说 HTTP。
 * 保留是为了两种边角场景：纯 IP 临时连一台自签证书，或前面没有反代却想要 https。
 * 读不到证书不会让服务起不来，降级成 HTTP 并明确提示。
 */
function createServer(handler) {
  const cert = process.env.TLS_CERT;
  const key = process.env.TLS_KEY;
  if (!cert || !key) return http.createServer(handler);
  try {
    const opt = { cert: readFileSync(cert), key: readFileSync(key) };
    console.log('[tls] 已启用 HTTPS（自签证书）');
    return https.createServer(opt, handler);
  } catch (e) {
    // 证书路径写错不该让服务起不来，降级成 HTTP 并明确提示
    console.error(`[tls] 读取证书失败，降级为 HTTP：${e.message}`);
    return http.createServer(handler);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 健康检查：给 Nginx / 云监控探活，也方便运维一条 curl 看清状态。
  // 刻意不暴露敏感信息，只有聚合数字。
  if (url.pathname === '/healthz') {
    const s = registry.stats();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      // 协议版本：前端页面与后端进程是否同版本，远程一眼就能看出来。
      // 之前排查"覆盖后仍提示客户端版本过旧"只能靠登服务器 ps/ls 猜，
      // 有了这个字段，浏览器直接打开 /healthz 就知道服务端到底加载了哪份代码。
      proto: PROTOCOL_VERSION,
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      rooms: s.rooms,
      players: s.players,
      // 地形强度：不设 TERRAIN 就是全平。排查"为什么地面没起伏"先看这里，
      // 省得怀疑代码没覆盖成功。
      terrain: process.env.TERRAIN || '0',
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
    }));
    return;
  }

  // 房间概览：自测和运维用。
  // codes 用短横线连接而不是数组：屏幕上看得清，用来核对"朋友输的房间码"对不对。
  // 典型误判：屋里有两三个旧房间（关掉页面没退出）时，自己看到的码可能不是
  // 最新的那个，朋友按错的码进房就会提示"房间不存在"。
  if (url.pathname === '/api/rooms') {
    const s = registry.stats();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      rooms: s.rooms,
      players: s.players,
      codes: [...registry.rooms.keys()].join(' '),
      sizes: [...registry.rooms.values()].map((r) => r.size).join(' '),
    }));
    return;
  }

  // 榜单：规则在 functions/api/_lib/leaderboard.js，前端 Pages Function 与这里共用
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

// 兜底：请求处理里任何未捕获的异常都只影响这一个请求，不能把进程带走。
// 生产环境（systemd）虽然会自动拉起，但每崩一次房间就全没了，代价太大。
server.on('clientError', (err, socket) => {
  if (socket.writable && !socket.writableEnded) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  } else {
    socket.destroy();
  }
});

// ---------------- WebSocket 房间 ----------------

const wss = new WebSocketServer({ server, path: '/ws' });

/**
 * 心跳。
 *
 * 国内 NAT / 云负载均衡会静默回收"看起来空闲"的连接（常见 60~300 秒），
 * 但客户端并不知道，会以为还在房里继续跑预测，队友那边看到的是一台不动的
 * 幽灵坦克。服务端每 20 秒 ping 一次，两轮没有 pong 就主动断开，
 * 客户端就能走正常的"与服务器断开"路径，而不是假装还活着。
 */
const HEARTBEAT_MS = 20000;
const HEARTBEAT_MISS_LIMIT = 2;

setInterval(() => {
  for (const socket of wss.clients) {
    socket._missed = (socket._missed || 0) + 1;
    if (socket._missed > HEARTBEAT_MISS_LIMIT) {
      socket.terminate();
      continue;
    }
    try { socket.ping(); } catch { /* 已断开，close 会处理 */ }
  }
}, HEARTBEAT_MS).unref();

wss.on('connection', (socket) => {
  socket._missed = 0;
  socket.on('pong', () => { socket._missed = 0; });
  socket.on('error', () => { /* 由 close 统一清理 */ });

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

server.listen(port, host, () => {
  const scheme = process.env.TLS_CERT && process.env.TLS_KEY ? 'https' : 'http';
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  console.log('');
  console.log('  钢铁突击 · 联机服务已启动');
  console.log(`  监听：  ${host}:${port} (${scheme})`);
  console.log(`  本机：  ${scheme}://${shown}:${port}/`);
  if (host === '0.0.0.0') console.log(`  对外：  ${scheme}://<服务器公网IP>:${port}/`);
  console.log(`  健康：  ${scheme}://${shown}:${port}/healthz`);
  console.log('  榜单数据：.data/scores.json（与线上同一套规则）');
  console.log('');
});

/**
 * 优雅退出。
 *
 * systemctl restart 默认先发 SIGTERM，等 90 秒后才 SIGKILL。
 * 早期版本没接信号，进程一被停，房间里的人直接断线且拿不到任何提示。
 * 这里先停止接新连接、给已有连接发一句"服务器重启"再关闭，最后才退出。
 */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] 收到 ${signal}，正在关闭…`);

  server.close(() => console.log('[shutdown] HTTP 已停止接受新连接'));

  for (const socket of wss.clients) {
    try { socket.close(1012, 'server-restart'); } catch { /* 已断开 */ }
  }
  wss.close();

  // 给客户端 1.5 秒收尾，然后强制退出；systemd 的 TimeoutStopSec 也要留足
  const timer = setTimeout(() => {
    console.log('[shutdown] 完成');
    process.exit(0);
  }, 1500);
  timer.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
