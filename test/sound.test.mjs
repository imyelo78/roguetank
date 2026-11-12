// 声音系统的离线回归测试：用一个假 AudioContext 跑真实代码路径。
//
// 这里不验证"好不好听"（那只能靠耳朵），只钉住三件容易回归的事：
//   1. 信号链没断——所有音源都必须连到 sfx/music 总线，再经 master/limiter 到扬声器；
//      以前有一次把 connect 改成 this.master 漏了音乐总线，线上就是"音效有、音乐没"。
//   2. 静音是真静音——muted 时不能创建振荡器（省 CPU，也避免后台偷偷发声）。
//   3. 爆炸并发限流与配乐起停——4 人联机同屏爆炸不能无限叠加；回菜单/死亡要停乐。

import assert from 'node:assert/strict';

// ---- 假 WebAudio ----

class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(v, t) { this.value = v; this.events.push(['set', v, t]); return this; }
  linearRampToValueAtTime(v, t) { this.value = v; this.events.push(['lin', v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.events.push(['exp', v, t]); return this; }
  cancelScheduledValues(t) { this.events.push(['cancel', t]); return this; }
}

class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.type = 'sine';
    this.gain = new FakeParam(1);
    this.frequency = new FakeParam(440);
    this.detune = new FakeParam(0);
    this.pan = new FakeParam(0);
    this.Q = new FakeParam(1);
    this.threshold = new FakeParam(0);
    this.knee = new FakeParam(0);
    this.ratio = new FakeParam(1);
    this.attack = new FakeParam(0.01);
    this.release = new FakeParam(0.1);
    this.buffer = null;
    this.connections = [];
    this.startAt = null;
    this.stopAt = null;
  }
  connect(node) { this.connections.push(node); return node; }
  start(t) { this.startAt = t; }
  stop(t) { this.stopAt = t; }
}

class FakeCtx {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = { kind: 'destination' };
    this.nodes = [];
  }
  _add(node) { this.nodes.push(node); return node; }
  createGain() { return this._add(new FakeNode(this, 'gain')); }
  createOscillator() { return this._add(new FakeNode(this, 'osc')); }
  createBiquadFilter() { return this._add(new FakeNode(this, 'biquad')); }
  createBufferSource() { return this._add(new FakeNode(this, 'source')); }
  createStereoPanner() { return this._add(new FakeNode(this, 'panner')); }
  createDynamicsCompressor() { return this._add(new FakeNode(this, 'compressor')); }
  createBuffer(channels, length, rate) {
    const data = new Float32Array(length);
    return { numberOfChannels: channels, length, sampleRate: rate, getChannelData: () => data };
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
}

