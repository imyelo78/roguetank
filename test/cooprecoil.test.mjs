// 多人开炮「炮塔不动、只有画面抖」防回归
//
// 现象（用户原话）：单人版开炮时炮塔抖动很自然，多人版开炮时炮管纹丝不动，
// 只剩屏幕在抖。
//
// 完整成因：
//   1. coop.js 从不调用 tank.update(dt)。Tank.update 是纯表现层
//      （recoilT 递减 + turret.position.z 后座动画 + 负重轮滚动），
//      单机每帧调用，组队没人调——onEvents 里 recoil() 设了 recoilT=0.12，
//      但没人递减、没人写进炮管位置 → 炮管纹丝不动。
//   2. 组队 shot 事件的震屏幅度/衰减与单机不一致（0.14/1.2 vs 单机 0.1/1.6），
//      于是观感变成"画面抖得比单机凶，炮管却不动"。
//
// Tank 构造依赖完整 three 场景，Node 里不好端到端跑，这里用
// 「数值模拟 + 源码钉住」双保险：公式行为用真代码验证，接线用源码断言钉住。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
const ok = (msg) => { pass++; console.log(`  ✓ ${msg}`); };

console.log('\n[组队开炮后座]');

// ---------------- 1. Tank.update 的后座公式（数值模拟同一段逻辑） ----------------
{
  // 与 Tank.js update() 一致的公式，改动这里必须同步改源码（见断言 2）
  let recoilT = 0;
  let turretZ = 0;
  const recoil = () => { recoilT = 0.12; };
  const update = (dt) => {
    if (recoilT > 0) recoilT = Math.max(0, recoilT - dt);
    turretZ = -(recoilT / 0.12) * 0.32;
  };
  recoil();
  const zs = [];
  for (let i = 0; i < 12; i++) { update(1 / 60); zs.push(turretZ); }
  assert.ok(zs[0] < -0.2, `开炮下一帧炮管应立即后拉（首帧 ${zs[0].toFixed(3)}）`);
  assert.ok(zs[zs.length - 1] === 0, '0.12s 后后座应完全复位');
  assert.ok(Math.abs(zs[3]) > Math.abs(zs[zs.length - 2]), '复位应单调递减');
  ok('后座动画公式：0.12s 内从 -0.32 平滑复位到 0');
}

// ---------------- 2. 源码钉住：Tank.update 的衰减参数没被改坏 ----------------
{
  const tank = src('src/Tank.js');
  assert.match(tank, /recoil\(\) \{ this\.recoilT = 0\.12; \}/);
  assert.match(tank, /this\.turret\.position\.z = this\.turretBaseZ - \(this\.recoilT \/ 0\.12\) \* 0\.32/);
  ok('Tank.js：recoil 时长 0.12s / 后座 0.32m 保持不变');
}

// ---------------- 3. 源码钉住：coop.js 每帧驱动所有坦克（含敌人）的 update ----------------
{
  const coop = src('src/coop.js');
  // 主循环里必须有 for tanks → t.update(dt)，且 tanks 与 enemies 两组都覆盖。
  // 以前是"recoil() 设了值但没人递减"，回归特征就是 update 循环里没有 t.update。
  assert.match(coop, /for \(const \[, t\] of this\.tanks\) \{[\s\S]{0,600}?t\.update\(dt\);/);
  assert.match(coop, /for \(const \[, t\] of this\.enemies\) t\.update\(dt\);/);
  ok('coop.js：update 循环驱动 this.tanks 与 this.enemies 的 Tank.update');
}

// ---------------- 4. 源码钉住：组队震屏与单机对齐（0.1 / dt*1.6） ----------------
{
  const coop = src('src/coop.js');
  const game = src('src/Game.js');
  assert.match(coop, /this\._shake = Math\.max\(this\._shake, 0\.1\);/, '组队 shot 震屏幅度应为 0.1（与单机一致）');
  assert.match(coop, /this\._shake - dt \* 1\.6/, '组队震屏衰减应为 dt*1.6（与单机一致）');
  assert.match(game, /0\.1\)/, '单机 fire 震屏幅度 0.1');
  ok('组队与单机震屏参数对齐：幅度 0.1 / 衰减 1.6');
}

// ---------------- 5. 震屏偏移的加/撤配对（不撤会永久漂移相机） ----------------
{
  const coop = src('src/coop.js');
  // _shakeOff 每帧先撤掉上一帧加的偏移再算新值；_shake 归零时也要清零偏移
  assert.match(coop, /cam\.position\.x -= this\._shakeOff\.x;/);
  assert.match(coop, /cam\.position\.y -= this\._shakeOff\.y;/);
  assert.match(coop, /if \(this\._shake === 0\) \{ this\._shakeT = 0; this\._shakeOff\.x = 0; this\._shakeOff\.y = 0; \}/);
  ok('震屏偏移加/撤配对完整，不会永久漂移相机');
}

console.log(`\n  ${pass} 项全部通过\n`);
