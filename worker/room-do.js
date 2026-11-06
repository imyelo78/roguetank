// 房间的 Cloudflare Durable Object 实现
//
// 为什么用 DO：房间是有状态的（谁在里面、世界跑到第几帧、敌人还剩几个），
// 而 Pages / Workers 的普通请求是无状态的，天然跑不了。DO 一个实例 = 一个房间，
// 地址由房间码决定（idFromName），全世界同一个码必然落到同一个实例上。
//
// 这里刻意不重写游戏逻辑：模拟还是 src/core/world.js，房间还是 server/room.js，
// 协议还是 server/session.js。DO 只负责"把 WebSocket 接上"和"提供定时器"，
// 这样本地 node server.mjs 与线上跑的是同一套代码，不会出现两边行为不一致。

import { Room } from '../server/room.js';
import { attachSession } from '../server/session.js';

/** DO 里定时器按 CPU 计费，用 33ms 一档、每次补帧，实际 tick 仍是 30Hz */
const TICK_PERIOD_MS = 33;

export class RoomDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
    // 房间码就是 DO 的名字。Worker 用 idFromName(code) 找到这里。
    this.code = state.id?.name || '';
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response(JSON.stringify({ ok: false, reason: 'expected-websocket' }), {
        status: 426,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const create = url.searchParams.get('create') === '1';

    // 建房请求撞到已占用的实例 → 让 Worker 换一个码重试
    if (create && this.room && this.room.size > 0) {
      return new Response('occupied', { status: 409 });
    }

    // 房间码一旦发出就长期有效（存在 storage 里）：
    // 这样 DO 被回收后，队友拿旧码还能重新开起来，而不是"房间不存在"。
    const issued = await this.state.storage.get('code');
    if (!create && !issued) {
      // 客户端凭空输入的码：先接上连接，回一句"房间不存在"再断开，
      // 和本地服务端的行为保持一致（客户端有现成的 deny 处理）。
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      attachSession(server, { join: () => ({ deny: 'no-room' }) });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!this.room) {
      this.room = new Room({
        code: this.code,
        onEmpty: () => {
          // 人都走了：停掉 tick，等下一次有人进来再重建
          this.room = null;
        },
      });
      this.room.run(TICK_PERIOD_MS);
    }
    if (create) await this.state.storage.put('code', { code: this.code, at: Date.now() });

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const room = this.room;
    attachSession(server, {
      join: (msg) => {
        const name = String(msg.name || '').trim().slice(0, 12) || '指挥官';
        const chassis = ['balanced', 'light', 'heavy', 'hunter'].includes(msg.chassis)
          ? msg.chassis : 'balanced';
        const r = room.join(server, { name, chassis, seed: msg.seed });
        if (!r.ok) return { deny: r.reason };
        return { ok: true, room, id: r.id, name };
      },
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
