// 音效 / 配乐系统：WebAudio 纯合成，零素材零依赖。
// M 键静音（localStorage 持久化）。首次点击"开始战斗"时解锁 AudioContext。
//
// 信号链（2026-11 r31 加入配乐时重排）：
//
//   开炮/爆炸/受击 …… → sfx 总线 ┐
//                                 ├→ master（静音开关）→ limiter → 扬声器
//   背景音乐 music.js → music 总线 ┘
//
// limiter 不是装饰：以前所有声音直接进 destination，4 人齐射 + Boss 殉爆
// 叠加时峰值会冲到 1.0 以上，实测在笔记本扬声器上是"噗"的爆音。
// 现在用 DynamicsCompressor 当限幅器，母带电平才能给到 0.5 而不破音。
//
// 爆炸是"定位音"：调用方把世界坐标交给 explosionAt(pos, i, listener)，
// 这里只负责把距离折成音量、把左右折成声像。所以本文件不 import THREE，
// 测试里喂 { x, z, fx, fz } 就能验距离衰减和声像方向。

import { Music } from './music.js';

const MUTE_KEY = 'tank3d.muted.v1';
const MASTER_LEVEL = 0.5;
const SFX_LEVEL = 0.95;
const MUSIC_LEVEL = 0.8;

// 爆炸空间化参数。战场 200×200，如果 100 米外队友被击毁和贴脸自爆一样响，
// 听感会糊成"一层背景毯子"，反而盖住近处该有的冲击力。
// 26 m 内不衰减；再远按 1/(1+(d/26)^1.3) 掉，下限留 30%（远处仍要有战场纵深）。
const FX_NEAR = 26;
const FX_FALLOFF = 1.3;
const FX_MIN = 0.3;
const FX_PAN_SPAN = 18;   // 横向 18 m ≈ 声像到满左/满右

function loadMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

