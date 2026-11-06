// 房间的 Cloudflare Durable Object 实现
//
// 为什么用 DO：房间是有状态的（谁在里面、世界跑到第几帧、敌人还剩几个），
// 而 Pages / Workers 的普通请求是无状态的，天然跑不了。
//
// ── 为什么不是"一个房间一个 DO" ──
// 最初的设计是 idFromName(房间码) 一个房间一个实例，看起来最干净，但实测不行：
// DO 的定时只能靠 alarm，而 alarm 的下限就在 100ms 附近（设 40ms 也要 106ms 才醒）。
// 15Hz 快照要求 66ms 一份，单靠 alarm 天然做不到，客户端就表现为"一顿一顿"。
// 而且每个房间各起一条 alarm，房间越多、边缘节点上的唤醒互相挤，抖动只会更糟。
//
// 现在的结构：整个 Worker 只有一个 DO（名字固定），它持有进程内的房间表，
// 用一条 alarm 统一驱动所有房间的 tick 与快照。房间内部仍是 server/room.js
// 那一套模拟与协议，没有分叉。
//
// 代价：所有房间跑在同一个实例上。对"4 人合作、同时几十个房间"这个量级足够，
// 真要横向扩展，可以按房间码哈希成若干分片（每个分片一个 DO），接口不用改。

import { Room } from '../server/room.js';
import { attachSession } from '../server/session.js';
import { TICK_RATE } from '../src/core/protocol.js';

const STEP_MS = 1000 / TICK_RATE;
/** alarm 周期。DO 平台下限约 100ms，就按 100ms 排。 */
const ALARM_MS = 100;
/** 一轮 alarm 最多补多少 tick，防止长挂起后一次性追太多。 */
const MAX_CATCHUP = 8;
/**
 * 快照节流的容差。
 *
 * alarm 的实际节拍在 100ms 上下浮动，一轮里能落 1~3 个 33ms 的步，
 * 快照判定的时间点因此不可能刚好压在 66.7ms 上。给 8ms 容差，
 * 让"差一点点就到点"的那一步也发出去，节奏才不会每两轮漏一帧。
 */
const SNAP_TOLERANCE_MS = 8;

export class RoomDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** code → Room */
    this.rooms = new Map();
    /** 世界时钟：上次推进到的时刻 */
    this._lastTickAt = 0;
    this._alarmArmed = false;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response(JSON.stringify({ ok: false, reason: 'expected-websocket' }), {
        status: 426,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const code = url.searchParams.get('code') || '';
    const create = url.searchParams.get('create') === '1';

    // 建房：这个码还活着就换一个（让 Worker 重试）
    if (create && this.rooms.has(code)) {
      return new Response('occupied', { status: 409 });
    }

    let room = this.rooms.get(code);

    // 房间码一旦发出就长期有效（存 storage）：
    // DO 被回收后，队友拿旧码还能把房间重新开起来，而不是"房间不存在"。
    const issued = await this.state.storage.get(`code:${code}`);
    if (!room && !create && !issued) {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      attachSession(server, { join: () => ({ deny: 'no-room' }) });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!room) {
      room = new Room({
        code,
        // DO 里实例可能随时被挂起，setTimeout 收不到；结算清理交给 alarm 循环
        noSelfDestroy: true,
        onEmpty: (r) => {
          this.rooms.delete(r.code);
        },
      });
      this.rooms.set(code, room);
    }

    if (create) {
      await this.state.storage.put(`code:${code}`, { at: Date.now() });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    attachSession(server, {
      join: (msg) => {
        const name = String(msg.name || '').trim().slice(0, 12) || '指挥官';
        const chassis = ['balanced', 'light', 'heavy', 'hunter'].includes(msg.chassis)
          ? msg.chassis : 'balanced';
        const r = room.join(server, { name, chassis, seed: msg.seed });
        if (!r.ok) return { deny: r.reason };
        this._arm();
        return { ok: true, room, id: r.id, name };
      },
    });

    this._arm();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 安排下一次 alarm（幂等）。at 省略时按标准周期排。 */
  async _arm(periodMs = ALARM_MS) {
    if (this._alarmArmed) return;
    this._alarmArmed = true;
    // 首次排期以此刻为世界时间的基准，避免把"建房到开打"这段空闲算成落后
    if (!this._lastTickAt) this._lastTickAt = Date.now();
    try {
      await this.state.storage.setAlarm(Date.now() + periodMs);
    } catch {
      this._alarmArmed = false;
    }
  }

  /**
   * 世界时钟。
   *
   * 关键点：一轮 alarm 里不能"连跑 N 步然后把 N 帧一起发出去"。
   * 那样客户端收到的是一团突发，插值缓冲（100ms）接不住，画面反而更顿。
   *
   * 所以这一轮按 33ms 的节拍把步分散开：每步之间 await 一个定时器，
   * 让快照真的散落在 100ms 窗口内。blockConcurrencyWhile 保证期间没有别的
   * 请求插进来改状态，节拍不会被输入消息打乱。
   */
  async alarm() {
    this._alarmArmed = false;

    const start = Date.now();
    const now = start;
    const last = this._lastTickAt || now;
    this._lastTickAt = now;
    const elapsed = Math.min(1000, now - last);
    const steps = Math.max(1, Math.min(MAX_CATCHUP, Math.round(elapsed / STEP_MS)));

    const runStep = () => {
      for (const room of [...this.rooms.values()]) {
        if (room.size === 0) { this.rooms.delete(room.code); continue; }
        if (room.over) continue;
        room._oneTick();
        if (!this.rooms.has(room.code)) continue;
        room.maybeSnapshot();
      }
    };

    if (steps <= 1) {
      runStep();
    } else {
      // 首步立即走（刚醒来的那一帧不该再等），其余按 33ms 散开
      runStep();
      await this.state.blockConcurrencyWhile(async () => {
        for (let i = 1; i < steps; i++) {
          await new Promise((r) => setTimeout(r, STEP_MS));
          runStep();
        }
      });
    }

    // 收尾：结算完的房间留 8 秒让客户端播完动画再撤
    for (const room of [...this.rooms.values()]) {
      if (!room.over) continue;
      room.endedAt = room.endedAt || now;
      if (now - room.endedAt > 8000 || room.size === 0) this.rooms.delete(room.code);
    }

    // 续订时把"本轮已经消耗的时间"扣掉：否则下一步总是在本轮最后一帧之后
    // 再等满 ALARM_MS，快照间隔会变成 (100 + 66) 而不是稳定的 66ms。
    if (this.rooms.size > 0) {
      const spent = Date.now() - start;
      this._arm(Math.max(0, ALARM_MS - spent));
    } else {
      await this.state.storage.deleteAlarm().catch(() => {});
    }
  }
}
