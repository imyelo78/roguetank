// 触屏操作：左下角走位摇杆、右下角瞄准摇杆（按住连发）。
//
// 设计前提（都是现有代码的事实，不是假设）：
//   1. 相机永远朝 -Z、不旋转（core/camera.js 的 followStep 只跟位置），
//      所以屏幕"上"恒等于世界 -Z，"右"恒等于 +X —— 摇杆方向不用做任何矩阵换算。
//   2. 瞄准只要"方位"：aimPoint 只喂给 player.aimAt()，距离不参与弹道。
//      所以右半屏交出的是**角度**，瞄准点由 Game 按固定半径落在坦克周围。
//   3. 战斗逻辑只读 keys / mouseNDC / firing。这里把触摸翻译成这三样，
//      单机和联机共用同一套代码，避免再出现"组队里某个键失效"那类分叉 bug。
//
// r36 的变化：两根摇杆从"在各自半屏里浮动"改成**固定在左下 / 右下角落**。
//   - 战斗中常显（压暗），按住变亮，位置一眼可见，不用先猜"摇杆在哪"。
//   - 按下点落在摇杆附近（半径 + 52px）时基点就是角落的圆心，摇杆不动；
//     落在更远处才把摇杆挪到手指下面 —— 保留这条是为了不给玩家制造死区，
//     手指偏几公分就"按了没反应"会被当成卡了。
//   - 瞄准摇杆仍是浮动方向摇杆：拇指只决定方位，准心画在固定 17m 的环上。
//   - 方向有粘性：拇指回到死区内不改朝向，抬手后炮塔保持最后朝向。
//   - 8° 辅助吸附（assistAim，可在开始界面关掉），只吸 46m 内的目标，
//     并且在窗口边缘平滑过渡，不会出现"锁上/脱锁"的跳变。
//
// 首次进战斗会弹一次双区引导（左推 / 右按），碰过两个区或 5 秒后消失，
// 只弹一次（localStorage 记账）， prefs.js 负责读写。

import { loadGuideSeen, saveGuideSeen } from './prefs.js';

/** 走位摇杆外圈半径（px）：拇指走到这里算推满 */
export const STICK_RADIUS = 62;
/** 走位死区：半径的 14% 以内不动，避免拇指轻放就漂移 */
export const STICK_DEAD = 0.14;

/** 瞄准摇杆外圈半径（px）。比走位小一点：只需要方位，不需要行程 */
export const AIM_RADIUS = 58;
/** 瞄准死区：22% —— 比走位大，避免手指微抖就把炮塔带偏 */
export const AIM_DEAD = 0.22;
/** 准心环半径（米）：方向确定后瞄准点固定落在这个距离上 */
export const AIM_RANGE = 17;
/** 辅助吸附的半角（8°）：只在这个窗口里往敌人身上靠 */
export const AIM_ASSIST_ANGLE = (8 * Math.PI) / 180;
/** 辅助吸附的最远距离（米）。超出这个距离要靠玩家自己预判 */
export const AIM_ASSIST_RANGE = 46;

/** 摇杆基点到屏幕边缘的距离（px）：拇指自然落点，也躲得开刘海与圆角 */
export const PAD_INSET = 112;
/** 抓取余量：在摇杆半径外这一圈按下，也算抓住角落这根摇杆 */
export const PAD_GRAB = 52;

/**
 * 固定摇杆的基点：走位在左下、瞄准在右下。
 *
 * 不写死在 CSS 里是因为"抓住摇杆"的判定要用同一组圆心坐标，
 * 两边各写一套数迟早会对不上（CSS 一改，抓取区就偏了）。
 * 屏幕矮（横屏手机 300 出头）时按高度收一档，否则摇杆会顶到屏幕中间。
 */
export function padCenter(kind, width, height) {
  const w = Math.max(1, width || 0);
  const h = Math.max(1, height || 0);
  const inset = Math.min(PAD_INSET, Math.max(96, h * 0.32));
  return { x: kind === 'aim' ? w - inset : inset, y: h - inset };
}

