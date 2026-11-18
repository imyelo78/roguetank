// 触屏输入的离线测试：只钉纯函数（摇杆向量换算、方位角、辅助吸附）和事件接线，
// 真机手感仍然只能在设备上验。
//
// 这里最值得钉的是"方向约定"：屏幕上方 = 世界 -Z，且方位角与 core/motion.js 的
// turretYaw 同一套（atan2(x, z)）。这条一旦反了，手机上按上坦克会往下开，
// 或者炮塔永远朝反方向——都是"一眼能看出、但代码里看不出"的 bug。

import assert from 'node:assert/strict';
import {
  stickVector, aimVector, aimAngle, assistAim, toNDC, padCenter,
  STICK_RADIUS, AIM_RADIUS, AIM_ASSIST_ANGLE, PAD_INSET,
} from '../src/input/touch.js';

let pass = 0;
const ok = (name) => { pass++; console.log(`  · ${name}`); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
// 角度比较要考虑 ±π 环绕
const angNear = (a, b, eps = 1e-6) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) <= eps;

console.log('\n[1] 走位死区');

assert.deepEqual(stickVector(0, 0), { x: 0, z: 0, mag: 0 }, '静止应返回零向量');
const tiny = stickVector(4, 0);
assert.equal(tiny.mag, 0, '半径 14% 以内不应该有位移');
assert.equal(tiny.x, 0);
ok('死区内不动（避免拇指轻放就漂移）');

console.log('\n[2] 方向约定：屏幕上方 = 世界 -Z');

const up = stickVector(0, -STICK_RADIUS);
assert.ok(near(up.z, -1), `向上推应该 z=-1（实际 ${up.z}）`);
assert.ok(near(up.x, 0));
const down = stickVector(0, STICK_RADIUS);
assert.ok(near(down.z, 1), '向下推应该 z=+1');
const right = stickVector(STICK_RADIUS, 0);
assert.ok(near(right.x, 1), '向右推应该 x=+1');
const left = stickVector(-STICK_RADIUS, 0);
assert.ok(near(left.x, -1), '向左推应该 x=-1');
ok('四个方向的符号都与世界坐标一致');

console.log('\n[3] 走位幅度与截断');

const half = stickVector(STICK_RADIUS / 2, 0);
assert.ok(half.x > 0.4 && half.x < 0.65, `半程应在 0.5 附近（实际 ${half.x}）`);
const over = stickVector(STICK_RADIUS * 3, 0);
assert.ok(near(over.x, 1, 1e-9), '推出边界应截断到 1');
assert.ok(over.mag <= 1);
const diag = stickVector(STICK_RADIUS, STICK_RADIUS);
assert.ok(Math.hypot(diag.x, diag.z) <= 1 + 1e-9, '斜推长度不能超过 1');
assert.ok(diag.x > 0.7 && diag.z > 0.7, '斜推应保持 45° 方向');
ok('半程线性、超界截断、斜推长度不超 1');

console.log('\n[4] 瞄准只是方位：长度无关');

// 拇指推 20px 和推 200px，只要方向一样，朝向就必须一样 ——
// 这正是"手指不必压在目标上"能被实现的原因。
const short = aimVector(0, -20);
const long = aimVector(0, -200);
assert.ok(near(short.x, long.x) && near(short.z, long.z), '同方向不同行程应给出同一朝向北');
assert.ok(near(Math.hypot(long.x, long.z), 1, 1e-9), '方向向量必须是单位向量');
assert.equal(aimVector(0, -4).mag, 0, '22% 死区内不给方向');
ok('方向与行程解耦，死区内保持静默（朝向不变）');

console.log('\n[5] 方位角与 turretYaw 同约定');

assert.ok(angNear(aimAngle(0, 1), 0), '屏幕下方（世界 +Z）应为 0');
assert.ok(angNear(aimAngle(0, -1), Math.PI), '屏幕上方（世界 -Z）应为 ±π');
assert.ok(angNear(aimAngle(1, 0), Math.PI / 2), '屏幕右方应为 +π/2');
assert.ok(angNear(aimAngle(-1, 0), -Math.PI / 2), '屏幕左方应为 -π/2');
ok('四个方向的方位角与炮塔角度约定一致');

