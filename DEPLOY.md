# 部署：阿里云 ECS + 域名 HTTPS

线上地址 **https://roguetank.i1978.com**

```
浏览器 ──TLS(443)──> Nginx ──HTTP──> node server.mjs (127.0.0.1:5173)
                      │                ├─ 静态文件（index.html / src / vendor）
                      │                ├─ /api/scores  今日榜 + 总榜
                      └─ 80 只做         ├─ /ws          4 人房间（WebSocket）
                         301 跳转 +      └─ /healthz     探活
                         ACME 验证
```

一个 Node 进程同时提供页面、榜单、联机，**同源**，所以前端不需要配任何服务器地址。
Nginx 只负责 TLS、gzip、限流和缓存头。

> **服务器上有宝塔面板？** 不要跑本文的 `deploy/bootstrap.sh`——它会用 apt 装第二套 Nginx 去抢
> 80/443，和宝塔自带的 `/www/server/nginx` 打架。宝塔的完整步骤见
> [部署手册.md](./部署手册.md) 第 3 章（Node 项目 + 反代补 `Connection "upgrade"` + 一键证书）。

> 历史包袱：早期版本部署在 Cloudflare Worker + Durable Object 上，那套代码（`worker/`、
> `wrangler.toml`、KV 榜单）已从仓库移除。现在唯一支持的线上形态就是本文这一种。

---

## 〇、一次性准备（务必先做完，否则脚本一定报错）

| # | 事项 | 在哪做 | 检查方式 |
| --- | --- | --- | --- |
| 1 | **域名备案**（`.com` 域名指向境内 ECS 必须备案，否则 80/443 直接被拦） | 阿里云控制台 → 备案 | 备案号下来才算完成 |
| 2 | **A 记录** `roguetank` → 服务器公网 IP | 阿里云 DNS 解析 | `ping roguetank.i1978.com` 显示服务器 IP |
| 3 | **安全组放行 80、443**（22 只对你自己的 IP 开放） | 阿里云 → ECS → 安全组 → 入方向 | 见下方自查命令 |
| 4 | 服务器装 **Ubuntu 22.04 / Debian 11+** | ECS 镜像 | `cat /etc/os-release` |

域名解析自查（在你自己的电脑上）：

```bash
dig +short roguetank.i1978.com        # 应输出服务器公网 IP
telnet roguetank.i1978.com 80         # 不通 = 安全组没放行
```

> **5173 端口不要对公网放行**。Node 只监听 `127.0.0.1`，公网流量统一走 Nginx，
> 这样 HTTPS、限流、健康检查才是唯一入口。

---

## 一、部署（两种方式，选一种）

### 方式 A：git 拉代码（推荐，以后更新最省事）

```bash
# 服务器上
sudo apt-get update -y && sudo apt-get install -y git
sudo git clone https://github.com/imyelo78/roguetank.git /opt/roguetank
cd /opt/roguetank
sudo bash deploy/bootstrap.sh
```

私有仓库请改成 SSH 地址并先在服务器上配好 deploy key。

### 方式 B：压缩包上传

```bash
# 本地
scp roguetank-server.tar.gz root@<服务器IP>:/tmp/

# 服务器
sudo mkdir -p /opt/roguetank
sudo tar -xzf /tmp/roguetank-server.tar.gz -C /opt/roguetank --strip-components=1
cd /opt/roguetank
sudo bash deploy/bootstrap.sh
```

> 方式 B 没有 `.git`，以后更新只能重新上传覆盖；`deploy/update.sh` 只支持方式 A。

### bootstrap.sh 做了哪些事

1. 校验域名解析是否指向本机（解析不对直接停下，不留半成品）；
2. 装 Nginx / Node 20 / certbot（已装则跳过）；
3. 建系统用户 `roguetank`，`npm ci --omit=dev`（只有 `ws` 一个依赖）；
4. 装 systemd 服务，`HOST=127.0.0.1 PORT=5173`，崩溃自动拉起、开机自启；
5. 先用临时 Nginx 配置跑通 ACME 验证 → 申请 Let's Encrypt 证书 → 换成完整配置；
6. 装续期钩子：证书续期后自动 `nginx -t && systemctl reload nginx`；
7. 自测 HTTP 跳转、HTTPS 200、`/healthz`，最后打印证书到期时间。

**幂等**：重复执行不会重复建用户或重复申请证书。

---

## 二、验收清单

```bash
# 1. 服务在跑
systemctl status roguetank --no-pager
curl -s http://127.0.0.1:5173/healthz
# → {"ok":true,"uptime":12,"rooms":0,"players":0,"rssMB":48}

# 2. HTTPS 正常 + 80 会跳转
curl -sI https://roguetank.i1978.com/ | head -3      # HTTP/2 200
curl -sI http://roguetank.i1978.com/  | head -2      # 301 → https

# 3. 缓存协商生效（第二次应返回 304）
E=$(curl -sI https://roguetank.i1978.com/src/net.js | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -sI -H "If-None-Match: $E" https://roguetank.i1978.com/src/net.js | head -1

# 4. WebSocket 握手（要 101，426/400 都不对）
curl -si -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
     -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
     https://roguetank.i1978.com/ws | head -1

# 5. 证书与续期
sudo certbot certificates
systemctl list-timers certbot.timer
```