/**
 * 把"拇指相对基点的位移"换算成世界移动向量。
 *
 * 屏幕坐标（y 向下）→ 世界坐标（z 向 +Z）：dy 为正 = 向下 = 世界 +Z。
 * 返回值 |(x,z)| ≤ 1，死区内为 (0,0)。
 * 死区外做了重新映射，否则刚越过死区就会瞬间满速，手感很突兀。
 */
export function stickVector(dx, dy, radius = STICK_RADIUS, dead = STICK_DEAD) {
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-4) || !(radius > 0)) return { x: 0, z: 0, mag: 0 };
  const mag = Math.min(1, len / radius);
  if (mag <= dead) return { x: 0, z: 0, mag: 0 };
  const scaled = Math.min(1, (mag - dead) / (1 - dead));
  return { x: (dx / len) * scaled, z: (dy / len) * scaled, mag: scaled };
}

/**
 * 瞄准方向：只取方位，不取长度。死区内返回零向量，调用方据此保留上一次朝向
 * （"回到死区不改变朝向"是刻意的：否则拇指一松炮塔就乱转）。
 */
export function aimVector(dx, dy, radius = AIM_RADIUS, dead = AIM_DEAD) {
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-4) || !(radius > 0)) return { x: 0, z: 0, mag: 0 };
  const mag = Math.min(1, len / radius);
  if (mag <= dead) return { x: 0, z: 0, mag: 0 };
  return { x: dx / len, z: dy / len, mag };
}

/** 世界方位角，与 core/motion.js 的 turretYaw 同一套约定：atan2(x, z) */
export function aimAngle(dx, dy) {
  return Math.atan2(dx, dy);
}

/** 屏幕坐标 → 归一化设备坐标（与 mousemove 那条路径完全一致） */export function toNDC(clientX, clientY, rect) {
  const r = rect || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const w = Math.max(1, r.width);
  const h = Math.max(1, r.height);
  return {
    x: ((clientX - r.left) / w) * 2 - 1,
    y: -((clientY - r.top) / h) * 2 + 1,
  };
}

const normAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * 8° 辅助吸附：在给定角度附近找一个敌人，把角度往它身上拉。
 *
 * targets 只需要 `{ x, z }`（单机传 Enemy.position，联机传快照里的 x/z），
 * 所以这个函数不依赖 THREE，也能直接单测。
 *
 * 权重随角差线性衰减（窗口中心 1、边缘 0），因此"进入/脱离吸附"是连续的：
 * 硬锁定在边界上会来回跳，玩家会觉得准心被抢。
 *
 * @returns {{ angle: number, snapped: boolean, x: number, z: number }}
 *          snapped 为 true 表示吸附已过半，界面可以给点反馈。
 */
export function assistAim(angle, ox, oz, targets, opts = {}) {
  const maxAngle = opts.maxAngle ?? AIM_ASSIST_ANGLE;
  const maxDist = opts.maxDist ?? AIM_ASSIST_RANGE;
  const blend = opts.blend ?? 0.9;
  const count = opts.count ?? (targets ? targets.length : 0);
  if (!targets || !count) return { angle, snapped: false, x: 0, z: 0 };

  let bestW = 0;
  let bestDiff = 0;
  let bx = 0;
  let bz = 0;
  for (let i = 0; i < count; i++) {
    const t = targets[i];
    if (!t) continue;
    const dx = t.x - ox;
    const dz = t.z - oz;
    const d = Math.hypot(dx, dz);
    // d < 1.2 是贴脸：这时候怎么瞄都能中，吸附反而挡住玩家转火
    if (!(d > 1.2) || d > maxDist) continue;
    const diff = normAngle(Math.atan2(dx, dz) - angle);
    const abs = Math.abs(diff);
    if (abs >= maxAngle) continue;
    const w = 1 - abs / maxAngle;
    if (w > bestW) {
      bestW = w;
      bestDiff = diff;
      bx = t.x;
      bz = t.z;
    }
  }
  if (bestW <= 0) return { angle, snapped: false, x: 0, z: 0 };
  // 0.3 ≈ 角差 5.6° 以内，界面可以在准心上给点"贴住了"的反馈
  return { angle: normAngle(angle + bestDiff * blend * bestW), snapped: bestW > 0.3, x: bx, z: bz };
}

