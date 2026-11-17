/**
 * 手机端极简 HUD 回归测试
 *
 * 背景：844×390 的横屏手机去掉地址栏只剩 300 出头的高度，而 r34 的顶栏
 * （装甲条 + 波次大块 + 击杀得分）、中央 32px 大字、底部武器条、右下小地图
 * 加起来把上半屏吃掉了 —— 敌人从上压过来时正好被面板挡住。
 *
 * 做法是分两层：常显五样（装甲 / 波次微标 / 换弹 / 小地图 / BOSS 血条），
 * 其余（击杀得分、地形、挑战词条、强化图标、武器名、房间码）默认收出边界，
 * 点右上「战况」展开 5 秒。
 *
 * 这里不测"好不好看"，只锁四件容易在后续改动里被悄悄破坏的事：
 *   1. 胶囊只在触屏 + 战斗中出现，桌面端 HUD 不能变
 *   2. 收起用 opacity / transform / max-height，不能用 display:none（否则没过渡）
 *   3. #chips 收起时必须一起归零 min-height —— CSS 里 min-height 优先级高于
 *      max-height，只写 max-height:0 是折不掉的（.chips 自带 min-height:26px）
 *   4. 展开态要把它们恢复到可见，否则点开还是空的
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const css = readFileSync(path.join(root, 'styles.css'), 'utf8');
const hud = readFileSync(path.join(root, 'src', 'HUD.js'), 'utf8');

let pass = 0;
const ok = (msg) => { pass++; console.log(`  ✓ ${msg}`); };

/**
 * 取某条选择器（同名取最后一次，后写的生效）声明块里的内容。
 * 先剥掉注释：本文件相关的 CSS 注释里写了 `button { width: 100% }` 这类示例，
 * 不剥的话按第一个 } 切会切在注释里。
 */
const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
const decl = (src, selector) => {
  const i = src.lastIndexOf(selector);
  if (i < 0) return '';
  const open = src.indexOf('{', i);
  const close = src.indexOf('}', open);
  if (open < 0 || close < 0) return '';
  return src.slice(open + 1, close).replace(/\s+/g, ' ');
};
const cssClean = clean;
const has = (src, selector) => src.includes(selector);

// ---------------------------------------------------------------- [1] DOM
{
  assert.ok(has(html, 'id="hud-peek"'), 'index.html 里没有「战况」胶囊 #hud-peek');
  assert.ok(/id="hud-peek"[^>]*class="[^"]*no-touch/.test(html)
    || /class="hud-peek no-touch[^"]*"[^>]*id="hud-peek"/.test(html),
  '胶囊必须带 no-touch：touch.js 的 pointerdown 会跳过它，否则点它会顺手推坦克 / 触发开火');
  assert.ok(/id="hud-peek"[^>]*aria-expanded="false"/.test(html), '胶囊初始 aria-expanded 应为 false');
  ok('胶囊在 DOM 里、带 no-touch、初始 aria-expanded=false');

  // 胶囊必须在 #hud 内部（HUD 隐藏时它也不该露出来）
  const hudOpen = html.indexOf('<div id="hud"');
  const hudClose = html.indexOf('<!-- ================= 开始界面');
  assert.ok(hudOpen > 0 && hudClose > hudOpen, '找不到 #hud 区块边界');
  const inside = html.slice(hudOpen, hudClose);
  assert.ok(inside.includes('id="hud-peek"'), '胶囊应在 #hud 内部');
  ok('胶囊位于 #hud 内，菜单/结算时随 HUD 一起隐藏');
}

