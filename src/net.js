// 联机客户端：连接、预测、插值
//
// 设计取舍（和 3D 坦克页游的做法一致，但更简单）：
//   - 自己的坦克：本地立刻按输入移动（预测），收到快照后只做温和校正。
//   - 队友与敌人：不预测，把快照按时间缓冲后插值，看起来才滑。
//   - 子弹：不预测实体，只根据服务端的开火事件播放飞行与命中。
//
// 这样即使延迟 100ms，操作手感依然是"跟手"的。

import {
  PROTOCOL_VERSION, C2S, S2C, TICK_RATE, SNAPSHOT_RATE,
  decodeSnapshot, normalizeRoomCode,
} from './core/protocol.js';
import { stepBody } from './core/motion.js';

/**
 * 渲染落后服务端多少毫秒（插值缓冲）。
 *
 * 快照间隔是 1000/SNAPSHOT_RATE（现在 20Hz → 50ms）。缓冲必须不少于一帧，
 * 否则 alpha 会经常撞到 1（直接贴最新帧），抖动就回来了。
 * 一帧半是经验值：同城/同局域网完全够用，延迟高的玩家会略微"看到过去"，
 * 但操作是自己的预测，手感不受影响。
 */
const interpMs = (hz) => Math.round(1500 / Math.max(1, hz));
const INTERP_MS = interpMs(SNAPSHOT_RATE);

/** 上行输入的最小间隔（毫秒）：与服务端 tick 同频，30Hz */
const INPUT_MS = 1000 / 30;

export class NetClient {
  constructor() {
    // 房间码字段叫 room，不叫 code。
    // code 在事件回调里太容易和"消息类型 / 错误码"混淆，早期版本叫 code，
    // 结果 welcome 里 msg.code 被同名局部变量遮住过一阵，排查了很久。
    this.ws = null;
    this.you = null;
    this.room = '';
    this.players = [];       // [{id, name, chassis}]
    this.state = 'idle';     // idle | connecting | lobby | playing | over | closed
    this.host = null;
    this.seq = 0;
    this.lastSnap = null;
    this.prevSnap = null;

    // 网络质量统计：卡顿时先看这里，别猜。
    // gapMs 是快照平均到达间隔（理论上 1000/SNAPSHOT_RATE），
    // stalls 记录超过 200ms 的停顿次数——它能区分"服务端发慢了"和"网络卡住"。
    this.netstat = { count: 0, gapMs: 0, gapMax: 0, stalls: 0, hz: 0 };
    this._lastSnapAt = 0;

    // 服务端最后一次拒绝的原因（{reason,text}）。用来区分"被拒绝"和"连不上"：
    // 两者都会触发 close，但给用户的提示完全不同。
    this.lastDeny = null;

    this.handlers = {
      welcome: [], deny: [], snap: [], event: [], roster: [], end: [], close: [],
    };

    this._pingT = 0;
    // 输入合帧用的状态（见 tick）
    this._lastSig = '';
    this._lastInputAt = 0;
  }

  on(kind, fn) {
    (this.handlers[kind] || (this.handlers[kind] = [])).push(fn);
    return this;
  }

  _emit(kind, payload) {
    for (const fn of this.handlers[kind] || []) {
      // 单个处理器出错不该拖垮整个客户端（比如某个 UI 元素缺失）
      try { fn(payload); } catch (e) { console.error('[net:' + kind + ']', e); }
    }
  }

