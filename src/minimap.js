// 小地图：静态障碍烘焙到离屏画布，动态层（玩家/敌人/预警）每帧轻量重绘
// 北向上（-Z 朝上），不做旋转，便于快速判断方位

const TYPE_COLOR = {
  gunner: '#ff5b4a',
  charger: '#ff9a3c',
  elite: '#ffcf4d',
  drone: '#ff5fa0',
  turret: '#ffa03a',
  // 补给车以前是绿的，和"我方=绿"撞色；改沙黄，和车体上的补给车配色对齐
  support: '#d8b04a',
  shield: '#ff6a5a',
};

/**
 * 地形在小地图上的颜色。
 *
 * 故意压暗、压灰：小地图是"看敌人在哪"的，不是"看风景"的。
 * 地形只要能让玩家认出"左上角那片是沼泽、绕开走"就够了，
 * 调得太鲜艳，红点敌人就沉进背景里了。
 * 草地不画（占一半面积，画了全是噪声，而且它本来就是基准速度）。
 */
const TERRAIN_COLOR = {
  // 公路：比底色亮一档的冷灰，一眼能认出"这条能跑"
  1: 'rgba(132,146,164,0.40)',
  // 沙漠：土黄，色相和所有其它元素都不同，最好认
  2: 'rgba(178,152,102,0.44)',
  // 雪地：偏冷的高亮度白。一开始和障碍物用的是同一档灰蓝，
  // 截图上完全分不清（障碍物也是灰的），所以往"更亮、更蓝"拉一档，
  // 让"大块雪原"和"小碎楼"在亮度上就分开。
  3: 'rgba(214,232,246,0.56)',
  // 沼泽：深绿。压得太暗（alpha 0.6 的墨绿）在深底上根本看不见，
  // 提亮到 0.8 才够认，又不能抢红点的注意力。
  4: 'rgba(68,94,56,0.80)',
};

const TYPE_SIZE = {
  elite: 3.6,
  drone: 2.2,
  turret: 2.6,
  support: 2.6,
  shield: 2.8,
};