// sound.js 里用 globalThis.AudioContext，测试不需要 window
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { Sound } = await import('../src/sound.js');
const { Music } = await import('../src/music.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const ok = (name) => { pass++; console.log(`  · ${name}`); };

// 从节点列表里算"这一批音源的总峰值"，用来比较限流前后
function peakSum(ctx) {
  let sum = 0;
  for (const n of ctx.nodes) {
    if (n.kind !== 'gain') continue;
    for (const e of n.gain.events) if (e[0] === 'set') sum += e[1];
  }
  return sum;
}

console.log('\n[1] 解锁与信号链');

const sound = new Sound();
assert.equal(sound.ctx, null, '构造时不应创建 AudioContext');
// 解锁前就要求放音乐：不能抛，且要记住意图
sound.startMusic();
assert.equal(sound._musicWanted, true);
assert.equal(sound.ctx, null);
ok('解锁前调用 startMusic 不抛异常，并记住意图');

globalThis.AudioContext = FakeCtx;
sound.unlock();
assert.ok(sound.ctx instanceof FakeCtx);
assert.ok(sound.master, '应有 master');
assert.ok(sound.sfxBus, '应有 sfx 总线');
assert.ok(sound.musicBus, '应有 music 总线');

assert.ok(sound.sfxBus.connections.includes(sound.master), 'sfx → master');
assert.ok(sound.musicBus.connections.includes(sound.master), 'music → master');
assert.ok(sound.master.connections.includes(sound.limiter), 'master → limiter');
assert.ok(sound.limiter.connections.includes(sound.ctx.destination), 'limiter → 扬声器');
assert.equal(sound.master.gain.value, 0.5);
assert.ok(sound.music, '解锁时应自动开始之前请求的音乐');
assert.equal(sound.music.playing, true);
ok('信号链 sfx/music → master → limiter → destination');

console.log('\n[2] 音效全部可播且都进 sfx 总线');

const before = sound.ctx.nodes.length;
const sfx = [
  () => sound.shoot('player', 'cannon'),
  () => sound.shoot('player', 'gatling'),
  () => sound.shoot('player', 'laser'),
  () => sound.shoot('player', 'mortar'),
  () => sound.shoot('enemy'),
  () => sound.explosion(0.3),
  () => sound.explosion(1),
  () => sound.explosion(2),
  () => sound.hit(),
  () => sound.hurt(),
  () => sound.clear(),
  () => sound.select(),
  () => sound.overheat(),
  () => sound.bossIn(),
  () => sound.warn(),
];
for (const fn of sfx) fn();
assert.ok(sound.ctx.nodes.length > before + 20, '应创建大量音源节点');

// 所有音效的最终增益都必须落在 sfxBus 上（音乐走 musicBus，由 Music 自己接）
const toSfx = sound.ctx.nodes.filter((n) => n.kind === 'gain' && n.connections.includes(sound.sfxBus)).length;
assert.ok(toSfx >= sfx.length, `应有至少 ${sfx.length} 个音源汇入 sfx 总线（实际 ${toSfx}）`);
ok(`${sfx.length} 个音效接口全部可播，且都汇入 sfx 总线`);

console.log('\n[3] 爆炸是分层而不是单薄一下');

sound.ctx.nodes.length = 0;
sound._explosions = [];
sound.explosion(1);
const layers = sound.ctx.nodes.filter((n) => n.kind === 'osc' || n.kind === 'source').length;
assert.ok(layers >= 6, `爆炸至少 6 个音源（实际 ${layers}）`);
const hasCompressor = sound.ctx.nodes.some((n) => n.kind === 'compressor');
assert.equal(hasCompressor, false, '单次音效不应重建 limiter');
ok(`单次爆炸 ${layers} 个音源（sub + body + crack + 碎片 + 金属余响）`);

console.log('\n[4] 并发限流：4 辆同时炸不会无限叠加');

const t0 = sound.ctx.currentTime;
sound.ctx.nodes.length = 0;
sound._explosions = [];
sound.explosion(1);
const solo = peakSum(sound.ctx);
assert.ok(solo > 0);

sound._explosions = [t0, t0, t0];
sound.ctx.nodes.length = 0;
sound.explosion(1);
const burst = peakSum(sound.ctx);
// 第 4 发应该降级到 55%，峰值明显低于满档
assert.ok(burst < solo * 0.75, `并发降级不明显：solo=${solo} burst=${burst}`);
ok(`第 4 发峰值合计 ${burst.toFixed(2)}（单发 ${solo.toFixed(2)}），已降级`);

// 时间窗口外的旧记录要被清掉
sound._explosions = [t0 - 5, t0 - 4];
sound.ctx.currentTime = t0 + 1;
sound.explosion(1);
assert.equal(sound._explosions.length, 1, '180ms 之前的记录应被过滤');
ok('爆炸时间戳窗口正常回收');

console.log('\n[5] 配乐起停与强度');

const music = sound.music;
assert.ok(music instanceof Music);
sound.setMusicIntensity(0.95);
assert.ok(music.intensity > 0.6, '强度必须立即生效（平滑会让 Boss 的心跳阈值永远够不到）');
const busGainBefore = sound.musicBus.gain.value;
assert.ok(busGainBefore > 0, '音乐总线应已淡入');
ok(`强度 ${music.intensity.toFixed(2)}，音乐总线 ${busGainBefore.toFixed(2)}`);

sound.stopMusic(0.1);
assert.equal(sound._musicWanted, false);
await sleep(400);
assert.equal(music.playing, false, 'stopMusic 淡出后应停止调度');
ok('stopMusic 淡出后停止调度');

// 音乐对象还能复用（重开一局）
sound.startMusic();
assert.equal(music.playing, true);
ok('重开一局可复用同一个 Music 实例');

console.log('\n[6] 静音');

const muted = sound.toggleMute();
assert.equal(muted, true);
assert.equal(sound.master.gain.value, 0);
assert.equal(store.get('tank3d.muted.v1'), '1');
sound.ctx.nodes.length = 0;
sound.explosion(2);
sound.shoot('player');
assert.equal(sound.ctx.nodes.length, 0, '静音时不应创建任何音源');
ok('静音后不创建音源，且状态写入 localStorage');

const unmuted = sound.toggleMute();
assert.equal(unmuted, false);
assert.equal(sound.master.gain.value, 0.5);
ok('取消静音恢复 master 电平');

console.log('\n[7] 爆炸按距离与方位发声');

// 相机在原点、朝 -Z：右向量 = (+1, 0)
const listener = { x: 0, z: 0, fx: 0, fz: -1 };
const clearNodes = () => {
  sound.ctx.nodes.length = 0;
  sound._explosions = [];
  sound.ctx.currentTime += 1;      // 跳过 180ms 限流窗口
};

clearNodes();
sound.explosionAt({ x: 0, z: 0 }, 1, listener);
const atFeet = peakSum(sound.ctx);
clearNodes();
sound.explosionAt({ x: 0, z: -8 }, 1, listener);
const near = peakSum(sound.ctx);
clearNodes();
sound.explosionAt({ x: 0, z: -110 }, 1, listener);
const far = peakSum(sound.ctx);

assert.ok(atFeet > near, `贴脸应比 8 m 响：${atFeet} vs ${near}`);
assert.ok(near > far * 1.8, `远处爆炸应明显变轻：近 ${near} / 远 ${far}`);
assert.ok(far / atFeet > 0.25, '再远也要留住地板音量，否则没有战场纵深');
ok(`距离衰减：0 m ${atFeet.toFixed(2)} / 8 m ${near.toFixed(2)} / 110 m ${far.toFixed(2)}`);

clearNodes();
sound.explosionAt({ x: 18, z: -20 }, 1, listener);
const rightPanners = sound.ctx.nodes.filter((n) => n.kind === 'panner');
assert.equal(rightPanners.length, 1, '右侧爆炸应建一个声像节点');
assert.ok(rightPanners[0].pan.value > 0.6, `右侧应偏右：${rightPanners[0].pan.value}`);
assert.ok(rightPanners[0].connections.includes(sound.sfxBus), '声像节点必须回到 sfx 总线');

clearNodes();
sound.explosionAt({ x: -18, z: -20 }, 1, listener);
const leftPanners = sound.ctx.nodes.filter((n) => n.kind === 'panner');
assert.ok(leftPanners[0].pan.value < -0.6, `左侧应偏左：${leftPanners[0].pan.value}`);
ok('左右声像跟随爆炸方位');

clearNodes();
sound.explosionAt({ x: 0, z: -18 }, 1, listener);
assert.equal(sound.ctx.nodes.filter((n) => n.kind === 'panner').length, 0, '正前方不该建声像节点');
clearNodes();
sound.explosionAt({ x: NaN, z: 0 }, 1, listener);
assert.ok(sound.ctx.nodes.length > 0, '坐标非法时应退回非定位版本，而不是静音');
ok('正前方省掉声像节点；坐标非法退回非定位版本');

console.log('\n[8] 出击号角');

clearNodes();
sound.fanfare();
const fanSources = sound.ctx.nodes.filter((n) => n.kind === 'osc' || n.kind === 'source').length;
assert.ok(fanSources >= 8, `号角至少 8 个音源（实际 ${fanSources}）`);
assert.ok(sound.ctx.nodes.some((n) => n.kind === 'gain' && n.connections.includes(sound.sfxBus)), '号角走 sfx 总线');
ok(`号角 ${fanSources} 个音源，走 sfx 总线`);

console.log('\n[9] 静音 / 切后台都停掉配乐调度');

assert.equal(sound.muted, false);
sound.startMusic();
assert.equal(sound.music.playing, true);

sound.toggleMute();
assert.equal(sound.music.playing, false, '静音后不该继续调度配乐');
assert.equal(sound._musicWanted, true, '静音不该忘掉"这局要音乐"');
sound.toggleMute();
assert.equal(sound.music.playing, true, '取消静音应恢复配乐');

sound.setHidden(true);
assert.equal(sound.music.playing, false, '后台不调度配乐');
assert.equal(sound.ctx.state, 'suspended', '后台应挂起音频时钟');
sound.startMusic();
assert.equal(sound.music.playing, false, '后台期间只记意图，不真起调度');

sound.setHidden(false);
assert.equal(sound.ctx.state, 'running', '回到前台应恢复音频时钟');
assert.equal(sound.music.playing, true, '回到前台应续上配乐');
ok('静音 / 后台停调度，恢复后自动续上');

sound.music?.stop();
sound.stopMusic(0.01);

console.log(`\n声音系统 ${pass} 项通过\n`);
