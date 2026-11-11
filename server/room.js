// 房间：把 World 包成可联网的东西
//
// 职责边界很窄：谁在房里、每 tick 跑一次模拟、把结果广播出去。
// 模拟本身全在 src/core/world.js，服务端不做任何"游戏规则"的判断。

import { World, HALF, syncedStats } from '../src/core/world.js';
import { TERRAIN_PRESETS } from '../src/core/terrain.js';
import {
  PROTOCOL_VERSION, TICK_RATE, SNAPSHOT_RATE, MAX_PLAYERS, S2C,
  encodeSnapshot, makeRoomCode,
} from '../src/core/protocol.js';

const TICK_MS = 1000 / TICK_RATE;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const SNAP_MS = 1000 / SNAPSHOT_RATE;
/**
 * 每多少个模拟 tick 发一帧快照。
 *
 * 关键：必须是**整数**，且快照率 = TICK_RATE / TICKS_PER_SNAP。
 *
 * 30tick/s 配 20snap/s 的比率是 3:2，不是整数倍——任何发送策略都会让相邻
 * 快照的 tick 差在 1 和 2 之间锯齿（数学上无解，不是调参能救的）。
 * 客户端按 tick 插值时，段长忽 33ms 忽 67ms，插值速度跟着忽快忽慢，
 * 就是"一动就轻微抖"的根源。实测锯齿下最优延迟也有 50% 的帧被夹死。
 *
 * 取 2 → 15Hz：段长恒为 2 格，客户端固定退 2 格，夹死率 6%、最长冻结 1 帧、
 * 速度突变 ≈ 0。带宽比 20Hz 还低 25%，画面反而更稳。
 * 牺牲的是"别人位置的刷新率"（15Hz），但插值把中间帧补出来了，观感无差别。
 */
const TICKS_PER_SNAP = 2;

/**
 * 全员离线后，房间再保留多久才回收（毫秒）。
 *
 * 用途只有一个：让"刷新页面 / 切网络 / 手机锁屏回来"的人还能回到同一间房。
 * **不是房间寿命上限** —— 只要还有一个活人挂在房间里，房间就一直存在。
 * 3 分钟足够走完一次刷新重连，又不会让废弃房间无限堆积。
 */
const EMPTY_GRACE_MS = 3 * 60 * 1000;

/**
 * 地表强度：服务端环境变量统一控制。
 *
 *   TERRAIN=off        全部按草地算，速度恒等 1.0（旧手感）
 *   TERRAIN=light      偏离打五折，新手房
 *   TERRAIN=standard   原始数值（默认）
 *   TERRAIN=harsh      偏离放大 1.4 倍，老手房
 *
 * 注意这里只管"强度"，不管"哪一格是什么地形" —— 后者由房间 seed 派生，
 * 每个房间一张不同的图。
 *
 * 为什么不给客户端传参：四个人必须踩在同一张图上，
 * 否则一个人陷在沼泽里爬、另一个按草地算，残差会被反复校正，手感回到"拖拽"。
 */
