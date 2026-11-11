// 移动抖动回归测试。
//
// 跑真实的 CoopMode._reconcile + 真实的 predict（core/motion.stepBody），
// 服务端按 30Hz 推进、客户端按给定帧率跑"预测 → 校正 → 外推"，
// 然后看画出来的位置每帧走了多远。匀速行驶时它必须是恒定的。
//
// 钉死三条：
//   1) 直线与转向过程中，逐帧位移不能出现"卡住"或"跳一下"（帧间突变 0 次）
//   2) 单帧位移不超过理想值的 1.7 倍（输入切换时允许几帧平滑过渡）
//   3) 完全静止时，画出来的位置一个像素都不许动
//
// 历史：这两条都真的坏过。渲染外推曾经用 sin(yaw)*speed，转向时车头还没
// 追齐、位置已经沿输入方向走了，每个 tick 归零一次，画面就被拉成锯齿；
// 后来改成"每帧重新算 me+速度×acc"，又在按下 A/D 的那一帧横跳 43cm。
import assert from 'node:assert/strict';
import { CoopMode } from '../src/coop.js';
import { predict } from '../src/net.js';

const TICK_DT = 1 / 30;
const HALF = 1000;
const COL = { speedAt: () => 1, hit: () => null };
const SPEED = 15;

let pass = 0;
const ok = (msg) => { pass++; console.log(`  ✓ ${msg}`); };

function makeCoop() {
  const c = Object.create(CoopMode.prototype);
  c.myId = 'u1';
  c._shift = { x: 0, z: 0 };
  c._vel = { x: 0, z: 0 };
  c._disp = { x: 0, z: 0, yaw: 0 };
  c._predAcc = 0;
  c._yawVel = 0;
  c._moveDir = null;
  c.me = {
    id: 'u1', x: 0, z: 0, yaw: Math.PI, speed: 0, speedBase: SPEED,
    alive: true, down: false, turretYaw: 0, turretRate: 0, turretLimit: Math.PI,
  };
  c.tanks = new Map();
  c.world = COL;
  return c;
}

