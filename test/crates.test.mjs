// 战场宝箱（r43）回归测试。
//
// 钉住四件事：
//   1. 数量随人数：1~2 人 1~2 个、3~4 人 2~3 个
//   2. 位置约束：不落在建筑里、离玩家 ≥26m、彼此 ≥18m
//   3. 服务端拾取：靠近 3.2m 自动开箱、卡生效、箱子移除、事件下发
//   4. 开卡按类别且排除满级：满级卡永远开不出来
import assert from 'node:assert/strict';
import { crateCount, cratePositions, rollCard, rollCategory, CATEGORIES } from '../src/core/crates.js';
import { World } from '../src/core/world.js';
import { createStats } from '../src/upgrades.js';

let pass = 0;
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }

// ---- 1) 数量随人数 ----
{
  for (let i = 0; i < 200; i++) {
    const a = crateCount(1, Math.random);
    assert.ok(a >= 1 && a <= 2, `1 人应 1~2 个，实际 ${a}`);
    const b = crateCount(2, Math.random);
    assert.ok(b >= 1 && b <= 2, `2 人应 1~2 个，实际 ${b}`);
    const c = crateCount(4, Math.random);
    assert.ok(c >= 2 && c <= 3, `4 人应 2~3 个，实际 ${c}`);
  }
  ok('数量随人数：1~2 人 1~2 个，3~4 人 2~3 个（200 轮）');
}

// ---- 2) 位置约束 ----
{
  const players = [{ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 0, z: 30 }];
  // 假建筑：把中心圈起来，任何落点都不许进
  const blocked = (x, z) => Math.hypot(x - 50, z - 50) < 10;
  let rnd = (() => { let s = 12345; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32); })();
  const pts = cratePositions({ half: 100, players, blocked, rnd, count: 3 });
  assert.equal(pts.length, 3);
  for (const p of pts) {
    assert.ok(!blocked(p.x, p.z), `落点(${p.x.toFixed(1)},${p.z.toFixed(1)})不得在建筑里`);
    for (const q of players) {
      assert.ok(Math.hypot(p.x - q.x, p.z - q.z) >= 26, '落点离玩家 ≥26m');
    }
  }
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z) >= 18, '落点彼此 ≥18m');
    }
  }
  ok('位置约束：离玩家 ≥26m、彼此 ≥18m、不进建筑');
}

// ---- 3) 服务端生成 + 拾取 ----
{
  // seed 3：W2 稳定投 2 个（相距 61m），方便断言"只拾取踩到的那一个"
  const w = new World({ code: 'TEST', seed: 3 });
  const p = w.addPlayer({ name: 't' });
  w.state = 'playing';
  w.startWave(2);
  assert.ok(w.crates.length >= 1 && w.crates.length <= 2, `W2 空投 1~2 个，实际 ${w.crates.length}`);
  const kinds = new Set(w.crates.map((c) => c.cat));
  for (const k of kinds) assert.ok(CATEGORIES[k], `类别 ${k} 必须在 CATEGORIES 里`);
  ok(`空投 ${w.crates.length} 个宝箱，类别合法`);

  const before = w.crates.length;
  // 开到第一个箱子旁边 → 只拾取这一个
  const c = w.crates[0];
  p.x = c.x;
  p.z = c.z + 2;
  const events = w.step(1 / 30);
  const get = events.find((e) => e.kind === 'crateGet');
  assert.ok(get, '必须有 crateGet 事件');
  assert.equal(get.id, p.id, '拾取者必须是开到旁边的玩家');
  assert.equal(events.filter((e) => e.kind === 'crateGet').length, 1, '一个 tick 只拾取一个');
  assert.ok(get.card && get.card.id && get.card.name, `开出的卡要带 id/name：${JSON.stringify(get.card)}`);
  assert.equal(w.crates.length, before - 1, `拾取后应剩 ${before - 1} 个`);
  assert.ok(Object.values(p.stats.counts).reduce((a, b) => a + b, 0) >= 1, 'stats.counts 必须记账');
  ok(`拾取生效：开出 ${get.card.icon}${get.card.name}，counts 已记账，箱子移除`);

  // 远离后不再触发
  const ev2 = w.step(1 / 30);
  assert.ok(!ev2.some((e) => e.kind === 'crateGet'), '远离后不得误触发');
  ok('远离宝箱不误触发');

  // fullState 带上剩余箱子（重连恢复）
  const fs = w.fullState();
  assert.equal(fs.crates.length, w.crates.length);
  if (w.crates.length) assert.equal(fs.crates[0].id, w.crates[0].id);
  ok('fullState 下发剩余宝箱（重连可恢复）');
}

// ---- 4) 开卡按类别且排除满级 ----
{
  const s = createStats('standard');
  const counts = {};
  let n = 0;
  const rnd = () => (n = (n * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < 100; i++) {
    const card = rollCard(s, counts, 'attack', rnd);
    assert.ok(card, 'attack 池必须开出卡');
    assert.ok(['damage', 'reload', 'multishot', 'pierce', 'explosive', 'railgun', 'overload'].includes(card.id),
      `attack 类别只能开火力卡，实际 ${card.id}`);
  }
  ok('attack 类别 100 次全部开出火力卡');

  // 把 damage 拿满，剩下的只能是非 damage 火力卡
  const s2 = createStats('standard');
  const counts2 = { damage: 5 };
  for (let i = 0; i < 60; i++) {
    const card = rollCard(s2, counts2, 'attack', rnd);
    assert.notEqual(card.id, 'damage', 'damage 满级后不得再开出');
  }
  ok('满级卡被排除（damage 拿满后 60 次不再出现）');

  // 整个类别全满 → 兜底 repair
  const s3 = createStats('standard');
  const counts3 = { damage: 5, reload: 4, multishot: 2, pierce: 2, explosive: 2, railgun: 2, overload: 1 };
  const card = rollCard(s3, counts3, 'attack', rnd);
  assert.equal(card.id, 'repair', `池子抽空应兜底 repair，实际 ${card.id}`);
  ok('类别抽空兜底「战地维修」');
}

console.log(`\n宝箱回归测试全部通过：${pass} 项\n`);
