/**
 * 暂停 / 退出回归测试
 *
 * 需求：战斗中能暂停、能直接退回主菜单；单人为主，组队（r48 起）走同一套
 * 「先暂停、后退出」的路径，只是组队的暂停是"暂离战场"（见 coopaway.test.mjs）。
 *
 * 这里锁的是几件一旦被改坏就会"看起来还能跑、其实已经错了"的事：
 *   1. 单机暂停必须是"冻结"，不是"减速"：Game.update 要在最前面 return，
 *      否则波次计时器继续走，暂停十分钟回来直接跳三波
 *   2. 暂停期间不能收战斗输入（WASD / 空格 攒着，恢复那一刻坦克自己动）
 *   3. 退出本局不上传成绩 —— 中途撂下的局不该进排行榜
 *   4. 暂停按钮宽度必须显式收窄：全局 button 是 width:100%，
 *      不收就会横贯整行（r35 的「战况」胶囊踩过一次，整条顶栏变黑带）
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const game = read('src/Game.js');
const hud = read('src/HUD.js');
const coop = read('src/coop.js');

let pass = 0;
const ok = (msg) => { pass++; console.log(`  ✓ ${msg}`); };

const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
const decl = (selector) => {
  const i = clean.lastIndexOf(selector);
  if (i < 0) return '';
  const open = clean.indexOf('{', i);
  const close = clean.indexOf('}', open);
  if (open < 0 || close < 0) return '';
  return clean.slice(open + 1, close).replace(/\s+/g, ' ');
};
/** 取一个方法体（从 `name(` 到下一个同缩进的 `}`）——够用就好，不引 JS 解析器 */
const methodBody = (src, name) => {
  const i = src.indexOf(`\n  ${name}(`);
  if (i < 0) return '';
  const end = src.indexOf('\n  }\n', i);
  return end < 0 ? src.slice(i) : src.slice(i, end + 4);
};

// ---------------------------------------------------------------- [1] DOM 契约
{
  assert.ok(html.includes('id="hud-pause"'), 'index.html 里没有暂停按钮 #hud-pause');
  assert.ok(/id="hud-pause" class="[^"]*no-touch/.test(html),
    '暂停按钮必须带 no-touch：否则 touch.js 会把这一下当成推坦克 / 开火');
  const hudOpen = html.indexOf('<div id="hud"');
  const hudClose = html.indexOf('<!-- ================= 开始界面');
  assert.ok(hudOpen > 0 && hudClose > hudOpen, '找不到 #hud 区块边界');
  assert.ok(html.slice(hudOpen, hudClose).includes('id="hud-pause"'),
    '暂停按钮要在 #hud 内部，退出战斗时随 HUD 一起消失');
  ok('按钮在 #hud 内、带 no-touch');

  assert.ok(html.includes('id="pause"'), '缺少暂停面板 #pause');
  for (const id of ['pause-resume', 'pause-quit', 'pause-kicker', 'pause-title', 'pause-tip']) {
    assert.ok(html.includes(`id="${id}"`), `暂停面板缺少 #${id}`);
  }
  // 面板初始必须藏着，否则一进游戏就盖在脸上
  assert.ok(/<div id="pause" class="overlay hidden"/.test(html), '#pause 初始必须是 hidden');
  ok('暂停面板含「继续 / 退出」两个出口，初始隐藏');
}

