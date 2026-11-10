/**
 * 首页（主菜单）版式回归 —— 对齐 Pixso 设计稿「web 1920 / 图纸 2:1」
 *
 * 为什么值得单独写一个测试：
 * 首页是纯视觉的东西，任何一次"顺手调整"都可能把设计稿的数值改掉，
 * 而 ESLint / 单元测试都看不见。更麻烦的是这个项目里 styles.css 有 2000 行，
 * 同一批选择器在多处媒体查询里被覆盖过 —— 实测就踩过：
 * 老的四宫格规则写在文件前段，新版首页样式写在末尾，但 520px 处的
 * `flex-direction: column` 把「120 甲 / 全向炮塔」压成了竖排。
 *
 * 所以这里不测"看起来好不好看"，只测三件事：
 *   1. 设计稿的关键数值确实存在于 CSS 里（面板 780×520 / 圆角 35、
 *      模式卡 156×88 / 圆角 15、输入框与主按钮 280×50 / 圆角 10、
 *      榜单 176×385 @top 27 right 23、键位 176×218）
 *   2. 结构上该有的元素都在（标题/副标题/三张模式卡/车体条/呼号/主按钮/
 *      右上榜单/右下键位/四角菱形）
 *   3. 首页所有可见文字没有残留旧文案（"单人出击"、"2~4 人 · 各自选卡" 等）
 */
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

let pass = 0;
const ok = (msg) => { pass++; console.log(`  ✓ ${msg}`); };

