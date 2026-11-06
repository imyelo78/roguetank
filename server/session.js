// 一条 WebSocket 连接的协议处理
//
// 平台无关：本机 node server.mjs（ws 库）与 Cloudflare Durable Object（原生
// WebSocket）共用这一份，避免两边对协议的理解慢慢分叉——比如一边允许空房间码
// 建房、另一边拒绝，玩家就会遇到"本机能建房、线上建不了"这种最难查的 bug。
//
// 只负责"会话"：解析消息、握手、转发输入。房间本身（谁在里面、怎么跑）由
// server/room.js 负责，这里不碰。

import { PROTOCOL_VERSION, C2S, S2C, DENY_TEXT } from '../src/core/protocol.js';

/** socket.readyState === 1 表示可写；Node 的 ws 与浏览器/DO 的 WebSocket 一致 */
const isOpen = (socket) => !!socket && socket.readyState === 1;

function listen(socket, type, handler) {
  // Node ws 与标准 WebSocket 都实现了 addEventListener，少数环境只有 on()
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(type, (ev) => handler(type === 'message' ? ev.data : ev));
  } else if (typeof socket.on === 'function') {
    socket.on(type, (arg) => handler(type === 'message' ? arg : arg));
  }
}

/**
 * 把连接接到房间上。
 *
 * @param socket  已建立的双向连接
 * @param join    (msg, helpers) => { ok:true, room, id, name } | { deny:'no-room' }
 *                helpers 提供 send/deny，方便实现方在拒绝前先回一句话
 * @param onLog   可选，日志回调（DO 里没有 console 的持久日志，可传空）
 */
export function attachSession(socket, { join, onLog = () => {} }) {
  const ctx = { room: null, id: null, name: '' };

  const send = (obj) => {
    try { if (isOpen(socket)) socket.send(JSON.stringify(obj)); } catch { /* 连接已断 */ }
  };
  const deny = (reason) => send({ k: S2C.DENY, reason, text: DENY_TEXT[reason] || '连接被拒绝' });

  listen(socket, 'message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return deny('bad-proto'); }
    if (!msg || typeof msg.k !== 'string') return deny('bad-proto');

    // ---- 握手：第一条必须是 hello ----
    if (!ctx.room) {
      if (msg.k !== C2S.HELLO) return deny('bad-proto');
      if (msg.v !== PROTOCOL_VERSION) return deny('bad-version');

      const r = join(msg, { send, deny });
      if (!r || r.deny) return deny(r?.deny || 'bad-proto');

      ctx.room = r.room;
      ctx.id = r.id;
      ctx.name = r.name;
      onLog('join', r.room.code, r.name);
      send(r.room.welcomePayload(r.id));
      return;
    }

    // ---- 已在房内 ----
    switch (msg.k) {
      case C2S.INPUT:
        ctx.room.onInput(ctx.id, msg);
        break;
      case C2S.READY:
        if (ctx.room.requestStart(ctx.id)) onLog('start', ctx.room.code, ctx.name);
        break;
      case C2S.PING:
        send({ k: S2C.PONG, t0: msg.t0, t1: Date.now() });
        break;
      case C2S.LEAVE:
        ctx.room.leave(ctx.id);
        ctx.room = null;
        try { socket.close(); } catch { /* 已关闭 */ }
        break;
      default:
        break;
    }
  });

  const onClose = () => {
    if (ctx.room) {
      onLog('leave', ctx.room.code, ctx.name);
      ctx.room.leave(ctx.id);
      ctx.room = null;
    }
  };
  listen(socket, 'close', onClose);
  listen(socket, 'error', () => { /* 统一由 close 清理 */ });

  return {
    get room() { return ctx.room; },
    get id() { return ctx.id; },
    send,
    deny,
  };
}

export { isOpen };
