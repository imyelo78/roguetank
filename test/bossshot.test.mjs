// 破城者主炮命中率：改前（纯直线瞄当前点） vs 改后（炮口解算 + 提前量 + 俯角）
//
// 用户反馈"打破坏城者时它的主炮一点伤害都没有"。真实原因有两层：
//
//   ① 高度（硬 bug）：Boss 模型缩放 1.75 → 炮口世界高度 2.89 米，
//      而玩家命中判定上限是 HIT_TOP = 2.3 米。开火方向 y 分量为 0（平射），
//      炮弹保持 2.89 米高度从玩家头顶掠过，判定永远不成立 → 伤害恒为 0。
//   ② 提前量：就算高度修好，朝"你现在站的地方"打直线也必空——玩家横移
//      15 m/s，18 米飞 0.31 秒，人已经挪了 4.6 米，命中半径才 1.45 米。
//
// 这个测试把两层都建模进去（发射点取炮口、方向带俯角、命中判定带高度），
// 同一套几何只换瞄准算法，多距离多相位取平均，避免离散噪声。
//
// ⚠ 只算水平面是不够的：第一版用"车身中心 + 平射"建模，新算法命中率被
//   算成 31%，和浏览器实测（站桩 8.6 秒死、绕圈 29.6 秒死）对不上。
//   差的就是炮口前移与俯角这两项。

import { solveIntercept, flatPitch, AIM_DEFAULTS, HIT_TOP, AIM_BODY_Y } from '../src/core/aim.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

const DT = 1 / 60;
const HIT_R = 1.45;        // 与 Game._updateBullets 的玩家命中半径一致
const SPEED = 15;          // 豹式平地速度
const FIRE_CD = 4.6;       // 破城者单轮间隔（未狂暴，与 Enemy._updateBoss 一致）
const SPREAD = 0.15;       // 与 Enemy._updateBoss 的破城者散布一致
const DURATION = 240;

// —— 与 Tank.js 的建模式一致：standard 底盘 + 1.75 倍缩放 ——
// muzzle 挂在 turret 下，局部 (0, 0.06, 0.55 + 2.1)；
// 浏览器实测（getWorldPosition）：炮口 y = 2.888、水平前伸 4.638。
// 这两个数不是算出来的而是量出来的——公式里改任何一个数字，这条断言就该响。
const BOSS_SCALE = 1.75;
const MUZZLE_Y = 2.89;
const MUZZLE_R = 4.638;
const MUZZLE_R_EXPECT = (0.55 + 2.1) * BOSS_SCALE;

/**
 * @param {'lead'|'naive'} mode  lead=新算法，naive=旧的"车身中心平射瞄当前点"
 * @param {'still'|'straight'|'weave'|'orbit'} walk
 * @param {number} dist Boss 与玩家的距离
 * @param {number} phase 初始相位偏移（不同起手，压掉离散噪声）
 */
