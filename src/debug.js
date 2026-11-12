// 联机抖动诊断面板（F3 呼出 / 再按关闭）
//
// 为什么需要它：这个项目的"抖"已经迭代了 29 版，快照节奏、插值缓冲、
// 残差消化、相机前馈各自都修过——但每一次都是"凭现象猜层"。面板把
// 抖动拆成 6 个可测量，下一次复现时看哪个数字超标，就是哪一层的问题：
//
//   1. 帧时间超标        → 渲染/逻辑本身卡（GC、DOM、GPU），跟网络无关
//   2. 快照 gap 峰值大    → 网络抖动，插值延迟会自动加深，看"夹死"是否为 0
//   3. 夹死 > 0          → 缓冲不够深，远端实体会一顿一顿（12/13 版的病）
//   4. RTT 大且波动       → 预测领先量天然变大，纵向残差是正常代价
//   5. 横向残差/待消化大  → 校正层在磨，画面会一顿一顿（19 版的病）
//   6. 画面速度波动 %     → 最终裁判：匀速直行时它应 < 3%，大就是真抖
//
// 纯只读诊断：不写任何游戏状态，DOM 每 0.25s 才更新一次（每帧写 DOM
// 本身就是抖动源，诊断工具不能犯自己诊断的病）。

const PANEL_ID = 'fx-debug-panel';

export class NetDebug {
  constructor() {
    this.el = null;
    this.visible = false;
    this._uiAcc = 0;
    this._frameMs = 0;          // 上一帧 dt（毫秒）
    this._ftMax = 0;            // 1 秒窗内最大帧时间
    this._ftSum = 0;
    this._ftN = 0;
    this._vErr = [];            // 画面速度相对误差样本（1 秒窗）
    this._lastDisp = null;      // 上一帧渲染位置
  }

  /** 懒创建面板 DOM：不抖的游戏就不该为诊断付任何代价 */
  _ensure() {
    if (this.el) return;
    const el = document.createElement('div');
    el.id = PANEL_ID;
    Object.assign(el.style, {
      position: 'fixed', top: '8px', right: '8px', zIndex: 9999,
      font: '12px/1.5 Consolas, monospace', color: '#9fe6a0',
      background: 'rgba(0,20,10,0.82)', padding: '8px 10px',
      borderRadius: '6px', whiteSpace: 'pre', pointerEvents: 'none',
      textShadow: '0 1px 2px #000',
    });
    el.textContent = '诊断面板';
    el.style.display = 'none';
    document.body.appendChild(el);
    this.el = el;
  }

  toggle() {
    this._ensure();
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
    // 重开面板时清掉旧窗口的统计，避免看到几分钟前的陈旧峰值
    this._ftMax = 0; this._ftSum = 0; this._ftN = 0;
    this._vErr.length = 0;
    this._lastDisp = null;
  }

  destroy() {
    this.el?.remove();
    this.el = null;
    this.visible = false;
  }

  /**
   * 每帧调用。dt 单位秒；deps 直接传引用，本类不做任何业务判断。
   * @param {{net:object, me:object, disp:{x,z}, vel:{x,z}}} d
   */
  frame(dt, d) {
    if (!this.visible) return;
    const ms = dt * 1000;
    this._frameMs = ms;
    this._ftMax = Math.max(this._ftMax, ms);
    this._ftSum += ms; this._ftN += 1;
    this._uiAcc += dt;
    if (this._uiAcc < 0.25) return;   // 面板 4Hz 刷新
    this._uiAcc = 0;

    const net = d.net || {};
    const s = d.net?.netstat || {};
    const alive = !!d.me?.alive && !d.me?.down;

    // ---- 画面速度波动（匀速直行时的最终裁判指标）----
    // 渲染位移的每帧速度 vs 预测实测速度，相对误差的 RMS。
    // ⚠ 只在"活着且明确在行驶"时采样；倒下/静止一律清窗——
    //   否则倒下期间 _vel 与画面的错位会把 RMS 污染成 100%（实测踩过）。
    let jitTxt = '--';
    const spd = Math.hypot(d.vel?.x || 0, d.vel?.z || 0);
    if (alive && spd > 2 && d.disp) {
      if (this._lastDisp) {
        const moved = Math.hypot(d.disp.x - this._lastDisp.x, d.disp.z - this._lastDisp.z) / dt;
        // 相对误差截到 ±100%，异常帧（卡顿恢复）不该把 RMS 打爆
        const err = Math.max(-1, Math.min(1, (moved - spd) / spd));
        this._vErr.push(err);
        if (this._vErr.length > 60) this._vErr.shift();
      }
      this._lastDisp = { x: d.disp.x, z: d.disp.z };
    } else {
      this._vErr.length = 0;
      this._lastDisp = null;
    }
    if (this._vErr.length > 10) {
      let sum = 0;
      for (const e of this._vErr) sum += e * e;
      jitTxt = `${(Math.sqrt(sum / this._vErr.length) * 100).toFixed(1)}%`;
    }

    // ---- 残差分解（纵向=预测领先，横向=真偏差）----
    // 行驶时按速度方向拆纵/横；静止时只剩"总偏差"一个数有意义。
    let resTxt = '--';
    const p = net.lastSnap?.players?.find?.((q) => q.id === d.myId);
    if (p && d.me) {
      const rx = p.x - d.me.x, rz = p.z - d.me.z;
      if (spd > 0.5) {
        let vx = d.vel.x, vz = d.vel.z;
        const vl = Math.hypot(vx, vz) || 1;
        const ux = vx / vl, uz = vz / vl;
        const along = rx * ux + rz * uz;
        const lat = Math.hypot(rx - ux * along, rz - uz * along);
        resTxt = `纵 ${along.toFixed(2)} 横 ${lat.toFixed(2)} m`;
      } else {
        resTxt = `静止 偏差 ${Math.hypot(rx, rz).toFixed(2)} m`;
      }
    }

    const avgMs = this._ftN ? this._ftSum / this._ftN : 0;
    const state = !d.me ? '--' : !d.me.alive ? '阵亡' : d.me.down ? '倒下' : spd > 2 ? '行驶' : '静止';
    this.el.textContent =
      `帧 ${ms.toFixed(1)}ms 均 ${avgMs.toFixed(1)} 峰 ${this._ftMax.toFixed(0)}\n` +
      `快照 ${(s.hz || 0).toFixed(1)}Hz 均 ${(s.gapMs || 0).toFixed(0)}ms ` +
      `峰 ${(s.gapMax || 0).toFixed(0)}ms 断流 ${s.stalls || 0}\n` +
      `缓冲 ${net.snaps?.length ?? '?'}帧 延迟 ${(net._interpDelay ?? 0).toFixed(1)}格 ` +
      `夹死 ${net._interpFrozen || 0}\n` +
      `RTT ${net.rtt ?? '--'}ms\n` +
      `状态 ${state}  残差 ${resTxt}\n` +
      `画面速度波动 ${jitTxt}`;
  }
}