console.log('\n[6] 辅助吸附');

const near8 = AIM_ASSIST_ANGLE * 0.5;   // 4°，窗口中心附近
const t1 = [{ x: Math.sin(near8) * 20, z: Math.cos(near8) * 20 }];  // 正前方 +4°
const r1 = assistAim(0, 0, 0, t1);
assert.ok(r1.snapped, '4° 应该吸上');
// 窗口中心权重 1、边缘 0：4° 处权重正好 0.5，修正量 = 0.5 × 0.9 × 4°
assert.ok(angNear(r1.angle, near8 * 0.9 * 0.5, 1e-6), `应把角度往目标拉（实际 ${r1.angle}）`);

const far = [{ x: Math.sin(0.35) * 20, z: Math.cos(0.35) * 20 }];   // 20°，窗口外
assert.ok(!assistAim(0, 0, 0, far).snapped, '窗口外不吸');
assert.equal(assistAim(0, 0, 0, far).angle, 0);

const distant = [{ x: 0, z: 60 }];                                   // 60m，超距离
assert.ok(!assistAim(0, 0, 0, distant).snapped, '超过 46m 不吸');

const adjacent = [{ x: 0, z: 1 }];                                   // 贴脸 1m
assert.ok(!assistAim(0, 0, 0, adjacent).snapped, '贴脸不吸（怎么瞄都能中，吸了反而妨碍转火');

// 窗口边缘要连续：修正量 = 角差 × 权重，边缘权重趋 0，所以 7.99° 的修正
// 必须近乎 0 —— 否则玩家刚进入吸附范围就会被"抢一下"准心。
const at = (a, r = 20) => [{ x: Math.sin(a) * r, z: Math.cos(a) * r }];
const edge = assistAim(0, 0, 0, at(AIM_ASSIST_ANGLE * 0.995));
const mid = assistAim(0, 0, 0, at(AIM_ASSIST_ANGLE * 0.5));
const out = assistAim(0, 0, 0, at(AIM_ASSIST_ANGLE * 1.02));
assert.ok(edge.angle < 2e-3, `窗口边缘修正量应趋近 0（实际 ${edge.angle}）`);
assert.ok(mid.angle > edge.angle * 10, '窗口中间的修正量应明显大于边缘');
assert.equal(out.angle, 0, '出窗口立刻不吸（而边缘本就≈0，所以不会跳变）');
ok('只吸窗口内的敌人，修正量随角差线性衰减');

// 两个目标：取角差更小的那个
const two = assistAim(0, 0, 0, [
  { x: Math.sin(0.12) * 20, z: Math.cos(0.12) * 20 },   // 6.9°
  { x: Math.sin(0.03) * 20, z: Math.cos(0.03) * 20 },   // 1.7°
]);
assert.ok(two.angle < 0.05, `应吸更近的那个（实际 ${two.angle}）`);

// ±π 环绕：玩家朝 -179°，敌人在 +179°，最短路径是跨过 ±π
const wrapAim = assistAim(Math.PI - 0.02, 0, 0, [{ x: Math.sin(-Math.PI + 0.03) * 20, z: Math.cos(-Math.PI + 0.03) * 20 }]);
assert.ok(Math.abs(wrapAim.angle) > Math.PI - 0.1, '跨 ±π 的吸附不能绕远路转一圈');
ok('多目标取最近角、跨 ±π 走最短路径');

console.log('\n[7] 屏幕坐标 → NDC');