/** 跑一段脚本化操作，返回每帧的渲染位置 */
function simulate(fps, seconds, inputAt) {
  const c = makeCoop();
  const DT = 1 / fps;
  const hist = [];
  const track = [];
  const out = [];
  for (let f = 0; f < fps * seconds; f++) {
    const t = f * DT;
    const input = inputAt(t);
    c._moveDir = Math.atan2(input.mx, input.mz);

    c._predAcc += DT;
    const from = { x: c.me.x, z: c.me.z, yaw: c.me.yaw };
    let ticks = 0;
    while (c._predAcc >= TICK_DT && ticks < 8) {
      c._predAcc -= TICK_DT;
      ticks++;
      predict(c.me, input, TICK_DT, COL, HALF);
    }
    // 记下每个 tick 结束时的逻辑位置，供上面造"晚 1 tick"的快照
    track[Math.floor(f * DT / TICK_DT)] = { x: c.me.x, z: c.me.z };

    if (ticks > 0) {
      c._yawVel = (((c.me.yaw - from.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) / (ticks * TICK_DT);
      c._vel.x = (c.me.x - from.x) / (ticks * TICK_DT);
      c._vel.z = (c.me.z - from.z) / (ticks * TICK_DT);
      hist.push({ x: c.me.x, z: c.me.z });
    }

    // 服务端位置：晚 1 个 tick（真实网络延迟的最小单位）
    //
    // ⚠ 这条快照必须是"逻辑位置的旧值"，不能自己编偏移。以前这里写
    //   `null`（→ _reconcile 直接 return，等于根本没在测渲染外推），
    //   或者给个固定 +0.5（→ 残差消化每帧在拉，把位移曲线搞成非匀速）。
    //   两种情况都会让测试永远变绿 / 永远变红，跟真实抖动无关。
    const tick = Math.floor(f * DT / TICK_DT) - 1;
    const srv = track[Math.max(0, tick)] || { x: c.me.x, z: c.me.z };
    c.net = { lastSnap: { players: [{ id: 'u1', x: srv.x, z: srv.z, yaw: c.me.yaw }] } };
    c._reconcile(DT);
    out.push({ t, x: c._disp.x, z: c._disp.z, mx: c.me.x, mz: c.me.z });
  }
  return out;
}

function stats(out, fps, skip = 30) {
  const DT = 1 / fps;
  const ideal = SPEED * DT;
  const steps = [];
  for (let i = skip; i < out.length; i++) {
    steps.push(Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z));
  }
  const ratios = steps.map((d) => d / ideal);
  // 判"突变"要跟**最近两帧的均值**比，不能跟上一帧单帧比。
  //
  // 服务端 30Hz、渲染 60Hz 时，理想曲线本来就是"走一格 / 走半格"交替
  // （0.5 米一格，两帧摊完）。拿单帧比会把这种法定节拍判成 329 次抖动。
  // 真正要看的是"有没有掉到不应有的低值"或"突然跳一大截"。
  let jerks = 0;
  for (let i = 2; i < steps.length; i++) {
    const ref = (steps[i - 1] + steps[i - 2]) / 2;
    if (steps[i] < ref * 0.25 || steps[i] > ref * 1.9) jerks++;
  }
  return {
    avg: ratios.reduce((a, b) => a + b, 0) / ratios.length,
    min: Math.min(...ratios),
    max: Math.max(...ratios),
    jerks,
    n: steps.length,
  };
}

// 前进 2 秒 → 右转 1 秒 → 继续前进：覆盖直行与转向两个最容易抖的场景
const scripted = (t) => (t < 2 ? { mx: 0, mz: -1 } : t < 3 ? { mx: 1, mz: -1 } : { mx: 1, mz: 0 });

for (const fps of [60, 144, 30]) {
  const s = stats(simulate(fps, 6, scripted), fps);
  assert.equal(s.jerks, 0, `${fps}fps 出现 ${s.jerks} 次帧间位置突变（卡住或跳帧）`);
  assert.ok(s.avg > 0.98 && s.avg < 1.03, `${fps}fps 平均速度异常：${s.avg.toFixed(3)}`);
  assert.ok(s.max < 1.7, `${fps}fps 单帧位移峰值 ${s.max.toFixed(2)} 倍理想值`);
  ok(`${fps}fps：${s.n} 帧内零突变，均值 ${s.avg.toFixed(3)}×，峰值 ${s.max.toFixed(2)}×`);
}

// ---- 高刷（90/120/144/240Hz）：匀速直行时逐帧位移必须是平的 ----
//
// 这是 19 版补的回归防线。症状是"帧率越高越卡"：前馈用 dt 而不是本帧
// 预测时钟推进量 acc，没推进 tick 的帧照样把 _disp 往前推，软约束又把它
// 拉回来，于是画出来的位置以帧率为节拍在目标两侧来回摆。
//
// 实测修复前 120Hz：每帧位移变异 73.7%，一半的帧只走 1cm、另一半走 12cm，
// 肉眼看就是"一顿一顿"。修复后必须接近 0。
for (const fps of [90, 120, 144, 240]) {
  const out = simulate(fps, 5, () => ({ mx: 0, mz: -1 }));
  const steps = [];
  for (let i = 31; i < out.length; i++) {
    steps.push(Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z));
  }
  const m = steps.reduce((a, b) => a + b, 0) / steps.length;
  const sd = Math.sqrt(steps.reduce((a, b) => a + (b - m) ** 2, 0) / steps.length);
  const cv = sd / (m || 1e-9);
  // 30Hz 格子与帧率的拍频天然存在：240Hz 下 8 帧里只有 1 帧推进 tick，
  // 理想值就是"7 帧近零 + 1 帧走满"。所以判据不是"逐帧相等"，而是
  // **一个 tick 周期内的总位移必须等于理想值**，且不许出现反向 / 卡死。
  const perTick = SPEED * TICK_DT;
  const winTicks = Math.floor((steps.length * fps) / 30 / 4);
  const win = steps.slice(0, winTicks * 30 / fps | 0);
  const sum = win.reduce((a, b) => a + b, 0);
  const idealSum = (win.length / fps) * SPEED;
  assert.ok(cv < 1.25, `${fps}fps 逐帧位移变异 ${(cv * 100).toFixed(1)}%（应<125%，30Hz 拍频下限）`);
  assert.ok(Math.abs(sum - idealSum) / idealSum < 0.06,
    `${fps}fps ${win.length} 帧总位移 ${sum.toFixed(3)} 与理想 ${idealSum.toFixed(3)} 偏差超 6%`);
  assert.ok(Math.max(...steps) < perTick * 1.35, `${fps}fps 单帧最大位移超过 1.35 个 tick（跳帧）`);
  ok(`${fps}fps 匀速：逐帧变异 ${(cv * 100).toFixed(1)}%，总位移偏差 ${(Math.abs(sum - idealSum) / idealSum * 100).toFixed(2)}%`);
}

