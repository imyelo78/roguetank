// 联机协议：消息类型、版本、编解码
//
// 客户端与服务端共享这一份定义。改协议必须同时改 PROTOCOL_VERSION，
// 握手时校验，避免老客户端连上来制造一堆灵异 bug。

// 版本 2：输入从"油门 + 方向盘"（f/t）改为八方向平移（mx/mz），与单机操作一致。
// 必须升版本：老页面留在缓存里会继续发 f/t，服务端按 mx/mz 解出来全是 0，
// 表现就是"进房间后车完全不动"——比报错难查得多。
// 版本 3：联机成长（每波各自 3 选 1）+ 建筑随种子变化。
// 必须升版本：v2 客户端收到 CARDS 消息会安静地忽略，玩家会觉得"说好的选卡呢"；
// 更危险的是 v2 客户端按自己的常量生成建筑，换种子后直接撞假墙。
// 版本 4（r46）：Boss 扩到 10 种，新增 bosskit 技能状态同步（bz / bt）。
// 必须升版本：v3 客户端不认识幽影的跃迁预警圈，会看到 Boss"原地闪现"——
// 正是 r45 刚从单机删掉的那个观感；而服务端按 v3 解包会把 bz 当未知字段丢掉。
// 版本 5（r48）：新增「暂离」（away）—— 联机按 Esc 不再直接退房间，
// 而是把自己撤出战场、保留席位与成长，点「返回战场」原样回去。
// 必须升版本：v4 服务端不认识 away，会当成未知消息静默丢掉，玩家按了 Esc
// 以为暂停了、人却还站在火力网里挨打；反过来新服务端对 v4 页面只是永远
// 收不到 away，表现为"暂停按钮点了没反应"。
// r49（换战区）、r50~r54（建模 / 特效 / 样式 / 合批账目）到 r55（两条线合并）
// 一个字段都没动线格式，版本仍是 5。战区是纯函数派生：服务端只发 wave，
// 客户端用同一个 zoneSeedFor 自己铺图，不需要新的消息类型。
export const PROTOCOL_VERSION = 5;

/**
 * 构建标识。**每次出包都要改**，只用于诊断，不参与协议校验。
 *
 * 为什么要有它：联机问题里最常见的假象是"我改了但你测的还是旧包"——
 * 服务端进程没重启、浏览器缓存了旧 dist、CDN 没刷新，现象和真 bug 一模一样，
 * 排查方向直接跑偏。页面会把本地 BUILD 和服务端 /healthz 的 build 对比，
 * 不一致就在左上角红条提示；房间码旁边也会显示当前构建号，截图即可确认版本。
 */
export const BUILD = 'r56';
export const TICK_RATE = 30;
/**
 * 快照率。**必须能整除 TICK_RATE**，否则相邻快照的 tick 差会在两个值之间锯齿，
 * 客户端插值段长不齐 → 画面轻微抖动（这是 08 版之前一直没除掉的病根）。
 *
 * 历史：15Hz（整除，稳）→ 20Hz（不整除，锯齿）→ 回到 15Hz。
 * 当初提到 20Hz 是为了减小残差，但真正让手感变差的是锯齿，不是残差：
 * 残差只要不超过 1 个 tick 就不会被看出来，而锯齿每三帧就来一次。
 *
 * 改成 15Hz 后：段长恒为 2 格，客户端退 2 格插值，夹死率 6%、最长冻结 1 帧、
 * 速度突变 ≈ 0；带宽还比 20Hz 低 25%。
 *
 * 改这里必须同时改 server/room.js 的 TICKS_PER_SNAP（= TICK_RATE / SNAPSHOT_RATE）。
 */
export const SNAPSHOT_RATE = 15;
export const MAX_PLAYERS = 4;

/**
 * 消息类型一律走 k 字段。
 * 早期版本用 t 作类型，但输入帧里 t 表示"转向"，两个 t 会互相覆盖，
 * 表现为"客户端一直在发输入，服务端收到的永远是初始值"。
 */
/** 客户端 → 服务端 */
export const C2S = {
  HELLO: 'hello',       // { v, name, chassis, code?, make? }   code 为空表示建房（随机码）；make + code 表示用自定义码建房
  INPUT: 'in',          // { seq, mx, mz, ax, az, fire }   紧凑字段名，省带宽
  PING: 'ping',         // { t }
  READY: 'ready',       // {}
  LEAVE: 'leave',
  PICK: 'pick',         // { id }  从 CARDS 给的选项里挑一张
  // { on } 暂离 / 归队。暂停期间把人从 world 里撤下来（席位、成长都留着），
  // 不是因为"本地能停住服务器"，而是让暂停的人不再挨打、也不当队友的拖累。
  AWAY: 'away',
};

