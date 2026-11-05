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

/vendor/*
  Cache-Control: public, max-age=31536000, immutable

/src/*
  Cache-Control: public, max-age=600
`
);

console.log(`built -> ${dist}`);