/**
 * 触摸 → 输入意图。一个实例挂全局，单机 / 联机通过 setTarget() 换接收方。
 *
 * target 是四个回调，别的一概不管：
 *   enabled() → 现在能不能操作（菜单、选卡、阵亡时为 false）
 *   move(x, z) → 世界方向向量，-1..1
 *   aim(angle) → 世界方位角（弧度，atan2(x, z)）；只在拇指出了死区时调用
 *   fire(on) → 是否开火
 */
export class TouchControls {
  constructor({ doc = typeof document !== 'undefined' ? document : null } = {}) {
    this.doc = doc;
    this.target = null;
    this.enabled = true;          // 全局开关（设置里"关闭触屏"用）
    this.movePointer = null;      // 左半屏的手指
    this.aimPointer = null;       // 右半屏的手指
    this.origin = { x: 0, y: 0 };  // 走位摇杆基点
    this.aimOrigin = { x: 0, y: 0 }; // 瞄准摇杆基点
    this.aimAngle = null;         // 最后一帧的有效朝向（抬手后保留）
    this._el = null;
    this._knob = null;
    this._aimEl = null;
    this._aimKnob = null;
    this._hint = null;
    this._guide = null;         // 首次引导浮层
    this._guideTimer = 0;
    this._guidedMove = false;   // 引导期间碰过左区吗
    this._guidedAim = false;    // 引导期间碰过右区吗
    this._bound = false;

    this._onDown = (e) => this._handleDown(e);
    this._onMove = (e) => this._handleMove(e);
    this._onUp = (e) => this._handleUp(e);
    // 尺寸变了要重算角落基点，否则转屏后摇杆还停在旧位置
    this._onResize = () => {
      this._checkOrientation();
      this._syncPads();
    };

    if (doc) this.bind();
  }

  bind() {
    if (this._bound || !this.doc) return;
    this._bound = true;
    const opt = { passive: false };
    // 用 window 而不是 canvas：手指滑出画布（比如压到 HUD 边缘）也不能丢事件
    window.addEventListener('pointerdown', this._onDown, opt);
    window.addEventListener('pointermove', this._onMove, opt);
    window.addEventListener('pointerup', this._onUp, opt);
    window.addEventListener('pointercancel', this._onUp, opt);
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    this._checkOrientation();
  }

  destroy() {
    if (!this._bound) return;
    this._bound = false;
    window.removeEventListener('pointerdown', this._onDown, { passive: false });
    window.removeEventListener('pointermove', this._onMove, { passive: false });
    window.removeEventListener('pointerup', this._onUp, { passive: false });
    window.removeEventListener('pointercancel', this._onUp, { passive: false });
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    this._el?.remove();
    this._aimEl?.remove();
    this._hint?.remove();
    this._guide?.remove();
    this._el = null;
    this._knob = null;
    this._aimEl = null;
    this._aimKnob = null;
    this._hint = null;
    this._guide = null;
  }

  /** 切换接收方。进入 / 退出组队时由 CoopMode 调用 */
  setTarget(target) {
    this.target = target;
    // 换模式时把手上的状态清干净：否则退出组队后"上一步的摇杆方向"会留在新目标里
    this._resetMove();
    this._releaseFire();
    this.aimAngle = null;
    this._syncPads();
    this._checkOrientation();
  }

  get active() {
    return !!(this.enabled && this.target && this.target.enabled?.());
  }

