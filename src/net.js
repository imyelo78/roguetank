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
 * 插值延迟按 tick 格数自适应（见 _renderTick / _updateInterp），并按**快照历史**
 * 而不是"最后两帧"取插值段（见 sample）。
 *
 * 服务端 30Hz 推进 / 15Hz 发快照，相邻帧 tick 差恒为 2。客户端退 2~4 格，
 * 渲染游标因此常常落在倒数第 2~3 帧之间——只留两帧缓冲时它会被死死夹在
 * 上一帧的 tick 上，alpha 恒 0，所有远端实体每 66ms 跳一格。
 * 保留 8 帧历史后，游标始终能找到真正跨越它的一对快照，插值帧帧连续。
 */

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
    this.make = false;
    this.players = [];       // [{id, name, chassis}]
    this.state = 'idle';     // idle | connecting | lobby | playing | over | closed
    this.host = null;
    this.seq = 0;
    this.lastSnap = null;
    this.prevSnap = null;

    // 快照历史缓冲。插值游标要"从最新帧往回退 2~4 格"，只留两帧根本不够：
    // 退 3 格时游标落在上上段，两帧缓冲只能把它夹在 A.tick 上，alpha 恒 0，
    // 于是队友 / 敌人 / 子弹每 66ms 跳一格——这才是"所有东西都在抖"的病根。
    // 留 8 帧（约 0.5 秒）后，游标始终能找到真正跨越它的那一对快照。
    // lastSnap / prevSnap 保留为缓冲尾部的视图，兼容 coop.js 等已有读取方。
    this.snaps = [];
    this.SNAP_BUF = 8;

    // ---- 平滑的服务端时钟 ----
    // 渲染游标不能挂在"最新快照的到达时刻"上：那条快照早到 10ms / 晚到 10ms，
    // 游标就跟着回摆 / 前跳 0.3 格，画面表现为细碎的来回抖（浏览器实测
    // alpha 序列在 0.03~0.87 之间乱跳就是这个）。这里维护一个低通滤波后的
    // 「服务端 tick 时间轴 ↔ 本地时钟」偏移，快照只负责提供位置，不负责计时。
    this._serverOffset = null;   // 毫秒；null = 还没收到第一条快照
    this._interpDelay = 3;       // 浮点延迟（tick 格），平滑趋近 _interpTicks
    this._lastRenderAt = 0;

    // 网络质量统计：卡顿时先看这里，别猜。
    // gapMs 是快照平均到达间隔（理论上 1000/SNAPSHOT_RATE），
    // stalls 记录超过 200ms 的停顿次数——它能区分"服务端发慢了"和"网络卡住"。
    // ticks 记录平均每个快照间隔推进几个 tick——它比 hz 更能说明插值是否平滑：
    // 服务端 15Hz 发声、30Hz 推进，稳定的序列是 2,2,2,2…；出现 1 就说明发早了。
    this.netstat = { count: 0, gapMs: 0, gapMax: 0, stalls: 0, hz: 0, ticks: 0 };
    this._lastSnapAt = 0;

    // ---- 自适应插值延迟（见 _renderTick）----
    // 相邻快照的 tick 差在 1 和 2 之间跳（20Hz 发 / 30Hz 推进），所以插值
    // 必须至少退 2 格才不会被"最新快照的 tick"夹住。再加一点网络抖动余量。
    this._interpTicks = 3;        // 当前生效的延迟（tick 数）
    this._interpFrozen = 0;       // 夹死帧计数（诊断用，见 _renderTick）

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

  connect({ code = '', name, chassis, make = false }) {
    this.close();
    this.state = 'connecting';
    this.room = code ? normalizeRoomCode(code) : '';
    this.make = !!make && !!this.room;   // 带码建房：服务端按这个码开新房间

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
      ws.send(JSON.stringify({ k: C2S.HELLO, v: PROTOCOL_VERSION, name, chassis, code: this.room, make: !!this.make }));
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
          // 地表场只下发"种子 + 强度"，格点由两端各自用同一个纯函数重建。
          // 客户端不猜、也不读 URL 参数，否则四人房里会出现两种地面。
          // 老服务端没有这个字段时留 null（全草地 + 速度 1.0），行为与改造前一致。
          const t = msg.terrain ?? msg.world?.terrain;
          // 本波的三选一（来自 S2C.CARDS）。null = 现在没在选卡。
    // 由 coop 渲染；放这里是为了重连时 welcome 后补发的那一条也能落到同一个地方。
    this.cards = null;
    this.terrain = (t && typeof t === 'object' && t.seed)
            ? {
              seed: t.seed >>> 0,
              k: Number(t.k ?? 1),
              preset: t.preset || 'standard',
              tile: t.tile || 8,
            }
            : null;
          this.state = msg.started ? 'playing' : 'lobby';
          this.lastSnap = null;
          this.prevSnap = null;
          this.snaps = [];
          this._serverOffset = null;
          this._interpDelay = 3;
          this._interpTicks = 3;
          this._interpFrozen = 0;
          this._lastRenderAt = 0;
          this._emit('welcome', msg);
          break;

        case S2C.ROSTER:
          this.players = msg.players || [];
          this.host = msg.host || this.host;
          this._emit('roster', msg);
          break;

        case S2C.SNAP: {
          const snap = decodeSnapshot(msg);
          // _noteSnap 用它算"每条快照推进几格"，必须是**上一条**快照，
          // 不能是上上条（那是两个周期，统计值会翻倍）。
          this._snapBefore = this.lastSnap;
          const entry = { ...snap, at: performance.now() };
          // ---- tick 回退 = 新一局，必须整段重置 ----
          //
          // 服务端 `world.start()` 会把 tick 归零重来（lobby 阶段已经跑到 86，
          // 开局后从 0 重新数）。客户端只做"tick 必须递增"的防乱序，于是
          // 认为后面几十条都是乱序包，全部丢弃；要等服务端 tick 重新爬过 86
          // （≈2.9 秒）才恢复接收。
          //
          // 表现就是：**点「开始战斗」后，队友/敌人/子弹定格约 3 秒**，
          // 自己那辆车因为有本地预测还能动，于是看起来像"别人卡住了"。
          // 更糟的是恢复的瞬间 `_serverOffset` 因为 tick 时间轴换了基准而跳变
          // 3000ms，渲染游标一口气超前 60 多格，要好几秒才收回来。
          //
          // 修法：tick 明显倒退就当作新一局，清空缓冲、重置时钟基准。
          //
          // 阈值取"倒退超过 SNAP_BUF 个周期"：正常乱序 / 重连补帧最多差一两帧，
          // 而开局的归零会退回几十格。用一个大阈值把两者分开，避免把普通的
          // 乱序包误判成新一局（那会白白清空缓冲、闪一下画面）。
          const buf = this.snaps;
          const lastTick = buf.length ? buf[buf.length - 1].tick : -1;
          const RESET_GAP = this.SNAP_BUF * (TICK_RATE / SNAPSHOT_RATE) * 2;
          if (lastTick >= 0 && entry.tick < lastTick - RESET_GAP) {
            this.snaps = [];
            this._serverOffset = null;
            this._interpDelay = 3;
            this._lastRenderAt = 0;
          }
          if (!this.snaps.length || entry.tick > this.snaps[this.snaps.length - 1].tick) {
            this.snaps.push(entry);
            if (this.snaps.length > this.SNAP_BUF) this.snaps.shift();
          }
          this.lastSnap = this.snaps[this.snaps.length - 1];
          this.prevSnap = this.snaps.length > 1
            ? this.snaps[this.snaps.length - 2] : null;

          // serviceTick 时间轴 = tick * tickMs。由到达时刻反推本地时钟偏移并
          // 低通滤波，单条快照的早到 / 晚到不会再直接推动渲染游标。
          // 系数 0.08 ≈ 12 条快照（0.8 秒）收敛，足够跟住真实时钟漂移。
          const observed = this.lastSnap.tick * (1000 / TICK_RATE) - this.lastSnap.at;
          this._serverOffset = this._serverOffset === null
            ? observed
            : this._serverOffset + (observed - this._serverOffset) * 0.08;

          this._noteSnap(entry.at);
          this._updateInterp();
          this.state = snap.state === 'over' ? 'over' : 'playing';
          this._emit('snap', this.lastSnap);
          break;
        }

        case S2C.CARDS:
          this.cards = {
            wave: msg.wave,
            options: msg.options || [],
            until: performance.now() + (msg.ms || 12000),
            // 服务端权威的成长数值（快照不带成长）。coop 在弹面板前用它
            // 对齐本地 me.stats / speedBase，否则本地预测会一直按旧速度跑。
            stats: msg.stats || null,
          };
          this._emit('cards', this.cards);
          break;

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
    // gapMax 必须能回落：原先是"历史最大值"，一次偶发的 70ms 抖动就把
    // 插值延迟永久顶高，之后网络恢复平滑也退不回来。每帧缓慢衰减（半衰期
    // 约 1.5 秒），只让最近的抖动生效。
    s.gapMax = Math.max(gap, (s.gapMax || 0) * 0.97);
    if (gap > 200) s.stalls += 1;
    s.hz = s.gapMs > 0 ? 1000 / s.gapMs : 0;
    if (this._snapBefore) {
      const dt = this.lastSnap.tick - this._snapBefore.tick;
      s.ticks = s.ticks ? s.ticks * 0.9 + dt * 0.1 : dt;
    }
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

  /** 选一张卡。服务端会校验"这张卡确实在他的选项里"，本地只做防连点 */
  pick(id) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    if (!this.cards || !this.cards.options.some((o) => o.id === id)) return false;
    this.ws.send(JSON.stringify({ k: C2S.PICK, id }));
    // 本地先关面板：等服务端确认会有一帧的空窗，玩家会以为没点上又点一次
    this.cards = null;
    return true;
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
    this.make = false;
    this.host = null;
    this.players = [];
    this.lastSnap = null;
    this.prevSnap = null;
    this.snaps = [];
    this._serverOffset = null;
    this._interpDelay = 3;
    this._interpTicks = 3;
    this._lastRenderAt = 0;
    this._interpFrozen = 0;
    this.lastDeny = null;
  }

  // ---------------- 插值 ----------------

  /**
   * 取"渲染时刻"的实体位置。
   *
   * 常规做法是"按到达时间在两帧之间插值"，但这里不行：
   *   - 到达时间取决于网络抖动，同一段匀速运动会被切成忽长忽短的片段；
   *   - 目标时刻 line 是 now-150ms，而帧里只有到达时间，没有"这一帧代表哪个时刻"，
   *     alpha 会经常撞到 1（直接贴最新帧）再跳回来。
   * 两者叠加就是"整个场景在抖"，而自己的车因为优先级高、贴着屏幕中心，抖得最明显。
   *
   * 现在改成按**服务端的 tick 序号**插值：快照里本来就带 tick，
   * 它严格单调、与实际模拟时刻线性对应，抖动源被彻底去掉。
   */
  /**
   * 本帧应该在服务端时间轴的哪个 tick 上渲染。
   *
   * 从"最新快照的 tick"往回退 _interpTicks 格（约 67~133ms）。服务端
   * tick 严格单调、与模拟时刻线性对应，不受到达抖动影响。
   *
   * ⚠ 为什么必须同时加深缓冲（08~13 版抖动的真正根因）：
   *   缓冲只有 prevSnap / lastSnap 两帧时，可插值区间只有 [A.tick, B.tick]，
   *   也就是最新那一段（2 格 / 66ms）。而延迟被网络抖动抬到 3~4 格后，
   *   渲染游标会落在更早的段里，于是每帧都被 Math.max(minTick, ...) 夹在
   *   A.tick 上，alpha 恒 0；直到下一条快照到达才整段跳一格。实测线上
   *   一周期内 100% 的渲染帧被夹死，队友 / 敌人 / 子弹全部一顿一顿。
   *   这跟"预测残差怎么调"完全无关——自己的车预测得再准也没用。
   *
   *   现在：缓冲 8 帧（约 0.5 秒），minTick 退到很久以前，clamp 只在
   *   快照真正断流时才触发；sample() 会去历史里挑跨越游标的那一段。
   */
  _renderTick() {
    const B = this.lastSnap;
    if (!B) return 0;
    const now = performance.now();
    const tickMs = 1000 / TICK_RATE;

    // 延迟连续过渡：_interpTicks 是整数目标，直接拿来用会在 3↔4 切换的那帧
    // 把游标瞬间拉回 1 格（33ms 位移），比它想吸收的抖动还扎眼。摊到几十帧里。
    const dtMs = this._lastRenderAt
      ? Math.min(100, Math.max(0, now - this._lastRenderAt)) : 16;
    this._lastRenderAt = now;
    this._interpDelay += (this._interpTicks - this._interpDelay)
      * (1 - Math.exp(-dtMs / 400));

    // 时间基准取平滑后的服务端时钟，而不是"最新快照到达了多久"。
    // 快照只提供位置；早到 / 晚到由 _serverOffset 的低通滤波吸收。
    const offset = this._serverOffset ?? (B.tick * tickMs - B.at);
    const want = (now + offset) / tickMs - this._interpDelay;

    // 可渲染区间由**整个缓冲**决定，而不是只由"上一帧"决定。
    // 旧版只有 prevSnap/lastSnap 两帧，minTick 就是 prevSnap.tick；
    // 一旦延迟退到 3 格，want 落在更早的一段里，必然被夹到 minTick，
    // alpha 恒 0 —— 远端实体每 66ms 才跳一格。缓冲加深后，这个 clamp
    // 只在快照真正断流时才生效，正常播放应一次都不触发。
    const buf = this.snaps;
    const minTick = buf.length ? buf[0].tick : B.tick;
    const out = Math.max(minTick, Math.min(B.tick, want));
    if (want > B.tick || want < minTick) this._interpFrozen++;
    return out;
  }

  /**
   * 每条快照到达时更新插值延迟（在 SNAP 处理里紧接着 _noteSnap 调用）。
   *
   * 服务端按 tick 计数发帧（每 2 个 tick 一帧，段长恒为 2），
   * 所以插值退 2 格正好让渲染游标落在"上一帧到当前帧"区间内，帧帧踩实。
   * 只有网络抖动明显超出标称间隔时才多加格子兜底。
   */
  _updateInterp() {
    const s = this.netstat;
    const tickMs = 1000 / TICK_RATE;
    // 段长 = TICK_RATE / SNAPSHOT_RATE = 2 格；延迟取同值，游标恰好在段内匀速走。
    const base = Math.max(2, Math.round(TICK_RATE / SNAPSHOT_RATE));
    const overshoot = Math.max(0, (s.gapMax || 0) - 1000 / SNAPSHOT_RATE);
    const jitter = Math.min(2, Math.ceil(overshoot / tickMs));
    // 延迟上限同时受缓冲深度约束：缓冲至少要能兜住 want 格。
    // 8 帧 × 2 格 = 16 格，limit 取 6 完全在安全范围内；这里仍显式算一遍，
    // 免得以后有人把 SNAP_BUF 调小又悄悄把插值夹死回去。
    const bufferTicks = Math.max(base, (this.SNAP_BUF - 2) * base);
    const want = Math.max(base, Math.min(Math.min(6, bufferTicks), base + jitter));
    // 一次只挪一格：延迟跳变本身也会让人看出来
    if (want > this._interpTicks) this._interpTicks++;
    else if (want < this._interpTicks) this._interpTicks = Math.max(base, this._interpTicks - 1);
  }

  sample() {
    const buf = this.snaps;
    if (!buf.length) return null;
    const newest = buf[buf.length - 1];
    if (buf.length === 1) return { ...newest, alpha: 1 };

    const targetTick = this._renderTick();

    // 在历史里找**真正跨越**渲染游标的那一段，而不是固定拿最后两帧。
    // 延迟退 3 格时游标落在倒数第 2~3 帧之间，固定两帧会把它夹死在
    // prevSnap.tick 上，alpha 恒 0 —— 12/13 版"全部实体一起抖"就是这么来的。
    let i = buf.length - 2;
    while (i > 0 && buf[i].tick > targetTick) i--;
    const A = buf[i];
    const B = buf[i + 1];
    const span = Math.max(1, B.tick - A.tick);
    const alpha = Math.max(0, Math.min(1, (targetTick - A.tick) / span));

    const lerpMap = (arrA, arrB) => {
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

    // 子弹以前直接用最新帧，等于每种 66ms 跳一格；现在一并插值。
    const lerpBullets = (arrA, arrB) => (arrB || []).map((b) => {
      const a = (arrA || []).find((it) => it.id === b.id);
      if (!a) return b;
      return {
        ...b,
        x: a.x + (b.x - a.x) * alpha,
        z: a.z + (b.z - a.z) * alpha,
      };
    });

    // 波次 / 状态 / 分数这类元数据不插值，一律取最新帧（避免 UI 回退）。
    return {
      tick: newest.tick,
      wave: newest.wave,
      state: newest.state,
      scores: newest.scores,
      left: newest.left,
      players: lerpMap(A.players || [], B.players || []),
      enemies: lerpMap(A.enemies || [], B.enemies || []),
      bullets: lerpBullets(A.bullets || [], B.bullets || []),
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
