// 音效系统：WebAudio 纯合成，零素材零依赖。
// M 键静音（localStorage 持久化）。首次点击"开始战斗"时解锁 AudioContext。

const MUTE_KEY = 'tank3d.muted.v1';

function loadMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = loadMuted();
  }

  /** 必须在用户手势里调用一次（浏览器自动播放策略） */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
  }

  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch { /* 忽略 */ }
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  _ok() { return this.ctx && !this.muted; }

  /** 单振荡器扫频 */
  _tone({ type = 'sine', f0 = 440, f1 = f0, dur = 0.1, vol = 0.2, delay = 0 }) {
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, f0), t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 噪声爆发（可选低通扫频） */
  _noise({ dur = 0.2, vol = 0.3, f0 = 1200, f1 = f0, q = 0.8, delay = 0 }) {
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(Math.max(40, f0), t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t0);
  }

  // ---------------- 具体音效 ----------------

  /** 开炮：玩家按武器微调音色，敌方更低沉 */
  shoot(team, kind = 'cannon') {
    if (!this._ok()) return;
    if (team === 'player') {
      if (kind === 'gatling') this._tone({ type: 'square', f0: 300, f1: 130, dur: 0.05, vol: 0.12 });
      else if (kind === 'laser') this._tone({ type: 'sawtooth', f0: 1100, f1: 260, dur: 0.1, vol: 0.14 });
      else if (kind === 'mortar') { this._tone({ type: 'square', f0: 120, f1: 45, dur: 0.16, vol: 0.3 }); this._noise({ dur: 0.12, vol: 0.2, f0: 600, f1: 150 }); }
      else { this._tone({ type: 'square', f0: 220, f1: 70, dur: 0.09, vol: 0.2 }); this._noise({ dur: 0.06, vol: 0.1, f0: 900, f1: 300 }); }
    } else {
      this._tone({ type: 'sawtooth', f0: 150, f1: 55, dur: 0.1, vol: 0.1 });
    }
  }

  /** 爆炸：intensity 0.3（小火花）~ 2（Boss 殉爆） */
  explosion(intensity = 1) {
    if (!this._ok()) return;
    const i = Math.max(0.3, Math.min(2, intensity));
    this._noise({ dur: 0.32 * i, vol: 0.26 + 0.14 * i, f0: 900, f1: 70, q: 1.2 });
    this._tone({ type: 'sine', f0: 90 + 30 * i, f1: 26, dur: 0.3 * i, vol: 0.24 + 0.1 * i });
  }

  /** 子弹命中金属 */
  hit() {
    if (!this._ok()) return;
    this._tone({ type: 'triangle', f0: 520, f1: 180, dur: 0.05, vol: 0.12 });
    this._noise({ dur: 0.04, vol: 0.08, f0: 2400, f1: 800 });
  }

  /** 玩家受击 */
  hurt() {
    if (!this._ok()) return;
    this._tone({ type: 'sawtooth', f0: 190, f1: 60, dur: 0.18, vol: 0.28 });
    this._noise({ dur: 0.1, vol: 0.14, f0: 700, f1: 200 });
  }

  /** 清波：上行双音 */
  clear() {
    if (!this._ok()) return;
    this._tone({ type: 'sine', f0: 523, dur: 0.12, vol: 0.18 });
    this._tone({ type: 'sine', f0: 784, dur: 0.18, vol: 0.18, delay: 0.1 });
  }

  /** 选卡 / 切炮 UI 音 */
  select() {
    if (!this._ok()) return;
    this._tone({ type: 'triangle', f0: 660, f1: 880, dur: 0.07, vol: 0.14 });
  }

  /** 激光过热警告 */
  overheat() {
    if (!this._ok()) return;
    this._tone({ type: 'square', f0: 300, f1: 120, dur: 0.35, vol: 0.16 });
    this._tone({ type: 'square', f0: 240, f1: 100, dur: 0.35, vol: 0.12, delay: 0.12 });
  }

  /** Boss 登场 */
  bossIn() {
    if (!this._ok()) return;
    this._tone({ type: 'sawtooth', f0: 70, f1: 42, dur: 0.7, vol: 0.3 });
    this._tone({ type: 'square', f0: 140, f1: 84, dur: 0.55, vol: 0.12, delay: 0.08 });
  }

  /** 炮击预警 */
  warn() {
    if (!this._ok()) return;
    this._tone({ type: 'square', f0: 880, f1: 660, dur: 0.09, vol: 0.1 });
    this._tone({ type: 'square', f0: 880, f1: 660, dur: 0.09, vol: 0.1, delay: 0.14 });
  }
}