  /**
   * 状态切换（开局 / 选卡 / 阵亡 / 回菜单）后调用一次：
   * 把手上残留的摇杆与扳机清掉，并重算竖屏提示该不该出现。
   */
  refresh() {
    if (!this.active) this._stopAll();
    // 角落里那两根摇杆的显隐也归这里管：战斗中常显（暗态），菜单/选卡时藏起来
    this._syncPads();
    // 引导跟着"进入战斗"走：开局弹出，退出战斗（选卡/阵亡/回菜单）时收掉
    if (this.active) this._maybeGuide();
    else this._dismissGuide();
    this._checkOrientation();
  }

  /** 键盘 / 鼠标开始操作时调用：把瞄准交还给鼠标 */
  releaseAim() {
    this.aimAngle = null;
  }

  // ---------------- 事件 ----------------

  _handleDown(e) {
    // 鼠标走原来的 mousemove/mousedown 路径，这里只接触摸与触控笔
    if (e.pointerType === 'mouse') return;
    // 界面上的按钮（开始 / 选卡 / 开关）不该顺手推一下坦克
    if (e.target?.closest?.('.no-touch')) return;
    if (!this.active) return;
    e.preventDefault();   // 关键：阻止浏览器补发 mousedown / 触发滚动与手势

    const half = window.innerWidth / 2;
    if (e.clientX < half) {
      if (this.movePointer !== null) return;   // 左半屏只认第一根手指
      this.movePointer = e.pointerId;
      const c = this._grabCenter('move', e.clientX, e.clientY);
      this.origin.x = c.x;
      this.origin.y = c.y;
      this._showStick(c.x, c.y);
      this.target.move?.(0, 0);
      this._guidedMove = true;
    } else {
      if (this.aimPointer !== null) return;
      this.aimPointer = e.pointerId;
      const c = this._grabCenter('aim', e.clientX, e.clientY);
      this.aimOrigin.x = c.x;
      this.aimOrigin.y = c.y;
      this._showAimStick(c.x, c.y);
      this.target.fire?.(true);
      this._guidedAim = true;
    }
    // 两个区都碰过 → 已经会玩了，立刻收掉引导
    if (this._guide && this._guidedMove && this._guidedAim) this._dismissGuide();
  }

  _handleMove(e) {
    // 面板弹出来了（选卡 / 阵亡结算）：这一帧就把残留的推杆清掉，
    // 否则手指还按着、画面已经切走，坦克会在后台继续走
    if (!this.active) {
      if (e.pointerId === this.movePointer || e.pointerId === this.aimPointer) {
        this._stopAll();
      }
      return;
    }
    if (e.pointerId === this.movePointer) {
      e.preventDefault();
      const dx = e.clientX - this.origin.x;
      const dy = e.clientY - this.origin.y;
      const v = stickVector(dx, dy);
      // 滑块视觉卡在外圈，实际向量按半径截断，两者用同一套数
      const len = Math.hypot(dx, dy);
      const k = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
      this._moveKnob(dx * k, dy * k);
      this.target.move?.(v.x, v.z);
      return;
    }
    if (e.pointerId === this.aimPointer) {
      e.preventDefault();
      const dx = e.clientX - this.aimOrigin.x;
      const dy = e.clientY - this.aimOrigin.y;
      const len = Math.hypot(dx, dy);
      const k = len > AIM_RADIUS ? AIM_RADIUS / len : 1;
      this._moveAimKnob(dx * k, dy * k);
      const v = aimVector(dx, dy);
      // 死区内不改朝向：拇指回中只是"停手"，不是"把炮塔转回去"
      if (v.mag > 0) {
        this.aimAngle = aimAngle(v.x, v.z);
        this.target.aim?.(this.aimAngle);
      }
    }
  }

  _handleUp(e) {
    if (e.pointerId === this.movePointer) {
      this._resetMove();
      this.target?.move?.(0, 0);
      return;
    }
    if (e.pointerId === this.aimPointer) {
      this.aimPointer = null;
      this._restAim();
      // 只松开扳机，不清朝向：炮塔保持最后指向（有转速的车归位会像回弹）
      this.target?.fire?.(false);
    }
  }

