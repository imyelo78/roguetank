// 排行榜：每日挑战 + 训练模式
// 日期种子确定性随机（每日挑战）、成绩上传 / 排行榜（远端 KV 失败时回退 localStorage）

const LB_KEY = 'tank3d.lb.v3';          // { days, trDays, all, trAll }
const LB_KEY_V2 = 'tank3d.daily.lb.v2'; // 旧结构，读到时自动迁移
const NAME_KEY = 'tank3d.name.v1';
const PID_KEY = 'tank3d.pid.v1';
const PENDING_KEY = 'tank3d.pending.v1'; // 上传失败的成绩，下次启动补传

const EMPTY = () => ({ days: {}, trDays: {}, all: [], trAll: [] });

/**
 * 当日日期键 YYYY-MM-DD，固定用 UTC+8，
 * 与后端 functions/api/scores.js 保持一致（避免时区导致跨日对不上榜）。
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

/** 确定性随机数生成器（与 level.js 同款） */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  if (v.trDays && typeof v.trDays === 'object') out.trDays = v.trDays;
  if (Array.isArray(v.all)) out.all = v.all;
  if (Array.isArray(v.trAll)) out.trAll = v.trAll;
  return out;
}

function readLocal() {
  try {
    const raw = localStorage.getItem(LB_KEY);
    if (raw) return normalize(JSON.parse(raw));
    // 旧版本数据一次性迁移
    const old = localStorage.getItem(LB_KEY_V2);
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

const sortDesc = (a, b) => b.score - a.score || b.wave - a.wave || (a.t || 0) - (b.t || 0);

const identOf = (e) => e.id || e.name;

/** 同身份（name#pid）只保留最高分，返回 Top50 */
export function mergeEntry(list, entry) {
  const key = identOf(entry);
  const prev = list.find((e) => identOf(e) === key);
  // 已有更高分（或同分但更靠前）则保留原成绩
  if (prev && (prev.score > entry.score ||
      (prev.score === entry.score && (prev.wave || 0) >= (entry.wave || 0)))) {
    return list;
  }
  const rest = list.filter((e) => identOf(e) !== key);
  rest.push(entry);
  rest.sort(sortDesc);
  return rest.slice(0, 50);
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
  return out.sort(sortDesc).slice(0, 50);
}

const dayBucket = (data, mode) => (mode === 'normal' ? data.trDays : data.days);
const allBucket = (data, mode) => (mode === 'normal' ? data.trAll : data.all);
const dayKeyOf = (mode) => (mode === 'normal' ? 'trDays' : 'days');
const allKeyOf = (mode) => (mode === 'normal' ? 'trAll' : 'all');

function localSubmit({ date, name, wave, kills, score, mode = 'daily', pid = '' }) {
  const data = readLocal();
  const entry = { name, wave, kills, score, t: Date.now() };
  if (pid) entry.id = `${name}#${pid}`;

  const dk = dayKeyOf(mode);
  const ak = allKeyOf(mode);
  data[dk][date] = mergeEntry(data[dk][date] || [], entry);
  data[ak] = mergeEntry(data[ak], entry);

  // 每个桶只保留最近 120 天
  const keys = Object.keys(data[dk]).sort().reverse().slice(0, 120);
  const trimmed = {};
  for (const k of keys) trimmed[k] = data[dk][k];
  data[dk] = trimmed;

  writeLocal(data);
  return data;
}

const localDays = (data, mode) => Object.keys(dayBucket(data, mode) || {}).sort().reverse();

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
  const list = readPending().filter((x) => !(x.date === item.date && x.name === item.name &&
    x.mode === item.mode && x.score === item.score && x.wave === item.wave));
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
 * 提交成绩。本地始终写入，再尝试远端；远端失败则进补传队列。
 * @returns {{ list, all, days, remote, reason? }}
 */
export async function submitScore({ date, name, wave, kills, score, mode = 'daily' }) {
  const pid = getPid();
  const local = localSubmit({ date, name, wave, kills, score, mode, pid });
  const localList = dayBucket(local, mode)[date] || [];

  const res = await postScore({ date, name, wave, kills, score, mode, pid });
  if (res.ok) {
    const d = res.data;
    return {
      // 远端可能只含云端的成绩，与本机记录合并，确保自己的这局一定在榜上
      list: mergeLists(d.list || [], localList),
      all: mergeLists(d.all || [], allBucket(local, mode)),
      days: mergeDays(d.days || [], localDays(local, mode)),
      remote: true,
    };
  }

  pushPending({ date, name, wave, kills, score, mode, pid, t: Date.now() });
  return {
    list: localList,
    all: allBucket(local, mode),
    days: localDays(local, mode),
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

/** 拉取某天战绩（远端 + 本地合并，远端缺失时也不丢本机记录） */
export async function fetchDay(date, mode = 'daily') {
  const local = readLocal();
  const localList = dayBucket(local, mode)[date] || [];
  try {
    const r = await fetch(`/api/scores?date=${encodeURIComponent(date)}&mode=${mode}`);
    if (r.ok) {
      const data = await r.json();
      if (data.ok && Array.isArray(data.list)) {
        return { list: mergeLists(data.list, localList), remote: true };
      }
    }
  } catch { /* 回退 */ }
  return { list: localList, remote: false };
}

/** 拉取总榜 + 已有战绩的日期列表（同样与本地合并） */
export async function fetchSummary(mode = 'daily') {
  const local = readLocal();
  try {
    const r = await fetch(`/api/scores?view=all&mode=${mode}`);
    if (r.ok) {
      const data = await r.json();
      if (data.ok) {
        return {
          all: mergeLists(Array.isArray(data.all) ? data.all : [], allBucket(local, mode)),
          days: mergeDays(Array.isArray(data.days) ? data.days : [], localDays(local, mode)),
          remote: true,
        };
      }
    }
  } catch { /* 回退 */ }
  return { all: allBucket(local, mode), days: localDays(local, mode), remote: false };
}

/** 服务端诊断：各榜条数与最后写入时间（用于确认写入是否真的生效） */
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

export { sortDesc };