浏览器再走一遍：打开首页 → 填呼号 → 组队 → 创建房间 → 另开窗口（或手机）用房间码加入 →
双方都进战场。地址栏应有**锁形图标**，`F3` 面板里 `ping` 个位数、`snap` 约 15Hz、`停顿 0`。

---

## 三、日常运维

| 操作 | 命令 |
| --- | --- |
| 更新到最新代码 | `cd /opt/roguetank && sudo bash deploy/update.sh` |
| 连 Nginx 配置一起更新 | `sudo bash deploy/update.sh --nginx` |
| 看实时日志 | `journalctl -u roguetank -f` |
| 重启游戏服务 | `sudo systemctl restart roguetank` |
| 改 Nginx | 改 `deploy/nginx.conf` → `sudo cp deploy/nginx.conf /etc/nginx/conf.d/roguetank.conf` → `sudo nginx -t && sudo systemctl reload nginx` |
| 续证书演练 | `sudo certbot renew --dry-run` |
| 榜单数据 | `/opt/roguetank/.data/scores.json`，备份直接拷走 |
| 清空榜单 | `sudo systemctl stop roguetank && sudo rm /opt/roguetank/.data/scores.json && sudo systemctl start roguetank` |

重启不会长时间踢人：`server.mjs` 收到 SIGTERM 会给房间里每个人发 `1012 server-restart`
关闭帧再退出，客户端据此提示"服务器重启"而不是"网络异常"。

---

## 四、排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `bootstrap.sh` 报"域名还没有解析" | A 记录没生效 / 指向别的 IP | 改 DNS，等 TTL 过期 |
| `certbot` 报 `Timeout during connect` | 安全组没放行 80 | 安全组入方向加 80 |
| `ERR_TOO_MANY_REDIRECTS` | Cloudflare 代理开着且 SSL 模式是 Flexible，或 CDN 回源到 80 | 改 Full(strict)，或直接关代理 |
| **页面能开，组队一直"连不上服务器"** | Nginx 没透传 Upgrade | 按验收第 4 条测握手；确认 `location /ws` 的 `proxy_set_header Upgrade $http_upgrade` 没被删 |
| 组队过一会掉一次 | 读超时太短 | `proxy_read_timeout 3600s`；Node 每 20s 心跳，两轮无 pong 才判掉线 |
| 进战场一顿一顿 | 开了 `proxy_buffering on` | `/ws` 必须 `proxy_buffering off` |
| 502 Bad Gateway | Node 没起来或端口不一致 | `systemctl status roguetank`，核对 `PORT=5173` 与 upstream |
| 首页 200 但白屏 | 缓存了旧 HTML，或命中了别的站点 | `Ctrl+Shift+R`；`nginx -T \| grep server_name` 应只有 `roguetank.i1978.com` |
| 手机 4G 打不开 | 备案未完成，运营商侧拦截 | 查备案状态 |
| `unknown directive "http2"` | Nginx < 1.25 | `bootstrap.sh` 会自动改写成 `listen 443 ssl http2;` |

一键看全貌：

```bash
systemctl status roguetank nginx --no-pager | head -20
curl -s http://127.0.0.1:5173/healthz; echo
curl -s https://roguetank.i1978.com/api/scores?view=stats
sudo nginx -t
journalctl -u roguetank -n 50 --no-pager
```

---

## 五、可选：不走 Nginx 的两条路

| 方案 | 何时用 | 代价 |
| --- | --- | --- |
| Node 直连 `HOST=0.0.0.0 PORT=8080` | 临时验证 | 没 HTTPS、剪贴板 API 不可用、无 gzip/限流，不要上线 |
| `deploy/Dockerfile`（`-p 127.0.0.1:8080:8080 -v $PWD/.data:/app/.data`） | 想用容器管进程 | 仍需 Nginx 在前面做 TLS |

容器方案记得把 `.data` 挂出来，否则重建容器成绩就没了。

---

## 六、已知限制

- 房间状态全在内存，进程重启即清空（正在打的局会收到 `1012` 提示）。
- 单进程：一个 4 人满房约占单核 8%（30Hz 模拟 + 15Hz 快照）。1 核 2G 的 ECS 大约带 8~12 个活跃房间，
  到顶了不是加带宽，而是拆进程做房间分片。
- 榜单是单文件 JSON 全量读写，适合几百到几千条；量级再大要换 SQLite。
- 没有操作审计：谁在什么时候建了什么房间不落盘，只有 `/healthz` 的聚合数字。
