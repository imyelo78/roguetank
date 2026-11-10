import { Game } from './Game.js';
import { BUILD } from './core/protocol.js';

const canvas = document.getElementById('scene');
const game = new Game(canvas);
game.mount();

// 便于调试
window.__game = game;

/**
 * 版本自检：页面本地 BUILD 与服务端 /healthz 的 build 必须一致。
 *
 * 不同步是联机排查里最大的假象来源 —— 服务端没重启、浏览器缓存了旧 dist、
 * 反向代理缓存了 JS，表现和真 bug 一模一样。以前只能靠登服务器 ps / ls 猜，
 * 现在不一致会直接在左上角弹红条，用户截个图就知道是"没部署成功"还是"真有问题"。
 */
if (location.protocol === 'http:' || location.protocol === 'https:') {
  fetch('/healthz', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j || !j.build || j.build === BUILD) return;
      const el = document.createElement('div');
      el.className = 'build-mismatch';
      el.textContent = `版本不一致：页面 ${BUILD} / 服务端 ${j.build} —— 请按 Ctrl+Shift+R 强制刷新，并确认服务端已重启`;
      document.body.appendChild(el);
      console.warn('[build] 页面与服务端不一致', { page: BUILD, server: j.build });
    })
    .catch(() => { /* 静态托管没有 healthz，忽略 */ });
}