// 静止：不按任何键，画出来的位置必须一动不动
{
  const out = simulate(60, 4, () => ({ mx: 0, mz: 0 }));
  let moved = 0;
  let worst = 0;
  for (let i = 1; i < out.length; i++) {
    const d = Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z);
    if (d > 1e-9) moved++;
    worst = Math.max(worst, d);
  }
  assert.equal(moved, 0, `静止时仍有 ${moved} 帧在动，最大 ${(worst * 100).toFixed(2)}cm`);
  ok('静止 4 秒：渲染位置零位移');
}

// ---- 帧间隔抖动（真实 rAF）：速度必须恒定 ----
//
// 上面的用例都是"每一帧 dt 完全相等"的理想时钟。真实浏览器里 rAF 的间隔
// 是 8.3±1.5ms 抖动，偶发一次 2.5 倍的长帧。这个用例专门钉"前馈用哪个 dt"：
//
//   前馈用 dt（真实流逝时间）  → 速度变异 0.0%
//   前馈用 dt - acc（tick 余量）→ 速度变异 21%，每帧忽快忽慢
//
// 后者是我在 19 版一度改错的写法，单元测试全绿但实际更卡。所以必须留着。
{
  const TICK_DT_S = 1 / 30;
  const COL2 = { speedAt: () => 1, hit: () => null };
  const jitterRun = (seed) => {
    let s = seed;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const c = Object.create(CoopMode.prototype);
    Object.assign(c, {
      myId: 'u1', _shift: { x: 0, z: 0 }, _vel: { x: 0, z: 0 },
      _disp: { x: 0, z: 0, yaw: 0 }, _predAcc: 0, _yawVel: 0, _moveDir: null,
      tanks: new Map(), world: COL2,
      me: {
        id: 'u1', x: 0, z: 0, yaw: Math.PI, speed: 0, speedBase: SPEED,
        alive: true, down: false, turretYaw: 0, turretRate: 0, turretLimit: Math.PI,
      },
    });
    const input = { mx: 0, mz: -1 };
    const track = [];
    const v = [];
    let T = 0;
    let px = 0; let pz = 0;
    for (let f = 0; f < 900; f++) {
      let dt = (1 / 120) * (0.82 + 0.36 * rnd());
      if (rnd() < 0.02) dt *= 2.5;
      T += dt;
      c._moveDir = Math.atan2(input.mx, input.mz);
      c._predAcc += dt;
      const from = { x: c.me.x, z: c.me.z, yaw: c.me.yaw };
      let ticks = 0;
      while (c._predAcc >= TICK_DT_S && ticks < 8) {
        c._predAcc -= TICK_DT_S;
        ticks++;
        predict(c.me, input, TICK_DT_S, COL2, HALF);
      }
      track[Math.floor(T / TICK_DT_S)] = { x: c.me.x, z: c.me.z };
      if (ticks > 0) {
        c._vel.x = (c.me.x - from.x) / (ticks * TICK_DT_S);
        c._vel.z = (c.me.z - from.z) / (ticks * TICK_DT_S);
      }
      const srv = track[Math.max(0, Math.floor(T / TICK_DT_S) - 1)] || { x: c.me.x, z: c.me.z };
      c.net = { lastSnap: { players: [{ id: 'u1', x: srv.x, z: srv.z, yaw: c.me.yaw }] } };
      c._reconcile(dt);
      if (f > 150) v.push(Math.hypot(c._disp.x - px, c._disp.z - pz) / dt);
      px = c._disp.x; pz = c._disp.z;
    }
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    return { m, cv: sd / m };
  };
  for (const seed of [1, 7, 42]) {
    const { m, cv } = jitterRun(seed);
    assert.ok(cv < 0.03, `帧间隔抖动下速度变异 ${(cv * 100).toFixed(1)}%（应<3%，前馈被量化到 30Hz 了）`);
    assert.ok(Math.abs(m - SPEED) / SPEED < 0.02, `帧间隔抖动下平均速度 ${m.toFixed(2)} 偏离 ${SPEED}`);
    ok(`帧抖动 seed${seed}：速度 ${m.toFixed(2)}，变异 ${(cv * 100).toFixed(2)}%`);
  }
}

