// 一条 WebSocket 连接的协议处理
//
// 与传输层解耦：只依赖标准的 WebSocket 形状（readyState / send / addEventListener），
// 所以既能跑在 node 的 ws 上，也能被其它宿主复用与单独测试。
//
// 只负责"会话"：解析消息、握手、转发输入。房间本身（谁在里面、怎么跑）由
// server/room.js 负责，这里不碰。

import { PROTOCOL_VERSION, C2S, S2C, DENY_TEXT } from '../src/core/protocol.js';

/** socket.readyState === 1 表示可写；node ws 与标准 WebSocket 一致 */
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
  const deny = (reason, text) => send({
    k: S2C.DENY,
    reason,
    text: text || DENY_TEXT[reason] || '连接被拒绝',
    // 把服务端版本带回去：前端能直接显示"页面 v2 / 服务端 v1"，
    // 不用登服务器猜到底哪边没更新。
    v: PROTOCOL_VERSION,
  });

  listen(socket, 'message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return deny('bad-proto'); }
    if (!msg || typeof msg.k !== 'string') return deny('bad-proto');

    // ---- 握手：第一条必须是 hello ----
    if (!ctx.room) {
      if (msg.k !== C2S.HELLO) return deny('bad-proto');
      if (msg.v !== PROTOCOL_VERSION) {
        // 版本不符有两种方向，处理方式完全不同，文案必须分开：
        //   页面比服务端新 → 服务端还在跑旧代码，要重启 Node 进程（覆盖文件不等于生效）
        //   页面比服务端旧 → 浏览器缓存里的旧页面，强刷即可
        // 线上真实案例：覆盖了全部文件、protocol.js 也是 v2，但进程没重启，
        // 于是页面一直提示"客户端版本过旧"，用户以为是缓存问题反复强刷。
        const page = Number(msg.v);
        const newer = Number.isFinite(page) && page > PROTOCOL_VERSION;
        return deny('bad-version', newer
          ? `服务端仍是旧版本（页面 v${page}，服务端 v${PROTOCOL_VERSION}）。文件覆盖了但进程没重启，请在服务器上重启 Node 进程后再试。`
          : `页面版本过旧（页面 v${page}，服务端 v${PROTOCOL_VERSION}），按 Ctrl+Shift+R 强制刷新。`);
      }

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
