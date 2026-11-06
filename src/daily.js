// 榜单与身份
//
// 只有一条榜：所有战斗（单人或 2~4 人合作）都计入。两个视图：
//   今日  / 总榜
//
// 三条原则：
//   1. 本地永远先写（断网、KV 未绑定也不丢战绩），远端失败进补传队列。
//   2. 去重身份优先用 pid（改名后仍是同一个人），与服务端保持一致。
//   3. 榜单条目带人数与车体，读者自己判断可比性。

const LB_KEY = 'tank3d.lb.v4';
const LB_KEY_V3 = 'tank3d.lb.v3';
const LB_KEY_V2 = 'tank3d.daily.lb.v2';
const NAME_KEY = 'tank3d.name.v1';
const PID_KEY = 'tank3d.pid.v1';
const PENDING_KEY = 'tank3d.pending.v1'; // 上传失败的成绩，下次启动补传

const EMPTY = () => ({ days: {}, all: [] });

/**
 * 当日日期键 YYYY-MM-DD，固定用 UTC+8，
 * 与后端保持一致（避免时区导致跨日对不上榜）。
 */
export function todayKey(offsetDays = 0) {
  const t = Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 字符串哈希 → uint32 种子（FNV-1a） */
export function seedFromKey(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export { mulberry32 } from './rng.js';

export function loadCallsign() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}

export function saveCallsign(name) {
  try { localStorage.setItem(NAME_KEY, name.trim().slice(0, 12)); } catch { /* 忽略 */ }
}

/** 本机唯一 ID：用于服务端去重，保证不同玩家即使同名也不会互相覆盖成绩 */
export function getPid() {
  try {
    let p = localStorage.getItem(PID_KEY);
    if (!p || p.length < 6) {
      p = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      localStorage.setItem(PID_KEY, p);
    }
    return p;
  } catch { return ''; }
}

// ---------------- 本地兜底存储 ----------------

function normalize(v) {
  const out = EMPTY();
  if (!v || typeof v !== 'object') return out;
  if (v.days && typeof v.days === 'object') out.days = v.days;
  if (Array.isArray(v.all)) out.all = v.all;
  return out;
}

function readLocal() {
  try {
    const raw = localStorage.getItem(LB_KEY);
    if (raw) return normalize(JSON.parse(raw));

    // 旧版本数据一次性迁移（v3 → v4 只是多了挑战榜，结构兼容）
    // 老版本可能存了「训练榜 / 挑战榜」，这里只保留统一榜需要的部分
    const old = localStorage.getItem(LB_KEY_V3) || localStorage.getItem(LB_KEY_V2);
    if (old) {
      const o = JSON.parse(old);
      const data = normalize({ days: o.days, all: o.all });
      writeLocal(data);
      return data;
    }
  } catch { /* 忽略 */ }
  return EMPTY();
}

function writeLocal(data) {
  try { localStorage.setItem(LB_KEY, JSON.stringify(data)); } catch { /* 忽略 */ }
}

const sortDesc = (a, b) => (b.score || 0) - (a.score || 0)
  || (b.wave || 0) - (a.wave || 0)
  || (a.t || 0) - (b.t || 0);

/** 去重身份：与 Service Worker 端一致，优先 pid */
const identOf = (e) => e.pid || e.id || e.name;

const TOP_N = 100;

/** 同身份只保留最高分，返回 Top100 */
export function mergeEntry(list, entry) {
  const key = identOf(entry);
  const prev = list.find((e) => identOf(e) === key);
  if (prev && (prev.score > entry.score
      || (prev.score === entry.score && (prev.wave || 0) >= (entry.wave || 0)))) {
    return list;
  }
  const rest = list.filter((e) => identOf(e) !== key);
  rest.push(entry);
  rest.sort(sortDesc);
  return rest.slice(0, TOP_N);
}

/**
 * 合并远端与本地榜单：同身份取最高分。
 * 避免"云端为空/未绑定"时把本机成绩抹掉（断网、KV 未绑定期间打的局会丢记录）。
 */
export function mergeLists(remote = [], local = []) {
  let out = Array.isArray(remote) ? [...remote] : [];
  for (const e of Array.isArray(local) ? local : []) {
    if (!e || !e.name || typeof e.score !== 'number') continue;
    out = mergeEntry(out, e);
  }
  return out.sort(sortDesc).slice(0, TOP_N);
}

const makeEntry = (run) => {
  const e = {
    name: run.name,
    wave: run.wave,
    kills: run.kills,
    score: run.score,
    players: Math.max(1, Math.min(4, run.players || 1)),
    t: Date.now(),
  };
  if (run.pid) { e.pid = run.pid; e.id = `${run.name}#${run.pid}`; }
  if (run.timeMs) e.timeMs = run.timeMs;
  if (run.chassis) e.chassis = run.chassis;
  if (run.weapon) e.weapon = run.weapon;
  if (run.mods) e.mods = run.mods;
  return e;
};

function localSubmit(run) {
  const data = readLocal();
  const entry = makeEntry(run);
  const date = run.date || todayKey();

  data.days[date] = mergeEntry(data.days[date] || [], entry);
  data.all = mergeEntry(data.all, entry);

  // 只保留最近 120 天
  const keys = Object.keys(data.days).sort().reverse().slice(0, 120);
  const trimmed = {};
  for (const k of keys) trimmed[k] = data.days[k];
  data.days = trimmed;

  writeLocal(data);
  return data;
}

const localDays = (data) => Object.keys(data.days || {}).sort().reverse();

// ---------------- 上传失败队列 ----------------

function readPending() {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function writePending(list) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-20))); } catch { /* 忽略 */ }
}