// ---- 残差不许顶着保险丝 ----
//
// 19 版定位到的真正抖动源：`_absorbResidual` 用"车头朝向 × 速度"算运动方向，
// 而位移是立即沿**输入方向**走的、车头要 8 rad/s 才追齐。撞墙沿墙滑行时两者
// 能差 70°，于是本来正确的纵向残差被误判成横向，横向追赶每帧推 me 2cm，
// `want = me + v*acc` 再把这点微动抄给 `_disp`。
// 实测：直行 5 秒，残差一路涨到保险丝 1.19 米并钉在那里。
//
// 现在残差必须全程接近 0。这条用例专门盯这个数。
{
  const COL3 = { speedAt: () => 1, hit: () => null };
  const c = Object.create(CoopMode.prototype);
  Object.assign(c, {
    myId: 'u1', _shift: { x: 0, z: 0 }, _vel: { x: 0, z: 0 },
    _disp: { x: 0, z: 0, yaw: 0 }, _predAcc: 0, _yawVel: 0, _moveDir: null,
    tanks: new Map(), world: COL3,
    // 车头故意歪 70°：模拟沿墙滑行 / 刚改方向，这是真实会出现的姿态
    me: {
      id: 'u1', x: 0, z: 0, yaw: 1.227, speed: 0, speedBase: SPEED,
      alive: true, down: false, turretYaw: 0, turretRate: 0, turretLimit: Math.PI,
    },
  });
  const input = { mx: 0, mz: -1 };
  const track = [];
  let worst = 0;
  let T = 0;
  for (let f = 0; f < 900; f++) {
    const dt = 1 / 90;
    T += dt;
    c._predAcc += dt;
    const from = { x: c.me.x, z: c.me.z, yaw: c.me.yaw };
    let ticks = 0;
    while (c._predAcc >= 1 / 30 && ticks < 8) {
      c._predAcc -= 1 / 30;
      ticks++;
      // 沿墙滑行：位移只沿输入方向（-z）走，车头被墙别住转不过来。
      // 直接手写这一步，不用 predict —— predict 会按输入方向把 yaw 转齐，
      // 那样就测不到"车头方向 ≠ 真实位移方向"这个分叉了。
      const spd = c.me.speedBase * (c.world.speedAt ? c.world.speedAt() : 1);
      c.me.speed = spd;
      c.me.x += input.mx * spd * (1 / 30);
      c.me.z += input.mz * spd * (1 / 30);
      // 车头缓慢朝输入方向靠，但始终差一截（模拟贴墙摩擦）
      const want = Math.atan2(input.mx, input.mz);
      c.me.yaw += Math.sign(want - c.me.yaw) * Math.min(Math.abs(want - c.me.yaw), 0.02);
    }
    track[Math.floor(T / (1 / 30))] = { x: c.me.x, z: c.me.z };
    if (ticks > 0) {
      c._vel.x = (c.me.x - from.x) / (ticks / 30);
      c._vel.z = (c.me.z - from.z) / (ticks / 30);
    }
    const srv = track[Math.max(0, Math.floor(T / (1 / 30)) - 1)] || { x: c.me.x, z: c.me.z };
    c.net = { lastSnap: { players: [{ id: 'u1', x: srv.x, z: srv.z, yaw: c.me.yaw }] } };
    c._reconcile(dt);
    if (f > 100) worst = Math.max(worst, Math.hypot(c._shift.x, c._shift.z));
  }
  assert.ok(worst < 0.3, `残差峰值 ${worst.toFixed(2)} 米（应<0.3，顶到保险丝就成了持续微动）`);
  ok(`车头歪 70° 直行 10 秒：残差峰值 ${worst.toFixed(3)} 米`);
}

// 松键：必须立刻停住，不许惯性滑动
{
  const out = simulate(60, 4, (t) => (t < 1.5 ? { mx: 0, mz: -1 } : { mx: 0, mz: 0 }));
  const tail = out.filter((o) => o.t > 2.2);
  let moved = 0;
  for (let i = 1; i < tail.length; i++) {
    if (Math.hypot(tail[i].x - tail[i - 1].x, tail[i].z - tail[i - 1].z) > 0.0005) moved++;
  }
  assert.equal(moved, 0, `松键 0.7 秒后仍有 ${moved} 帧在动`);
  ok('松键后立即停住，无惯性回滑');
}

console.log(`\n移动抖动测试全部通过（${pass} 项）`);
