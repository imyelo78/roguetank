// 房间：把 World 包成可联网的东西
//
// 职责边界很窄：谁在房里、每 tick 跑一次模拟、把结果广播出去。
// 模拟本身全在 src/core/world.js，服务端不做任何"游戏规则"的判断。

import { World, HALF } from '../src/core/world.js';
import {
  PROTOCOL_VERSION, TICK_RATE, SNAPSHOT_RATE, MAX_PLAYERS, S2C,
  encodeSnapshot, makeRoomCode,
} from '../src/core/protocol.js';

const TICK_MS = 1000 / TICK_RATE;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const SNAP_MS = 1000 / SNAPSHOT_RATE;

/** 一名玩家在房间里的连接状态 */
class Member {
  constructor(id, socket, { name, chassis }) {
    this.id = id;
    this.socket = socket;
    this.name = name;
    this.chassis = chassis;
    this.input = { mx: 0, mz: 0, aimX: 0, aimZ: 0, fire: false, seq: 0 };
    this.lastSeq = -1;
    this.ready = false;
    this.disconnectedAt = 0;
    this.rtt = 0;
  }
}

export class Room {
  constructor({ code, onEmpty }) {
    this.code = code || makeRoomCode();
    this.members = new Map();
    this.autoStartT = 0;
    this.world = null;
    this.timer = null;
    this.onEmpty = onEmpty;
    this.createdAt = Date.now();
    this.startedAt = 0;
    this.seq = 0;
    // 上次发快照的时刻（时间节流用，见 _oneTick）
    this._lastSnapAt = 0;
  }

  get size() { return this.members.size; }

  /** 加入。返回 { ok } 或 { ok:false, reason } */
  join(socket, { name, chassis, seed }) {
    if (this.members.size >= MAX_PLAYERS && !this._reclaimable()) {
      return { ok: false, reason: 'full' };
    }

    // 同名断线重连：回收旧席位
    const stale = [...this.members.values()].find(
      (m) => m.name === name && (!m.socket || m.socket.readyState > 1),
    );
    if (stale) this.members.delete(stale.id);

    const id = `u${++this.seq}`;
    const m = new Member(id, socket, { name, chassis });
    this.members.set(id, m);

    if (!this.world) {
      this.world = new World({ code: this.code, seed: seed || (Math.random() * 0xFFFFFFFF) | 0, maxPlayers: MAX_PLAYERS });
    }
    this.world.addPlayer({ id, name, chassisId: chassis });

    // 房主 = 第一个进来的人。房主可以不等 3 秒直接开打。
    if (!this.hostId) this.hostId = id;

    // 有人进来就开倒计时：3 秒后自动开打，避免"等人等到烦"
    // 已经开打就不重置倒计时（否则中途加入会打断别人）
    if (!this.startedAt) this.autoStartT = 3;

    this._broadcastRoster();
    return { ok: true, id };
  }

  /** 房主点「开始战斗」：立刻开局，不等倒计时 */
  requestStart(id) {
    if (this.startedAt || !this.world || !this.world.players.length) return false;
    if (id && this.hostId && id !== this.hostId) return false;
    this.autoStartT = 0;
    this.world.start();
    this.startedAt = Date.now();
    return true;
  }

  _reclaimable() {
    return [...this.members.values()].some((m) => !m.socket || m.socket.readyState > 1);
  }

  leave(id) {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    if (this.world) this.world.removePlayer(id);
    this._broadcastRoster();
    if (this.members.size === 0) this.destroy();
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onEmpty?.(this);
  }

  /**
   * 启动 tick 循环。
   *
   * 计时用 performance.now()（亚毫秒精度）。早期版本用 Date.now()（整毫秒），
   * 当定时器实际步长只有 8ms 时，毫秒取整会把累加器永远压在 33ms 以下，
   * 结果就是"房间在跑但世界不动"——这类问题在日志里完全看不出来，只能靠单测抓住。
   *
   * periodMs：轮询间隔，默认 4ms（追逐精确的 33.3ms tick）。
   * 宿主定时器精度不够时可以传更大的值，靠累加器补帧，实际 tick 频率不变。
   */
  run(periodMs = 4) {
    if (this.timer) return;
    let acc = 0;
    let last = nowMs();
    const period = Math.max(1, periodMs);
    // 一次回调最多补几帧：4ms 轮询下补 8 帧足够，间隔更大时也不会雪崩
    const maxCatchUp = period >= 20 ? 3 : 8;

    this.timer = setInterval(() => {
      const t = nowMs();
      acc += t - last;
      last = t;

      // 落后太多就丢弃积压，宁可跳帧也不要雪崩
      if (acc > TICK_MS * 5) acc = TICK_MS;

      let guard = 0;
      while (acc >= TICK_MS && guard++ < maxCatchUp) {
        acc -= TICK_MS;
        // 把"这一步对应的真实时刻"传下去：快照按模拟时间发，
        // 而不是按"谁先跑到判定点"。否则同一次回调里连走两步时，
        // 第一步到点发一次、第二步立刻又覆盖发一次，快照就变成
        // tick 增量 2,2,2,2,1 的锯齿——客户端每帧拿到的是最后一次覆盖的
        // 第二帧位置，本地只预测了一帧，偏差恒等于"跑一帧的距离"，看起来就是拖拽。
        this._oneTick(t - acc);
      }
      // 快照独立按时间发：轮询间隔再小，对外也是稳定的 15Hz
      this.maybeSnapshot();
    }, period);
  }