/** 服务端 → 客户端 */
export const S2C = {
  WELCOME: 'welcome',   // { v, you, code, players[], host, tick, world }  中途加入会带全量世界
  DENY: 'deny',         // { reason, text }
  SNAP: 'snap',         // 快照（见 encodeSnapshot）
  EVENT: 'ev',          // [ { kind, ... } ]  击杀/倒地/救援/波次等一次性事件
  PONG: 'pong',         // { t0, t1 }
  END: 'end',           // { results[], wave }  本局结束
  ROSTER: 'roster',     // { players[], started, host }  有人进出
  CARDS: 'cards',       // { wave, options[{id,name,icon,rarity,desc}], deadline }
};

/** 拒绝原因 → 人话 */
export const DENY_TEXT = {
  full: '房间已满（最多 4 人）',
  'no-room': '房间不存在，检查一下房间码',
  'bad-version': '客户端版本过旧，刷新页面再试',
  'bad-proto': '数据格式不对',
  'room-taken': '这个房间码已经被占用了，换一个或者直接点「加入」',
  'bad-code': '房间码要 4 位字母或数字（不用 0/O/1/I 这几个容易看错的）',
  // 「房间过期」：服务端回收房间时主动推给还挂着的房主，
  // 否则他只会在朋友报错时才知道码已经失效了。
  'room-expired': '房间已经回收了（长时间没人进来），请重新创建并换新码',
  // 注：这里曾经有 in-game / not-started 两条文案，但服务端从来不返回它们。
  // 中途加入对局是**有意的设计**（朋友打一半进来接着打），不存在"开始了就不让进"。
  // 留着会让人以为有这条规则，反而误导，所以删掉。
  // 同理 r30 里那条 'server-busy' 也删了：服务端没有任何地方发送这个 code，
  // 留着就是一条永远不会出现的"规则"。
};

/** 房间码：4 位，去掉了容易看错的 0/O/1/I */
const CODE_ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function makeRoomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHA[(Math.random() * CODE_ALPHA.length) | 0];
  return s;
}

/**
 * 房间码归一化：只做"去空白 / 转大写 / 掐长度"，**绝不替换字符**。
 *
 * ⚠ 以前这里写着 O→0→2、I→1→J 的连环替换，是个真实事故：
 *   用户手输 AB0D，被静默改写成 AB2D，然后收到"房间不存在"——
 *   他怎么也想不通，自己明明照着屏幕敲的。
 *   更糟的是 0→2 这一步：本来想纠正 O 被输入成 0，结果把真正的 0 也改了。
 *   生成的码本来就不含 0/O/1/I（见 CODE_ALPHA），所以合法输入永远不需要纠正。
 *
 * 现在遇到 0/O/1/I 不猜，交给 UI 提示"这几个字符不用，换成 2/J 或换个码"，
 * 让人自己决定。见 ROOM_CODE_RE 与 HUD 的错误提示。
 */
export function normalizeRoomCode(v) {
  return String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 4);
}

/**
 * 容易看错的字符：命中了就提示，不自动改写。
 * 返回 null 表示没问题，否则返回那条导致问题的字符。
 */
export function roomCodeProblem(v) {
  const s = normalizeRoomCode(v);
  if (s.length !== 4) return { why: 'length', code: s };
  if (/[01OI]/.test(s)) return { why: 'confusable', code: s };
  return null;
}

/**
 * 合法房间码：4 位，取自 CODE_ALPHA（不含 0/O/1/I）。
 * 自定义建房码用同一套字母表，避免"自己定了个码里带 0，朋友照着念成 O 永远进不来"。
 */
export const ROOM_CODE_RE = /^[2-9A-HJ-NP-Z]{4}$/;

/** 坐标量化为 int16（1cm 精度，±327m 足够覆盖战场） */
export const quantPos = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 100)));
export const dequantPos = (v) => v / 100;

/** 朝向量化为 uint8（1.4° 精度，肉眼看不出） */
export const quantAng = (rad) => {
  let a = rad % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return Math.round((a / (Math.PI * 2)) * 255) & 255;
};
export const dequantAng = (v) => (v / 256) * Math.PI * 2;

/**
 * 快照编码。用扁平数组而不是对象数组，JSON 体积能小三到四成。
 *
 * 每个实体 8 个数：
 *   [type, id, x, z, yaw, turretYaw, hpRatio, extra]
 *   type: 0=玩家 1=敌人 2=子弹 3=倒地队友
 *   extra: 玩家→(倒地标记|救援进度)，敌人→(类型码)，子弹→(朝向)
 */