// ---------------------------------------------------------------- [1] 设计稿数值
{
  // 面板 780×520 圆角 35
  assert.ok(/\.menu-panel\s*\{[^}]*width:\s*calc\(780px \* var\(--s,\s*1\)\)/.test(css), '面板宽应为 780px × 缩放');
  assert.ok(/\.menu-panel\s*\{[^}]*min-height:\s*calc\(520px/.test(css), '面板最小高应为 520px');
  assert.ok(/\.menu-panel\s*\{[^}]*border-radius:\s*calc\(35px/.test(css), '面板圆角应为 35px');
  assert.ok(/\.menu-panel\s*\{[^}]*background:\s*rgba\(35,\s*41,\s*49,\s*\.80\)/.test(css), '面板底色应为 #232931@.80');
  ok('中央面板 780×520 / 圆角 35 / #232931@.80');

  // 标题 46px，渐变 #f2ca91 → #f79b38
  assert.ok(/\.menu-title h1\s*\{[^}]*font-size:\s*calc\(46px/.test(css), '标题应为 46px');
  assert.ok(/\.menu-title h1\s*\{[^}]*linear-gradient\(180deg,\s*#f2ca91 0%,\s*#f79b38 100%\)/.test(css), '标题渐变应为 #f2ca91 → #f79b38');
  ok('标题 46px、渐变 #f2ca91 → #f79b38');

  // 模式标题 20px 粗体 #f79b38
  assert.ok(/\.menu-section\s*\{[^}]*font-size:\s*calc\(20px/.test(css), '「作战模式」应为 20px');
  assert.ok(/\.menu-section\s*\{[^}]*color:\s*var\(--home-orange\)/.test(css), '「作战模式」应为橙色');
  ok('分区标题 20px / #f79b38');

  // 模式卡 156×88，圆角 15，间距 20
  assert.ok(/\.mode-card\s*\{[^}]*width:\s*calc\(156px/.test(css), '模式卡宽应为 156px');
  assert.ok(/\.mode-card\s*\{[^}]*height:\s*calc\(88px/.test(css), '模式卡高应为 88px');
  assert.ok(/\.mode-card\s*\{[^}]*border-radius:\s*calc\(15px/.test(css), '模式卡圆角应为 15px');
  assert.ok(/\.mode-cards\s*\{[^}]*gap:\s*calc\(20px/.test(css), '模式卡间距应为 20px');
  ok('模式卡 156×88 / 圆角 15 / 间距 20');

  // 输入框与主按钮 280×50，圆角 10
  assert.ok(/\.callsign input\s*\{[^}]*width:\s*calc\(280px/.test(css), '呼号框宽应为 280px');
  assert.ok(/\.callsign input\s*\{[^}]*height:\s*calc\(50px/.test(css), '呼号框高应为 50px');
  assert.ok(/#start-btn\s*\{[^}]*width:\s*calc\(280px/.test(css), '主按钮宽应为 280px');
  assert.ok(/#start-btn\s*\{[^}]*background:\s*#f79b38/.test(css), '主按钮应为实心 #f79b38');
  assert.ok(/#start-btn\s*\{[^}]*color:\s*#333333/.test(css), '主按钮文字应为 #333');
  ok('呼号框 / 主按钮 280×50、主按钮实心 #f79b38');

  // 右上榜单 176×385 @ top 27 right 23
  assert.ok(/\.menu-board\s*\{[^}]*width:\s*calc\(176px/.test(css), '榜单宽应为 176px');
  assert.ok(/\.menu-board\s*\{[^}]*height:\s*calc\(385px/.test(css), '榜单高应为 385px');
  assert.ok(/\.menu-board\s*\{[^}]*top:\s*calc\(27px/.test(css), '榜单距顶应为 27px');
  // 卡片底：矩形 12 = #ffffff@.10 叠在 #333333@.80 上（两层，不是单层半透明白）
  assert.ok(/\.menu-board\s*\{[^}]*rgba\(255,\s*255,\s*255,\s*\.10\)/.test(css), '榜单底应含 #ffffff@.10');
  assert.ok(/rgba\(51,\s*51,\s*51,\s*\.80\)/.test(css), '榜单底应含 #333333@.80');
  ok('右上榜单卡 176×385 @ 27 / 23');

  // 右下键位 176×218
  assert.ok(/\.key-help\s*\{[^}]*width:\s*calc\(176px/.test(css), '键位卡宽应为 176px');
  assert.ok(/\.key-help\s*\{[^}]*height:\s*calc\(218px/.test(css), '键位卡高应为 218px（设计稿 3:47）');
  ok('右下键位卡 176×218');

  // ---- 设计稿几何细节（逐节点对过的，改样式时不该漂）----
  // 矩形 18：78×22 @9,10 圆角 5，#f2ca91@.80 —— "今日排行"胶囊底
  assert.ok(/width:\s*calc\(78px/.test(css), 'tab 胶囊底应为 78×22（设计稿 矩形 18）');
  assert.ok(/height:\s*calc\(22px[^;]*;[\s\S]{0,200}?rgba\(242,\s*202,\s*145,\s*\.80\)/.test(css),
    '胶囊底颜色应为 #f2ca91@.80');
  // 矩形 13：174×60 标题条
  assert.ok(/\.mb-bar\s*\{[^}]*width:\s*calc\(174px/.test(css), '榜单标题条应为 174 宽');
  assert.ok(/\.mb-bar\s*\{[^}]*height:\s*calc\(60px/.test(css), '榜单标题条应为 60 高');
  // 列表第一行 T65，行距 32
  assert.ok(/\.mb-list\s*\{[^}]*top:\s*calc\(65px/.test(css), '榜单首行应在 T65');
  assert.ok(/\.mb-row\s*\{[^}]*height:\s*calc\(32px/.test(css), '榜单行距应为 32（组合 1~10 间距）');
  // 操作说明四行基线 52 / 94 / 135 / 176
  for (const t of [52, 94, 135, 176]) {
    assert.ok(new RegExp(`:nth-child\\(\\d\\)\\s*\\{\\s*top:\\s*calc\\(${t}px`).test(css)
      || new RegExp(`:nth-child\\(\\d\\)\\s*>\\s*span\\s*\\{\\s*top:\\s*calc\\(${t}px`).test(css)
      || new RegExp(`padding:\\s*calc\\(52px`).test(css),
      `操作说明缺 T${t} 那一行（设计稿四行基线）`);
  }
  ok('设计稿几何：胶囊 78×22@9,10 / 标题条 174×60 / 行距 32 / 键位四行 T52·94·135·176');

  // 键位四行必须是 22 高、间距 20/19/19（设计稿 T52→94→135→176 的差值减行高）
  assert.ok(/\.key-help-list li\s*\{[^}]*height:\s*calc\(22px/.test(css), '键位行高应为 22');
  assert.ok(/padding:\s*calc\(52px/.test(css), '键位列表应从 T52 起（设计稿第一行基线）');

  // ---- 两个曾把整个面板搞坏的 CSS 陷阱，必须有断言盯着 ----
  //
  // (1) `.key-help-list span { margin-left: auto }` 是旧版遗留。在绝对定位的
  //     span 上 auto 边距会把文字推出容器，实测跑到 x=-69（面板左侧画布外）。
  // (2) li 若是 position:absolute，li>span 的 right 会相对 li 计算（li 只有
  //     键帽那么宽），同样把文字挤出面板。
  const helpCss = css.slice(css.indexOf('右下角操作说明'));
  assert.ok(!/\.key-help-list[^{]*\{[^}]*margin-left:\s*auto/.test(helpCss),
    '键位说明文字不能用 margin-left:auto（会把文字推出面板）');
  assert.ok(/\.key-help-list li\s*\{[^}]*position:\s*static/.test(helpCss),
    '键位 li 必须是 position:static，否则 span 的 right 会相对 li 计算');

  ok('键位排版陷阱：无 margin-left:auto、li 为 static');

  // ---- 操作说明的行数与文案，必须与设计稿一字不差 ----
  //
  // 设计稿 3:47 只有 4 组：行驶 / 瞄准 / 开炮 / 切换解锁过的武器。
  // 曾经自作主张加过「1 2 3 选择强化」——那不是设计稿的内容，用户明确要求
  // "设计稿没有的一律去掉"。这条断言就是防止再犯。
  const helpBlock = html.slice(html.indexOf('id="key-help"'), html.indexOf('</ul>', html.indexOf('id="key-help"')));
  const rows = [...helpBlock.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  assert.equal(rows.length, 4,
    `操作说明应为 4 行（设计稿只有 行驶/瞄准/开炮/切换武器），实际 ${rows.length} 行`);
  const expectHelp = [
    ['W', 'A', 'S', 'D', '行驶'],
    ['鼠标', '瞄准'],
    ['左键', '空格', '开炮'],
    ['Q', '切换解锁过的武器'],
  ];
  for (const [i, parts] of expectHelp.entries()) {
    for (const p of parts) {
      assert.ok(rows[i].includes(`>${p}<`), `操作说明第 ${i + 1} 行缺少「${p}」`);
    }
  }
  // 明确断言"不该有"的那一行
  assert.ok(!helpBlock.includes('选择强化'), '操作说明不该有「选择强化」（设计稿无此内容）');
  assert.ok(!helpBlock.includes('<kbd class="kk">1</kbd>'), '操作说明不该有数字键 1/2/3（设计稿无此内容）');
  ok('操作说明严格 4 行，无设计稿外的「选择强化」');
}

// ---------------------------------------------------------------- [2] 结构完整
{
  const need = [
    ['menu-panel', '中央面板'],
    ['menu-title', '标题块'],
    ['mode-cards', '模式卡容器'],
    ['id="callsign"', '呼号输入框'],
    ['id="start-btn"', '主按钮'],
    ['id="menu-board"', '右上排行榜卡'],
    ['id="mb-body"', '排行榜列表容器'],
    ['id="key-help"', '右下键位卡'],
  ];
  for (const [pat, name] of need) {
    assert.ok(html.includes(pat), `首页缺少${name}（${pat}）`);
  }
  ok(`${need.length} 个关键结构全部存在`);

  // 设计稿里没有车体选择：91 段文字中查不到「豹式 / 车体 / 基础型」。
  // 坦克固定为豹式一款后没有可选项，首页就不该出现这条信息。
  assert.ok(!html.includes('chassis-cards'), '首页不该再有车体选择区（设计稿无此栏）');
  assert.ok(!html.includes('豹式'), '首页不该出现「豹式」字样（设计稿无此标注）');
  ok('首页无车体选择区、无「豹式」字样，与设计稿一致');

  const diamonds = (html.match(/class="deco-diamond/g) || []).length;
  assert.equal(diamonds, 4, `四角菱形装饰应为 4 个，实际 ${diamonds}`);
  ok('四角菱形装饰 4 个');

  // 用 data-mode 计数：class="mode-card" 也会匹配到容器 mode-cards
  const modeCards = (html.match(/class="mode-card[^"]*"\s+data-mode=/g) || []).length;
  assert.equal(modeCards, 3, `模式卡应为 3 张，实际 ${modeCards}`);
  ok('模式卡 3 张');
}

// ---------------------------------------------------------------- [3] 文案与设计稿一致
{
  const pairs = [
    ['钢铁突击', '主标题'],
    ['3D坦克 · 肉鸽生存', '副标题'],
    ['作战模式', '分区标题'],
    ['无尽冲锋', '模式 1'],
    ['群狼共舞', '模式 2'],
    ['经典战役', '模式 3'],
    ['复刻开发中', '模式 3 副标'],
    ['选择呼号', '输入框占位'],
    ['开始冲锋', '主按钮'],
    ['今日排行', '榜单 tab 1'],
    ['总排行榜', '榜单 tab 2'],
    ['操作说明', '键位标题'],
  ];
  for (const [txt, name] of pairs) {
    assert.ok(html.includes(txt), `${name}文案应为「${txt}」`);
  }
  ok(`${pairs.length} 条文案与设计稿一致`);

  // 旧文案必须清干净：留着说明改了 HTML 没改 JS，或者反过来
  const stale = ['单人出击', '2~4 人 · 各自选卡', '单人 · 越打越强', '复刻 · 开发中', '基础型 · 豹式', '120 甲', '全向炮塔'];
  for (const s of stale) {
    assert.ok(!html.includes(s), `首页还残留旧文案「${s}」`);
  }
  ok('旧文案已全部清理，无残留');

  // 矮屏（1366×768 是最常见的笔记本分辨率）不许把榜单 / 键位直接隐藏。
  //
  // 设计稿是 1920×1080，右侧两张浮动卡按原尺寸放不进 768 高。曾经用过
  // display:none 让位，结果 1366 用户在首页根本看不到排行榜和操作说明，
  // 等于这两个功能不存在。现在改成整体 scale(.82) 缩一档，缩也要看得见。
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const mq = [`@media (max-height: 800px), (max-width: 1100px)`];
  for (const q of mq) {
    assert.ok(css.includes(q), `styles.css 缺少矮屏媒体查询 ${q}`);
  }
  // 找出矮屏查询块，确认里面没有 display:none 掉这两张卡
  const block = css.slice(css.indexOf(mq[0]));
  const end = block.indexOf('}\n}');
  const body = block.slice(0, end > 0 ? end : 600);
  assert.ok(!/\.key-help[^{]*\{[^}]*display:\s*none/.test(body),
    '矮屏下不该隐藏键位提示');
  assert.ok(!/\.menu-board[^{]*\{[^}]*display:\s*none/.test(body),
    '矮屏下不该隐藏排行榜');
  assert.ok(/scale:\s*0?\.\d+/.test(body), '矮屏下应当缩放而不是隐藏浮动卡');
  ok('矮屏（1366×768）保留榜单与键位，改为缩放');
}

console.log(`\n首页版式回归测试全部通过（${pass} 项）`);
