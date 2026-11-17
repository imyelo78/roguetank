/**
 * 全屏：手机浏览器里地址栏永远占着那 50~100px，
 * 而俯视战场是"横屏 + 看得越宽越好"的游戏 —— 这段空间代价很大。
 *
 * 策略：
 * - 触屏设备在"开始冲锋"这类用户手势里请求全屏，成功后顺手锁横屏；
 * - iOS Safari 上 documentElement.requestFullscreen 不存在（只有 video 能全屏），
 *   这里返回 'unsupported'，由调用方保持沉默 —— 那边的解法是把页面"添加到主屏幕"，
 *   靠 apple-mobile-web-app-capable 以独立窗口启动（index.html 里已声明）；
 * - 任何异常都吞掉：全屏是加成，不是游戏能不能玩的前提。
 */

export function isTouchLike() {
  try {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return true;
  } catch { /* 老环境没有 matchMedia */ }
  return (navigator.maxTouchPoints || 0) > 0;
}

export function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

/** 已经是独立窗口（加到主屏 / 桌面已全屏）就不用再折腾 */
function isStandalone() {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
  } catch { /* 忽略 */ }
  return navigator.standalone === true;
}

export function fullscreenSupported() {
  const el = document.documentElement;
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
}

/**
 * 请求全屏。必须在用户手势（click / pointerdown）的同步调用栈里调用，
 * 否则浏览器会以"缺少用户激活"拒绝。
 * @returns {'on'|'already'|'unsupported'|'denied'}
 */
export async function enterFullscreen() {
  if (isStandalone() || isFullscreen()) return 'already';
  if (!fullscreenSupported()) return 'unsupported';
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else await el.webkitRequestFullscreen();
  } catch {
    return 'denied';
  }
  // 全屏之后才有资格锁方向；失败无所谓（iOS 根本不支持锁）
  try { await screen.orientation?.lock?.('landscape'); } catch { /* 忽略 */ }
  return 'on';
}

export async function exitFullscreen() {
  if (!isFullscreen()) return;
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else document.webkitExitFullscreen?.();
  } catch { /* 忽略 */ }
  try { screen.orientation?.unlock?.(); } catch { /* 忽略 */ }
}

/** 触屏设备在开局手势里自动进全屏；桌面浏览器不打扰 */
export async function autoFullscreenOnTouch() {
  if (!isTouchLike()) return 'skipped';
  return enterFullscreen();
}