  _resetMove() {
    this.movePointer = null;
    this._restMove();
  }

  /** 摇杆、扳机、目标里的移动向量一起归零（面板弹出 / 切模式时用） */
  _stopAll() {
    this._resetMove();
    this._releaseFire();
    this.target?.move?.(0, 0);
  }

  _releaseFire() {
    this.aimPointer = null;
    this._restAim();
    this.target?.fire?.(false);
  }

  // ---------------- 首次引导 ----------------

  /**
   * 第一次进战斗时弹双区提示。不挡操作（pointer-events: none）：
   * 会玩的人直接开打，碰过两个区就提前收掉；5 秒后也自动收。
   */
  _maybeGuide() {
    if (this._guide || this._guideTimer || loadGuideSeen() || !this.doc) return;
    if (!this._isTouchDevice()) return;   // 鼠标用户用不着，别闪一下烦人

    const el = this.doc.createElement('div');
    el.className = 'touch-guide';
    const mk = (cls, title, sub) => {
      const card = this.doc.createElement('div');
      card.className = `touch-guide-card ${cls}`;
      const b = this.doc.createElement('b');
      b.textContent = title;
      const s = this.doc.createElement('span');
      s.textContent = sub;
      card.appendChild(b);
      card.appendChild(s);
      el.appendChild(card);
    };
    mk('left', '左手', '推动驾驶');
    mk('right', '右手', '按住瞄准开火 · 松手停火');
    this.doc.body.appendChild(el);
    this._guide = el;
    this._guidedMove = false;
    this._guidedAim = false;
    this._guideTimer = setTimeout(() => this._dismissGuide(), 5000);
  }

  _dismissGuide() {
    if (this._guideTimer) {
      clearTimeout(this._guideTimer);
      this._guideTimer = 0;
    }
    if (!this._guide) return;
    this._guide.remove();
    this._guide = null;
    // 弹过一次就算见过：哪怕 5 秒到了还没碰右区，也别每局都唠叨
    saveGuideSeen();
  }

  /** 这个设备到底有没有触摸能力（触屏本、平板、手机都算） */
  _isTouchDevice() {
    if (this._touchCap === undefined) {
      this._touchCap = !!(window.matchMedia?.('(pointer: coarse)')?.matches
        || (navigator.maxTouchPoints || 0) > 0);
    }
    return this._touchCap;
  }

  // ---------------- 覆盖层 ----------------

  /**
   * 摇杆基点：默认固定在角落（左下 / 右下）。手指落在摇杆附近
   * （半径 + PAD_GRAB 的圈内）就认这根固定摇杆，基点不动、只跟拇指偏移；
   * 落得更远时把摇杆挪到手指下面。
   *
   * 后者是刻意保留的：固定摇杆最怕"按了没反应"——手指偏了几公分坦克就不动，
   * 玩家会以为是卡了。挪过去视觉上立刻有反馈，松手自己回角落。
   */
  _grabCenter(kind, x, y) {
    const base = padCenter(kind, window.innerWidth, window.innerHeight);
    const grab = (kind === 'aim' ? AIM_RADIUS : STICK_RADIUS) + PAD_GRAB;
    return Math.hypot(x - base.x, y - base.y) <= grab ? base : { x, y };
  }

  _place(el, c) {
    if (!el) return;
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
  }

