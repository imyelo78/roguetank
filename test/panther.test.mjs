// 车体合并回归测试：豹式必须**真的**是豹式
//
// 线上事故：数据层把四款车合并成 panther 了，但 Tank.js 的 BUILDERS 表
// 只认 balanced/light/heavy/hunter，'panther' 查不到就静默落到 buildStandard
// （敌人用的极简模型）。结果 CHASSIS 里写着"豹式"，玩家开出去的却是一辆
// 没侧裙、没炮盾、没车长塔的简模——从玩家视角看就是"让你改一款车你没改"。
//
// 这个测试钉死三件事：
//   1. 玩家车（任何 chassis id，含历史 id）都走豹式模型
//   2. 敌人车（不传 chassis）仍走低模，不能cost 暴涨
//   3. 模型函数本身没被删错（豹式零件数远多于低模）

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeChassisId, CHASSIS, CHASSIS_LIST } from '../src/chassis.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };

console.log('\n[1] 只有一款车，且名字是豹式');

assert.equal(CHASSIS_LIST.length, 1, `车体卡数量应为 1，实际 ${CHASSIS_LIST.length}`);
assert.equal(CHASSIS_LIST[0].id, 'panther');
assert.equal(CHASSIS_LIST[0].name, '豹式');
ok('车体表里只有一款「豹式」');

console.log('\n[2] 历史 id 全部归一化');

for (const legacy of ['balanced', 'light', 'heavy', 'hunter', 'commander', 'nope', '', null, undefined]) {
  assert.equal(normalizeChassisId(legacy), 'panther', `${String(legacy)} 应归一化为 panther`);
}
ok('10 种历史/非法 id 全部落到豹式，不会出现"未知车体"');

console.log('\n[3] Tank.js 的模型表必须认 panther');

const tank = src('src/Tank.js');

// BUILDERS 表里必须有 panther 键
assert.ok(/const BUILDERS = \{[^}]*panther:\s*buildBalanced/s.test(tank),
  'BUILDERS 里必须有 panther → buildBalanced，否则会静默落到敌人低模');
ok('BUILDERS 里 panther 指向豹式构建函数');

// 必须用 normalizeChassisId 解析玩家车体
assert.ok(/opts\.chassis \? normalizeChassisId\(opts\.chassis\) : 'standard'/.test(tank),
  '玩家车体必须经 normalizeChassisId 归一化，敌人（不传 chassis）才走 standard');
ok('玩家车走归一化、敌人车走低模，两条路径分开');

// 兜底不能是 buildStandard
assert.ok(/BUILDERS\[chassisId\] \|\| BUILDERS\.panther/.test(tank),
  '兜底必须是豹式，不能是 buildStandard（那正是这次事故的原因）');
ok('查不到车体时兜底为豹式，不会静默降级成简模');

console.log('\n[4] 三款已删的旧车模型不能残留');

for (const dead of ['buildLight', 'buildHeavy', 'buildHunter']) {
  assert.ok(!new RegExp(`function ${dead}\\b`).test(tank), `${dead} 应该已删除`);
}
ok('轻装/重装/猎手三个模型函数已移除，不会有人再画出第二种车');

console.log('\n[5] 豹式模型比敌人低模"更像一辆车"');

// 数一下两个函数体里 add(...) 的调用次数：豹式有侧裙/炮盾/车长塔/负重轮/炮管/抽气装置，
// 低模只有车体+炮塔+炮管。零件数明显更少就是"降级"，这里用下界卡住。
const bodyOf = (fnName, nextMarker) => {
  const i = tank.indexOf(`function ${fnName}(`);
  assert.ok(i > 0, `找不到 ${fnName}`);
  const j = tank.indexOf(nextMarker, i);
  return tank.slice(i, j > 0 ? j : undefined);
};

const pantherBody = bodyOf('buildBalanced', '// ======================================================================\n// 通用（敌方）车体');
const enemyBody = bodyOf('buildStandard', 'const BUILDERS');

