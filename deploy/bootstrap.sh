#!/usr/bin/env bash
# 阿里云 ECS 首次部署脚本（域名 roguetank.i1978.com + Let's Encrypt HTTPS）
#
#   sudo bash deploy/bootstrap.sh
#
# 跑完之后：https://roguetank.i1978.com 就能玩，重启机器自动恢复。
# 重复执行是安全的：已存在的用户/证书/配置不会重复创建。
#
# 前提（脚本会检查）：
#   1. 域名 A 记录已指向本机公网 IP
#   2. 阿里云安全组已放行 80 和 443
#   3. 代码已放在 /opt/roguetank（git clone 或解压压缩包）

set -Eeuo pipefail

DOMAIN="${DOMAIN:-roguetank.i1978.com}"
APP_DIR="${APP_DIR:-/opt/roguetank}"
APP_USER="${APP_USER:-roguetank}"
WEBROOT="/var/www/letsencrypt"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[注意] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[失败] %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/bootstrap.sh"
[[ -f "$APP_DIR/server.mjs" ]] || die "没找到 $APP_DIR/server.mjs，先把代码放到 $APP_DIR"

# ---------------------------------------------------------------- 1. 环境检查
log "检查域名解析"
PUBIP="$(curl -fsS --max-time 5 https://api.ipify.org || true)"
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1; exit}' || true)"
echo "  域名 $DOMAIN → ${RESOLVED:-<未解析>}"
echo "  本机公网 IP → ${PUBIP:-<获取失败>}"
if [[ -z "$RESOLVED" ]]; then
  die "域名还没有解析。去阿里云 DNS 加一条 A 记录：$DOMAIN → 服务器公网 IP，等生效后再跑一次"
fi
if [[ -n "$PUBIP" && "$RESOLVED" != "$PUBIP" ]]; then
  warn "解析到 $RESOLVED，但本机出口 IP 是 $PUBIP。若服务器在 SLB/NAT 后面可忽略，否则证书申请会失败"
fi

# ---------------------------------------------------------------- 2. 依赖
log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# Nginx 用的是 Ubuntu 官方源版本（1.18+ 都支持本配置里的 http2 on 语法差异见下）
apt-get install -y -qq nginx curl ca-certificates gnupg git >/dev/null
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]]; then
  log "安装 Node.js 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "  node $(node -v) / npm $(npm -v)"

# Nginx 1.24 之前没有 `http2 on;`，只有 `listen 443 ssl http2;`
NGX_VER="$(nginx -v 2>&1 | sed 's#.*nginx/##; s/[^0-9.].*//')"
NGX_MAJOR="${NGX_VER%%.*}"
NGX_MINOR="$(echo "$NGX_VER" | cut -d. -f2)"
if [[ "$NGX_MAJOR" -eq 1 && "$NGX_MINOR" -lt 25 ]]; then
  warn "Nginx $NGX_VER 不支持 'http2 on;'，脚本会自动改成 listen 内联写法"
  USE_INLINE_HTTP2=1
else
  USE_INLINE_HTTP2=0
fi

# ---------------------------------------------------------------- 3. 用户与目录
log "准备运行用户与目录"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
  echo "  已创建系统用户 $APP_USER"
fi
mkdir -p "$APP_DIR/.data" "$WEBROOT"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "安装 Node 依赖（只有 ws）"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci --omit=dev" || \
  sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm install --omit=dev"

# ---------------------------------------------------------------- 4. 先起 Node
log "配置 systemd 服务"
install -m 644 "$APP_DIR/deploy/roguetank.service" /etc/systemd/system/roguetank.service
systemctl daemon-reload
systemctl enable roguetank >/dev/null
systemctl restart roguetank
sleep 1.5
if ! curl -fsS --max-time 3 http://127.0.0.1:5173/healthz >/dev/null; then
  journalctl -u roguetank -n 30 --no-pager || true
  die "Node 服务没起来，上面是最近日志"