const rect = { left: 0, top: 0, width: 800, height: 400 };
const center = toNDC(400, 200, rect);
assert.ok(near(center.x, 0) && near(center.y, 0), '中心应为 (0,0)');
const topLeft = toNDC(0, 0, rect);
assert.ok(near(topLeft.x, -1) && near(topLeft.y, 1), '左上应为 (-1, 1)');
const bottomRight = toNDC(800, 400, rect);
assert.ok(near(bottomRight.x, 1) && near(bottomRight.y, -1), '右下应为 (1, -1)');
const offset = toNDC(200, 200, { left: 100, top: 100, width: 200, height: 200 });
assert.ok(near(offset.x, 0) && near(offset.y, 0), '带偏移的画布应按 rect 归零');
ok('NDC 换算与 mousemove 那条路径一致');

console.log('\n[7.5] 角落摇杆基点');

// 走位在左下、瞄准在右下；两者关于屏幕中线镜像
const pad = padCenter('move', 800, 400);
const padAim = padCenter('aim', 800, 400);
assert.equal(pad.y, padAim.y, '两根摇杆应该同高');
assert.ok(near(pad.x + padAim.x, 800, 1e-9), '左右基点应关于中线镜像');
assert.ok(near(pad.x, PAD_INSET), `正常高度下基点距边缘应为 ${PAD_INSET}px（实际 ${pad.x}）`);
assert.ok(pad.y > 400 * 0.5, '基点应在屏幕下半部');
// 摇杆中心 ± 半径都得留在屏幕内，否则会压到刘海或边角
assert.ok(pad.x - STICK_RADIUS > 0 && pad.y + STICK_RADIUS < 400, '走位摇杆不应出界');
assert.ok(padAim.x + AIM_RADIUS < 800, '瞄准摇杆不应出界');
// 矮屏（横屏手机 302px 高）按键面收一档，不能顶到屏幕中间
const shortPad = padCenter('move', 700, 302);
assert.ok(shortPad.y > 302 * 0.6, `矮屏基点应仍在下半部（实际 y=${shortPad.y}）`);
// 两根摇杆不能互相重叠（窄屏 640 宽也还够）
const narrow = [padCenter('move', 640, 360), padCenter('aim', 640, 360)];
assert.ok(narrow[1].x - narrow[0].x > STICK_RADIUS + AIM_RADIUS, '窄屏两根摇杆也不该连在一起');
ok('左 / 右对称、不出界、矮屏内收、窄屏不重叠');

console.log('\n[8] 事件接线（假 DOM）');

// 只验"谁调了谁"：触摸落到左半屏 → 移动；右半屏 → 瞄准朝向 + 扳机；鼠标不接管
const listeners = new Map();
globalThis.window = {
  innerWidth: 800,
  innerHeight: 400,
  addEventListener: (t, fn) => { listeners.set(t, fn); },
  removeEventListener: () => {},
  matchMedia: () => ({ matches: true }),
};
const mkEl = () => ({
  style: {}, className: '', textContent: '',
  appendChild() {}, setAttribute() {}, remove() {},
  classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
});
globalThis.document = {
  getElementById: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }) }),
  createElement: mkEl,
  body: { appendChild() {} },
};

const { TouchControls } = await import('../src/input/touch.js');
const calls = { move: [], aim: [], fire: [] };
const tc = new TouchControls();
tc.setTarget({
  enabled: () => true,
  move: (x, z) => calls.move.push([x, z]),
  aim: (a) => calls.aim.push(a),
  fire: (on) => calls.fire.push(on),
});

calls.move.length = 0;
calls.aim.length = 0;
calls.fire.length = 0;

const ev = (over) => ({ pointerType: 'touch', preventDefault() {}, target: null, ...over });
const M = padCenter('move', 800, 400);   // (112, 288)
const A = padCenter('aim', 800, 400);    // (688, 288)

// 摇杆附近按下：基点是角落圆心（不是手指落点），所以拇指从侧面搭上来也不会立刻满速
listeners.get('pointerdown')(ev({ pointerId: 11, clientX: M.x + 8, clientY: M.y + 12 }));
assert.deepEqual(calls.fire, [], '左半屏按下不该开火');
assert.equal(tc.origin.x, M.x, '落在摇杆圈内时基点应固定在角落');
assert.equal(tc.origin.y, M.y);

