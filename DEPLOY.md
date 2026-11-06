# 部署

线上是**一个 Cloudflare Worker**，同时干三件事：

| 路径 | 能力 | 实现 |
| --- | --- | --- |
| `/`、`/src/*`、`/vendor/*` | 静态页面 | Worker 静态资源（`dist/`，由 `npm run build` 产出） |
| `/api/scores` | 今日榜 / 总榜 | KV 绑定 `DAILY_SCORES`（没绑也能跑，成绩存本地） |
| `/ws` | 4 人合作房间 | Durable Object（一个房间码 = 一个实例） |

为什么不是 Pages：Pages 的 Functions 是无状态的，**跑不了常驻 WebSocket**，
所以线上组队会永远连不上。换成 Worker + Durable Objects 之后，页面、榜单、
联机同源，前端不需要配任何服务器地址。

---

## 一、本地开发

```bash
npm install          # 只装 ws（联机服务用）
npm start            # http://localhost:5173 完整环境：静态页 + 榜单 + 联机房间
```

想验证"线上那套"（Worker + Durable Object）而不部署：

```bash
npm run dev:worker   # 构建 dist 后起本地 Worker，地址 http://127.0.0.1:8787
```

两种环境跑的是同一份房间逻辑（`server/room.js`、`server/session.js`），
区别只有传输层。

---

## 二、部署方式 A：命令行（推荐）

首次需要登录 Cloudflare（会弹浏览器授权）：

```bash
npx wrangler login
npm run build
npx wrangler deploy
```

输出里会给出地址，形如：

```
https://roguetank.<你的子域>.workers.dev
```

以后每次更新只要：

```bash
npm run deploy      # = npm run build && npx wrangler deploy
```

也可以在 Cloudflare 面板生成 API Token 后免登录部署：

```bash
export CLOUDFLARE_API_TOKEN=xxxx
export CLOUDFLARE_ACCOUNT_ID=yyyy
npm run deploy
```

Token 权限需要 **Workers Scripts: Edit**，如需操作 KV 再加 **Workers KV Storage: Edit**。

---

## 三、部署方式 B：GitHub Actions 自动部署

仓库自带 `docs/deploy.workflow.yml`：**先把它整份复制到 `.github/workflows/deploy.yml`**
（覆盖原来的 Pages 工作流），之后推 `main` 就会自动构建 + `wrangler deploy`。

> 为什么绕这一下：`.github/workflows/` 下的文件受 GitHub 保护，改它需要 token 带
> `Workflows: Read and write` 权限，普通 fine-grained token 会被拒（403）。网页上直接
> 编辑该文件没有这个限制，所以最快的方式是在 GitHub 页面里粘贴一次。

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 里配两个 Secret：

| Secret | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token，权限 `Workers Scripts: Edit`（要改 KV 再勾 `Workers KV Storage: Edit`） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 面板 **Workers & Pages** 右侧账户信息里的 Account ID |

配好后推一次 `main`，或到 **Actions → Deploy to Cloudflare Workers → Run workflow** 手动跑。

> 之前用 Pages 的同学注意：旧 token 可能只有 `Cloudflare Pages: Edit`，需要补上
> `Workers Scripts: Edit`，否则 `wrangler deploy` 会报认证失败。

---

## 四、榜单持久化（KV）

不建 KV 也能上线：`/api/scores` 返回 `ok:false`，前端自动回退到 localStorage，
只是每个人的成绩只存在自己浏览器里。

要真正共享榜单，建一个命名空间并绑定：

```bash
npx wrangler kv namespace create DAILY_SCORES
# 输出里会有 id = "xxxxxxxxxxxxxxxx"
```

把 id 填进 `wrangler.toml` 末尾那三行（取消注释）：

```toml
[[kv_namespaces]]
binding = "DAILY_SCORES"
id = "xxxxxxxxxxxxxxxx"
```

再 `npm run deploy` 一次即可。排行榜规则在 `functions/api/_lib/leaderboard.js`，
线上 KV 和本地文件存储共用这一份（`test/scores.test.mjs` 覆盖）。

---

## 五、自定义域名

Cloudflare 面板 → **Workers & Pages** → 选 `roguetank` → **Settings → Domains & Routes**
→ **Add custom domain**（域名需托管在 Cloudflare）。

绑定后 `wss://你的域名/ws` 自动可用，无需改代码。

---

## 六、只部署静态页（组队不可用）

如果只想放个页面预览，可以继续用 Pages：

```bash
npm run build
npx wrangler pages deploy dist --project-name=roguetank
```

这种形态下 `/api/scores` 和 `/ws` 都不存在：榜单回退本地，点「组队」会提示
"连不上联机服务"（见 `src/Game.js` 的 `_coopOffline`），而不是卡在"正在创建房间…"。

---

## 七、注意事项

- 站点必须走 HTTP(S)，不要用 `file://` 打开（ES Module 跨域限制）。
- 游戏用 `localStorage` 保存呼号与最佳记录，换域名/清缓存会丢。
- 房间是内存态 + 少量 KV 标记：**DO 被回收后房间会重新开始**，正在打的局不会续上。
- 每个房间 30Hz 模拟，1 核足够撑几十个并发房间；DO 按请求与时长计费，
  Workers 免费额度对小规模朋友局够用。
- 改了资源路径记得同步 `build.mjs` 的 `ITEMS` 和 `dist/_headers` 缓存规则。
- 旧的 `functions/api/scores.js` 保留只是为了 Pages 形态兼容，Worker 直接复用
  `functions/api/_lib/leaderboard.js`，两条路径的规则完全一致。