fi
echo "  $(curl -fsS http://127.0.0.1:5173/healthz)"

# ---------------------------------------------------------------- 5. 先出 HTTP 站点（给证书验证用）
log "写入 Nginx 配置"
mkdir -p /etc/nginx/conf.d
install -m 644 "$APP_DIR/deploy/nginx.conf" /etc/nginx/conf.d/roguetank.conf

if [[ "$USE_INLINE_HTTP2" -eq 1 ]]; then
  sed -i 's/^\(\s*\)listen 443 ssl;/\1listen 443 ssl http2;/; s/^\(\s*\)listen \[::\]:443 ssl;/\1listen [::]:443 ssl http2;/; /^\s*http2 on;\s*$/d' \
    /etc/nginx/conf.d/roguetank.conf
fi

# 证书还没申请时，443 段落指向不存在的文件会让 nginx -t 直接失败。
# 所以首次先用一份"只有 80"的临时配置把 ACME 验证跑通，证书下来后再启用完整配置。
if [[ ! -f "$CERT_DIR/fullchain.pem" ]]; then
  log "尚无证书，先用临时配置申请证书"
  cat > /etc/nginx/conf.d/roguetank.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location / { root $WEBROOT; }
}
EOF
  # 站点还没起 HTTPS，先让 80 直接指向 Node，至少域名能访问
  cat > /etc/nginx/conf.d/roguetank.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
EOF
  nginx -t || die "临时 Nginx 配置有语法错误"
  systemctl reload nginx || systemctl restart nginx

  log "申请 Let's Encrypt 证书"
  apt-get install -y -qq certbot >/dev/null
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
    --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring \
    || die "证书申请失败：多半是 80 端口没放行，或域名还没解析到本机。用 'curl -I http://$DOMAIN/.well-known/acme-challenge/test' 自查"

  # 证书到位，换成完整配置
  install -m 644 "$APP_DIR/deploy/nginx.conf" /etc/nginx/conf.d/roguetank.conf
  if [[ "$USE_INLINE_HTTP2" -eq 1 ]]; then
    sed -i 's/^\(\s*\)listen 443 ssl;/\1listen 443 ssl http2;/; s/^\(\s*\)listen \[::\]:443 ssl;/\1listen [::]:443 ssl http2;/; /^\s*http2 on;\s*$/d' \
      /etc/nginx/conf.d/roguetank.conf
  fi
fi

# ---------------------------------------------------------------- 6. 自动续期
log "配置证书自动续期"
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
nginx -t && systemctl reload nginx
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
systemctl enable --now certbot.timer >/dev/null 2>&1 || true

# ---------------------------------------------------------------- 7. 校验
log "校验完整配置"
# 默认站点占着 80 default_server 会干扰，但这里没用 default_server，不冲突
nginx -t || die "Nginx 配置有语法错误"
systemctl reload nginx

log "自测"
sleep 1
echo "  本机 HTTP  → $(curl -s -o /dev/null -w '%{http_code} (跳转 %{redirect_url})' http://127.0.0.1/ -H "Host: $DOMAIN")"
echo "  外网 HTTPS → $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$DOMAIN/" || echo '失败')"
echo "  健康检查   → $(curl -s --max-time 5 "https://$DOMAIN/healthz" || echo '失败')"

cat <<EOF

\033[1;32m部署完成\033[0m

  地址      https://$DOMAIN
  证书到期  $(openssl x509 -enddate -noout -in "$CERT_DIR/fullchain.pem" 2>/dev/null | cut -d= -f2 || echo '未知')
  自动续期  systemctl list-timers certbot.timer

常用命令：
  systemctl status roguetank       # 服务状态
  journalctl -u roguetank -f       # 实时日志
  systemctl restart roguetank      # 重启游戏服务
  bash deploy/update.sh            # 更新代码并重启

EOF