listeners.get('pointerdown')(ev({ pointerId: 12, clientX: A.x + 12, clientY: A.y + 12 }));  // 右半屏
assert.deepEqual(calls.fire, [true], '右半屏按下应开火');
assert.equal(calls.aim.length, 0, '刚按下还没方向，不该立刻给朝向');
assert.equal(tc.aimOrigin.x, A.x, '瞄准摇杆同样固定在右下角');

// 上推 56px：方向 = 屏幕上方 = 世界 -Z
listeners.get('pointermove')(ev({ pointerId: 12, clientX: A.x, clientY: A.y - 56 }));
assert.equal(calls.aim.length, 1, '出死区后应给一次朝向');
assert.ok(angNear(calls.aim[0], Math.PI), `上推应为 ±π（实际 ${calls.aim[0]}）`);

// 回到死区（位移 4px）：朝向保持不变，也不再上报
listeners.get('pointermove')(ev({ pointerId: 12, clientX: A.x + 4, clientY: A.y + 4 }));
assert.equal(calls.aim.length, 1, '死区内不应该改写朝向');
assert.ok(angNear(tc.aimAngle, Math.PI), '朝向应停留在最后一次有效方向');

// 再拉到右侧：朝向变 +π/2
listeners.get('pointermove')(ev({ pointerId: 12, clientX: A.x + 72, clientY: A.y }));
assert.ok(angNear(calls.aim.at(-1), Math.PI / 2), '右推应为 +π/2');

listeners.get('pointermove')(ev({ pointerId: 11, clientX: M.x, clientY: M.y - 60 }));  // 左摇杆上推 60px
const lastMove = calls.move.at(-1);
assert.ok(lastMove[1] < 0, `上推应得到 z<0（实际 ${lastMove[1]}）`);
assert.ok(Math.abs(lastMove[0]) < 1e-9, '纯上推不该有横向分量');

listeners.get('pointerup')(ev({ pointerId: 12 }));
assert.deepEqual(calls.fire, [true, false], '抬手应松开扳机');
assert.ok(angNear(tc.aimAngle, Math.PI / 2), '抬手后朝向保留（炮塔不回弹）');
assert.equal(tc._aimEl.style.left, `${A.x}px`, '松手后瞄准摇杆回到右下角');

// 按在离摇杆很远的地方：摇杆钉死在角落，这次按下不算走位（r37 起不再跟手）
listeners.get('pointerup')(ev({ pointerId: 11 }));   // 先放开上一根走位手指
const movesBefore = calls.move.length;
listeners.get('pointerdown')(ev({ pointerId: 14, clientX: 300, clientY: 90 }));
assert.equal(tc.movePointer, null, '远处按下不该接管走位');
assert.equal(tc._el.style.left, `${M.x}px`, '摇杆必须留在左下角，不跟手');
assert.equal(calls.move.length, movesBefore, '远处按下不该给移动向量');
// 圈外一点点（角落圆心 + 半径 + 余量之外）同样不算
listeners.get('pointerdown')(ev({ pointerId: 15, clientX: M.x, clientY: M.y - STICK_RADIUS - 80 }));
assert.equal(tc.movePointer, null, '摇杆圈外半屏也不接管');
// 圈内但不在圆心：基点仍是角落，拇指偏一点就是慢速
listeners.get('pointerdown')(ev({ pointerId: 16, clientX: M.x + 10, clientY: M.y - 20 }));
assert.equal(tc.origin.x, M.x, '圈内按下基点固定在角落');
calls.move.length = 0;
listeners.get('pointermove')(ev({ pointerId: 16, clientX: M.x + 10, clientY: M.y - 20 - 12 }));
assert.ok(calls.move[0][1] < 0 && calls.move[0][1] > -0.5, '轻推应是慢速而不是满速');
listeners.get('pointerup')(ev({ pointerId: 16 }));
assert.equal(tc._el.style.left, `${M.x}px`, '松手后摇杆还在角落');

