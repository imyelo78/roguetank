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

/**
 * 合并远端与本地榜单：同名取最高分。
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
  const localList = local.days[date] || [];

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
          // 远端可能只含云端的成绩，与本机记录合并，确保自己的这局一定在榜上
          list: mergeLists(data.list, localList),
          all: mergeLists(data.all || [], local.all),
          days: mergeDays(data.days || [], localDays(local)),
          remote: true,
        };
      }
    }
  } catch { /* 无后端 / 离线，用本地 */ }

  return {
    list: localList,
    all: local.all,
    days: localDays(local),
    remote: false,
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
export async function fetchDay(date) {
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

/** 拉取总榜 + 已有战绩的日期列表（同样与本地合并） */
export async function fetchSummary() {
  const local = readLocal();
  try {
    const r = await fetch('/api/scores?view=all');
    if (r.ok) {
      const data = await r.json();
      if (data.ok) {
        return {
          all: mergeLists(Array.isArray(data.all) ? data.all : [], local.all),
          days: mergeDays(Array.isArray(data.days) ? data.days : [], localDays(local)),
          remote: true,
        };
      }
    }
  } catch { /* 回退 */ }
  return { all: local.all, days: localDays(local), remote: false };
}

export { sortDesc };
