// 小地图：静态障碍烘焙到离屏画布，动态层（玩家/敌人/预警）每帧轻量重绘
// 北向上（-Z 朝上），不做旋转，便于快速判断方位

const TYPE_COLOR = {
  gunner: '#ff5b4a',
  charger: '#ff9a3c',
  elite: '#ffcf4d',
  drone: '#b06cff',
  turret: '#ffa03a',
  support: '#4fd985',
  shield: '#5aa8ff',
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
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    canvas.width = Math.round(size * this.dpr);
    canvas.height = Math.round(size * this.dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    this.ctx.scale(this.dpr, this.dpr);

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
   * @param {object} view
   * @param {{x:number,z:number,rot:number}} view.player
   * @param {Array} view.enemies  [{position:{x,z}, type, isBoss}]
   * @param {Array} view.strikes  [{x,z,radius}]
   * @param {Array} view.warnings [{x,z,type}]
   */
  update({ player, enemies = [], strikes = [], warnings = [] }) {
    const g = this.ctx;
    const s = this.size;

    g.clearRect(0, 0, s, s);
    g.drawImage(this.static, 0, 0, s, s);

    // 压制炮击预警圈
    for (const st of strikes) {
      const r = Math.max(2.5, (st.radius / (this.half * 2)) * s);
      g.beginPath();
      g.arc(this._px(st.x), this._px(st.z), r, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,84,52,0.22)';
      g.fill();
      g.strokeStyle = 'rgba(255,110,70,0.85)';
      g.lineWidth = 1;
      g.stroke();
    }

    // 刷怪落点预警
    for (const w of warnings) {
      const c = TYPE_COLOR[w.type] || '#ff5b4a';
      g.beginPath();
      g.arc(this._px(w.x), this._px(w.z), 2.6, 0, Math.PI * 2);
      g.strokeStyle = c;
      g.lineWidth = 1;
      g.stroke();
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
