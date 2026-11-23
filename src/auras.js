import * as THREE from '../vendor/three.module.js';
import { ENEMY_TYPES } from './core/world.js';

// 治疗光环：单机（Enemy.js）和联机（coop.js）共用这一个实现。
//
// 为什么单独抽出来：这个项目里"两端各写一份"已经出过三次事故
// （BOSS 血条配色、棱镜折射风暴、补给车治疗量）。光环的半径必须和
// 判定半径严格对应——只要一端画大了 1 米，玩家就会站在圈里不回血。
// 所以半径只从 ENEMY_TYPES.support.healAura 取，这里不再出现任何数字常量。

const R0 = ENEMY_TYPES.support.healAura;

// 几何按半径共享：所有补给车用同一个圈，进出波次不会反复分配显存。
const DISC_GEO = new THREE.CircleGeometry(R0 * 0.97, 48);
// 外环收在判定的 94%：圈还在，人就一定在范围内。
// 反过来（圈比判定大）会出现"站在圈里却不回血"，那种体验更糟。
const RING_GEO = new THREE.RingGeometry(R0 * 0.94, R0 * 0.985, 56);

export class HealAura {
  /**
   * @param {THREE.Object3D} parent 挂载对象（坦克的 group）
   * @param {number} scale 父节点缩放。半径与离地高度都要除掉它，
   *   否则 1.05 倍的车身会把 8 米圈画成 8.4 米。
   */
  constructor(parent, scale = 1) {
    const k = scale || 1;

    this.disc = new THREE.Mesh(DISC_GEO, new THREE.MeshBasicMaterial({
      color: 0x3fbf5f, transparent: true, opacity: 0.07,
      side: THREE.DoubleSide, depthWrite: false,
    }));
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.position.y = 0.05 / k;
    this.disc.renderOrder = 1;
    this.disc.scale.setScalar(1 / k);
    parent.add(this.disc);

    this.ring = new THREE.Mesh(RING_GEO, new THREE.MeshBasicMaterial({
      color: 0x63e08a, transparent: true, opacity: 0.32,
      side: THREE.DoubleSide, depthWrite: false,
    }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.07 / k;
    this.ring.renderOrder = 2;
    this.ring.scale.setScalar(1 / k);
    parent.add(this.ring);

    this.t = 0;          // 呼吸相位
    this.pulse = 0;      // 治到人时的额外亮度，随时间衰减
  }

  /** 治到人：整片亮一下，让玩家看清"血是这台车奶的" */
  hit(v = 0.55) {
    this.pulse = Math.max(this.pulse, v);
  }

  /**
   * 每帧推进。dt 用调用方传的模拟时间，不用 performance.now()——
   * 暂停时 dt 为 0，相位才不会在恢复那一刻跳一下。
   */
  update(dt) {
    this.t += dt;
    this.pulse = Math.max(0, this.pulse - dt * 1.7);
    const breathe = 0.32 + 0.06 * Math.sin(this.t * 2.1);
    this.ring.material.opacity = Math.min(0.95, breathe + this.pulse);
    this.disc.material.opacity = 0.07 + this.pulse * 0.25;
  }

  dispose() {
    this.disc.parent?.remove(this.disc);
    this.ring.parent?.remove(this.ring);
    this.disc.material.dispose();
    this.ring.material.dispose();
  }
}

// 几何是共享的，模块级只释放一次也无意义（进程结束自然回收）；
// 材质每个实例一份（要独立改 opacity），必须随实例 dispose。