export class Minimap {
  constructor(canvas, world, { size = 168 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.half = world.half;
    this.size = size;
    // Node（单元测试）里没有 window：退化成 1，别让一个取 DPR 的动作把模块顶崩。
    this.dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);

    canvas.width = Math.round(size * this.dpr);
    canvas.height = Math.round(size * this.dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    this.ctx.scale(this.dpr, this.dpr);
    this.pulses = [];   // 开火脉冲（见 pulse()）

    this._bake();
  }

  _px(v) {
    return ((v + this.half) / (this.half * 2)) * this.size;
  }

  _bake() {
    const s = this.size;
    const off = document.createElement('canvas');
    off.width = Math.round(s * this.dpr);
    off.height = Math.round(s * this.dpr);
    const g = off.getContext('2d');
    g.scale(this.dpr, this.dpr);

    // 底色（略透，能看到背后战场）
    g.fillStyle = 'rgba(13,19,25,0.82)';
    g.fillRect(0, 0, s, s);

    // 地表类型：铺在网格下面，让玩家一眼看出哪条路能跑、哪块地陷车
    const tm = this.world.terrain;
    if (tm) {
      for (let iz = 0; iz < tm.n; iz++) {
        for (let ix = 0; ix < tm.n; ix++) {
          const c = TERRAIN_COLOR[tm.cells[iz * tm.n + ix]];
          if (!c) continue;
          const wx = tm.x0 + ix * tm.tile;
          const wz = tm.x0 + iz * tm.tile;
          const x0 = this._px(wx);
          const z0 = this._px(wz);
          const x1 = this._px(wx + tm.tile);
          const z1 = this._px(wz + tm.tile);
          g.fillStyle = c;
          g.fillRect(x0, z0, Math.max(1, x1 - x0) + 0.5, Math.max(1, z1 - z0) + 0.5);
        }
      }
    }

    // 10×10 网格
    g.strokeStyle = 'rgba(120,156,178,0.10)';
    g.lineWidth = 1;
    const step = s / 10;
    for (let i = 1; i < 10; i++) {
      const p = Math.round(i * step) + 0.5;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(s, p); g.stroke();
    }

    // 障碍物
    for (const o of this.world.obstacles) {
      const b = o.box;
      const x = this._px(b.min.x);
      const z = this._px(b.min.z);
      const w = this._px(b.max.x) - x;
      const h = this._px(b.max.z) - z;
      g.fillStyle = 'rgba(158,176,192,0.5)';
      g.fillRect(x, z, Math.max(1.4, w), Math.max(1.4, h));
      g.strokeStyle = 'rgba(196,212,226,0.30)';
      g.lineWidth = 0.6;
      g.strokeRect(x + 0.3, z + 0.3, Math.max(1.4, w) - 0.6, Math.max(1.4, h) - 0.6);
    }

    // 战场边框
    g.strokeStyle = 'rgba(214,166,74,0.55)';
    g.lineWidth = 1.4;
    g.strokeRect(0.7, 0.7, s - 1.4, s - 1.4);

    this.static = off;
  }

  /**
   * 地表场变了（联机时 WELCOME 才拿到种子）→ 重新烘焙静态层。
   *
   * 注意 map 只是"触发信号"，真正读的是 this.world.terrain：
   * level.js 里 terrain 是只读 getter，从外面赋值会直接抛 TypeError
   * （ES module 默认严格模式）。谁改了地表，谁负责先 setTerrain 到 world 上。
   */
  setTerrain() {
    this._bake();
  }

  /**
   * 建筑换了一套（换种子 / 联机收服务端布局）→ 重烘焙底图。
   *
   * 地表与建筑是两张独立的底图层，但烘焙是一次性合成的，所以只能整张重来。
   * 168px 的画布重绘一次不到 1ms，只在开局调一次，不值得拆成两层。
   */
  invalidate() {
    this._bake();
  }

  /**
   * 开火脉冲：把小地图上对应目标画成亮圈，持续 `dur` 秒后自动消失。
   *
   * 为什么要有：联机里敌人的炮弹没有炮口火光也没有音效（服务端事件只发
   * "谁开了炮"，坐标是开火瞬间的），玩家挨打时完全不知道弹从哪来。
   * 小地图上闪一下红圈，是成本最低的"我被人瞄着"提示。
   *
   * @param {Array<{x:number,z:number,color?:string,dur?:number}>} list
   */
  pulse(list) {
    if (!Array.isArray(list) || !list.length) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (const p of list) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      this.pulses.push({ x: p.x, z: p.z, color: p.color || '#ff6a4a', t: now, dur: p.dur || 420 });
    }
    // 上限保护：一帧里被打进来几百个也不至于把数组撑爆
    if (this.pulses.length > 24) this.pulses.splice(0, this.pulses.length - 24);
  }