function simulate(mode, walk, dist, phase) {
  const BOSS = { x: 0, z: -dist };
  let px = phase;
  let pz = 0;
  let vx = 0;
  let vz = 0;
  let dirSign = 1;
  let nextTurn = 0;
  let ang = -Math.PI / 2 + phase / dist;

  let turretYaw = 0;      // 炮塔朝向（旧算法里炮塔自己也慢慢追人，这里简化为瞬时）
  const bullets = [];
  let shots = 0;
  let hits = 0;
  let t = 0;
  let nextFire = 1 + (Math.abs(phase) % 0.7);

  while (t < DURATION) {
    // ---- 玩家移动 ----
    if (walk === 'still') {
      vx = 0; vz = 0;
    } else if (walk === 'orbit') {
      ang += (SPEED / dist) * DT;
      px = Math.cos(ang) * dist;
      pz = -dist + Math.sin(ang) * dist;
      vx = -Math.sin(ang) * SPEED;
      vz = Math.cos(ang) * SPEED;
    } else if (walk === 'straight') {
      vx = SPEED * dirSign; vz = 0;
      // 折返只在"确实往外跑"时翻一次——用 Math.abs 每帧翻会把玩家卡在边界抖动
      if (px > 30 && vx > 0) dirSign = -1;
      if (px < -30 && vx < 0) dirSign = 1;
      px += vx * DT;
    } else {
      // weave：每 0.37 秒变向。刻意避开开火间隔的整数比，
      // 否则每次开火都落在同一个换向相位上，统计会有系统性偏差。
      nextTurn -= DT;
      if (nextTurn <= 0) {
        nextTurn = 0.37;
        dirSign *= -1;
      }
      vx = SPEED * dirSign; vz = 0;
      px += vx * DT;
    }

    // ---- 开火 ----
    nextFire -= DT;
    if (nextFire <= 0) {
      nextFire = FIRE_CD;

      // 旧算法：从**车身中心**、朝玩家**当前**位置、**水平**发射
      let ox = BOSS.x;
      let oz = BOSS.z;
      let fireY = 0;     // 方向向量 y 分量（0 = 平射，就是那个 bug）
      let sp = 44;       // 旧弹速
      let base = Math.atan2(px - BOSS.x, pz - BOSS.z);

      if (mode === 'lead') {
        // 新算法：从**炮口**出发解拦截 → 再按炮口到车身中部加俯角
        sp = AIM_DEFAULTS.breakerSpeed;
        ox = BOSS.x + Math.sin(turretYaw) * MUZZLE_R;
        oz = BOSS.z + Math.cos(turretYaw) * MUZZLE_R;
        const mdx = px - ox;
        const mdz = pz - oz;
        const sol = solveIntercept({
          dx: mdx, dz: mdz, vx, vz, speed: sp, lead: AIM_DEFAULTS.breakerLead,
        });
        base = sol ? Math.atan2(sol.x, sol.z) : Math.atan2(mdx, mdz);
        fireY = flatPitch(MUZZLE_Y, Math.hypot(mdx, mdz));
      }
      turretYaw = base;

      for (const off of [-SPREAD, 0, SPREAD]) {
        const a = base + off;
        // y 分量按水平速度的比例给，归一化后与 Enemy 里 dirAt 的算法一致
        const d = { x: Math.sin(a), y: fireY, z: Math.cos(a) };
        const len = Math.hypot(d.x, d.y, d.z);
        bullets.push({
          x: ox, y: MUZZLE_Y, z: oz,
          vx: d.x / len * sp, vy: d.y / len * sp, vz: d.z / len * sp,
          life: 4,
        });
        shots++;
      }
    }

    // ---- 炮弹推进 + 命中判定（复刻 Game._updateBullets） ----
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      const ny = b.y + b.vy * DT;
      b.x += b.vx * DT;
      b.z += b.vz * DT;
      b.y = ny;
      b.life -= DT;
      const onGround = b.y < 0.15;   // 砸地
      const near = Math.hypot(b.x - px, b.z - pz) < HIT_R && b.y < HIT_TOP;
      if (near) {
        hits++;
        bullets.splice(i, 1);
      } else if (b.life <= 0 || onGround) {
        bullets.splice(i, 1);
      }
    }
    t += DT;
  }

  return { shots, hits };
}

/** 多距离 × 多相位取平均（单场景 20 秒只有 15 发，样本太小会抖 ±3%） */
function rate(mode, walk) {
  let shots = 0;
  let hits = 0;
  for (const dist of [15, 18, 22]) {
    for (const phase of [-6, -3, 0, 3, 6]) {
      const r = simulate(mode, walk, dist, phase);
      shots += r.shots;
      hits += r.hits;
    }
  }
  return hits / shots;
}

const pct = (v) => `${(v * 100).toFixed(0)}%`;

console.log('破城者主炮命中率（多距离 × 多相位平均，含炮口位置与俯角）');

const stillOld = rate('naive', 'still');
const stillNew = rate('lead', 'still');
const straightOld = rate('naive', 'straight');
const straightNew = rate('lead', 'straight');
const weaveNew = rate('lead', 'weave');
const orbitNew = rate('lead', 'orbit');
const orbitOld = rate('naive', 'orbit');

console.log(`  新算法：站桩 ${pct(stillNew)} / 直线 ${pct(straightNew)} / 蛇形 ${pct(weaveNew)} / 绕圈 ${pct(orbitNew)}`);
console.log(`  旧算法：站桩 ${pct(stillOld)} / 直线 ${pct(straightOld)} / 绕圈 ${pct(orbitOld)}`);

// 1) 旧算法：平射的炮弹从头顶掠过，连站桩都打不中 —— 这就是用户看到的"0 伤害"
ok('站桩：旧算法 0 命中（复现"主炮一点伤害都没有"的硬 bug）',
  stillOld < 0.02, pct(stillOld));
ok('站桩：新算法打得中（加了俯角后炮弹才落进车身）',
  stillNew > 0.25, pct(stillNew));