const countAdd = (s) => (s.match(/\badd\(/g) || []).length;
const nPanther = countAdd(pantherBody);
const nEnemy = countAdd(enemyBody);

assert.ok(nPanther >= 10, `豹式零件数应 >= 10 个 add()，实际 ${nPanther}`);
// r53 删掉了烟幕弹发射器和独立的识别灯（灯改由构造函数长在舱盖上），
// 豹式从 14 个调用点降到 13。用"比例 1.5 倍"卡就会变成 13 > 13.5 的假失败——
// 这个测试要防的是"整辆车被换成低模"，不是"少了一个小零件"，改成差值更贴合意图。
assert.ok(nPanther >= nEnemy + 4, `豹式(${nPanther}) 应至少比低模(${nEnemy})多 4 个零件，否则说明模型被换掉了`);
ok(`豹式 ${nPanther} 个零件 vs 敌人低模 ${nEnemy} 个，确实是精细模型`);

console.log('\n[6] 服务端不能再用四款车白名单');

const server = src('server.mjs');
assert.ok(!/\['balanced', 'light', 'heavy', 'hunter'\]\.includes/.test(server),
  'server.mjs 还在用四款车白名单，会把 panther 静默降级');
assert.ok(/normalizeChassisId\(msg\.chassis\)/.test(server), 'server.mjs 应改用 normalizeChassisId');
ok('服务端用 normalizeChassisId 而不是白名单，panther 不会被降级');

console.log('\n[7] 徽章样式要有豹式');

const css = src('styles.css');
assert.ok(/\.chd\.c-panther/.test(css), 'styles.css 缺少 .chd.c-panther，徽章会没有底色');
ok('豹式徽章有配色，不会显示成空块');

console.log('\n[8] r53 造型约定（防回退）');

// 烟幕弹发射器：3 根 CYLZ(0.055, 0.055, 0.24, 6) 的后倾小管
assert.ok(!/CYLZ\(0\.055/.test(tank), '烟幕弹发射器（CYLZ 0.055 ×3）应已删除');
ok('炮塔右后侧不再有烟幕弹发射器');

// 炮盾要和炮塔顶盖同色（accent），不是深色
assert.ok(/BOX\(0\.56, 0\.44, 0\.16\), mats\.accent/.test(tank),
  '炮盾应为 accent（与 6 号顶盖同色），改回 dark 就不是需求要的观感了');
ok('炮盾与顶盖同色（accent）');

// 识别灯＝车长塔舱盖：不再有独立的灯杆 + 灯头
assert.ok(/CYLY\(0\.21, 0\.23, 0\.07, 10\), basicMat\(skin\.lamp\)/.test(tank),
  '识别灯必须长在车长塔舱盖上（CYLY 0.21/0.23/0.07 + basicMat(skin.lamp)）');
assert.ok(!/CYLY\(0\.05, 0\.05, 0\.46, 6\)/.test(tank), '独立的灯杆应已删除');
assert.ok(!/CYLY\(0\.19, 0\.19, 0\.09, 8\)/.test(tank), '独立的灯头圆盘应已删除');
ok('识别灯并进车长塔舱盖，独立的灯杆/灯头已删');

// 舱盖挂点必须由 builder 交出来：按 detail 猜会把队友（豹式+low）的舱盖埋进塔里
assert.ok(/parts\.lampSeat/.test(tank), '舱盖挂点要读 builder 返回的 lampSeat');
assert.equal((tank.match(/lampSeat:/g) || []).length, 2,
  'buildBalanced 与 buildStandard 都要返回 lampSeat（两套模型的塔高不同）');
ok('舱盖挂点来自构建函数，不会因细节档位错位');

console.log('\n[9] r54 敌人也不许有斜首上装甲');

// 玩家车 r50 就把那块 0.5 rad 的倾斜板删了，敌人低模却留着一个：
// 同一场里"我的车是方箱、对面车头顶多一截斜块"。玩家明确要求全部删掉。
// 判定按"绕 X 转 ~0.5 的 accent 板"找：敌人车体里不该再有任何 rx 非零的板。
const enemySlope = /add\(group, BOX\([^)]*\), mats\.accent, 0, s\.hy \+ 0\.28, s\.hl \* 0\.32, 0\.5/;
assert.ok(!enemySlope.test(tank), '敌人低模的斜首上装甲（rx 0.5 的 accent 板）应已删除');
assert.ok(!/s\.hl \* 0\.32, 0\.5/.test(tank), '敌人车头不应再留任何绕 X 倾斜的首上盖板');
ok('敌人低模车头没有斜首上装甲，与玩家车一致');

console.log(`\n豹式合并回归测试全部通过（${pass} 项）`);