function pushPending(item) {
  const list = readPending().filter((x) => !(x.date === item.date && x.name === item.name
    && x.score === item.score && x.wave === item.wave));
  list.push(item);
  writePending(list);
}

/** 启动时补传上次没成功的成绩（静默，不打扰玩家） */
export async function flushPending() {
  const list = readPending();
  if (list.length === 0) return 0;
  const left = [];
  let ok = 0;
  for (const item of list) {
    const r = await postScore(item);
    if (r.ok) ok += 1;
    else left.push(item);
  }
  writePending(left);
  return ok;
}

async function postScore(payload) {
  try {
    const r = await fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => null);
    if (r.ok && data && data.ok) return { ok: true, data };
    return { ok: false, reason: (data && data.reason) || `http-${r.status}` };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

// ---------------- 对外接口 ----------------

/**
 * 提交成绩。本地先写，再尝试远端；失败进补传队列。
 * @param {{date?, name, wave, kills, score, timeMs?, chassis?, weapon?, mods?, players?}} run
 */
export async function submitScore(run) {
  const pid = getPid();
  const payload = {
    date: run.date || todayKey(),
    name: run.name,
    wave: run.wave,
    kills: run.kills,
    score: run.score,
    players: Math.max(1, Math.min(4, run.players || 1)),
    timeMs: run.timeMs || 0,
    chassis: run.chassis || '',
    weapon: run.weapon || '',
    mods: Array.isArray(run.mods) ? run.mods : [],
    pid,
  };

  const local = localSubmit(payload);
  const localList = local.days[payload.date] || [];

  const res = await postScore(payload);
  if (res.ok) {
    const d = res.data;
    return {
      // 远端可能只含云端的成绩，与本机记录合并，确保自己的这局一定在榜上
      list: mergeLists(d.list || [], localList),
      all: mergeLists(d.all || [], local.all),
      days: mergeDays(d.days || [], localDays(local)),
      remote: true,
    };
  }

  pushPending({ ...payload, t: Date.now() });
  return {
    list: localList,
    all: local.all,
    days: localDays(local),
    remote: false,
    reason: res.reason,
  };
}

/** 日期索引取并集，倒序，最多 120 天 */
export function mergeDays(a = [], b = []) {
  return [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])]
    .sort()
    .reverse()
    .slice(0, 120);
}

/** 拉取今日榜（远端 + 本地合并） */
export async function fetchDay(date = todayKey()) {
  const local = readLocal();
  const localList = local.days[date] || [];
  try {
    const r = await fetch(`/api/scores?date=${encodeURIComponent(date)}`);
    if (r.ok) {
      const data = await r.json();
      if (data.ok && Array.isArray(data.list)) {
        return { list: mergeLists(data.list, localList), remote: true };
      }
    }
  } catch { /* 回退 */ }
  return { list: localList, remote: false };
}

/** 拉取总榜（远端 + 本地合并） */
export async function fetchAll() {
  const local = readLocal();
  try {
    const r = await fetch('/api/scores?view=all');
    if (r.ok) {
      const data = await r.json();
      if (data.ok) {
        return { all: mergeLists(Array.isArray(data.all) ? data.all : [], local.all), remote: true };
      }
    }
  } catch { /* 回退 */ }
  return { all: local.all, remote: false };
}

/** 服务端诊断：榜条数与最后写入时间 */
export async function fetchStats() {
  try {
    const r = await fetch('/api/scores?view=stats');
    if (r.ok) {
      const data = await r.json();
      if (data.ok) return data;
    }
  } catch { /* 忽略 */ }
  return null;
}

export { sortDesc, identOf };
