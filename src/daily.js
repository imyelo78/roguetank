// 每日挑战：日期种子确定性随机 + 分数上传/排行榜（远端 KV 失败时回退 localStorage）

const LB_KEY = 'tank3d.daily.lb.v1';
const NAME_KEY = 'tank3d.name.v1';

/** 当日日期键（本地时区）YYYY-MM-DD */
export function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  try { localStorage.setItem(NAME_KEY, name.slice(0, 12)); } catch { /* 忽略 */ }
}

function localList(date) {
  try { return JSON.parse(localStorage.getItem(LB_KEY))?.[date] || []; } catch { return []; }
}

function localSave(date, list) {
  try {
    const all = JSON.parse(localStorage.getItem(LB_KEY)) || {};
    all[date] = list.slice(0, 50);
    localStorage.setItem(LB_KEY, JSON.stringify(all));
  } catch { /* 忽略 */ }
}

/**
 * 提交成绩：先更新本地，再尝试远端（Cloudflare Pages Function + KV）。
 * 返回 { list, remote }
 */
export async function submitScore({ date, name, wave, kills, score }) {
  const local = localList(date).filter((e) => e.name !== name || e.score < score);
  local.push({ name: name || '指挥官', wave, kills, score, t: Date.now() });
  local.sort((a, b) => b.score - a.score || b.wave - a.wave);
  localSave(date, local);

  try {
    const r = await fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, name, wave, kills, score }),
    });
    if (r.ok) {
      const data = await r.json();
      if (data.ok && Array.isArray(data.list)) return { list: data.list, remote: true };
    }
  } catch { /* 无后端/离线，走本地 */ }
  return { list: local, remote: false };
}

/** 拉取排行榜：远端优先，失败回退本地 */
export async function fetchLeaderboard(date) {
  try {
    const r = await fetch(`/api/scores?date=${encodeURIComponent(date)}`);
    if (r.ok) {
      const data = await r.json();
      if (data.ok && Array.isArray(data.list)) return { list: data.list, remote: true };
    }
  } catch { /* 回退 */ }
  return { list: localList(date), remote: false };
}