  connect({ code = '', name, chassis }) {
    this.close();
    this.state = 'connecting';
    this.room = code ? normalizeRoomCode(code) : '';

    // 允许用 ?ws=host:port 指向另一台机器上的联机服务（本机静态托管 + 内网服务端）
    const override = resolveOverride();
    // 协议跟着页面走：https 页面必须 wss（浏览器会拦截混合内容），
    // http 页面（本机开发、纯 IP 直连）用 ws。
    const proto = override
      ? (override.startsWith('wss:') ? 'wss:' : 'ws:')
      : (location.protocol === 'https:' ? 'wss:' : 'ws:');
    const host = override || location.host;
    // 房间码同时放在查询串里：服务端可以在握手阶段就拿到房间码，便于将来做
    // 边缘路由/分片。server.mjs 以 hello 里的 code 为准，这个参数不影响行为。
    const q = this.room ? `?code=${encodeURIComponent(this.room)}` : '';
    const url = `${proto}//${host}/ws${q}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this.state = 'closed';
      this._emit('deny', { reason: 'offline', text: '连不上服务器' });
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ k: C2S.HELLO, v: PROTOCOL_VERSION, name, chassis, code: this.room }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      switch (msg.k) {
        case S2C.WELCOME:
          this.you = msg.you;
          this.room = msg.code || this.room;
          // 服务端的 code 字段名和客户端常量同名，这里统一落到 room 上，
          // 下游一律只读 net.room，避免出现"房间码明明是 PJTL、界面显示 ——"这种歧义。
          msg.code = this.room;
          this.players = msg.players || [];
          this.host = msg.host || null;
          this.state = msg.started ? 'playing' : 'lobby';
          this.lastSnap = null;
          this.prevSnap = null;
          this._emit('welcome', msg);
          break;

        case S2C.ROSTER:
          this.players = msg.players || [];
          this.host = msg.host || this.host;
          this._emit('roster', msg);
          break;

        case S2C.SNAP: {
          const snap = decodeSnapshot(msg);
          // 保留上一帧用于插值
          this.prevSnap = this.lastSnap;
          this.lastSnap = { ...snap, at: performance.now() };
          this._noteSnap(this.lastSnap.at);
          this.state = snap.state === 'over' ? 'over' : 'playing';
          this._emit('snap', this.lastSnap);
          break;
        }

        case S2C.EVENT:
          this._emit('event', msg.e || []);
          break;

        case S2C.END:
          this.state = 'over';
          this._emit('end', msg);
          break;

        case S2C.DENY:
          this.state = 'closed';
          // 记下服务端的拒绝原因：随后的 onclose 会再发一次 close 事件，
          // 上层如果不看这个字段，就会把"房间不存在"覆盖成"连不上服务器"。
          this.lastDeny = msg;
          this._emit('deny', msg);
          try { ws.close(); } catch { /* 已关闭 */ }
          break;

        case S2C.PONG:
          if (msg.t0) this.rtt = Date.now() - msg.t0;
          break;

        default:
          break;
      }
    };

    ws.onclose = () => {
      if (this.state !== 'over') this.state = 'closed';
      this._emit('close', {});
    };
    ws.onerror = () => { /* onclose 会处理 */ };
  }

  /** 记录快照到达节奏。只做滑动统计，不影响任何游戏逻辑。 */
  _noteSnap(at) {
    const s = this.netstat;
    const gap = this._lastSnapAt ? at - this._lastSnapAt : 0;
    this._lastSnapAt = at;
    s.count += 1;
    if (!gap) return;

    // 指数滑动平均，起步阶段直接采用首个样本
    s.gapMs = s.gapMs ? s.gapMs * 0.9 + gap * 0.1 : gap;
    if (gap > s.gapMax) s.gapMax = gap;
    if (gap > 200) s.stalls += 1;
    s.hz = s.gapMs > 0 ? 1000 / s.gapMs : 0;
  }

  /**
   * 每帧调用：发输入 + 心跳。
   *
   * 输入按 30Hz 合帧发送：服务端就是 30Hz 跑的，一帧里发两条一模一样的输入
   * 不会让车走得更远（后一条覆盖前一条，tick 照样只走一步），
   * 反而在 120Hz 屏幕上把上行带宽和 JSON 序列化开销翻四倍——
   * 弱网/手机上这直接表现为"按键后有半秒才动"。
   * 但按键状态变化必须立刻发，否则松键后车会多冲一小段。
   */
  tick(input, force = false) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const now = performance.now();
    const sig = `${input.mx}|${input.mz}|${input.fire ? 1 : 0}`;
    const changed = sig !== this._lastSig;
    if (!force && !changed && now - (this._lastInputAt || 0) < INPUT_MS) {
      this._pingIfDue(now);
      return;
    }
    this._lastSig = sig;
    this._lastInputAt = now;

    this.seq += 1;
    this.ws.send(JSON.stringify({
      k: C2S.INPUT,
      seq: this.seq,
      mx: input.mx,
      mz: input.mz,
      ax: Math.round(input.aimX * 10) / 10,
      az: Math.round(input.aimZ * 10) / 10,
      fire: !!input.fire,
    }));

    this._pingIfDue(now);
  }

  _pingIfDue(now) {
    if (now - this._pingT > 2000) {
      this._pingT = now;
      this.ws.send(JSON.stringify({ k: C2S.PING, t0: Date.now() }));
    }
  }

  start() {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ k: C2S.READY }));
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch { /* 已关闭 */ }
      this.ws = null;
    }
    this.state = 'idle';
    this.you = null;
    this.room = '';
    this.host = null;
    this.players = [];
    this.lastSnap = null;
    this.prevSnap = null;
    this.lastDeny = null;
  }

  // ---------------- 插值 ----------------

  /**
   * 取"渲染时刻"的实体位置。
   * 用两帧快照按时间线性插值，避免 20Hz 快照直接贴到 mesh 上导致的抖动。
   */
  sample() {
    const A = this.prevSnap;
    const B = this.lastSnap;
    if (!B) return null;
    if (!A) return { ...B, alpha: 1 };

    const span = Math.max(1, B.at - A.at);
    const target = B.at - INTERP_MS;
    const alpha = Math.max(0, Math.min(1, (target - A.at) / span));

    const lerpMap = (arrA, arrB) => {
      const map = new Map();
      for (const b of arrB) map.set(b.id, b);
      const out = [];
      for (const b of arrB) {
        const a = arrA.find((it) => it.id === b.id);
        if (!a) { out.push({ ...b, alpha: 1 }); continue; }
        out.push({
          ...b,
          x: a.x + (b.x - a.x) * alpha,
          z: a.z + (b.z - a.z) * alpha,
          yaw: lerpAngle(a.yaw, b.yaw, alpha),
          turretYaw: lerpAngle(a.turretYaw, b.turretYaw, alpha),
          alpha,
        });
      }
      return out;
    };

    return {
      tick: B.tick,
      wave: B.wave,
      state: B.state,
      scores: B.scores,
      left: B.left,
      players: lerpMap(A.players || [], B.players || []),
      enemies: lerpMap(A.enemies || [], B.enemies || []),
      bullets: B.bullets || [],
      alpha,
    };
  }
}

/** 角度插值要走最短弧，否则炮塔会突然转一整圈 */
function lerpAngle(a, b, t) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * t;
}

/** 角度差归一化到 [-PI, PI] */
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/**
 * ?ws=192.168.1.20:5173 → 联机服务在别的机器上。
 * 用途：页面放 GitHub Pages（纯静态），房间服务跑在自己的小服务器上；
 * 或者手机只开页面、服务端在开发机上调试。
 */
function resolveOverride() {
  try {
    const v = new URLSearchParams(location.search).get('ws');
    if (!v) return '';
    return v.replace(/^https?:\/\//, '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

/**
 * 本地预测：把自己的坦克按输入推进，用于跟手。
 *
 * 转向 / 加速 / 撞墙滑行全部交给 core/motion.js —— 服务端跑的是同一个函数。
 * 这里只负责"补一步"。碰撞参数（col / half）由调用方传，因为只有
 * 渲染层（coop.js）手里才有地图碰撞表。
 *
 * 别名 `predictStep` 供 coop.js 按 tick 累积调用，名字更贴近语义。
 */
export function predict(me, input, dt, col, half) {
  if (!me) return;
  stepBody(me, input, dt, col, half);
}

/** 对外暴露一份，渲染层按 tick 累积时用它（同一个实现，只是名字直白些） */
export const predictStep = predict;

export { TICK_RATE };
