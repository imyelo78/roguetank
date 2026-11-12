// 程序化战争配乐（WebAudio 实时合成，零素材、零版权风险）
//
// 为什么不用 mp3：
//   1. 一段能听的管弦乐 loop 至少 1~3 MB，而服务器静态白名单只放行
//      index.html / styles.css / src / vendor，加素材要同时改 server.mjs 和构建；
//   2. 版权是硬约束——网上能直接下的"史诗战争"几乎都有授权问题。
//
// 所以这里用合成器搭一层"战场底色"：
//   低音弦乐 ostinato（Dm–B♭–F–C 四小节循环）
//   + 定音鼓（重拍）
//   + 军鼓（2、4 拍，高强度加花）
//   + 铜管/人声质感的和声垫（小节头起音、跨两小节）
//   音量与层数跟着 intensity 上涨：0.3 = 刚开场，1.0 = Boss。
//
// 声音是"压迫感"而不是"电影级"——真要电影级，把 assets/bgm/battle.ogg
// 放进来，用 Sound.useMusicFile() 切换（见 sound.js）。
//
// 调度方式：setInterval 每 25ms 醒来一次，只把未来 200ms 内的音符排进
// AudioContext 的时间轴。不用 setTimeout 逐个排，是因为后者在切标签页
// 或主线程卡顿时会漂，听感就是"鼓点忽快忽慢"。

/** 用到的音高（Hz，A4=440 平均律） */
const P = {
  D2: 73.42, Bb1: 58.27, F2: 87.31, C2: 65.41,
  D3: 146.83, F3: 174.61, A3: 220.00,
  Bb2: 116.54, A2: 110.00, C3: 130.81,
  E3: 164.81, G3: 196.00,
  F4: 349.23, G4: 392.00, A4: 440.00, D5: 587.33,
};

/**
 * 四小节循环：i – VI – III – VII（D 小调）。
 * 这个进行每小节都"没解决"，天然适合打仗——不给耳朵收束感。
 */
const PROGRESSION = [
  { root: P.D2,  pad: [P.D3, P.F3, P.A3] },
  { root: P.Bb1, pad: [P.Bb2, P.D3, P.F3] },
  { root: P.F2,  pad: [P.F2, P.A2, P.C3] },
  { root: P.C2,  pad: [P.C3, P.E3, P.G3] },
];

/** 铜管旋律动机：只在强度高时出现，两小节一句 */
const MOTIF = [
  { step: 0,  note: P.A4, dur: 0.36 },
  { step: 6,  note: P.G4, dur: 0.28 },
  { step: 10, note: P.F4, dur: 0.52 },
];

