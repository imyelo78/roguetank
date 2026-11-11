// 榜单存量清洗：把不合格的历史条目从存储里删掉
//
// 为什么需要单独一步：入口拦住了新提交，但**已经写进去的脏数据不会自己消失**。
// 线上真实情况：总榜末尾躺着一条 `gunner / 0 分 / 第 1 波 / 0 杀`，
// 那是"点了开始立刻被撞毁"留下的。它既没有意义，又在榜尾显得"0 分也能上榜"。
//
// 读取接口（handleGet）已经会过滤，所以页面上看不到；但存储里留着会让
// `stats` 的条数、`imported` 统计、以及以后做导出时都是脏的。这里一次性清干净。
//
// 幂等：没有脏数据就不写盘（避免每次启动都改写 mtime 和 ETag）。

import { ALL_KEY, DAYS_KEY, DAY_PREFIX, getJSON, putJSON, liveEntries } from '../functions/api/_lib/leaderboard.js';

/**
 * 扫描总榜与所有日榜，删除不合格条目。
 * @returns {Promise<{removed:number, days:string[], total:number}>}
 */
export async function pruneInvalidScores(kv, { log = console.log } = {}) {
  let removed = 0;
  const touchedDays = [];

  const all = await getJSON(kv, ALL_KEY, []);
  if (Array.isArray(all)) {
    const kept = liveEntries(all);
    const gone = all.length - kept.length;
    if (gone > 0) {
      await putJSON(kv, ALL_KEY, kept);
      removed += gone;
    }
  }

  // 日期索引只会保留有数据的日期；某个日期被清空后索引项留着无害，
  // 但没人再查它，也不必特意删除（删了反而丢掉"这天曾有人打"的信息）。
  const days = await getJSON(kv, DAYS_KEY, []);
  for (const date of Array.isArray(days) ? days : []) {
    const key = `${DAY_PREFIX}${date}`;
    const list = await getJSON(kv, key, []);
    if (!Array.isArray(list)) continue;
    const kept = liveEntries(list);
    if (kept.length === list.length) continue;
    await putJSON(kv, key, kept);
    removed += list.length - kept.length;
    touchedDays.push(date);
  }

  const total = liveEntries(await getJSON(kv, ALL_KEY, [])).length;
  if (removed > 0) {
    log(`[clean] 清掉 ${removed} 条无效成绩（0 分）`
      + `${touchedDays.length ? `，涉及 ${touchedDays.join(', ')}` : ''}；总榜现有 ${total} 条`);
  }
  return { removed, days: touchedDays, total };
}
