# 部署到 Cloudflare Pages

本项目是**纯静态站点**。Cloudflare Pages 在部署时会执行 `npm run build`（即 `node build.mjs`），
把 `index.html`、`styles.css`、`src/`、`vendor/` 复制到 `dist/`，再发布 `dist/`。

`dist/` 是构建产物，已加入 `.gitignore`，**不需要提交到 GitHub**。

---

## 一、方式 A：GitHub 自动部署（推荐）

配置一次，以后每次 `git push` 到 `main`，Cloudflare 都会自动重新构建并上线。

### 1. 把代码推到 GitHub

先在 GitHub 新建一个空仓库（不要勾选 README / .gitignore / License），然后：

```powershell
cd tank3d-p0
git init
git add .
git commit -m "feat: 坦克肉鸽 v0.3 — Boss / 精英 / 多武器"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

> 建议直接把 `tank3d-p0` 作为仓库根目录。如果仓库根目录是外层文件夹，
> 构建命令和输出目录需要按下方“多目录仓库”调整。

### 2. 在 Cloudflare 连接仓库

1. 打开 https://dash.cloudflare.com/ → **Workers & Pages**
2. **Create** → **Pages** → **Connect to Git**
3. 授权 GitHub，选择刚才的仓库
4. 构建配置：

| 配置项 | 值 |
| --- | --- |
| Framework preset | `None` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | `/`（仓库根目录） |

5. 点 **Save and Deploy**

首次构建完成后会得到：

```
https://<项目名>.pages.dev
```

之后每次推送到 `main` 都会自动部署；推送其他分支/PR 会生成预览地址。

### 2.1 Cloudflare 看不到 / 无法读取仓库

通常是 **Cloudflare Pages GitHub App 没有授予该仓库权限**，不是代码问题。按顺序检查：

1. **安装或授权 GitHub App**  
   打开 https://github.com/apps/cloudflare-pages/installations/new  
   登录 `imyelo78` 账号 → 选择 **Only select repositories** → 勾选 `roguetank` → **Install / Save**。
2. **已安装但没勾选仓库**  
   打开 https://github.com/settings/installations → 找到 **Cloudflare Pages** → **Configure** → **Repository access** → 勾选 `roguetank` → **Save**。
3. **确认 GitHub 账号一致**  
   浏览器当前登录的 GitHub 必须是 `imyelo78`，或拥有该仓库权限的账号；否则 Cloudflare 只能看到那个账号名下的仓库。
4. **组织仓库需要管理员批准**  
   如果仓库属于 GitHub 组织，需要组织 Owner 在 **Organization settings → Third-party access / Installed GitHub Apps** 里批准 Cloudflare Pages，并授予该仓库访问权。
5. **授权弹窗被拦截**  
   关闭广告拦截/隐私插件，允许弹窗和第三方 Cookie，或换 Chrome 无痕窗口重试。
6. **回到 Cloudflare 刷新列表**  
   Workers & Pages → Create → Pages → Connect to Git → 刷新仓库列表；必要时先断开 GitHub 再重新连接。

如果以上仍不行，直接用下面的 **GitHub Actions 备选方案**，不依赖 Cloudflare 读取仓库。

### 3. 多目录仓库（仓库根不是 tank3d-p0）

如果 `tank3d-p0` 只是仓库里的一个子目录：

| 配置项 | 值 |
| --- | --- |
| Build command | `cd tank3d-p0 && npm run build` |
| Build output directory | `tank3d-p0/dist` |

### 4. 更新流程

```powershell
git add .
git commit -m "balance: 调整 Boss 血量"
git push
```

Cloudflare 自动构建，约 30~60 秒后线上生效。

### 5. 备选：GitHub Actions 部署（Cloudflare 连不上 GitHub 时）

如果 Cloudflare 面板一直无法授权/找不到仓库，可跳过 Git 集成，改用仓库自带的
`.github/workflows/deploy.yml`：推送 `main` → GitHub Actions 构建 `dist/` → wrangler 上传到 Cloudflare Pages。

只需要在 GitHub 仓库配置两个 Secrets：

1. 获取 **Account ID**：Cloudflare Dashboard → **Workers & Pages**，右侧账户信息里可复制。
2. 创建 **API Token**：Cloudflare Dashboard → 右上角头像 → **My Profile** → **API Tokens** → **Create Token**
   - 权限：`Account` → `Cloudflare Pages` → `Edit`
   - 账户资源：选择你的账户
   - 创建后复制 Token（只显示一次）
3. 打开 GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，添加：

| Secret | 值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 上一步创建的 Token |
| `CLOUDFLARE_ACCOUNT_ID` | 你的 Cloudflare Account ID |

4. 到仓库 **Actions** 标签，选择 **Deploy to Cloudflare Pages** → **Run workflow** 手动跑一次，或直接再推一次 `main`。

工作流会自动创建名为 `roguetank` 的 Pages 项目并部署，之后地址是：

```
https://roguetank.pages.dev
```

> 如果 `Ensure Pages project` 这一步报“项目已存在”是正常的，`continue-on-error` 会忽略。
> 如果部署仍提示项目不存在，先在 Cloudflare 面板用 **Upload assets** 建一个同名项目，再重跑工作流。

---

## 二、方式 B：拖拽上传（不接 GitHub）

1. 本地生成 `dist/`：

```powershell
cd tank3d-p0
npm run build
```

2. 打开 https://dash.cloudflare.com/ → **Workers & Pages** → **Create** → **Pages** → **Upload assets**
3. 项目名填 `tank3d-rogue`
4. 把 `tank3d-p0/dist` 文件夹整个拖进去
5. 点 **Deploy site**

以后更新：同一项目 → **Create new deployment** → 再拖一次新的 `dist/`。

---

## 三、方式 C：命令行（wrangler）

首次需要登录，会弹浏览器授权：

```powershell
cd tank3d-p0
npm run build
npx wrangler login
npx wrangler pages deploy dist --project-name tank3d-rogue
```

首次部署会自动创建项目；之后每次更新只需最后一条命令。

---

## 四、自定义域名（可选）

Cloudflare Pages 项目 → **Custom domains** → 绑定自己的域名（域名需托管在 Cloudflare）。

---

## 五、注意事项

- **不要**直接拖整个 `tank3d-p0` 目录上线，里面包含 `README.md`、`server.mjs`、`preview.jpg` 等非站点文件；用 `dist/`。
- 站点必须走 HTTP(S)，不要用 `file://` 打开（ES Module 跨域限制）。
- 游戏用 `localStorage` 保存最佳记录，换域名/清缓存会丢。
- 免费额度足够朋友游玩：每月 500 次构建、无限静态请求、100 GB 流量。
- 如果改了资源路径，记得同步 `build.mjs` 的 `ITEMS` 列表和 `dist/_headers` 缓存规则。
