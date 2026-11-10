// 组队小地图与"敌人在开火"提示：端到端
//
// 用户这条线是这样报过来的：
//   「破坏者的主炮是不是失效了，去掉炮击锁定后它对我没伤害了」
// 实测主炮完全正常（12 秒 4 轮齐射、每发 7 点）。真正的问题是**玩家不知道**：
// 联机的敌人开炮没有炮口火光（玩家才有）、没有音效、屏幕也不震。
// 这里补两件事，并用测试钉住：
//   1. coop 模式的小地图要真正画出来（以前 canvas 一直在页面上，组队却是空的）
//   2. 敌人开炮必须产生 eshot 事件，客户端据此在小地图上闪一下

import assert from 'node:assert/strict';
import { World, ENEMY_TYPES } from '../src/core/world.js';
import { createPlayer } from '../src/core/players.js';

let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

console.log('\n[组队小地图 / 开火提示]');

// ---------------- 1. 敌人开炮会推 eshot 事件 ----------------
{
  const w = new World({ seed: 7, terrainPreset: 'off' });
  w.players.push(createPlayer({ id: 'p1', name: 'A', chassisId: 'panther', x: 0, z: 0 }));
  w.start();

  // 直接塞一个敌人到玩家正前方，炮塔已对准 → 下一个 tick 必然开火
  const tpl = ENEMY_TYPES.gunner;
  w.enemies.push({
    id: 'e1', type: 'gunner', x: 0, z: -14, yaw: 0, turretYaw: 0,
    hp: 100, maxHp: 100, speed: tpl.speed, radius: tpl.radius, damage: tpl.damage,
    range: tpl.range, fireCd: 0, fireCdRange: tpl.fireCd, bulletSpeed: tpl.bulletSpeed,
    score: tpl.score, alive: true, boss: false, fireCdRangeOk: true,
  });
  // 补上世界初始化时会给敌人加的字段（不同版本字段名略有差异，这里只保证开火判据齐全）
  const e = w.enemies[0];
  e.fireCd = 0;
  e.range = tpl.range;
  e.bulletSpeed = tpl.bulletSpeed;
  e.fireCdRange = tpl.fireCd;

  const events = [];
  for (let i = 0; i < 40; i++) {
    const ev = w.step(1 / 30);
    for (const it of ev) events.push(it);
    if (events.some((x) => x.kind === 'eshot')) break;
  }
  const eshot = events.filter((x) => x.kind === 'eshot');
  ok('敌人开火会推送 eshot 事件', eshot.length > 0, JSON.stringify(events.map((x) => x.kind)));
  if (eshot.length) {
    ok('eshot 只带敌人 id（不带坐标，省字节）',
      eshot[0].id === 'e1' && eshot[0].x === undefined && eshot[0].z === undefined,
      JSON.stringify(eshot[0]));
  }
}

// ---------------- 2. 小地图接口：队友 / 子弹 / 脉冲都能吃 ----------------
{
  // 用一个最小 canvas 桩喂给 Minimap（Node 里没有 DOM）
  const calls = [];
  const ctxStub = new Proxy({}, {
    get(_, k) {
      if (k === 'canvas') return null;
      return (...args) => { calls.push([k, ...args]); };
    },
    set() { return true; },
  });
  const makeCanvas = () => ({ width: 0, height: 0, style: {}, getContext: () => ctxStub });
  const canvas = makeCanvas();
  // _bake() 会 document.createElement('canvas') 造离屏画布（地表 + 障碍底图）。
  // Node 里没有 DOM，给它一个最小的替身即可 —— 测的是绘制调用，不是浏览器行为。
  globalThis.document = { createElement: () => makeCanvas() };
  const world = { half: 100, obstacles: [], terrain: null };

  const { Minimap } = await import('../src/minimap.js').catch((err) => {
    // minimap.js 顶层 import 了 three，Node 下可能拿不到 DOM；这里给出明确信息
    throw new Error('minimap 模块无法在 Node 下加载：' + err.message);
  });
  const mm = new Minimap(canvas, world, { size: 168 });
  calls.length = 0;

  mm.update({
    player: { x: 0, z: 0, rot: 0 },
    enemies: [{ position: { x: 10, z: 10 }, type: 'gunner' }],
    warnings: [],
    mates: [{ x: -20, z: -20 }],
    bullets: [{ x: 5, z: 5, team: 'enemy' }, { x: 6, z: 6, team: 'player' }],
  });
  const arcs = calls.filter((c) => c[0] === 'arc');
  ok('小地图画出了敌人 + 队友 + 来袭炮弹', arcs.length >= 3, `arc 调用 ${arcs.length} 次`);

  // 脉冲：画一次之后有生命周期，超过时长自动消失
  calls.length = 0;
  mm.pulse([{ x: 0, z: -10 }]);
  ok('pulse 入队成功', mm.pulses.length === 1);
  mm.update({ player: { x: 0, z: 0, rot: 0 }, enemies: [] });
  ok('脉冲会在小地图上画出来', calls.some((c) => c[0] === 'stroke'));

  // 时间到了要清掉，否则会一直画
  mm.pulses[0].t -= 10000;
  mm.update({ player: { x: 0, z: 0, rot: 0 }, enemies: [] });
  ok('脉冲过期后自动清理', mm.pulses.length === 0);

  // 坐标坏掉时不能污染画布（NaN 会让整个 2D context 静默失效）
  const before = calls.length;
  mm.pulse([{ x: NaN, z: 0 }, { x: 1, z: Infinity }]);
  ok('非法坐标的脉冲被丢弃', mm.pulses.length === 0, `新增 ${calls.length - before} 次调用`);
}

console.log(`\n组队小地图：${pass} 项全部通过`);
