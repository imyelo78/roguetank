// 榜单与身份
//
// r59 起三条榜分立（与服务端 functions/api/_lib/leaderboard.js 同一套规则）：
//   solo     单人无尽榜（今日 + 历史）
//   coop     组队榜（今日 + 历史）。2 人和 4 人同榜混排不加权，players 只做标注。
//            服务端房间结算时自动上报（数值来自服务端，客户端伪造不了），
//            客户端**不**提交 coop——这里保留本地兜底只为显示。
//   campaign 战役荣誉榜（不按天）：通关 > 难度 > 击毁 > 用时。固定图人人同局，
//            比的是"打得又狠又快"。
//
// 三条原则不变：
//   1. 本地永远先写（断网、服务端异常也不丢战绩），远端失败进补传队列。
//   2. 去重身份优先用 pid（改名后仍是同一个人），与服务端保持一致。
//   3. 榜单条目带人数与车体，读者自己判断可比性。

const LB_KEY = 'tank3d.lb.v4';          // 单人榜（沿用旧键，老用户本地数据无缝续用）
const LB_KEY_V3 = 'tank3d.lb.v3';
const LB_KEY_V2 = 'tank3d.daily.lb.v2';
const MODES_KEY = 'tank3d.lb.modes.v1'; // coop + campaign 的本地榜（v1 新开）
const NAME_KEY = 'tank3d.name.v1';
const PID_KEY = 'tank3d.pid.v1';
const PENDING_KEY = 'tank3d.pending.v1'; // 上传失败的成绩，下次启动补传
const LAST_MODE_KEY = 'tank3d.lastmode.v1'; // 上次玩的模式：榜单卡默认停在它

const EMPTY = () => ({ days: {}, all: [] });

export const LB_MODES = ['solo', 'coop', 'campaign'];

/** 战役难度（与 src/core/villers.js 的 DIFFICULTIES 一致） */
export const CAMPAIGN_DIFFS = [
  { id: 'novice', name: '新手' },
  { id: 'normal', name: '普通' },
  { id: 'ruthless', name: '冷血' },
  { id: 'wittmann', name: '魏神' },
];

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

/** 上次玩的模式（榜单卡默认显示它），非法值回 solo */
export function loadLastMode() {
  try {
    const m = localStorage.getItem(LAST_MODE_KEY);
    return LB_MODES.includes(m) ? m : 'solo';
  } catch { return 'solo'; }
}