  /**
   * 走一步模拟。
   *
   * 快照按"真实时间"节流，而不是按 tick 计数（tick % SNAP_EVERY）。
   * 原因：如果按 tick 计数（tick % SNAP_EVERY）发快照，一旦宿主某次回调里
   * 连走了好几步，就会"一次涌出 8 帧、然后静默 260ms"——客户端插值缓冲
   * 只有 100ms，碰上这种突发就一顿一顿。改用时间节流后，
   * 无论调用方一次走一步还是一次走八步，对外发出的快照间隔都稳定在 66ms。
   */
  _oneTick(tickTime = nowMs()) {
    const w = this.world;
    if (!w) return;

    // 自动开局
    if (!this.startedAt && this.autoStartT > 0) {
      this.autoStartT -= TICK_MS / 1000;
      if (this.autoStartT <= 0 && w.players.length > 0) {
        w.start();
        this.startedAt = Date.now();
      }
    }

    // 把每个成员的最新输入灌进世界
    for (const m of this.members.values()) {
      w.setInput(m.id, m.input);
    }
    const events = w.step(1 / TICK_RATE);

    // 事件立刻转发（不等快照），这样击杀反馈没有额外延迟
    if (events.length) {
      const msg = JSON.stringify({ k: S2C.EVENT, e: events });
      for (const m of this.members.values()) this._send(m, msg);
    }

    // 快照按真实时间单独节流（见 tick 说明）。
    // 这里不用 w.tick 计数，因为一次调用可能连走多步，计数会把快照挤成突发。
    this._maybeSnapshotAt(tickTime);

    if (w.state === 'over') {
      const results = w.players
        .map((p) => ({ id: p.id, name: p.name, kills: p.stats.kills, score: p.stats.score, wave: w.wave }))
        .sort((a, b) => b.score - a.score);
      const msg = JSON.stringify({ k: S2C.END, results, wave: w.wave });
      for (const m of this.members.values()) this._send(m, msg);
      this._running = false;
      this.startedAt = 0;
      this.over = true;
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      // 结算后再留一会儿，让客户端播完动画再回收。
      // noSelfDestroy=true 的宿主（生命周期不受自己控制）跳过这步，由宿主自己回收。
      if (this.noSelfDestroy) return;
      setTimeout(() => this.destroy(), 8000);
    }
  }

  /**
   * 到点就发一份快照。
   *
   * 与 _oneTick 解耦，是因为宿主调用节奏可能不均匀。
   * 如果快照挂在内层循环里，节奏就跟着宿主调用频率走，客户端插值缓冲接不住。
   *
   * catchUp=true 时会把错过的帧一次性补出来，让客户端收到的仍是连续的 15Hz 序列；
   * 本机 4ms 轮询不需要补，避免重复发。
   */
  maybeSnapshot(catchUp = false) {
    if (!this.world || !this.members.size) return;
    this._maybeSnapshotAt(nowMs(), catchUp);
  }