// 鼠标（pointerType mouse）必须留给原来的 mousemove/mousedown 路径
const fireBefore = calls.fire.length;
listeners.get('pointerdown')({ pointerType: 'mouse', pointerId: 99, preventDefault() {}, target: null });
assert.equal(calls.fire.length, fireBefore, '鼠标事件不能被触屏接管');

// 界面按钮上的触摸不能被当成摇杆
const moveBefore = calls.move.length;
listeners.get('pointerdown')(ev({
  pointerId: 21, clientX: 120, clientY: 300,
  target: { closest: (sel) => (sel === '.no-touch' ? {} : null) },
}));
assert.equal(calls.move.length, moveBefore, '点在按钮上不该推坦克');

// 面板打开（enabled 变 false）后再动手指：推杆要被清零
let allowed = true;
tc.setTarget({
  enabled: () => allowed,
  move: (x, z) => calls.move.push([x, z]),
  aim: () => {},
  fire: (on) => calls.fire.push(on),
});
listeners.get('pointerdown')(ev({ pointerId: 13, clientX: 120, clientY: 300 }));
allowed = false;
calls.move.length = 0;
listeners.get('pointermove')(ev({ pointerId: 13, clientX: 200, clientY: 300 }));
assert.deepEqual(calls.move[0], [0, 0], '不可操作时应把推杆清零而不是继续推');
ok('左右分区、朝向粘性、扳机、鼠标隔离、按钮隔离、面板打开即松杆');

console.log('\n[9] 辅助瞄准偏好');

// localStorage 只在调用时读，所以这里才装假实现（import 时不能碰真 storage）
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
};
const { loadAssist, saveAssist } = await import('../src/input/prefs.js');
assert.equal(loadAssist(), true, '默认应开启（手机上 8° 吸附能明显减少打偏）');
saveAssist(false);
assert.equal(loadAssist(), false, '关掉后应持久化为关');
saveAssist(true);
assert.equal(loadAssist(), true, '再打开应持久化为开');
ok('偏好默认开、可持久化关闭');

console.log('\n[10] 首次触屏引导');

// 记录 createElement 产物与 remove 调用，好断言"弹了/收了"
const created = [];
globalThis.document.createElement = (tag) => {
  const el = mkEl();
  el.tag = tag;
  el.remove = () => { el.removed = true; };
  created.push(el);
  return el;
};
store.clear();   // 假装是第一次玩（复用 [9] 的假 localStorage）

const gcalls = { move: [], aim: [], fire: [] };
const tc3 = new TouchControls();
tc3.setTarget({
  enabled: () => true,
  move: (x, z) => gcalls.move.push([x, z]),
  aim: (a) => gcalls.aim.push(a),
  fire: (on) => gcalls.fire.push(on),
});
tc3.refresh();   // 进入战斗（active）→ 应弹引导
const guide = created.find((el) => el.className === 'touch-guide');
assert.ok(guide, '首次进战斗应创建引导浮层');
assert.equal(store.get('tank3d.touchGuide.v1'), undefined, '还没见过就不该记账');

listeners.get('pointerdown')(ev({ pointerId: 31, clientX: 120, clientY: 300 }));  // 左区
listeners.get('pointerdown')(ev({ pointerId: 32, clientX: 700, clientY: 300 }));  // 右区
assert.ok(guide.removed, '两个区都碰过应立刻收掉引导');
assert.equal(store.get('tank3d.touchGuide.v1'), '1', '收掉引导时记一次账');
assert.ok(gcalls.fire.includes(true), '引导期间操作照常生效（引导不挡操作）');

// 见过之后不再弹
created.length = 0;
const tc4 = new TouchControls();
tc4.setTarget({ enabled: () => true, move: () => {}, aim: () => {}, fire: () => {} });
tc4.refresh();
assert.ok(!created.some((el) => el.className === 'touch-guide'), '见过一次就不再弹');
tc4._dismissGuide();   // 清掉可能挂着的定时器，别拖慢测试进程
ok('首战弹引导、双区碰过即收、只弹一次');

console.log(`\n触屏输入 ${pass} 项通过\n`);