// ---------------------------------------------------------------- [2] 只在触屏战斗时出现
{
  // 注意前面要带换行：`body.is-touch ... .hud-peek {` 里也含 ".hud-peek {"
  const base = decl(cssClean, '\n.hud-peek {');
  assert.match(base, /display: none/, '胶囊基础态必须 display:none，桌面端不能出现');
  assert.match(base, /pointer-events: auto/, '#hud 整体 pointer-events:none，胶囊必须自己收回点击');
  assert.ok(has(css, 'body.is-touch #app.playing .hud-peek { display: flex; }'),
    '缺少「触屏 + 战斗中才显示胶囊」的规则');
  ok('桌面端不显示；仅 body.is-touch 且 #app.playing 时出现');

  // 所有缩/收规则都必须挂在 body.is-touch 下，不能裸写 #app.playing
  const tail = css.slice(css.indexOf('手机端极简 HUD'));
  assert.ok(tail.length > 500, '找不到手机端极简 HUD 段落');
  const bare = tail.match(/(^|\n)#app\.playing[^{,]*\{/g) || [];
  assert.equal(bare.length, 0, `手机端规则里有 ${bare.length} 条没挂 body.is-touch，会污染桌面端`);
  ok('新增规则全部以 body.is-touch 限定，桌面端零影响');
}

// ---------------------------------------------------------------- [3] 收起态
{
  const collapsed = [
    '.hud-right',
    '#terrain-chip',
    '#modifier',
    '#chips',
    '.weapon-line',
    '#room-chip',
  ];
  for (const sel of collapsed) {
    assert.ok(has(css, `body.is-touch #app.playing:not(.peek-on) ${sel}`),
      `缺少 ${sel} 的收起态规则`);
  }
  ok(`6 类次要信息都有收起态：${collapsed.join('、')}`);

  // 滑出边界的三个（顶部信息 / 房间码）
  const rightBody = decl(cssClean, 'body.is-touch #app.playing:not(.peek-on) .hud-right,');
  assert.match(rightBody, /opacity: 0/, '.hud-right 收起后应透明');
  assert.match(rightBody, /translateY\(-160%\)/, '.hud-right 应收出上边界而不是留在原地');
  const roomBody = decl(cssClean, 'body.is-touch #app.playing:not(.peek-on) #room-chip');
  assert.match(roomBody, /translateY\(160%\)/, '房间码应向下滑出（左下角是走位拇指区）');
  ok('.hud-right / 地形 / 词条上滑出界，房间码下滑出界');

  // 折叠类必须归零 min-height（.chips 自带 min-height:26px）
  const foldBody = decl(cssClean, 'body.is-touch #app.playing:not(.peek-on) #chips,');
  assert.match(foldBody, /max-height: 0/, '#chips / .weapon-line 应收成 0 高');
  assert.match(foldBody, /min-height: 0/,
    '#chips 收起必须同时 min-height:0 —— min-height 优先级高于 max-height，只写 max-height 折不掉');
  assert.match(foldBody, /overflow: hidden/, '折高度必须 overflow:hidden，否则内容会溢出显示');
  ok('#chips / 武器名折成 0 高，且 min-height 一起归零（否则折不掉）');

  // 不许用 display:none —— 那就没过渡了，展开时会硬闪
  for (const sel of collapsed) {
    const body = decl(cssClean, `body.is-touch #app.playing:not(.peek-on) ${sel}`);
    assert.ok(!/display:\s*none/.test(body),
      `${sel} 的收起态用了 display:none，会失去过渡；改用 opacity + transform / max-height`);
  }
  ok('收起一律用 opacity / transform / max-height，保留 0.26s 过渡');
}

// ---------------------------------------------------------------- [4] 展开态
{
  for (const sel of ['.hud-right', '#terrain-chip', '#modifier']) {
    const body = decl(cssClean, `body.is-touch #app.playing.peek-on ${sel}`);
    assert.match(body, /opacity: 1/, `${sel} 展开后应恢复可见`);
    assert.match(body, /transform: none/, `${sel} 展开后应回到原位`);
  }
  // #chips 展开分两块写：合并块恢复高度，单独一条把 min-height 还给 .chips 原值
  const chipsOpen = decl(cssClean, 'body.is-touch #app.playing.peek-on #chips,');
  assert.match(chipsOpen, /max-height: 60px/, '#chips 展开后应恢复高度');
  const chipsMin = decl(cssClean, '\nbody.is-touch #app.playing.peek-on #chips {');
  assert.match(chipsMin, /min-height: 26px/, '#chips 展开后应恢复原 min-height');
  ok('展开态把 6 类信息全部恢复（含 #chips 的 min-height）');

  // 展开时右侧要给胶囊让位，且左右对称 —— 否则波次微标会偏
  const pad = decl(cssClean, 'body.is-touch #app.playing.peek-on .hud-top');
  const left = pad.match(/padding-left:\s*calc\(([\d.]+)px/);
  const right = pad.match(/padding-right:\s*calc\(([\d.]+)px/);
  assert.ok(left && right, '展开态缺少 .hud-top 的左右 padding 让位规则');
  assert.equal(left[1], right[1], '展开态左右 padding 必须相等，否则居中的波次微标会被挤偏');
  ok(`展开时 .hud-top 左右各让 ${left[1]}px，波次仍居中`);
}

// ---------------------------------------------------------------- [5] 常显部分确实缩了
{
  assert.match(decl(cssClean, 'body.is-touch #app.playing .center-msg'), /font-size: 16px/,
    '中央大字在手机上应压到 16px（原来 32px 等于半个战场）');
  assert.match(decl(cssClean, '\nbody.is-touch #app.playing .wave-chip {'), /flex-direction: row/,
    '波次应压成一行微标');
  assert.match(decl(cssClean, 'body.is-touch #app.playing .boss-bar'), /top: 40px/,
    'BOSS 血条应贴到顶部，不能压在战场中央');
  assert.match(decl(cssClean, 'body.is-touch #app.playing .hud-left'), /max-width: 128px/,
    '装甲区应限宽，别横着占满左边');
  ok('常显五样也按手机尺寸缩了一档（装甲 / 波次 / 武器 / 中央字 / BOSS 条）');
}

// ---------------------------------------------------------------- [6] 接线
{
  assert.ok(/const PEEK_MS = 5000/.test(hud), 'HUD.js 应定义 PEEK_MS = 5000（展开 5 秒收回）');
  assert.ok(/_setPeek\(on\)/.test(hud), 'HUD.js 缺少 _setPeek 方法');
  assert.match(hud, /setTimeout\(\(\) => this\._setPeek\(false\), PEEK_MS\)/,
    '_setPeek 应挂 5 秒自动收回定时器');
  // 状态类必须叫 peek-on：叫 hud-peek 会撞上胶囊自身的 display:none，
  // #app 一挂上整个 HUD 就没了
  assert.ok(/classList\.toggle\('peek-on', want\)/.test(hud),
    '_setPeek 应在 #app 上切换 peek-on 类（CSS 靠它认状态）');
  assert.ok(!/classList\.toggle\('hud-peek'/.test(hud),
    '状态类不能用 hud-peek —— 会命中胶囊的 display:none，整页消失');

  // 开局必须回到极简，不能把上一波展开的状态带进新一波
  const startBody = hud.slice(hud.indexOf('startPlaying()'), hud.indexOf('showRewards('));
  assert.match(startBody, /this\._setPeek\(false\)/, 'startPlaying 里应重置为收起态');

  // 结算时也收掉，否则下次开局前 DOM 里留着一个展开态
  const goIdx = hud.lastIndexOf("this.app.classList.remove('playing')");
  assert.ok(goIdx > 0, '找不到结算分支里的 remove(\'playing\')');
  assert.match(hud.slice(goIdx, goIdx + 120), /this\._setPeek\(false\)/,
    '结算分支应同时把战况收回');

  assert.match(hud, /document\.body\.classList\.toggle\('is-touch'/,
    'HUD.bind 应把 is-touch 挂到 body（触屏判定与辅助瞄准同一套）');
  ok('展开 / 收回已接线：开局重置、点击切换、5 秒自动收回、结算清状态');
}

// ---------------------------------------------------------------- [7] 顺序
{
  // styles.css 里前段有大量 @media 覆盖，新规则必须写在最后一段才不会被顶掉
  const lastMedia = css.lastIndexOf('@media');
  const block = css.indexOf('手机端极简 HUD');
  assert.ok(block > lastMedia - 1 || block > css.indexOf('@media (max-height: 560px) and (min-width: 560px)'),
    '手机端极简 HUD 段落必须写在所有 @media 之后（前段同特异性规则会覆盖它）');
  ok('规则位于文件末尾，不被前段媒体查询覆盖');
}

console.log(`\n手机端极简 HUD ${pass} 项通过`);