  /**
   * 同 maybeSnapshot，但快照的"时刻"由调用方给。
   *
   * 用途：run() 里一次回调可能连走 2~3 步模拟。如果每一步都按 nowMs() 判定，
   * 第一步恰好到点发了快照，第二步马上又到点（因为 nowMs() 没变，但容差 −8ms
   * 让它又通过），结果是一次回调发两帧、然后静默一整帧。
   * 传"这一步对应的模拟时刻"后，同一时刻只会发一帧，快照序列严格单调。
   */
  _maybeSnapshotAt(at, catchUp = false) {
    if (!this.world || !this.members.size) return;
    const gap = at - this._lastSnapAt;
    // 容差取"最小相邻 tick 间隔的一半"：
    // 20Hz 快照 = 1.5 个 30Hz tick，像原来那样按 8ms 容差判断，
    // 会在 1 tick 和 2 tick 之间随机跳，快照间隔忽长忽短，客户端残差跟着抖。
    if (gap < SNAP_MS - TICK_MS / 2) return;

    if (catchUp) {
      // 宿主是低频 alarm（DO）：这一轮可能欠了 2~3 帧，一次补齐，
      // 让客户端那边的序列保持连续。上限 3 帧，防止长挂起后狂发。
      const due = Math.min(3, Math.max(1, Math.round(gap / SNAP_MS)));
      this._lastSnapAt = at;
      for (let i = 0; i < due; i++) this._broadcastSnapshot();
      return;
    }

    this._lastSnapAt = at;
    this._broadcastSnapshot();
  }

  _broadcastSnapshot() {
    const w = this.world;
    // 快照只发"这个房间里真实存在的成员"，顺序与 members 一致，
    // 这样 scores 数组可以按同一下标对应到玩家
    const players = [...this.members.keys()]
      .map((id) => w.players.find((p) => p.id === id))
      .filter(Boolean);

    const snap = encodeSnapshot({
      tick: w.tick,
      wave: w.wave,
      state: w.state,
      players,
      enemies: w.enemies,
      bullets: w.bullets,
      enemiesLeft: w.enemies.length + w.pending.length,
    });
    const msg = JSON.stringify(snap);
    for (const m of this.members.values()) this._send(m, msg);
  }

  /** 收到客户端输入 */
  onInput(id, inp) {
    const m = this.members.get(id);
    if (!m) return;
    // 丢弃重放/乱序的输入（seq 单调）
    if (typeof inp.seq === 'number' && inp.seq <= m.lastSeq) return;
    m.lastSeq = typeof inp.seq === 'number' ? inp.seq : m.lastSeq;
    m.input = {
      // 八方向平移，与单机 Game.js 的 WASD 完全同构。
      // 服务端不认"方向盘"：老字段 f/t 即使收到也会被当成 0，
      // 所以协议版本升到 2，旧页面在握手阶段就被拦下。
      mx: clampDir(inp.mx),
      mz: clampDir(inp.mz),
      aimX: Number(inp.ax) || 0,
      aimZ: Number(inp.az) || 0,
      fire: !!inp.fire,
      seq: inp.seq,
    };
  }

  welcomePayload(id) {
    const w = this.world;
    const me = this.members.get(id);
    return {
      k: S2C.WELCOME,
      v: PROTOCOL_VERSION,
      you: id,
      code: this.code,
      tick: w.tick,
      tickRate: TICK_RATE,
      maxPlayers: MAX_PLAYERS,
      started: !!this.startedAt,
      players: [...this.members.values()].map((m) => ({ id: m.id, name: m.name, chassis: m.chassis })),
      host: this.hostId || null,
      world: w.fullState(),
      seed: w.seed,
    };
  }

  rosterPayload() {
    return {
      k: S2C.ROSTER,
      players: [...this.members.values()].map((m) => ({ id: m.id, name: m.name, chassis: m.chassis })),
      started: !!this.startedAt,
      host: this.hostId || null,
    };
  }

  _broadcastRoster() {
    const msg = JSON.stringify(this.rosterPayload());
    for (const m of this.members.values()) this._send(m, msg);
  }

  _send(m, data) {
    try {
      if (m.socket && m.socket.readyState === 1) m.socket.send(data);
    } catch { /* 连接已断，等 onclose 处理 */ }
  }
}

const clampDir = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
};

/** 房间表：一个进程内的所有房间 */
export class RoomRegistry {
  constructor() {
    this.rooms = new Map();
  }

  create() {
    let code = makeRoomCode();
    let guard = 0;
    while (this.rooms.has(code) && guard++ < 50) code = makeRoomCode();

    const room = new Room({
      code,
      onEmpty: (r) => {
        this.rooms.delete(r.code);
        console.log(`[room] ${r.code} 结束（${this.rooms.size} 个房间在跑）`);
      },
    });
    this.rooms.set(code, room);
    room.run();
    console.log(`[room] ${code} 创建（${this.rooms.size} 个房间在跑）`);
    return room;
  }

  get(code) {
    return this.rooms.get(code) || null;
  }

  stats() {
    return {
      rooms: this.rooms.size,
      players: [...this.rooms.values()].reduce((s, r) => s + r.size, 0),
    };
  }
}

export { HALF };
