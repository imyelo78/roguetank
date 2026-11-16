// 触屏偏好：辅助吸附开关 + 首次引导标记。单独放一个文件是为了
// 让 Game（读）和 HUD（写）不用互相认识，也方便单测里替换 storage。

const ASSIST_KEY = 'tank3d.aimAssist.v1';
const GUIDE_KEY = 'tank3d.touchGuide.v1';

/** 默认开：手机上 8° 吸附能显著减少"看着瞄准了却打偏"的挫败感 */
export function loadAssist() {
  try {
    const v = localStorage.getItem(ASSIST_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;   // 隐私模式 / 无 storage 环境
  }
}

export function saveAssist(on) {
  try { localStorage.setItem(ASSIST_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
}

/** 触屏引导只第一次进战斗时弹一次 */
export function loadGuideSeen() {
  try { return localStorage.getItem(GUIDE_KEY) === '1'; } catch { return false; }
}

export function saveGuideSeen() {
  try { localStorage.setItem(GUIDE_KEY, '1'); } catch { /* 忽略 */ }
}
