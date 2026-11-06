# 《钢铁突击》腾讯云部署说明（纯 IP 访问）

> 场景：只有公网 IP、没有域名。本机/服务器用 Node 直接对外提供全站。
> 所有文件都在项目的 `deploy/` 目录下，按顺序照着做即可。

---

## 一、先说结论：纯 IP 能做什么、不能做什么

| 能力 | 纯 IP + HTTP | 纯 IP + 自签 HTTPS |
| --- | --- | --- |
| 打开游戏、单人玩 | ✅ | ✅ |
| 4 人组队联机 | ✅ | ✅ |
| 榜单读写 | ✅ | ✅ |
| 复制邀请链接按钮 | ⚠️ 降级为手动复制（`execCommand`） | ✅ 正常 |
| 浏览器地址栏 | 显示「不安全」 | 显示「不安全」（自签证书不被信任） |
| 朋友第一次打开 | 直接能进 | 要点一次「高级 → 继续访问」 |

**建议先用 HTTP 直连**，跑通了再说别的。自签 HTTPS 的唯一好处是剪贴板 API 能用，代价是每个人第一次都要点一次警告，反而更麻烦。

---

## 二、服务器侧需要什么

| 项 | 要求 |
| --- | --- |
| 系统 | Ubuntu 20.04+ / Debian 11+ / CentOS 7+ / TencentOS 均可 |
| Node | **18 以上**（推荐 20 LTS） |
| 依赖 | 只有 `ws` 一个，`npm ci` 即可 |
| 安全组 | 放行 **你自己定的端口**（默认 8080）；22 只对你自己的 IP 开放 |
| 内存 | 512MB 够用；1GB 更稳 |
| 带宽 | 1Mbps 能玩（每房下行 13KB/s），人多了要加 |

---

## 三、部署步骤（三种方式，选一种）

### 方式 A：打包上传（推荐，不需要 git）

**本地（或我这边）已经打好包：`roguetank-server.tar.gz`**

```bash
# 1. 上传到服务器（在你自己的电脑上执行）
scp roguetank-server.tar.gz root@<服务器IP>:/opt/

# 2. 登录服务器
ssh root@<服务器IP>

# 3. 解包
mkdir -p /opt/roguetank && tar -xzf /opt/roguetank-server.tar.gz -C /opt/roguetank
cd /opt/roguetank

# 4. 装依赖（只有 ws）
npm ci --omit=dev

# 5. 前台试跑，确认能起来
PORT=8080 node server.mjs
# 浏览器打开 http://<服务器IP>:8080/ 看看能不能进主菜单
# 看到 "钢铁突击 · 联机服务已启动" 就是成功，Ctrl+C 停掉
```

**装成系统服务（开机自启、崩溃自动拉起来）：**

```bash
# 复制项目自带的 service 文件
cp deploy/roguetank.service /etc/systemd/system/

# 如果你的端口不是 8080，或者路径不是 /opt/roguetank，改这两个地方：
nano /etc/systemd/system/roguetank.service

systemctl daemon-reload
systemctl enable --now roguetank

# 看状态和日志
systemctl status roguetank
journalctl -u roguetank -f
```

**防火墙放行端口：**

```bash
# 有 firewalld（CentOS / TencentOS）
firewall-cmd --permanent --add-port=8080/tcp && firewall-cmd --reload

# 有 ufw（Ubuntu）
ufw allow 8080/tcp

# 云控制台的「安全组」也要放行 8080/TCP，这一步最容易漏
```

### 方式 B：从 GitHub 拉（服务器能访问 GitHub 时）

```bash
yum install -y git || apt-get install -y git
git clone https://github.com/imyelo78/roguetank.git /opt/roguetank
cd /opt/roguetank
npm ci --omit=dev
cp deploy/roguetank.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now roguetank
```

### 方式 C：不装 Node，用 Docker

```bash
cd /opt/roguetank
docker build -t roguetank -f deploy/Dockerfile .
docker run -d --name roguetank --restart=always -p 8080:8080 -v /opt/roguetank-data:/app/.data roguetank
```

> `.data` 一定要挂出来，否则容器重建后榜单就丢了。

---

## 四、验证清单

部署完按这个表逐项过：

