/**
 * 视口坐标 ↔ canvas 坐标。
 *
 * 为什么不用 window.innerWidth / innerHeight：
 * 手机浏览器上 innerHeight 是「当前可见高度」，而 canvas 的高度由 CSS 的 100dvh 决定，
 * 地址栏伸缩的那一瞬间两者会差几十像素。用 window 去换算 NDC，
 * 结果就是"手指点在这里、准心落在那里"，偏得越靠边越明显。
 * canvas 的 getBoundingClientRect() 才是画面真正占的那块矩形。
 */

/** 视口坐标（clientX / clientY）→ NDC */
export function screenToNDC(canvas, cx, cy, out = { x: 0, y: 0 }) {
  const r = canvas.getBoundingClientRect();
  const w = r.width || 1;
  const h = r.height || 1;
  out.x = ((cx - r.left) / w) * 2 - 1;
  out.y = -((cy - r.top) / h) * 2 + 1;
  return out;
}

/** 投影后的 NDC（Vector3 / {x,y}）→ 视口坐标，给 fixed 定位的准心用 */
export function ndcToScreen(canvas, v) {
  const r = canvas.getBoundingClientRect();
  return {
    x: r.left + (v.x * 0.5 + 0.5) * r.width,
    y: r.top + (-v.y * 0.5 + 0.5) * r.height,
  };
}
