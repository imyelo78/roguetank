// 每日挑战：日期种子确定性随机 + 分数上传 / 排行榜（远端 KV 失败时回退 localStorage）

const LB_KEY = 'tank3d.daily.lb.v2';   // { days: { 'YYYY-MM-DD': [entry] }, all: [entry] }
const NAME_KEY = 'tank3d.name.v1';

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

// ---------------- 本地兜底存储 ----------------

function readLocal() {
  try {
    const v = JSON.parse(localStorage.getItem(LB_KEY));
    if (v && typeof v === 'object' && v.days) return v;
  } catch { /* 忽略 */ }
  return { days: {}, all: [] };
}

function writeLocal(data) {
  try { localStorage.setItem(LB_KEY, JSON.stringify(data)); } catch { /* 忽略 */ }
}

const sortDesc = (a, b) => b.score - a.score || b.wave - a.wave || (a.t || 0) - (b.t || 0);

/** 同呼号只保留最高分，返回 Top50 */
export function mergeEntry(list, entry) {
  const prev = list.find((e) => e.name === entry.name);
  // 已有更高分（或同分但更靠前）则保留原成绩
  if (prev && (prev.score > entry.score ||
      (prev.score === entry.score && (prev.wave || 0) >= (entry.wave || 0)))) {
    return list;
  }
  const rest = list.filter((e) => e.name !== entry.name);
  rest.push(entry);
  rest.sort(sortDesc);
  return rest.slice(0, 50);
}

function localSubmit({ date, name, wave, kills, score }) {
  const data = readLocal();
  const entry = { name, wave, kills, score, t: Date.now() };
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

const localDays = (local) => Object.keys(local.days).sort().reverse();

// ---------------- 对外接口 ----------------

/**
 * 提交当日成绩。本地始终写入，再尝试远端。
 * @returns {{ list: object[], all: object[], days: string[], remote: boolean }}
 */
export async function submitScore({ date, name, wave, kills, score }) {
  const local = localSubmit({ date, name, wave, kills, score });

  try {
    const r = await fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, name, wave, kills, score }),
    });
    if (r.ok) {
      const data = await r.json();
      if (data.ok && Array.isArray(data.list)) {
        return {
          list: data.list,
          all: data.all || local.all,
          days: data.days || localDays(local),
          remote: true,
        };
      }
    }
  } catch { /* 无后端 / 离线，用本地 */ }

  return {
    list: local.days[date] || [],
    all: local.all,
    days: localDays(local),
    remote: false,
  };
}

/** 拉取某天战绩 */
export async function fetchDay(date) {
  try {
    const r = await fetch(`/api/scores?date=${encodeURIComponent(date)}`);
    if (r.ok) {
      const data = await r.json();
      if (data.ok && Array.isArray(data.list)) return { list: data.list, remote: true };
    }
  } catch { /* 回退 */ }
  const local = readLocal();
  return { list: local.days[date] || [], remote: false };
}

/** 拉取总榜 + 已有战绩的日期列表 */
export async function fetchSummary() {
  try {
    const r = await fetch('/api/scores?view=all');
    if (r.ok) {
      const data = await r.json();
      if (data.ok) {
        return {
          all: Array.isArray(data.all) ? data.all : [],
          days: Array.isArray(data.days) ? data.days : [],
          remote: true,
        };
      }
    }
  } catch { /* 回退 */ }
  const local = readLocal();
  return { all: local.all, days: localDays(local), remote: false };
}

export { sortDesc };
