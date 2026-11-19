// 战场宝箱的 3D 表现（r43）。单机（Game.js）与联机（coop.js）共用。
//
// 视觉设计：能从远处一眼分清是"要去捡的东西"而不是掩体/敌人——
//   - 箱体按类别配色（火力红 / 装甲蓝 / 机动绿 / 维修金黄），半亮材质 + 自发光边；
//   - 顶上悬浮类别 emoji 图标（Sprite，始终面向相机）；
//   - 缓慢自转 + 上下浮动 + 底部光环，静置时也有存在感。
//
// 数量极少（每波 1~3 个），不值得进 InstancedMesh 合批：合批省的是
// "几十个同类对象"的开销，这里省出来的复杂度远大于 3 个 draw call。
import * as THREE from '../vendor/three.module.js';
import { CATEGORIES } from './core/crates.js';

const BOX_GEO = new THREE.BoxGeometry(1.6, 1.15, 1.6);
const LID_GEO = new THREE.BoxGeometry(1.72, 0.26, 1.72);
const RING_GEO = new THREE.RingGeometry(1.5, 2.0, 28);

/** 类别色板缓存：同类别共享材质，4 类最多 4 份 */
const MATS = new Map();

function catMats(cat) {
  let m = MATS.get(cat);
  if (m) return m;
  const def = CATEGORIES[cat] || CATEGORIES.support;
  m = {
    box: new THREE.MeshLambertMaterial({
      color: def.color,
      emissive: new THREE.Color(def.color).multiplyScalar(0.35),
    }),
    lid: new THREE.MeshLambertMaterial({ color: 0x2a3038 }),
    ring: new THREE.MeshBasicMaterial({
      color: def.color,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  };
  MATS.set(cat, m);
  return m;
}

/** 类别 emoji → 悬浮图标贴图（每类别缓存一张） */
const ICON_TEX = new Map();
function iconTexture(cat) {
  let tex = ICON_TEX.get(cat);
  if (tex) return tex;
  const def = CATEGORIES[cat] || CATEGORIES.support;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext('2d');
  g.font = '84px "PingFang SC", "Microsoft YaHei", "Segoe UI Emoji", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(def.icon, 64, 70);
  tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  ICON_TEX.set(cat, tex);
  return tex;
}

/**
 * 造一个宝箱。返回 { group, update(dt) }。
 * 调用方负责 add 到 scene、并在拾取/清场时把 group 从场景摘掉并 dispose。
 */
export function makeCrate(cat) {
  const m = catMats(cat);
  const group = new THREE.Group();

  const body = new THREE.Mesh(BOX_GEO, m.box);
  body.castShadow = true;
  const lid = new THREE.Mesh(LID_GEO, m.lid);
  lid.position.y = 0.7;
  const ring = new THREE.Mesh(RING_GEO, m.ring);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;

  const icon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: iconTexture(cat),
    transparent: true,
    depthWrite: false,
  }));
  icon.scale.set(1.7, 1.7, 1);
  icon.position.y = 3.0;
  icon.renderOrder = 6;

  group.add(body, lid, ring, icon);
  group.position.y = 0.75;   // 浮空基线，update 里上下摆动

  let t = Math.random() * Math.PI * 2;   // 各箱子相位错开，别像仪仗队
  return {
    group,
    update(dt) {
      t += dt;
      group.rotation.y += dt * 0.9;
      group.position.y = 0.75 + Math.sin(t * 2.2) * 0.18;
      icon.position.y = 3.0 + Math.sin(t * 2.2 + 0.6) * 0.12;
    },
    dispose() {
      // 几何/材质是共享缓存，不能销毁；只有图标 SpriteMaterial 是本箱独有
      icon.material.dispose();
    },
  };
}
