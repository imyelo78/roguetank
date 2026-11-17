// 视口换算与全屏入口的单元测试
import assert from 'node:assert/strict';
import { screenToNDC, ndcToScreen } from '../src/core/viewport.js';

let pass = 0;
const ok = (msg) => { pass++; console.log('  ✓', msg); };

// Node 22 的 navigator 是只读 getter，直接赋值会抛 TypeError
const stub = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

const fakeCanvas = (rect) => ({ getBoundingClientRect: () => rect });

// canvas 铺满视口：中心是 (0,0)，右上角是 (1,1)
{
  const c = fakeCanvas({ left: 0, top: 0, width: 800, height: 400 });
  assert.deepEqual(screenToNDC(c, 400, 200), { x: 0, y: 0 });
  assert.deepEqual(screenToNDC(c, 800, 0), { x: 1, y: 1 });
  assert.deepEqual(screenToNDC(c, 0, 400), { x: -1, y: -1 });
  ok('画布铺满时四角与中心换算正确');
}

// 关键回归：canvas 比窗口矮（手机地址栏占位）时，必须按 canvas 算，不能按 window
{
  const c = fakeCanvas({ left: 0, top: 0, width: 800, height: 300 });
  const center = screenToNDC(c, 400, 150);
  assert.ok(Math.abs(center.x) < 1e-9 && Math.abs(center.y) < 1e-9, 'canvas 中心仍是 NDC 原点');
  const bottom = screenToNDC(c, 400, 300);
  assert.ok(Math.abs(bottom.y + 1) < 1e-9, 'canvas 底边是 y=-1（不是窗口底边）');
  ok('画布高度小于窗口时以画布矩形为准');
}

// 带偏移的画布（HUD 挤窄、iframe 内嵌）要减掉 left/top
{
  const c = fakeCanvas({ left: 100, top: 40, width: 400, height: 200 });
  const p = screenToNDC(c, 300, 140);
  assert.ok(Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9, '偏移画布的中心点应归零');
  ok('画布带偏移时减去 left/top');
}

// 写进既有对象（Game 用的是 THREE.Vector2，不能换实例）
{
  const out = { x: 9, y: 9 };
  const ret = screenToNDC(fakeCanvas({ left: 0, top: 0, width: 100, height: 100 }), 50, 50, out);
  assert.equal(ret, out, '应复用传入的对象');
  assert.ok(Math.abs(out.x) < 1e-9 && Math.abs(out.y) < 1e-9);
  ok('结果写进传入的 out 对象');
}

// ndcToScreen 与 screenToNDC 互为逆运算
{
  const rect = { left: 30, top: 12, width: 640, height: 360 };
  const c = fakeCanvas(rect);
  for (const [cx, cy] of [[0, 0], [640, 360], [123, 234], [30, 372]]) {
    const ndc = screenToNDC(c, cx, cy);
    const back = ndcToScreen(c, ndc);
    assert.ok(Math.abs(back.x - cx) < 1e-9 && Math.abs(back.y - cy) < 1e-9,
      `(${cx},${cy}) 往返后应还原，实际 (${back.x},${back.y})`);
  }
  ok('NDC 与屏幕坐标互为逆运算');
}

// 尺寸为 0（canvas 还没布局完）时不能除零，返回有限值
{
  const c = fakeCanvas({ left: 0, top: 0, width: 0, height: 0 });
  const p = screenToNDC(c, 10, 10);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), '零尺寸不应产生 Infinity/NaN');
  ok('画布尺寸为 0 时不产生 NaN');
}

// 全屏入口：没有 requestFullscreen（iOS Safari）时应返回 unsupported，而不是抛异常
{
  stub('document', { documentElement: {}, fullscreenElement: null });
  stub('window', { matchMedia: () => ({ matches: false }) });
  stub('navigator', { maxTouchPoints: 0 });
  const { fullscreenSupported, enterFullscreen, isTouchLike } = await import('../src/input/fullscreen.js');
  assert.equal(fullscreenSupported(), false, '没有 requestFullscreen 应判定不支持');
  assert.equal(await enterFullscreen(), 'unsupported', '不支持时返回 unsupported');
  assert.equal(isTouchLike(), false, '无触点、无 coarse 指针 → 非触屏');
  stub('navigator', { maxTouchPoints: 5 });
  assert.equal(isTouchLike(), true, 'maxTouchPoints > 0 → 触屏');
  stub('window', { matchMedia: (q) => ({ matches: q === '(pointer: coarse)' }) });
  stub('navigator', { maxTouchPoints: 0 });
  assert.equal(isTouchLike(), true, 'pointer: coarse → 触屏');
  ok('全屏能力探测与触屏判定');
}

// 有 requestFullscreen 时应真的调用，并带上 navigationUI: hide
{
  let calledWith = null;
  stub('document', {
    documentElement: { requestFullscreen: (o) => { calledWith = o; return Promise.resolve(); } },
    fullscreenElement: null,
  });
  stub('window', { matchMedia: () => ({ matches: false }) });
  stub('navigator', { maxTouchPoints: 0 });
  stub('screen', { orientation: { lock: () => Promise.resolve() } });
  const { enterFullscreen } = await import('../src/input/fullscreen.js?fresh');
  assert.equal(await enterFullscreen(), 'on');
  assert.deepEqual(calledWith, { navigationUI: 'hide' });
  ok('全屏请求带 navigationUI: hide');
}

// 被浏览器拒绝时吞掉异常（否则开局按钮会抛红字）
{
  stub('document', {
    documentElement: { requestFullscreen: () => Promise.reject(new Error('denied')) },
    fullscreenElement: null,
  });
  const { enterFullscreen } = await import('../src/input/fullscreen.js?denied');
  assert.equal(await enterFullscreen(), 'denied');
  ok('全屏被拒绝时返回 denied 且不抛异常');
}

console.log(`\n视口/全屏 ${pass} 项通过\n`);