  /**
   * @param {object} view
   * @param {{x:number,z:number,rot:number}} view.player
   * @param {Array} view.enemies  [{position:{x,z}, type, isBoss}]
   * @param {Array} view.warnings [{x,z,type}]
   * @param {Array} view.mates    [{x,z}]（组队：队友位置，可选）
   * @param {Array} view.bullets  [{x,z,team}]（可选，只画朝我方飞的）
   */
  update({ player, enemies = [], warnings = [], mates = [], bullets = [] }) {
    const g = this.ctx;
    const s = this.size;

    g.clearRect(0, 0, s, s);
    g.drawImage(this.static, 0, 0, s, s);

    // 刷怪落点预警
    for (const w of warnings) {
      const c = TYPE_COLOR[w.type] || '#ff5b4a';
      g.beginPath();
      g.arc(this._px(w.x), this._px(w.z), 2.6, 0, Math.PI * 2);
      g.strokeStyle = c;
      g.lineWidth = 1;
      g.stroke();
    }

    // 队友（青蓝小三角，和自己的绿三角区分开）
    for (const m of mates) {
      if (!m || !Number.isFinite(m.x)) continue;
      const x = this._px(m.x);
      const z = this._px(m.z);
      g.beginPath();
      g.arc(x, z, 3.2, 0, Math.PI * 2);
      g.fillStyle = '#5fd8ff';
      g.fill();
      g.strokeStyle = 'rgba(8,12,16,0.85)';
      g.lineWidth = 0.8;
      g.stroke();
    }

    // 飞向我方的炮弹：小亮点，只在近处画，避免糊成一片
    for (const b of bullets) {
      if (!b || b.team === 'player' || !player) continue;
      const d = Math.hypot(b.x - player.x, b.z - player.z);
      if (d > 34) continue;
      g.beginPath();
      g.arc(this._px(b.x), this._px(b.z), 1.5, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,150,90,0.9)';
      g.fill();
    }

    // 敌人
    for (const e of enemies) {
      const p = e.position;
      if (!p) continue;
      const boss = e.isBoss || (e.type && e.type.startsWith('boss_'));
      const color = boss ? (e.type === 'boss_prism' ? '#38d8ff' : '#ff2a1a') : (TYPE_COLOR[e.type] || '#ff5b4a');
      const r = boss ? 5 : (TYPE_SIZE[e.type] || 2.4);
      const x = this._px(p.x);
      const z = this._px(p.z);

      if (boss || e.isElite) {
        g.beginPath();
        g.arc(x, z, r + 2.2, 0, Math.PI * 2);
        g.fillStyle = boss ? 'rgba(255,42,26,0.18)' : 'rgba(255,207,77,0.16)';
        g.fill();
      }
      g.beginPath();
      g.arc(x, z, r, 0, Math.PI * 2);
      g.fillStyle = color;
      g.fill();
      g.strokeStyle = 'rgba(8,12,16,0.85)';
      g.lineWidth = 0.8;
      g.stroke();
    }

    // 开火脉冲（画在敌人之上，保证看得见）
    if (this.pulses.length) {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      for (let i = this.pulses.length - 1; i >= 0; i--) {
        const pl = this.pulses[i];
        const k = (now - pl.t) / pl.dur;
        if (k >= 1) { this.pulses.splice(i, 1); continue; }
        const x = this._px(pl.x);
        const z = this._px(pl.z);
        g.beginPath();
        g.arc(x, z, 4 + 9 * k, 0, Math.PI * 2);
        g.strokeStyle = pl.color;
        g.globalAlpha = 0.9 * (1 - k);
        g.lineWidth = 1.6;
        g.stroke();
        g.globalAlpha = 1;
      }
    }

    // 玩家（三角指向车头）
    if (player) {
      const x = this._px(player.x);
      const z = this._px(player.z);
      const rot = player.rot ?? 0;
      // 车头方向：Three.js 默认朝 -Z，绕 Y 轴旋转 rot
      const dx = -Math.sin(rot);
      const dz = -Math.cos(rot);
      const L = 6.2;
      const W = 4.2;

      g.beginPath();
      g.moveTo(x + dx * L, z + dz * L);
      g.lineTo(x - dx * L * 0.55 - dz * W, z - dz * L * 0.55 + dx * W);
      g.lineTo(x - dx * L * 0.55 + dz * W, z - dz * L * 0.55 - dx * W);
      g.closePath();
      g.fillStyle = '#9ee06a';
      g.fill();
      g.strokeStyle = 'rgba(6,10,8,0.9)';
      g.lineWidth = 1;
      g.stroke();

      // 外圈呼吸光
      g.beginPath();
      g.arc(x, z, 7.5, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(158,224,106,0.35)';
      g.lineWidth = 1;
      g.stroke();
    }
  }
}
