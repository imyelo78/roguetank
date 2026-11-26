// 把 styles.css 压成 styles.min.css
// 用法: npm run css:min   或   node tools/minify-css.mjs [源] [目标]
//
// 为什么不用现成的 minifier：这个项目没有构建依赖（package.json 只有 ws），
// 为了一个 CSS 压入 csso/esbuild 不划算。而"去掉空白"这种朴素做法会把
// calc(50% + 47px) 压成 calc(50%+47px) —— 运算符两侧空格是语法要求，
// 整条声明会直接失效。所以这里先把字符串和函数调用摘出来保护，压完再放回。
//
// 产物头部带源文件指纹：index.html 引用的是 styles.min.css，styles.css 改完
// 忘了重跑本脚本的话，线上样式静默回退到旧包（r56 就犯过一次）。test/home.test.mjs
// 会校验这个指纹，对不上直接报"min.css 过期"，不再靠人眼发现。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = process.argv[2] || path.join(root, 'styles.css');
const DST = process.argv[3] || path.join(root, 'styles.min.css');

const srcRaw = fs.readFileSync(SRC, 'utf8');
let css = srcRaw;

// 1) 去注释（先识别字符串，避免误删 content 里的 /*）
{
  let out = '', i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const q = ch; out += ch; i++;
      while (i < css.length) {
        out += css[i];
        if (css[i] === '\\') { i++; out += css[i] ?? ''; i++; continue; }
        if (css[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      i += 2;
      while (i < css.length && !(css[i] === '*' && css[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch; i++;
  }
  css = out;
}

// 2) 保护字符串与函数调用
const store = [];
const stash = (s) => { store.push(s); return '\u0001' + (store.length - 1) + '\u0001'; };

css = css.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, stash);

const FN = /(?:calc|min|max|clamp|env|var|url|cubic-bezier|steps|attr|linear-gradient|radial-gradient|repeating-linear-gradient|conic-gradient|translate|translateX|translateY|translate3d|scale|rotate|matrix|blur|brightness|drop-shadow|inset)\([^()]*\)/gi;
for (let guard = 0; guard < 12; guard++) {
  const before = css;
  css = css.replace(FN, stash);
  if (css === before) break;
}

// 3) 压空白
css = css
  .replace(/\s+/g, ' ')
  .replace(/\s*([{};:,])\s*/g, '$1')
  .replace(/\s*([>~+])\s*/g, '$1')
  .replace(/;}/g, '}')
  .replace(/\s*!\s*important/gi, '!important')
  .trim();

// 4) 还原
for (let guard = 0; guard < 40; guard++) {
  const before = css;
  css = css.replace(/\u0001(\d+)\u0001/g, (_, n) => store[Number(n)]);
  if (css === before) break;
}

fs.writeFileSync(DST,
  `/* generated from ${path.basename(SRC)} (sha256 ${createHash('sha256').update(srcRaw).digest('hex').slice(0, 16)}) — 手改无效，改样式后重跑 npm run css:min */\n${css}`);

const src = Buffer.byteLength(srcRaw);
const dst = Buffer.byteLength(css);
console.log(`${path.basename(SRC)}  ${src}B → ${path.basename(DST)}  ${dst}B  (-${((1 - dst / src) * 100).toFixed(1)}%)`);