```bash
# 1. 健康检查
curl http://127.0.0.1:8080/healthz
# 期望：{"ok":true,"uptime":12,"rooms":0,"players":0,"rssMB":42}

# 2. 首页
curl -I http://127.0.0.1:8080/
# 期望：HTTP/1.1 200 OK，Content-Type: text/html

# 3. 304 缓存是否生效（第二次请求应回 304）
curl -I http://127.0.0.1:8080/src/Game.js
curl -I -H 'If-None-Match: <上一步返回的 ETag>' http://127.0.0.1:8080/src/Game.js
# 期望：HTTP/1.1 304 Not Modified

# 4. 榜单接口
curl http://127.0.0.1:8080/api/scores
# 期望：{"ok":true,"day":...,"all":...}
```

浏览器端：

- [ ] `http://<IP>:8080/` 能进主菜单
- [ ] 单人打一局，结算后榜上有名
- [ ] **两个浏览器**（或两台设备）组队：A 建房拿房间码 → B 输码加入 → 双方进战场
- [ ] 游戏内按 `F3`，看 `snap` 稳定在 14~15、`停顿` 为 0、`ping` 是个位数或十几
- [ ] 关掉一个浏览器，另一个人不会看到不动的幽灵坦克

---

## 五、日常运维

| 操作 | 命令 |
| --- | --- |
| 看状态 | `systemctl status roguetank` |
| 看实时日志 | `journalctl -u roguetank -f` |
| 重启（会踢掉当前对局） | `systemctl restart roguetank` |
| 停服 | `systemctl stop roguetank` |
| 看当前房间 | `curl http://127.0.0.1:8080/api/rooms` |
| 备份榜单 | `cp /opt/roguetank/.data/scores.json /root/scores-$(date +%F).json` |
| 更新代码 | `cd /opt/roguetank && tar -xzf 新包.tar.gz && systemctl restart roguetank` |

**重启时会不会踢人？** 会的，但现在是「优雅退出」：先给所有人发一条 `server-restart` 关闭帧，客户端走正常的断线提示，而不是卡死。整个过程约 1.5 秒。

---

## 六、可选：换成自签 HTTPS

只有当你在意「复制邀请链接」按钮能正常工作时才需要。

```bash
# 1. 生成自签证书（10 年有效，CN 填你的公网 IP）
cd /opt/roguetank/deploy
sh gen-selfsigned.sh <你的公网IP>
# 产出 certs/tank.key 与 certs/tank.crt

# 2. 直接把 TLS 交给 Node（不需要 Nginx）
#    改 service 文件，加上这两个环境变量：
#    Environment=TLS_CERT=/opt/roguetank/deploy/certs/tank.crt
#    Environment=TLS_KEY=/opt/roguetank/deploy/certs/tank.key
#    然后把端口改成 8443
systemctl daemon-reload && systemctl restart roguetank
```

访问 `https://<IP>:8443/`，浏览器会警告「证书不受信任」，点「高级 → 继续前往」即可。

> 注意：自签证书下 `wss` 能握手（浏览器会为已接受的例外放行），组队正常。但每个新设备第一次都要点一次警告。

---

## 七、如果以后有了域名

改两处就行，代码不用动：

1. 域名 A 记录指向这台机器
2. `deploy/nginx.conf` 里把 `server_name` 改掉，用 certbot 申请免费证书，然后：
   - `HOST=127.0.0.1 PORT=5173` 起 Node
   - Nginx 监听 80/443 反代过去

Nginx 配置已经在 `deploy/nginx.conf` 里写好了，届时直接 `cp` 过去即可。

---

## 八、排障速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 浏览器打不开 `http://IP:8080` | 安全组没放行 | 云控制台 → 安全组 → 入方向加 8080/TCP |
| 能打开但组队提示「连不上联机服务」 | 端口通了但 WebSocket 被拦 | 检查是否用了 CDN / 反向代理却没透传 `Upgrade` 头 |
| `systemctl status` 显示 `inactive (dead)` | 启动即崩，看日志 | `journalctl -u roguetank -n 50 --no-pager` |
| 日志刷 `EADDRINUSE` | 端口被占 | `ss -lntp \| grep 8080` 找占用进程 |
| 游戏很卡但 F3 显示 fps 正常、snap 正常 | 客户端网络差 | 看 F3 的 `ping`，高了就是链路问题 |
| 游戏很卡且 F3 的 snap 掉到 12 以下 | 服务器 CPU 吃满 | `top` 看 node 占用；减少同时房间数或升配 |
| 榜单不更新 | `.data` 目录无写权限 | `chown -R roguetank:roguetank /opt/roguetank/.data` |