/** 参数节点安全赋值：老浏览器 / 测试里的假节点可能没有 AudioParam */
function setValue(param, value) {
  if (param && typeof param === 'object' && 'value' in param) param.value = value;
}

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.limiter = null;
    this.music = null;
    this.muted = loadMuted();

    this._musicWanted = false;   // 用户在这局里要不要音乐（解锁前就点开始也能记住）
    this._intensity = 0.4;
    this._musicLevel = MUSIC_LEVEL;
    this._explosions = [];       // 最近爆炸的时间戳，用来并发限流
    this._hidden = false;        // 标签页在后台
  }

  /** 必须在用户手势里调用一次（浏览器自动播放策略） */
  unlock() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();

      // limiter：阈值 -10dB、8:1，快启动慢释放，压住爆炸的瞬时峰值
      try {
        this.limiter = this.ctx.createDynamicsCompressor();
        setValue(this.limiter.threshold, -10);
        setValue(this.limiter.knee, 6);
        setValue(this.limiter.ratio, 8);
        setValue(this.limiter.attack, 0.003);
        setValue(this.limiter.release, 0.25);
      } catch { this.limiter = null; }

      this.master = this.ctx.createGain();
      setValue(this.master.gain, this.muted ? 0 : MASTER_LEVEL);

      this.sfxBus = this.ctx.createGain();
      setValue(this.sfxBus.gain, SFX_LEVEL);

      this.musicBus = this.ctx.createGain();
      setValue(this.musicBus.gain, 0);   // 由 startMusic() 淡入，避免"啪"地开始

      this.sfxBus.connect(this.master);
      this.musicBus.connect(this.master);
      if (this.limiter) {
        this.master.connect(this.limiter);
        this.limiter.connect(this.ctx.destination);
      } else {
        this.master.connect(this.ctx.destination);
      }
    }

    if (this.ctx.state === 'suspended') {
      // resume() 是 Promise；有的浏览器在没有手势时会 reject，不能让它冒成未捕获异常
      try { this.ctx.resume()?.catch?.(() => {}); } catch { /* 忽略 */ }
    }
    // 解锁前就点过"出击"：现在补上
    if (this._musicWanted) this.startMusic();
  }

  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch { /* 忽略 */ }
    if (this.master) setValue(this.master.gain, this.muted ? 0 : MASTER_LEVEL);
    // 静音就别留 25ms 的调度器了：它一直在造振荡器，哪怕 master 是 0。
    // 长时间静音挂着（尤其后台标签页）纯属白烧 CPU 和电。
    if (this.muted) this.music?.stop();
    else if (this.ctx && this._musicWanted && !this._hidden) this.startMusic();
    return this.muted;
  }

  /** 切到后台 / 切回来：停配乐调度并挂起音频时钟，回来再续上 */
  setHidden(hidden) {
    this._hidden = !!hidden;
    if (!this.ctx) return;
    if (this._hidden) {
      this.music?.stop();
      try { this.ctx.suspend?.(); } catch { /* 忽略 */ }
    } else {
      try { this.ctx.resume()?.catch?.(() => {}); } catch { /* 忽略 */ }
      if (this._musicWanted && !this.muted) this.startMusic();
    }
  }

  _ok() { return !!this.ctx && !this.muted; }

  // ---------------- 配乐 ----------------

  /** 开始背景音乐（已解锁才真正发声；未解锁先记下意图） */
  startMusic() {
    this._musicWanted = true;
    // 上一次 stopMusic 的延迟停止可能还没触发（快速"退出→再进"），先取消
    clearTimeout(this._stopTimer);
    // 未解锁 / 后台 / 静音：只记意图，等 unlock() / setHidden(false) / 取消静音再真正起调度
    if (!this.ctx || this._hidden || this.muted) return;
    if (!this.music) this.music = new Music(this.ctx, this.musicBus, { bpm: 96 });
    this.music.setIntensity(this._intensity);
    this.music.start();
    this._musicLevel = MUSIC_LEVEL;
    this._rampGain(this.musicBus, MUSIC_LEVEL, 1.2);
  }

  /** 停止背景音乐。fade 秒内淡出（0 表示立刻） */
  stopMusic(fade = 0.8) {
    this._musicWanted = false;
    if (!this.ctx) return;
    this._rampGain(this.musicBus, 0.0001, Math.max(0.01, fade));
    if (this.music) {
      // 等淡出走完再停调度，否则最后一小节的音会被硬切
      const m = this.music;
      const wait = Math.max(0, fade) * 1000 + 120;
      clearTimeout(this._stopTimer);
      this._stopTimer = setTimeout(() => m.stop(), wait);
    }
  }

  /** 0.25（紧张）~ 1（Boss）。见 music.js 里各层乐器的开关阈值 */
  setMusicIntensity(x) {
    const v = Math.max(0, Math.min(1, Number(x) || 0));
    this._intensity = v;
    this.music?.setIntensity(v);
  }

  /** 爆炸时把音乐压下去一点，0.4 秒后恢复（"闪避"） */
  _duckMusic(strength = 1) {
    if (!this.ctx || !this.musicBus || !this._musicWanted) return;
    const target = this._musicLevel * Math.max(0.25, 1 - 0.5 * strength);
    const g = this.musicBus.gain;
    const t = this.ctx.currentTime;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(target, t + 0.03);
      g.linearRampToValueAtTime(this._musicLevel, t + 0.45);
    } catch {
      setValue(g, this._musicLevel);
    }
  }

  _rampGain(node, value, seconds) {
    if (!node) return;
    const g = node.gain;
    const t = this.ctx.currentTime;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(Math.max(0.0001, value), t + Math.max(0.01, seconds));
    } catch {
      setValue(g, value);
    }
  }

  // ---------------- 底层音源 ----------------

  /** 单振荡器扫频。dest 默认进 sfx 总线，空间化的爆炸会传一个临时声像节点进来 */
  _tone({ type = 'sine', f0 = 440, f1 = f0, dur = 0.1, vol = 0.2, delay = 0, attack = 0.004, dest = null }) {
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, f0), t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const peak = Math.max(0.0002, vol);
    if (attack > 0.005) {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    } else {
      g.gain.setValueAtTime(peak, t0);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(dest || this.sfxBus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 噪声爆发（可选滤波器类型 / 扫频） */
  _noise({ type = 'lowpass', dur = 0.2, vol = 0.3, f0 = 1200, f1 = f0, q = 0.8, delay = 0, dest = null }) {
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(Math.max(40, f0), t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(dest || this.sfxBus);
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

  /**
   * 坦克爆炸：intensity 0.3（小火花）~ 2（Boss 殉爆）。
   *
   * 分五层叠出"装甲被掀开"的厚度，而不是以前那记单薄的 noise + sine：
   *   1. sub thump   60~110Hz 正弦下坠 —— 胸腔能感到的那一下
   *   2. body        低通噪声 1.1k → 60Hz —— 火球本体
   *   3. crack       高通噪声 5k → 1.5k，20ms —— 装甲板崩裂的脆响
   *   4. debris      0.08~0.3s 后几声短噪声 —— 碎片飞散 / 二次小爆
   *   5. ring        2~3 个不成谐波关系的金属音 —— 车体余响，避免"电子味"
   *
   * 并发限流：4 人联机时同一次齐射可能同时炸 4~6 辆，全叠满会瞬间糊成白噪。
   * 180ms 内超过 3 发，后几发自动降到 55% 音量。
   *
   * @param {number} intensity 0.3~2
   * @param {{gain?:number, pan?:number}} opts 距离衰减后的音量系数与声像（-1 左 ~ 1 右）；
   *        一般不用自己算，走 explosionAt(pos, i, listener)
   */
  explosion(intensity = 1, { gain = 1, pan = 0 } = {}) {
    if (!this._ok()) return;
    const i = Math.max(0.3, Math.min(2, intensity));
    const now = this.ctx.currentTime;

    this._explosions = this._explosions.filter((t) => now - t < 0.18);
    const overlapping = this._explosions.length;
    this._explosions.push(now);
    // 距离衰减直接折进音量系数，不再多建一级增益节点
    const k = (overlapping < 3 ? 1 : 0.55) * Math.max(0, Math.min(1.5, gain));
    const bus = this._panned(pan);

    // 1. sub thump
    this._tone({ type: 'sine', f0: 64 + 34 * i, f1: 26, dur: 0.34 * i, vol: (0.24 + 0.09 * i) * k, dest: bus });

    // 2. body
    this._noise({ type: 'lowpass', dur: 0.3 * i, vol: (0.22 + 0.1 * i) * k, f0: 900 + 250 * i, f1: 60, q: 1.1, dest: bus });

    // 3. crack
    this._noise({ type: 'highpass', dur: 0.055, vol: 0.14 * k, f0: 1400, f1: 4600, q: 0.7, dest: bus });

    // 4. debris：两粒，音量和延迟都带点随机，听感才不像程序
    this._noise({ type: 'bandpass', dur: 0.07, vol: 0.07 * k, f0: 1800, f1: 700, q: 1.4, delay: 0.09 + Math.random() * 0.05, dest: bus });
    this._noise({ type: 'bandpass', dur: 0.05, vol: 0.05 * k, f0: 2400, f1: 900, q: 1.6, delay: 0.17 + Math.random() * 0.1, dest: bus });

    // 5. ring：不成谐波，才有金属感
    this._tone({ type: 'triangle', f0: 233 + 40 * i, f1: 190, dur: 0.26, vol: 0.05 * k, delay: 0.01, dest: bus });
    this._tone({ type: 'triangle', f0: 351 + 55 * i, f1: 288, dur: 0.19, vol: 0.035 * k, delay: 0.02, dest: bus });

    // 大爆炸压一下音乐，小爆炸不压
    if (i >= 1.1) this._duckMusic(Math.min(1, i - 0.4));
  }

  /**
   * 位置化爆炸：按"离玩家多远、在左还是右"调音量和声像。
   *
   * listener 是纯数字（{x, z, fx, fz}，fx/fz 为相机朝向向量），
   * 这样 sound.js 不必依赖 THREE，也能在测试里直接喂数字。
   * 没给 listener（或位置非法）就退回非定位版本，不会因为算不出来就丢音。
   */
  explosionAt(pos, intensity = 1, listener = null) {
    if (!pos || !listener) return this.explosion(intensity);
    const dx = Number(pos.x) - Number(listener.x);
    const dz = Number(pos.z) - Number(listener.z);
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return this.explosion(intensity);

    const dist = Math.hypot(dx, dz);
    // 相机朝向投影到 XZ 平面，右向量 = (-fz, fx)
    let fx = Number(listener.fx) || 0;
    let fz = Number.isFinite(Number(listener.fz)) ? Number(listener.fz) : -1;
    const len = Math.hypot(fx, fz);
    if (len > 1e-4) { fx /= len; fz /= len; } else { fx = 0; fz = -1; }

    const pan = (dx * -fz + dz * fx) / FX_PAN_SPAN;
    const gain = Math.max(FX_MIN, 1 / (1 + Math.pow(dist / FX_NEAR, FX_FALLOFF)));
    return this.explosion(intensity, { gain, pan });
  }

  /** 一次性声像节点；pan 为 0 时不建节点（绝大多数爆炸就在正前方） */
  _panned(pan) {
    const p = Number(pan);
    if (!p || !this.ctx || typeof this.ctx.createStereoPanner !== 'function') return null;
    try {
      const node = this.ctx.createStereoPanner();
      setValue(node.pan, Math.max(-1, Math.min(1, p)));
      node.connect(this.sfxBus);
      return node;
    } catch {
      return null;
    }
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
    this._duckMusic(0.8);
  }

  /**
   * 出击号角：F 大三和弦上行的四支铜管 + 三连定音鼓 + 一记落地大鼓。
   * 作用不是"好听"，而是把"这局开始了"和"菜单里随便点点"分开——
   * 只靠配乐渐入，开局那一下听觉上没有边界感。
   */
  fanfare() {
    if (!this._ok()) return;
    const chord = [174.61, 220.0, 261.63, 349.23];   // F3 A3 C4 F4
    chord.forEach((f, i) => {
      this._tone({ type: 'sawtooth', f0: f, f1: f * 1.002, dur: 1.5 - i * 0.1, vol: 0.05, delay: i * 0.02, attack: 0.1 });
      this._tone({ type: 'square', f0: f / 2, f1: f / 2, dur: 1.1, vol: 0.028, delay: i * 0.02, attack: 0.14 });
    });
    [0, 0.26, 0.52].forEach((d, i) => {
      this._tone({ type: 'sine', f0: 92 - i * 7, f1: 40, dur: 0.4, vol: 0.16, delay: d });
    });
    this._tone({ type: 'sine', f0: 62, f1: 30, dur: 1.2, vol: 0.22, delay: 0.78 });
    this._noise({ type: 'lowpass', dur: 0.6, vol: 0.09, f0: 700, f1: 110, delay: 0.78 });
    // 这里故意不压音乐：startMusic 的 1.2 s 淡入本身就是留给号角的空隙，
    // 再叠一次 duck 反而会把配乐提前推到满档，号角被埋掉。
  }

  /** 炮击预警 */
  warn() {
    if (!this._ok()) return;
    this._tone({ type: 'square', f0: 880, f1: 660, dur: 0.09, vol: 0.1 });
    this._tone({ type: 'square', f0: 880, f1: 660, dur: 0.09, vol: 0.1, delay: 0.14 });
  }
}