export class Music {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} dest  已经接好音量的音乐总线
   */
  constructor(ctx, dest, { bpm = 96 } = {}) {
    this.ctx = ctx;
    this.dest = dest;
    this.bpm = bpm;
    this.stepDur = 60 / bpm / 4;          // 十六分音符时长
    this.intensity = 0.4;
    this.playing = false;
    this._timer = null;
    this._next = 0;
    this._step = 0;
    this._seed = 0x9e3779b9;              // 固定种子：同一局里加花位置不会乱跳
    this._lookahead = 0.2;
  }

  /** 0.25（安静）~ 1（Boss）。会立即影响下一拍的配器厚度。 */
  setIntensity(x) {
    const v = Math.max(0, Math.min(1, Number(x) || 0));
    // 立即生效，不做平滑：配器是逐拍判断的，换波次时听感本来就是"加人"。
    // 早期这里做了 0.6 的平滑，结果 setIntensity(0.95) 实际只到 0.73，
    // Boss 专属的低频心跳（阈值 0.8）永远触发不了。
    this.intensity = v;
  }

  start() {
    if (this.playing || !this.ctx) return;
    this.playing = true;
    this._step = 0;
    this._next = this.ctx.currentTime + 0.08;
    this._pump();
    this._timer = setInterval(() => this._pump(), 25);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  dispose() {
    this.stop();
    this._noiseBuf = null;
    this.ctx = null;
    this.dest = null;
  }

  // ---------------- 调度 ----------------

  /** 把未来 lookahead 秒内的十六分音符全部排掉 */
  _pump() {
    if (!this.playing || !this.ctx) return;
    const horizon = this.ctx.currentTime + this._lookahead;
    let guard = 0;
    while (this._next < horizon && guard++ < 64) {
      this._playStep(this._step, this._next);
      this._next += this.stepDur;
      this._step = (this._step + 1) % 64;     // 4 小节 × 16 步
    }
  }

  /** 一个十六分音符上要发生什么 */
  _playStep(step, t) {
    const bar = Math.floor(step / 16);         // 0..3
    const s = step % 16;                       // 小节内的步
    const chord = PROGRESSION[bar];
    const k = this.intensity;

    // ---- 低音弦乐 ostinato：八分音符，跨两小节换一次八度 ----
    if (s % 2 === 0) {
      const octave = bar >= 2 && s >= 8 ? 2 : 1;
      const f = chord.root * octave;
      this._tone({
        type: 'sawtooth', f0: f, f1: f, t,
        dur: this.stepDur * 1.7,
        vol: 0.085 + 0.05 * k,
        filter: { type: 'lowpass', f0: 420 + 260 * k, q: 0.9 },
        attack: 0.012,
      });
    }

    // ---- 定音鼓：1、3 拍，高强度加 3.5 拍的补击 ----
    if (s === 0 || s === 8) this._timpani(t, 0.9);
    if (s === 12 && k > 0.45) this._timpani(t, 0.62);
    if (s === 14 && k > 0.78) this._timpani(t, 0.4);

    // ---- 军鼓：2、4 拍；强度越高花越多 ----
    if (s === 4 || s === 12) this._snare(t, 0.7 + 0.3 * k);
    if (k > 0.6 && (s === 6 || s === 10) && this._rand() < 0.55) this._snare(t, 0.32);
    if (k > 0.85 && s >= 13 && s <= 15 && this._rand() < 0.5) this._snare(t, 0.28);

    // ---- 和声垫：每小节头起音，两小节一换 ----
    if (s === 0) {
      const hold = this.stepDur * 16 * (bar % 2 === 0 ? 1.9 : 1.4);
      this._pad(chord.pad, t, hold, 0.055 + 0.045 * k);
    }

    // ---- 铜管动机：只在后半段、高强度时出现 ----
    if (k > 0.55 && (bar === 2 || bar === 3)) {
      const m = MOTIF.find((x) => x.step === s);
      if (m) {
        this._tone({
          type: 'square', f0: m.note, f1: m.note * 0.995, t,
          dur: m.dur, vol: 0.05 + 0.03 * k,
          filter: { type: 'lowpass', f0: 1500, q: 0.7 },
          attack: 0.03,
        });
        this._tone({
          type: 'sawtooth', f0: m.note / 2, f1: m.note / 2, t,
          dur: m.dur * 1.2, vol: 0.045,
          filter: { type: 'lowpass', f0: 900, q: 0.6 },
          attack: 0.03,
        });
      }
    }

    // ---- 极低频心跳：Boss 段才有存在感 ----
    if (k > 0.8 && s === 0) {
      this._tone({ type: 'sine', f0: 46, f1: 34, t, dur: 0.9, vol: 0.1, attack: 0.02 });
    }
  }

  // ---------------- 乐器 ----------------

  _timpani(t, vel = 1) {
    this._tone({
      type: 'sine', f0: 74, f1: 38, t, dur: 0.55,
      vol: 0.26 * vel, attack: 0.004,
    });
    this._noise({
      t, dur: 0.09, vol: 0.1 * vel,
      filter: { type: 'lowpass', f0: 320, q: 0.7 },
    });
  }

  _snare(t, vel = 1) {
    this._noise({
      t, dur: 0.13, vol: 0.085 * vel,
      filter: { type: 'bandpass', f0: 1700, q: 1.1 },
    });
    this._tone({ type: 'triangle', f0: 210, f1: 150, t, dur: 0.05, vol: 0.05 * vel });
  }

  /** 三个音的合成器垫音：慢起音、长释放，做"人声/铜管"厚度 */
  _pad(notes, t, dur, vol) {
    for (let i = 0; i < notes.length; i++) {
      const detune = (i - 1) * 4;           // ±4 音分，制造合唱感
      this._tone({
        type: 'sawtooth', f0: notes[i], f1: notes[i], t,
        dur, vol: vol / notes.length,
        filter: { type: 'lowpass', f0: 700, q: 0.5 },
        attack: 0.35, release: 0.6, detune,
      });
    }
  }

  // ---------------- 底层音源 ----------------

  _tone({ type, f0, f1 = f0, t, dur, vol, filter, attack = 0.005, release = 0.05, detune = 0 }) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    if (detune) osc.detune.setValueAtTime(detune, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
    g.gain.setValueAtTime(Math.max(0.0002, vol), t + Math.max(attack, dur - release));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = osc;
    if (filter) {
      const bq = ctx.createBiquadFilter();
      bq.type = filter.type;
      bq.frequency.setValueAtTime(filter.f0, t);
      bq.Q.value = filter.q ?? 0.7;
      node.connect(bq);
      node = bq;
    }
    node.connect(g).connect(this.dest);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  _noise({ t, dur, vol, filter }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer();
    // 同一段 1 秒噪声每次从随机位置起播：省掉每拍新建 buffer，
    // 又不会因为每次都播同一段而听出"复读感"。
    const maxOff = Math.max(0, src.buffer.length / ctx.sampleRate - dur - 0.02);
    const off = Math.random() * maxOff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = src;
    if (filter) {
      const bq = ctx.createBiquadFilter();
      bq.type = filter.type;
      bq.frequency.setValueAtTime(filter.f0, t);
      bq.Q.value = filter.q ?? 0.8;
      node.connect(bq);
      node = bq;
    }
    node.connect(g).connect(this.dest);
    src.start(t, off, dur);
  }

  /** 1 秒白噪声，鼓/爆炸共用（懒创建） */
  _noiseBuffer() {
    if (this._noiseBuf) return this._noiseBuf;
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;
    return buf;
  }

  /** 固定种子 LCG：加花的位置在同一局里稳定，不会每小节乱蹦 */
  _rand() {
    this._seed = (this._seed * 1664525 + 1013904223) >>> 0;
    return this._seed / 4294967296;
  }
}