  /** 把两根摇杆摆到角落，并按"现在能不能操作"显隐（战斗中常显，菜单里藏起来） */
  _syncPads() {
    if (!this.doc) return;
    this._ensureStick();
    this._ensureAimStick();
    const w = window.innerWidth;
    const h = window.innerHeight;
    // 纯键鼠设备一根都不画：常显是给拇指找位置的，桌面上只会变成两块浮斑
    const show = this.active && this._isTouchDevice() ? 'block' : 'none';
    if (this._el) {
      // 正按着的手指不打断：它可能已经被挪到手指下面了
      if (this.movePointer === null) this._place(this._el, padCenter('move', w, h));
      this._el.style.display = show;
    }
    if (this._aimEl) {
      if (this.aimPointer === null) this._place(this._aimEl, padCenter('aim', w, h));
      this._aimEl.style.display = show;
    }
    if (!this.active) {
      this._moveKnob(0, 0);
      this._moveAimKnob(0, 0);
      this._el?.classList?.remove?.('is-held');
      this._aimEl?.classList?.remove?.('is-held');
    }
  }

  _ensureStick() {
    if (this._el || !this.doc) return;
    const base = this.doc.createElement('div');
    base.className = 'touch-stick';
    const knob = this.doc.createElement('div');
    knob.className = 'touch-stick-knob';
    base.appendChild(knob);
    this.doc.body.appendChild(base);
    this._el = base;
    this._knob = knob;
  }

  _showStick(x, y) {
    this._ensureStick();
    if (!this._el) return;
    this._place(this._el, { x, y });
    this._el.style.display = 'block';
    this._el.classList?.add?.('is-held');
    this._moveKnob(0, 0);
  }

  _moveKnob(dx, dy) {
    if (!this._knob) return;
    this._knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  /** 松手 / 清零：拇指归中，摇杆回到角落，只在战斗里继续显示 */
  _restMove() {
    this._moveKnob(0, 0);
    this._el?.classList?.remove?.('is-held');
    this._place(this._el, padCenter('move', window.innerWidth, window.innerHeight));
    if (this._el) this._el.style.display = this.active && this._isTouchDevice() ? 'block' : 'none';
  }

  _ensureAimStick() {
    if (this._aimEl || !this.doc) return;
    const base = this.doc.createElement('div');
    base.className = 'touch-stick touch-stick--aim';
    const knob = this.doc.createElement('div');
    knob.className = 'touch-stick-knob touch-stick-knob--aim';
    base.appendChild(knob);
    this.doc.body.appendChild(base);
    this._aimEl = base;
    this._aimKnob = knob;
  }

  _showAimStick(x, y) {
    this._ensureAimStick();
    if (!this._aimEl) return;
    this._place(this._aimEl, { x, y });
    this._aimEl.style.display = 'block';
    this._aimEl.classList?.add?.('is-held');
    this._moveAimKnob(0, 0);
  }

  _moveAimKnob(dx, dy) {
    if (!this._aimKnob) return;
    this._aimKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  _restAim() {
    this._moveAimKnob(0, 0);
    this._aimEl?.classList?.remove?.('is-held');
    this._place(this._aimEl, padCenter('aim', window.innerWidth, window.innerHeight));
    if (this._aimEl) this._aimEl.style.display = this.active && this._isTouchDevice() ? 'block' : 'none';
  }

  /**
   * 竖屏提示：战场是宽视野俯视，竖屏会切掉左右两侧，敌人从侧后包抄几乎看不见。
   * 只在"触屏 + 竖屏 + 正在战斗"时挡一层，菜单里不打扰。
   */
  _checkOrientation() {
    if (!this.doc) return;
    const portrait = window.innerHeight > window.innerWidth;
    const show = portrait && this.active && window.matchMedia?.('(pointer: coarse)')?.matches;
    if (!show) {
      if (this._hint) this._hint.style.display = 'none';
      return;
    }
    if (!this._hint) {
      const el = this.doc.createElement('div');
      el.className = 'touch-rotate-hint';
      const box = this.doc.createElement('div');
      box.className = 'touch-rotate-box';
      const icon = this.doc.createElement('div');
      icon.className = 'touch-rotate-icon';
      const text = this.doc.createElement('span');
      text.textContent = '横过手机再开战';
      box.appendChild(icon);
      box.appendChild(text);
      el.appendChild(box);
      this.doc.body.appendChild(el);
      this._hint = el;
    }
    this._hint.style.display = 'flex';
  }
}
