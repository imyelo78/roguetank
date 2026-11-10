// 旧站（roguetank.pages.dev）成绩同步
//
// 背景：新站的 handlePost 只收今天 / 昨天的成绩（防伪造历史战绩），所以旧站
// 那些历史记录没法用普通提交搬过来。上一版给了离线脚本 tools/import-old-scores.mjs，
// 结果没人跑、榜上一直没有旧数据。这版把它做成**服务端自动同步**：
//
//   1. 部署包自带 tools/old-scores.json（已抓好的旧站成绩快照）
//   2. 服务端启动 3 秒后在后台并入榜单存储，并写一个 meta:legacy 记录已完成
//   3. 已同步过就不再动；想重新抓就去掉 meta:legacy 或加 --force
//
// 与离线脚本的区别：脚本改的是某个 .data/scores.json 文件，得知道文件在哪；
// 这里的入口是 server.mjs 手里的**同一个** KV 实例，
// 所以"换目录部署""改过 DATA_DIR""跑在别名目录里"都不会再出现"导了但没生效"。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeEntry, mergeEntry, ALL_KEY, DAYS_KEY, DAY_PREFIX, getJSON, putJSON,
} from '../functions/api/_lib/leaderboard.js';

/** 同步完成标记：内容里带上批次信息，便于事后核对 */
const LEGACY_KEY = 'meta:legacy';

/** 快照默认位置：<站点根>/tools/old-scores.json */
export const defaultSnapshotPath = () =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'old-scores.json');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 读快照并转成可入库的记录。
 * 只认带合法日期、正分、有名字的条目——防的是快照里混进本地测试写的假成绩。
 */
export function prepareEntries(raw) {
  const list = Array.isArray(raw) ? raw : (raw?.list || []);
  const entries = [];
  let ignored = 0;
  for (const e of list) {
    if (!e || typeof e !== 'object') { ignored += 1; continue; }
    const date = String(e.date || '');
    const score = Number(e.score);
    if (!DATE_RE.test(date) || !(score > 0) || !String(e.name || '').trim()) {
      ignored += 1;
      continue;
    }
    // 旧站的车款早已下线，硬塞会过不了白名单校验；留空表示"未知"，不误导
    const t = Number(e.timeMs);
    const entry = normalizeEntry({
      name: e.name,
      wave: e.wave,
      kills: e.kills,
      score,
      timeMs: Number.isFinite(t) && t > 0 ? Math.round(t) : 0,
      players: e.players || 1,
      chassis: '',
      weapon: e.weapon || '',
      pid: e.pid || e.id || '',
    });
    if (!entry) { ignored += 1; continue; }
    if (Number.isFinite(Number(e.t)) && Number(e.t) > 0) entry.t = Math.round(Number(e.t));
    entry.date = date;
    entry.importedFrom = 'roguetank.pages.dev';
    entries.push(entry);
  }
  return { entries, ignored };
}

/**
 * 把一批旧记录并进 KV（幂等：同一身份只留最高分，t 用原始时间戳）。
 * @returns {Promise<{imported:number, total:number, days:string[], skipped:boolean}>}
 */
export async function importEntries(kv, entries, { force = false, source = 'snapshot' } = {}) {
  if (!force && (await getJSON(kv, LEGACY_KEY, null))) {
    return { imported: 0, total: await countAll(kv), days: [], skipped: true };
  }

  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }

  let allList = await getJSON(kv, ALL_KEY, []);
  for (const [date, list] of byDate) {
    const key = `${DAY_PREFIX}${date}`;
    let dayList = await getJSON(kv, key, []);
    for (const e of list) dayList = mergeEntry(dayList, e);
    for (const e of list) allList = mergeEntry(allList, e);
    await putJSON(kv, key, dayList);
  }

  await putJSON(kv, ALL_KEY, allList);
  const prevDays = await getJSON(kv, DAYS_KEY, []);
  const days = [...new Set([...byDate.keys(), ...prevDays])].sort().reverse().slice(0, 120);
  await putJSON(kv, DAYS_KEY, days);

  await putJSON(kv, LEGACY_KEY, {
    at: Date.now(),
    source,
    imported: entries.length,
    days: [...byDate.keys()].sort(),
    total: allList.length,
  });

  return { imported: entries.length, total: allList.length, days: [...byDate.keys()].sort(), skipped: false };
}

async function countAll(kv) {
  const all = await getJSON(kv, ALL_KEY, []);
  return Array.isArray(all) ? all.length : 0;
}

/**
 * 从磁盘快照同步（server.mjs 启动时调用）。
 * 任何失败都只记日志：榜单同步不该挡住开服。
 */
export async function syncLegacyScores(kv, { file = defaultSnapshotPath(), force = false, log = console.log } = {}) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // 没带快照（比如只挑了源码上传）就安静跳过，属于正常情况
    return { ok: false, reason: 'no-snapshot', file };
  }
  const { entries, ignored } = prepareEntries(raw);
  if (!entries.length) return { ok: false, reason: 'empty-snapshot', file };

  const r = await importEntries(kv, entries, { force, source: `file:${path.basename(file)}` });
  if (r.skipped) {
    log(`[legacy] 旧站成绩已同步过（总榜 ${r.total} 条），跳过`);
  } else {
    log(`[legacy] 旧站成绩已并入：${r.imported} 条 / ${r.days.length} 天`
      + `${ignored ? `（忽略 ${ignored} 条无效记录）` : ''}，总榜现有 ${r.total} 条`);
  }
  return { ok: true, ...r, ignored, file };
}
