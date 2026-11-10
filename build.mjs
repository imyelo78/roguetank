import { rm, mkdir, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

// 参与发布的静态资源（preview.jpg / README / server.mjs 不打包）
const ITEMS = ['index.html', 'styles.css', 'src', 'vendor'];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const item of ITEMS) {
  await cp(path.join(root, item), path.join(dist, item), { recursive: true });
}

// Cloudflare Pages 响应头
await writeFile(
  path.join(dist, '_headers'),
  `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Cache-Control: no-cache

/vendor/*
  Cache-Control: no-cache

/src/*
  Cache-Control: no-cache
`
// 全部 no-cache。vendor 曾经设成 max-age=31536000, immutable（一年、永不验证），
// 静态托管上这意味着 three.module.js 更新后老用户一年拿不到新的，而且完全没有报错，
// 只会表现成"改了代码没生效"。文件名没有 hash，就不该配 immutable。
);

console.log(`built -> ${dist}`);