// 2) 匀速直线：两边都很难打中，但原因不同——旧的是高度、新的是提前量误差
ok('匀速直线跑：旧算法仍是 0', straightOld < 0.02, pct(straightOld));
ok('匀速直线跑：新算法打得中（提前量 + 俯角一起生效）',
  straightNew > 0.25, `${pct(straightNew)}（旧 ${pct(straightOld)}）`);

// 3) 绕圈是"匀速但不直线"的走位，提前量照样算得准
ok('绕圈跑：旧算法 0 命中（玩家的日常打法）', orbitOld < 0.02, pct(orbitOld));
ok('绕圈跑：新算法能打中', orbitNew > 0.25, pct(orbitNew));

// 4) 但变向要能躲——否则就是把玩家钉死
ok('蛇形变向：命中率低于匀速直线（变向仍是有效解法）',
  weaveNew < straightNew, `蛇形 ${pct(weaveNew)} vs 直线 ${pct(straightNew)}`);

// 5) 单轮三发不能全中（那玩家 8 秒就没了）
ok('单轮期望命中不超过 2 发（三发中最多两发）',
  orbitNew < 0.7, `最高场景 ${pct(orbitNew)}`);

// 6) 俯角数学：2.89 米的炮口打 18 米外，落点必须穿过车身中部且低于判定上限
{
  const pitch = flatPitch(MUZZLE_Y, 18);
  const len = Math.hypot(1, pitch);
  const yAt = MUZZLE_Y + (pitch / len) * 18;   // 单位方向飞 18 米后的高度
  ok('俯角：飞到 18 米时正好穿过车身中部', yAt > 0.9 && yAt < 1.3, `y=${yAt.toFixed(2)}m`);
  ok('俯角：落点低于命中上限（否则平射那个 bug 会复发）', yAt < HIT_TOP, `HIT_TOP=${HIT_TOP}`);
  // 小兵（炮口 1.6 米）不该被压成高抛：只给 1.4° 的最小下压量
  const small = flatPitch(1.6, 18);
  ok('小兵的弹道几乎不被改动（下压 ≤ 3°）', Math.abs(small) < 0.055,
    `${(Math.atan(Math.abs(small)) * 180 / Math.PI).toFixed(1)}°`);
  ok('flatPitch 必须是负值（正数=往下瞄却往上飞，第一版就错在这里）',
    pitch < 0 && small < 0, `boss ${pitch.toFixed(3)} / 小兵 ${small.toFixed(3)}`);
  ok('炮口前伸与建模一致（4.638m，是命中半径 1.45 的 3 倍——按车身中心解算会整体偏这么多）',
    Math.abs(MUZZLE_R - MUZZLE_R_EXPECT) < 0.02,
    `实测 ${MUZZLE_R} vs 建模 ${MUZZLE_R_EXPECT.toFixed(3)}`);
}

// 7) 拦截解算的数学正确性
{
  const sol = solveIntercept({ dx: 0, dz: -18, vx: 15, vz: 0, speed: 62, lead: 1 });
  const flyT = Math.hypot(sol.x, sol.z) / 62;
  ok('拦截解算：预测点的到达时间 = 实际飞行时间', Math.abs(sol.t - flyT) < 1e-6,
    `t=${sol.t.toFixed(3)}s`);
  ok('拦截解算：预测点确实落在目标未来位置', Math.abs(sol.x - 15 * sol.t) < 1e-6,
    `x=${sol.x.toFixed(2)} 应为 ${(15 * sol.t).toFixed(2)}`);
}

// 8) 退化保护
{
  const fast = solveIntercept({ dx: 0, dz: 5, vx: 200, vz: 0, speed: 62, lead: 1 });
  ok('目标比炮弹快：返回 null 或有限值（上层不会拿到 NaN）',
    fast === null || Number.isFinite(fast.x));
  ok('弹速为 0：返回 null', solveIntercept({ dx: 0, dz: 10, speed: 0 }) === null);
  const behind = solveIntercept({ dx: 0, dz: 10, vx: 0, vz: 0, speed: 62 });
  ok('静止目标：解出直线命中时间', Math.abs(behind.t - 10 / 62) < 1e-6,
    `t=${behind.t.toFixed(4)}s`);
}

// 9) 参数护栏
ok('预判系数 < 1（留出躲避余地，否则变向无用）', AIM_DEFAULTS.breakerLead < 1,
  `lead=${AIM_DEFAULTS.breakerLead}`);
ok('破城者弹速已提升到 62', AIM_DEFAULTS.breakerSpeed === 62);

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