export function encodeSnapshot(world) {
  const ents = [];

  for (const p of world.players) {
    ents.push(
      0, p.id,
      quantPos(p.x), quantPos(p.z),
      quantAng(p.yaw), quantAng(p.turretYaw),
      Math.round((p.hp / Math.max(1, p.maxHp)) * 100),
      p.down ? 128 | Math.min(127, Math.round(p.reviveT * 40)) : 0,
    );
  }

  for (const e of world.enemies) {
    ents.push(
      1, e.id,
      quantPos(e.x), quantPos(e.z),
      quantAng(e.yaw || 0), quantAng(e.turretYaw || e.yaw || 0),
      Math.round((e.hp / Math.max(1, e.maxHp)) * 100),
      e.typeCode || 0,
    );
  }

  for (const b of world.bullets) {
    ents.push(
      2, b.id,
      quantPos(b.x), quantPos(b.z),
      quantAng(b.yaw || 0), 0,
      100,
      b.team === 1 ? 1 : 0,
    );
  }

  return {
    // 注意：消息类型用 k 字段，t 保留给 tick —— 早期版本两者都用 t，导致客户端按类型收不到
    k: S2C.SNAP,
    tick: world.tick,
    w: world.wave,
    s: world.state,
    e: ents,        // 扁平
    sc: world.players.map((p) => p.stats.score),
    ex: world.enemiesLeft === undefined ? -1 : world.enemiesLeft,
    // 宝箱（r43）：状态同步而不是事件——'crates' 事件只在开波瞬间发一次，
    // 客户端若正好在大厅→战场切换（active=false）就会永久错过，箱子从此
    // 不渲染。放快照里每帧 1~3 条（空 [] 时 ~6 字节），天然覆盖迟入/重连。
    // [id, x, z, catIdx]，catIdx 见 CRATE_CATS
    cr: (world.crates || []).map((c) => [c.id, quantPos(c.x), quantPos(c.z), CRATE_CATS.indexOf(c.cat)]),
    // Boss 场地标记（r46）：[kind, x, z, r×10, t×100]。
    // 走快照而不是事件，理由同宝箱：预警圈有 1.2 秒的持续状态，
    // 迟入的玩家必须能看到"它要跳到哪"，错过一次事件就完全读不懂画面。
    bz: (world.zones || []).map((z) => [
      z.kind, quantPos(z.x), quantPos(z.z), Math.round(z.r * 10),
      Math.max(0, Math.min(100, Math.round(z.t * 100))),
    ]),
    // Boss 阶段 + 觉醒词条位（bitmask）：终焉三阶段、双生两只、55 波后的词条
    bt: (world.enemies || [])
      .filter((e) => e.boss)
      .map((e) => [e.id, e.stage || 0, e.awakenMask || 0]),
  };
}

/** 宝箱类别在协议里的顺序：两端共用，改动即断协议 */
export const CRATE_CATS = ['attack', 'defense', 'mobility', 'support'];

/** 解码成便于客户端消费的结构 */
export function decodeSnapshot(snap) {
  const e = snap.e || [];
  const players = [];
  const enemies = [];
  const bullets = [];
  for (let i = 0; i + 7 < e.length; i += 8) {
    const type = e[i];
    const item = {
      id: e[i + 1],
      x: dequantPos(e[i + 2]),
      z: dequantPos(e[i + 3]),
      yaw: dequantAng(e[i + 4]),
      turretYaw: dequantAng(e[i + 5]),
      hp: e[i + 6],
      extra: e[i + 7],
    };
    if (type === 0) {
      item.down = (e[i + 7] & 128) !== 0;
      item.revive = (e[i + 7] & 127) / 40;
      players.push(item);
    } else if (type === 1) {
      item.typeCode = e[i + 7];
      enemies.push(item);
    } else if (type === 2) {
      item.team = e[i + 7];
      bullets.push(item);
    }
  }
  return { tick: snap.tick, wave: snap.w, state: snap.s, scores: snap.sc || [], players, enemies, bullets, left: snap.ex,
    crates: (snap.cr || []).map(([id, x, z, cat]) => ({ id, x: dequantPos(x), z: dequantPos(z), cat: CRATE_CATS[cat] || 'support' })),
    // Boss 场地标记（r46）：一张通用表装下所有"地上画了个东西"的状态——
    // 跃迁预警圈、岩浆区、冲刺路径、转阶段冲击波都走同一条 [kind,x,z,r,t]，
    // 以后加 Boss 不用再动协议。
    // kind: 0 跃迁预警 1 岩浆危险区 2 冲刺路径 3 转阶段冲击波
    // t: 0~100，kind=0 时是收缩进度，其余是剩余寿命比例
    zones: (snap.bz || []).map(([kind, x, z, r, t]) => ({
      kind, x: dequantPos(x), z: dequantPos(z), r: r / 10, t: t / 100,
    })),
    // Boss 阶段与觉醒词条位：双生要区分两只、终焉要区分三阶段
    bossStates: (snap.bt || []).map(([id, stage, mask]) => ({ id, stage, mask })),
  };
}