function terrainPresetOf() {
  const v = String(process.env.TERRAIN || 'standard').trim().toLowerCase();
  if (v in TERRAIN_PRESETS) return v;
  // 也接受直接写系数（0 / 0.5 / 1 / 1.4），换算回最近的档名
  const n = Number(v);
  if (Number.isFinite(n)) {
    if (n === 0) return 'off';
    if (n <= 0.7) return 'light';
    if (n <= 1.2) return 'standard';
    return 'harsh';
  }
  return 'standard';
}

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
    // 倒计时归零 ≠ 一定开得起来：世界可能还在 lobby 之外的中间态，
    // 或者玩家刚好全灭。以前到点只调一次 start()，失败就永久卡在"进不了战场也开不了炮"。
    // 现在记住"该开局了"，每个 tick 重试直到成功。
    this._startPending = false;
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
      this.world = new World({
        code: this.code,
        seed: seed || (Math.random() * 0xFFFFFFFF) | 0,
        maxPlayers: MAX_PLAYERS,
        // 地表由服务端的房间 seed 派生 + 服务端的档位决定，
        // 房间内所有人拿到的 seed 相同，重建出来就是同一张图。
        // 不读客户端参数：一旦允许各自指定，就会出现"你在沼泽、他在草地"的漂移。
        terrainPreset: terrainPresetOf(),
      });
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
    if (this.world.start()) {
      this.startedAt = Date.now();
      this._startPending = false;
    } else {
      // 世界此刻开不起来（死人还没复活 / 状态没归位）。挂起，由 _oneTick 重试，
      // 不能让房主点一下"开始战斗"就石沉大海。
      this._startPending = true;
    }
    return true;
  }

  /**
   * 空闲回收：**只在房间里没有任何在线 socket 时才生效**，给断线重连留缓冲。
   *
   * 以前的规则是"房间里还有人在，但超过 N 秒没有新人进来，就把房间从索引删掉"，
   * 这是线上真实事故：创建者建房 → 复制码 → 发微信 → 朋友过一分钟才点进来，
   * 房间已经没了，报"房间不存在"，而创建者那边连接还在、界面还显示着房间码，
   * 完全无感。**房间寿命不该由"多久没人加入"决定，只能由"还有没有人在"决定。**
   *
   * 现在：全员离线 → 再等 EMPTY_GRACE_MS（3 分钟）→ 回收。
   * 只要有任何一个人在线上，房间就永久保留，不论多久没人进来。
   */
  _idleExpired() {
    const now = Date.now();
    const online = [...this.members.values()].some((m) => m.socket && m.socket.readyState === 1);
    if (online) {
      this._emptySince = 0;
      return false;
    }
    if (!this._emptySince) this._emptySince = now;
    return now - this._emptySince > EMPTY_GRACE_MS;
  }

  _reclaimable() {
    return [...this.members.values()].some((m) => !m.socket || m.socket.readyState > 1);
  }

  leave(id) {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    if (this.world) this.world.removePlayer(id);
    // 房主走了就把房主让给还在的人：以前房主一断，剩下三个人就再也没人能点「开始战斗」，
    // 只能干等自动开局的倒计时（而倒计时只在有人进来时重置一次）。
    if (this.hostId === id) {
      const next = [...this.members.values()].find((x) => x.socket && x.socket.readyState === 1);
      this.hostId = next ? next.id : null;
    }
    this._broadcastRoster();
    if (this.members.size === 0) this.destroy();
  }

  destroy(reason = 'empty') {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // 先通知还挂在房间里的人再删索引。
    // 以前是静默删除：房主的连接还在，界面还显示着房间码，朋友按码进来却报
    // "房间不存在"，房主完全不知道为什么（线上真实投诉）。现在房主会立刻收到
    // 一条 room-expired，前端提示"房间已回收，重新建房换新码"。
    const msg = JSON.stringify({
      k: S2C.END,
      expired: true,
      reason,
      wave: this.world?.wave || 0,
      results: [],
      text: '房间已回收（长时间没有新玩家进来），请重新创建房间并换一个新码',
    });
    for (const m of this.members.values()) this._send(m, msg);
    this.world = null;
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

      // 空闲回收：没有任何在线玩家超过宽限期就收掉（有活人在就永不过期）
      if (this._idleExpired()) {
        this.destroy('idle');
        return;
      }

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
      // 快照不在这一层发：它挂在 _oneTick 里按 tick 计数发（见 _maybeSnapshotAt）。
      // ⚠ 这里曾经有一行 this.maybeSnapshot()，每 4ms 轮询都会走一次累加器，
      //   结果每个 tick 累加 8 次，快照实际按 8 倍频发出（实测到达间隔 7ms），
      //   既浪费带宽又把客户端的段长彻底打乱。
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

    // ---- 开局调度 ----
    // 两个触发源：3 秒自动倒计时走完，或房主点了「开始战斗」。
    // 两者都只置 _startPending，真正 start() 在这里重试，
    // 这样"到点了但世界开不起来"不会变成永久卡死。
    if (!this.startedAt && this.autoStartT > 0) {
      this.autoStartT -= TICK_MS / 1000;
      if (this.autoStartT <= 0) {
        this.autoStartT = 0;
        this._startPending = true;
      }
    }
    if (this._startPending && !this.startedAt && w.players.length > 0) {
      if (w.start()) {
        this.startedAt = Date.now();
        this._startPending = false;
      }
      // 开不起来就下个 tick 再试（世界只会在 'playing' 时拒绝 start）
    }

    // 把每个成员的最新输入灌进世界
    for (const m of this.members.values()) {
      w.setInput(m.id, m.input);
    }
    const events = w.step(1 / TICK_RATE);

    // 事件立刻转发（不等快照），这样击杀反馈没有额外延迟
    if (events.length) {
      // cards 事件里的 dealt 是"每人一份选项"，不能广播给所有人（会互相看到对方的卡），
      // 所以先摘出来，单独一人一条 CARDS 消息。
      const dealt = events.find((e) => e.kind === 'cards');
      const rest = events.filter((e) => e.kind !== 'cards');
      if (rest.length) {
        const msg = JSON.stringify({ k: S2C.EVENT, e: rest });
        for (const m of this.members.values()) this._send(m, msg);
      }
      if (dealt) this._sendCards(dealt);
    }

    // 快照按真实时间单独节流（见 tick 说明）。
    // 这里不用 w.tick 计数，因为一次调用可能连走多步，计数会把快照挤成突发。
    this._maybeSnapshotAt(tickTime);

    if (w.state === 'over') {
      // 世界判"全员阵亡"就 over 了。但联机房间**不能**因此解散：
      // 房主挂机等人时被敌人打死是常态（实测：建房后静置 60~77 秒正好被围死），
      // 一 over 就停循环 + 8 秒后销毁，房间码失效——朋友进来报"房间不存在"，
      // 房主那边连接还在、界面还显示着码，完全不知道为什么。
      //
      // 正确做法：有人还在线就重开一局（保留连接与房间码），
      // 只有所有连接都断了，才交回给空闲回收处理。
      const anyOnline = [...this.members.values()]
        .some((m) => m.socket && m.socket.readyState === 1);
      if (anyOnline) {
        for (const p of w.players) {
          if (!p.alive) this._respawnPlayer(p);
        }
        w.state = 'lobby';
        this.startedAt = 0;
        // 重新起倒计时。以前这里是 0（"等人按开始战斗"），但大厅面板只在
        // 进场前看得见，局内玩家根本找不到那个按钮——结果就是全员阵亡后
        // 永久停在 'lobby'，画面还在、车也在，却开不了炮、走不动。
        // 现在到点自己重开，和"刚进房间"完全一样的体验。
        this.autoStartT = 3;
        this._startPending = true;
        this._broadcastRoster();
        return;
      }

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
      setTimeout(() => this.destroy('over'), 8000);
    }
  }

  /** 把阵亡的玩家复活回出生点（全员阵亡但房间还在时的重开用） */
  _respawnPlayer(p) {
    p.alive = true;
    p.down = false;
    p.hp = p.maxHp;
    p.reviveT = 0;
    p.fireCd = 0;
    // 出生点记在玩家身上（world.addPlayer 时不存，这里用首帧位置兜底）
    if (Number.isFinite(p._spawnX)) {
      p.x = p._spawnX;
      p.z = p._spawnZ;
    }
    // 炮弹与仇恨不清：清掉会让已经在场上的敌人瞬间"失忆"，反而更怪
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
   *
   * ⚠ 为什么最终改成**按 tick 计数**而不是按毫秒阀值：
   *   快照 20Hz = 50ms 发一次，tick 30Hz = 33.3ms 一格，两者不是整数倍关系。
   *   按毫秒判"距上次 ≥ 33ms"时，实际发出节奏是 2,1,1,1,2,1,1,1... 的锯齿
   *   （实测最长连续 15 帧 tick 差都是 1，然后跳 2）。
   *   客户端按 tick 插值，段长忽 33ms 忽 67ms，插值速度跟着忽快忽慢——
   *   这就是"还有一点点抖"的真正来源，跟延迟给多少格没关系：
   *   给 1 格会在差 2 时夹死，给 2 格会在差 1 时爬得过慢。
   *
   *   现在按模拟 tick 计数：每 3 个 tick 发一帧（30×2/3 = 20Hz，帧率不变），
   *   相邻快照 tick 差**恒为 3**。客户端固定退 3 格即可帧帧踩在段中间，
   *   既不夹死也不追赶。帧率、带宽、模拟频率全都不变，只是发送时点对齐到网格。
   */
  _maybeSnapshotAt(at, catchUp = false) {
    if (!this.world || !this.members.size) return;

    if (catchUp) {
      // 宿主是低频 alarm（DO）：按时间补帧，保持客户端序列不断档。
      const gap = at - this._lastSnapAt;
      if (gap < SNAP_MS - TICK_MS / 2) return;
      const due = Math.min(3, Math.max(1, Math.round(gap / SNAP_MS)));
      this._lastSnapAt = at;
      for (let i = 0; i < due; i++) this._broadcastSnapshot();
      return;
    }

    // 正常路径：按模拟 tick 计数，每 TICKS_PER_SNAP 个 tick 发一帧。
    // 这样相邻快照的 tick 差恒为 TICKS_PER_SNAP，客户端插值段长恒定。
    this._snapTickAcc = (this._snapTickAcc || 0) + 1;
    if (this._snapTickAcc < TICKS_PER_SNAP) return;
    this._snapTickAcc = 0;
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

  /** 给每个人单独发他自己的那三张卡 */
  _sendCards(dealt) {
    for (const item of dealt.dealt || []) {
      const m = this.members.get(item.id);
      if (!m) continue;
      this._send(m, JSON.stringify({
        k: S2C.CARDS,
        wave: item.wave,
        options: item.options,
        // 他此刻的成长数值（服务端权威）。客户端用它修正本地预测的速度/血量，
        // 并让卡片上显示正确的 Lv —— 快照不带成长，不在这里对齐就会一直是第一波的白板数值。
        stats: item.stats || null,
        // 预算时间：超时服务端会自动替他选第一张，客户端按这个倒计时显示
        ms: Math.round((dealt.window || 12) * 1000),
      }));
    }
  }

  /** 有人中途进来：把还没选完的卡补发给他（重连不能白丢一波收益） */
  _resendCards(id) {
    const c = this.world?.cards?.get(id);
    if (!c || c.picked) return;
    const p = this.world.players.find((q) => q.id === id);
    this._sendCards({
      dealt: [{ id, wave: c.wave, options: c.options, stats: p ? syncedStats(p.stats) : null }],
      window: this.world.pickT,
    });
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

  /**
   * 收到选卡。服务端是唯一裁判：选项是否合法、是否已经选过，都以这里为准。
   * 客户端只是把点击翻译成 { id } 发上来。
   */
  onPick(id, cardId) {
    const w = this.world;
    if (!w || !w.picksOpen) return false;
    const r = w.pickCard(id, cardId);
    if (!r.ok) return false;
    const m = this.members.get(id);
    if (m) this._send(m, JSON.stringify({ k: S2C.EVENT, e: [{ kind: 'picked', id, card: cardId }] }));
    return true;
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
      // 顶层也放一份，客户端不用钻进 world 里翻。
      // 只给种子和档位：27×27 的格点数组没必要走协议，两端用同一个纯函数重建即可。
      terrain: {
        seed: w.terrain.seed,
        preset: w.terrainPreset,
        k: w.terrain.k ?? 1,
        tile: w.terrain.tile,
      },
    };
  }

  rosterPayload() {
    return {
      k: S2C.ROSTER,
      players: [...this.members.values()].map((m) => ({ id: m.id, name: m.name, chassis: m.chassis })),
      started: !!this.startedAt,
      host: this.hostId || null,
      // 自动开局剩余秒数：真实值，不是客户端猜的。
      // 以前大厅写死"3 秒后自动开始"，但服务端只在**有人加入**时重置倒计时，
      // 单人建房后一直没人进，倒计时走完就开打了，界面上却还写着"3 秒后"，
      // 玩家以为卡住。现在下发剩余秒数，界面显示的是真数。
      autoStart: Math.max(0, Math.round(this.autoStartT || 0)),
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

  /** code 传了就用自定义码（调用方已查重），否则随机生成 */
  create(code) {
    let finalCode = code || makeRoomCode();
    let guard = 0;
    while (this.rooms.has(finalCode) && guard++ < 50) finalCode = makeRoomCode();

    const room = new Room({
      code: finalCode,
      onEmpty: (r) => {
        this.rooms.delete(r.code);
        console.log(`[room] ${r.code} 结束（${this.rooms.size} 个房间在跑）`);
      },
    });
    this.rooms.set(finalCode, room);
    room.run();
    console.log(`[room] ${finalCode} 创建（${this.rooms.size} 个房间在跑）`);
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
