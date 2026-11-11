// 阵营配色：锁住"绿=我方 / 暖色=敌方"这条可读性约定
//
// 背景：组队模式里玩家、队友、敌人全都走了 Tank 的默认绿（0x5f7a3c），
// 战场上分不出谁是谁。修复分两半——色板集中到 teams.js，Tank 缺省按 team 取色。
// 这个测试就是防止哪天又有人"顺手"把某个敌人调成绿色，或者新增敌人类型忘了配色。

import { ENEMY_TYPES } from '../src/core/world.js';
import {
  SELF_SKIN, MATE_SKIN, ENEMY_LAMP, enemySkin, tankSkin, ENEMY_SKIN_TYPES,
} from '../src/teams.js';

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const rgb = (v) => [(v >> 16) & 255, (v >> 8) & 255, v & 255];
const hex = (v) => '#' + v.toString(16).padStart(6, '0');
/**
 * 是否"一眼绿"：绿通道同时显著高于红与蓝。
 * 阈值取 12：低于这个差值的（比如灰褐 0x7d6a5e）读起来是灰，不会被当成友军。
 */
const greenish = (v) => {
  const [r, g, b] = rgb(v);
  return g > r + 12 && g > b + 12;
};

console.log('\n[阵营配色]');

// ---- 1. 我方必须是绿的 ----
ok('自己车体是军绿', greenish(SELF_SKIN.body), hex(SELF_SKIN.body));
ok('队友车体是军绿', greenish(MATE_SKIN.body), hex(MATE_SKIN.body));
ok('自己与队友的车体色不同（能分出哪辆是我的）', SELF_SKIN.body !== MATE_SKIN.body,
  `${hex(SELF_SKIN.body)} vs ${hex(MATE_SKIN.body)}`);

// ---- 2. 敌方不能有绿车 ----
const types = Object.keys(ENEMY_TYPES);
ok('色板覆盖全部敌人类型', types.every((t) => ENEMY_SKIN_TYPES.includes(t)),
  types.filter((t) => !ENEMY_SKIN_TYPES.includes(t)).join(',') || '无遗漏');

for (const t of types) {
  const s = enemySkin(t);
  ok(`敌人 ${t} 不是绿色`, !greenish(s.body), hex(s.body));
}

// 已知的撞色历史：补给车曾是 0x4f8f5f、炮台曾是 0x77806b
ok('补给车不再用旧的绿色 0x4f8f5f', enemySkin('support').body !== 0x4f8f5f);
ok('炮台不再用旧的灰绿 0x77806b', enemySkin('turret').body !== 0x77806b);

// ---- 3. 敌方整体偏暖（棱镜是唯一的冷色 BOSS，单独放行） ----
for (const t of types) {
  if (t === 'boss_prism') continue;
  const [r, , b] = rgb(enemySkin(t).body);
  ok(`敌人 ${t} 偏暖（红 ≥ 蓝）`, r >= b, `${hex(enemySkin(t).body)} r=${r} b=${b}`);
}

// ---- 4. 缺省取色：漏传 body 也必须拿到阵营色，而不是"默认绿" ----
const asPlayer = tankSkin({ team: 'player' });
ok('player 缺省 = 自己的配色', asPlayer.body === SELF_SKIN.body && asPlayer.lamp === SELF_SKIN.lamp);

const asGunner = tankSkin({ team: 'enemy' });
ok('enemy 缺省 = 普通炮手（红棕，不是绿）', asGunner.body === enemySkin('gunner').body,
  hex(asGunner.body));
ok('enemy 缺省的灯是红的', asGunner.lamp === ENEMY_LAMP);

const asDrone = tankSkin({ team: 'enemy', type: 'drone' });
ok('enemy 带 type 时按类型取色', asDrone.body === enemySkin('drone').body);

const unknown = tankSkin({ team: 'enemy', type: 'nope' });
ok('未知敌型退回普通炮手（仍是暖色，不会变绿）',
  unknown.body === enemySkin('gunner').body && !greenish(unknown.body));

const explicit = tankSkin({ team: 'enemy', body: 0x123456 });
ok('显式传入的 body 优先', explicit.body === 0x123456);

// ---- 5. 识别灯三色互不相同 ----
ok('自己 / 队友 / 敌人的灯色互不相同',
  new Set([SELF_SKIN.lamp, MATE_SKIN.lamp, ENEMY_LAMP]).size === 3,
  `${hex(SELF_SKIN.lamp)} / ${hex(MATE_SKIN.lamp)} / ${hex(ENEMY_LAMP)}`);

console.log(`\n阵营配色：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