// ---------------------------------------------------------------- [2] 按钮样式
{
  const base = decl('\n.hud-pause {');
  assert.ok(base, 'styles.css 里没有 .hud-pause 基础规则');
  assert.match(base, /width: auto/, '按钮必须显式 width:auto —— 全局 button 是 width:100%');
  assert.match(base, /display: none/, '基础态要 display:none，只有战斗中才挂出来');
  assert.match(base, /pointer-events: auto/, '#hud 整体 pointer-events:none，按钮要自己收回点击');
  assert.ok(/body:has\(#app\.playing\) \.hud-pause \{ display: inline-flex; \}/.test(clean),
    '缺少「战斗中才显示暂停按钮」的规则');
  ok('按钮窄态、默认隐藏、战斗中才出现');
}

// ---------------------------------------------------------------- [3] 冻结而非减速
{
  const body = methodBody(game, 'update');
  assert.ok(body, '找不到 Game.update');
  const head = body.slice(0, 260);
  assert.match(head, /if \(this\.paused\)/, 'update 开头要判 paused');
  const ret = head.indexOf('return');
  const hudTick = head.indexOf('this.hud.update(');
  assert.ok(ret > 0 && (hudTick < 0 || ret < hudTick),
    'paused 的 return 必须早于 hud.update / 世界推进，否则计时器还在走');
  ok('暂停时 update 直接返回，只重画不动世界');

  const pauseBody = methodBody(game, 'pause');
  // 组队不能再被"挡"在门外（r48）：现在先转交 CoopMode.pause —— 那一套是
  // "暂离战场"，世界照跑、但你已经不在里面挨打了（见 coopaway.test.mjs）。
  assert.match(pauseBody, /this\.mode === 'coop'/, 'pause 要先把组队转交出去');
  assert.match(pauseBody, /this\.coop\?\.pause\(\)/, '组队暂停走 CoopMode.pause');
  assert.match(pauseBody, /this\.state !== 'playing'/, '单机 pause 只该在战斗中生效');
  assert.match(pauseBody, /this\.keys\.clear\(\)/, '暂停时要清掉按住的键');
  assert.match(pauseBody, /this\.touch\.refresh\(\)/, '暂停时要收起触屏摇杆');
  assert.match(pauseBody, /hud\.showPause\(/, 'pause 要通知 HUD 弹面板');
  ok('pause 按模式分派，单机有战斗守卫，并清输入、收摇杆');
}

// ---------------------------------------------------------------- [4] 输入与 Esc
{
  assert.match(game, /if \(e\.key === 'Escape' && \(this\.mode === 'solo' \|\| this\.mode === 'coop'\)\)/,
    '缺少「单机 / 组队 Esc 都是暂停」的分支');
  // Esc 分支必须在打字判断之后：呼号框里按 Esc 不该把仗停下来
  const typingAt = game.indexOf('if (isTyping(e) || e.isComposing)');
  const escAt = game.indexOf("if (e.key === 'Escape' && (this.mode === 'solo' || this.mode === 'coop'))");
  assert.ok(typingAt > 0 && escAt > typingAt, 'Esc 暂停分支要放在打字判断之后');
  assert.match(game, /if \(this\.paused\) return;/, '暂停期间要在按键处理里直接返回');
  assert.match(game, /state === 'playing' && !this\.paused/, '鼠标按下开火要判 paused');
  assert.match(game, /enabled: \(\) => this\.state === 'playing' && !this\.paused/,
    '触屏摇杆的 enabled 要判 paused');
  ok('Esc 可暂停/继续；暂停期间键盘、鼠标、摇杆都不响应');
}

// ---------------------------------------------------------------- [5] 退出到主菜单
{
  const quit = methodBody(game, 'quitToMenu');
  assert.ok(quit, '找不到 Game.quitToMenu');
  assert.ok(!/_submitRun/.test(quit), '退出本局不该上传成绩（中途撂下的局不进榜）');
  assert.match(quit, /this\.state = 'menu'/, 'quittoMenu 要把状态切回 menu');
  assert.match(quit, /_clearField\(\)/, '退出时要清场，否则菜单背景停着上一局的战场');
  assert.match(quit, /hud\.overlay\?\.classList\.remove\('hidden'\)/, '退出后要显示开局面板');
  assert.match(quit, /sound\.stopMusic/, '退出时要停配乐');
  assert.match(quit, /this\.mode !== 'solo'/, '组队退出要走 leaveCoop，不能在这里重写');
  ok('quitToMenu：回菜单、清场、停音乐、不上榜');

  // HUD 侧：继续要把 #app.playing 补回来（showPause 摘掉了它）
  const resume = methodBody(game, 'resume');
  assert.match(resume, /hidePause\(\)/, 'resume 要收起暂停面板');
  assert.match(resume, /classList\.add\('playing'\)/, 'resume 要把 playing 补回来，否则光标常显');
  ok('resume 收起面板并恢复 playing');
}

// ---------------------------------------------------------------- [6] 组队也是先暂停
{
  // 以前是"Esc 直接退组队"，太危险：世界还在跑，手一抖整局进度就没了（还不进榜）。
  // 现在和单人一致：Esc 暂停，退出只能点面板里的按钮。
  assert.ok(!/else this\.leaveCoop\(\)/.test(game),
    'Game 里不能再留"按 Esc 直接退出组队"的路径');
  assert.match(coop, /setPausable\(true\)/, '联机开局要给暂停按钮留位置');
  const gate = methodBody(hud, 'setPausable');
  assert.match(gate, /classList\.toggle\('hidden'/, 'setPausable 通过 hidden 类控制显隐');
  assert.match(gate, /hidePause\(\)/, '关掉可暂停时要把已经弹出的面板收起来');
  ok('组队 Esc 不再直接退房，暂停按钮可用');
}

// ---------------------------------------------------------------- [7] 面板数据
{
  const show = methodBody(hud, 'showPause');
  for (const k of ['pauseWave', 'pauseKills', 'pauseScore', 'pauseTime']) {
    assert.ok(show.includes(k), `showPause 没有填 ${k}`);
  }
  assert.match(show, /classList\.add\('paused'\)/, '暂停时应挂上 paused 类（光标要可见）');
  // 组队复用同一块面板，但文案必须换：否则玩家会以为"整局都停了"
  assert.match(show, /coop = false/, 'showPause 要接受 coop 标记');
  assert.match(show, /已暂离战场/, '组队暂停的标题要说清楚是暂离，不是整局暂停');
  assert.match(show, /返回战场/, '组队按钮是"返回战场"，不是"继续战斗"');
  assert.match(show, /离开房间/, '组队的退出是离开房间');
  const hide = methodBody(hud, 'hidePause');
  assert.match(hide, /classList\.remove\('paused'\)/, 'hidePause 要摘掉 paused');
  ok('面板展示波次 / 击杀 / 得分 / 存活，单人组队各一套文案');
}

console.log(`\n暂停 / 退出：${pass} 项通过`);
