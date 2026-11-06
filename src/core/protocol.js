// 联机协议：消息类型、版本、编解码
//
// 客户端与服务端共享这一份定义。改协议必须同时改 PROTOCOL_VERSION，
// 握手时校验，避免老客户端连上来制造一堆灵异 bug。

export const PROTOCOL_VERSION = 1;
export const TICK_RATE = 30;
export const SNAPSHOT_RATE = 15;
export const MAX_PLAYERS = 4;

/**
 * 消息类型一律走 k 字段。
 * 早期版本用 t 作类型，但输入帧里 t 表示"转向"，两个 t 会互相覆盖，
 * 表现为"客户端一直在发输入，服务端收到的永远是初始值"。
 */
/** 客户端 → 服务端 */
export const C2S = {
  HELLO: 'hello',       // { v, name, chassis, code? }   code 为空表示建房
  INPUT: 'in',          // { seq, f, t, ax, az, fire }   紧凑字段名，省带宽
  PING: 'ping',         // { t }
  READY: 'ready',       // {}
  LEAVE: 'leave',
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
};

/** 拒绝原因 → 人话 */
export const DENY_TEXT = {
  full: '房间已满（最多 4 人）',
  'no-room': '房间不存在，检查一下房间码',
  'bad-version': '客户端版本过旧，刷新页面再试',
  'bad-proto': '数据格式不对',
  'in-game': '这局已经开始了，等他们打完再来',
};

/** 房间码：4 位，去掉了容易看错的 0/O/1/I */
const CODE_ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function makeRoomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHA[(Math.random() * CODE_ALPHA.length) | 0];
  return s;
}

export function normalizeRoomCode(v) {
  const s = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  // 常见误输入纠正
  return s.replace(/O/g, '0').replace(/I/g, '1').replace(/0/g, '2').replace(/1/g, 'J').slice(0, 4);
}

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
  };
}

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
  return { tick: snap.tick, wave: snap.w, state: snap.s, scores: snap.sc || [], players, enemies, bullets, left: snap.ex };
}