export function saveLastMode(mode) {
  if (!LB_MODES.includes(mode)) return;
  try { localStorage.setItem(LAST_MODE_KEY, mode); } catch { /* 忽略 */ }
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

/**
 * 0 分不算一局成绩（开局即毁 / 直接退出），不上榜。
 *
 * 和服务端 `functions/api/_lib/leaderboard.js` 的 `isValidEntry` 是同一条规则：
 * 两边都拦，是因为只拦一边都会漏 —— 前端不拦会白发一次请求，
 * 后端不拦则旧客户端仍然能塞进来。
 */
const hasScore = (e) => !!e && Number(e.score) > 0;

/** 战役成绩是否算数：通关必留；没通关至少击毁一辆（与服务端同规则） */
const hasCampaignResult = (e) => !!e && !!e.name && (e.win || Number(e.kills) > 0);

function normalize(v) {
  const out = EMPTY();
  if (!v || typeof v !== 'object') return out;
  if (v.days && typeof v.days === 'object') {
    // 清掉历史遗留的 0 分（老版本会把"开局即死"也写进本地榜）
    out.days = {};
    for (const [k, list] of Object.entries(v.days)) {
      out.days[k] = Array.isArray(list) ? list.filter(hasScore) : [];
    }
  }
  if (Array.isArray(v.all)) out.all = v.all.filter(hasScore);
  return out;
}

function readLocal() {
  try {
    const raw = localStorage.getItem(LB_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      const parsed = normalize(obj);
      // 只有真的过滤掉了东西才写回。用条数比较而不是比较 JSON 字符串：
      // 后者受键顺序、空字段影响，会变成"每次读都写一遍"。
      const countIn = (d) => (Array.isArray(d?.all) ? d.all.length : 0)
        + Object.values(d?.days || {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
      if (countIn(obj) !== countIn(parsed)) writeLocal(parsed);
      return parsed;
    }

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

// ---- coop / campaign 的本地榜（新键） ----

function readModes() {
  try {
    const v = JSON.parse(localStorage.getItem(MODES_KEY));
    return {
      coop: normalize(v?.coop),
      campaign: Array.isArray(v?.campaign) ? v.campaign.filter(hasCampaignResult) : [],
    };
  } catch { return { coop: EMPTY(), campaign: [] }; }
}

function writeModes(data) {
  try { localStorage.setItem(MODES_KEY, JSON.stringify(data)); } catch { /* 忽略 */ }
}

const sortDesc = (a, b) => (b.score || 0) - (a.score || 0)
  || (b.wave || 0) - (a.wave || 0)
  || (a.t || 0) - (b.t || 0);

// 战役排序/合并：与 functions/api/_lib/leaderboard.js 的 campaignSort/mergeCampaignEntry
// 保持同一规则（那边是权威实现）。不在客户端直接 import 它——浏览器要按路径拉那个
// 文件，部署形态（Pages Function）不保证它可静态访问，这里复制一份并注明来源。
const campaignRank = (d) => Math.max(0, CAMPAIGN_DIFFS.findIndex((x) => x.id === d));
const campaignSort = (a, b) => (b.win || 0) - (a.win || 0)
  || campaignRank(b.difficulty) - campaignRank(a.difficulty)
  || (b.kills || 0) - (a.kills || 0)
  || ((a.win ? 1 : -1) * (a.timeMs || 0) - (b.win ? 1 : -1) * (b.timeMs || 0))
  || (a.t || 0) - (b.t || 0);

/** 去重身份：与服务端一致，优先 pid */
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

/** 战役榜合并：同身份保留"排得最前"的那条 */
export function mergeCampaignEntry(list, entry) {
  const key = identOf(entry);
  const prev = list.find((e) => identOf(e) === key);
  if (prev && campaignSort(prev, entry) <= 0) return list;
  const rest = list.filter((e) => identOf(e) !== key);
  rest.push(entry);
  rest.sort(campaignSort);
  return rest.slice(0, TOP_N);
}

/**
 * 合并远端与本地榜单：同身份取最高分。
 * 避免"云端返回空/服务端异常"时把本机成绩抹掉（期间打的局不能丢）。
 */
export function mergeLists(remote = [], local = []) {
  let out = Array.isArray(remote) ? [...remote] : [];
  for (const e of Array.isArray(local) ? local : []) {
    if (!e || !e.name || typeof e.score !== 'number' || !hasScore(e)) continue;
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

/** 战役本地条目：字段与服务端 normalizeCampaignEntry 对齐 */
const makeCampaignEntry = (run) => {
  const e = {
    name: run.name,
    difficulty: run.difficulty,
    win: run.win ? 1 : 0,
    kills: run.kills,
    timeMs: run.timeMs || 0,
    t: Date.now(),
  };
  if (run.pid) { e.pid = run.pid; e.id = `${run.name}#${run.pid}`; }
  return e;
};

function localSubmit(run) {
  const entry = makeEntry(run);
  const date = run.date || todayKey();
  const mode = run.mode === 'coop' ? 'coop' : 'solo';

  if (mode === 'coop') {
    const data = readModes();
    const local = data.coop;
    local.days[date] = mergeEntry(local.days[date] || [], entry);
    local.all = mergeEntry(local.all, entry);
    const keys = Object.keys(local.days).sort().reverse().slice(0, 120);
    const trimmed = {};
    for (const k of keys) trimmed[k] = local.days[k];
    local.days = trimmed;
    writeModes({ ...data, coop: local });
    return local;
  }

  const data = readLocal();
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

function localCampaignSubmit(run) {
  const data = readModes();
  data.campaign = mergeCampaignEntry(data.campaign, makeCampaignEntry(run));
  writeModes(data);
  return data.campaign;
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
    && x.score === item.score && x.wave === item.wave && x.mode === item.mode));
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
    // 队列里可能躺着老版本存下的 0 分成绩：服务端会拒（no-score），
    // 留在队列里会每次启动都重试一遍，永远清不掉。直接丢弃。
    if (item.mode === 'campaign' ? !hasCampaignResult(item) : !hasScore(item)) continue;
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
 * @param {{mode?, date?, name, wave, kills, score, timeMs?, chassis?, weapon?, mods?, players?}} run
 *   mode='campaign' 时走战役榜：需要 {difficulty, win, kills, timeMs}，不需要 score/wave。
 */
export async function submitScore(run) {
  const isCampaign = run.mode === 'campaign';

  // 战役：没通关又一辆没毁的局不存在（服务端同规则 no-kills），不发请求
  if (isCampaign && !hasCampaignResult(run)) {
    return { list: readModes().campaign, remote: null, reason: 'no-kills' };
  }
  // 单人/组队：0 分不写本地、不上传、不进补传队列。
  // `remote: null` 让结算页显示"0 分不计入榜单"，而不是"云端同步失败"。
  if (!isCampaign && !hasScore(run)) {
    const local = run.mode === 'coop' ? readModes().coop : readLocal();
    return {
      list: local.days?.[todayKey()] || [],
      all: local.all,
      days: localDays(local),
      remote: null,
      reason: 'no-score',
    };
  }

  const pid = getPid();
  let payload;
  let localList;
  let localAll;

  if (isCampaign) {
    payload = {
      mode: 'campaign',
      name: run.name,
      difficulty: run.difficulty,
      win: run.win ? 1 : 0,
      kills: run.kills,
      timeMs: run.timeMs || 0,
      pid,
    };
    localList = localCampaignSubmit(run);
    localAll = localList;
  } else {
    payload = {
      mode: run.mode === 'coop' ? 'coop' : 'solo',
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
    localList = local.days?.[payload.date] || [];
    localAll = local.all;
  }

  const res = await postScore(payload);
  if (res.ok) {
    const d = res.data;
    if (isCampaign) {
      // 远端可能只含云端的成绩，与本机记录合并，确保自己的这局一定在榜上
      return { list: mergeCampaignEntry(d.list || [], localList), remote: true };
    }
    return {
      // 远端可能只含云端的成绩，与本机记录合并，确保自己的这局一定在榜上
      list: mergeLists(d.list || [], localList),
      all: mergeLists(d.all || [], localAll),
      days: mergeDays(d.days || [], localDays(readLocal())),
      remote: true,
    };
  }

  pushPending({ ...payload, t: Date.now() });
  return {
    list: localList,
    all: localAll,
    days: isCampaign ? [] : localDays(payload.mode === 'coop' ? readModes().coop : readLocal()),
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

/**
 * 拉取今日榜（远端 + 本地合并）
 * @param {string} [date]
 * @param {'solo'|'coop'} [mode]
 */
export async function fetchDay(date = todayKey(), mode = 'solo') {
  const m = mode === 'coop' ? 'coop' : 'solo';
  const local = m === 'coop' ? readModes().coop : readLocal();
  const localList = local.days?.[date] || [];
  try {
    const r = await fetch(`/api/scores?date=${encodeURIComponent(date)}&mode=${m}`);
    if (r.ok) {
      const data = await r.json();
      if (data.ok && Array.isArray(data.list)) {
        return { list: mergeLists(data.list, localList), remote: true };
      }
    }
  } catch { /* 回退 */ }
  return { list: localList, remote: false };
}

/**
 * 拉取总榜（远端 + 本地合并）
 * @param {'solo'|'coop'} [mode]
 */
export async function fetchAll(mode = 'solo') {
  const m = mode === 'coop' ? 'coop' : 'solo';
  const local = m === 'coop' ? readModes().coop : readLocal();
  try {
    const r = await fetch(`/api/scores?view=all&mode=${m}`);
    if (r.ok) {
      const data = await r.json();
      if (data.ok) {
        return { all: mergeLists(Array.isArray(data.all) ? data.all : [], local.all), remote: true };
      }
    }
  } catch { /* 回退 */ }
  return { all: local.all, remote: false };
}

/**
 * 拉取战役荣誉榜（不按天）
 * @param {string} [difficulty] 传了只返回该难度的排名
 */
export async function fetchCampaign(difficulty = '') {
  const local = readModes().campaign;
  const localList = difficulty ? local.filter((e) => e.difficulty === difficulty) : local;
  try {
    const q = difficulty ? `&difficulty=${encodeURIComponent(difficulty)}` : '';
    const r = await fetch(`/api/scores?mode=campaign&view=all${q}`);
    if (r.ok) {
      const data = await r.json();
      if (data.ok && Array.isArray(data.list)) {
        const out = difficulty ? [...data.list] : mergeCampaignEntry(data.list, local);
        return { list: out, remote: true };
      }
    }
  } catch { /* 回退 */ }
  return { list: localList, remote: false };
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
