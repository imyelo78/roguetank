#!/usr/bin/env bash
# 更新已部署的线上版本：拉代码 → 装依赖 → 重启 → 自测
#
#   sudo bash deploy/update.sh
#
# 只动 Node 侧，不碰 Nginx 与证书（除非你改了 deploy/nginx.conf，用 --nginx 一并同步）

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/roguetank}"
APP_USER="${APP_USER:-roguetank}"
DOMAIN="${DOMAIN:-roguetank.i1978.com}"
SYNC_NGINX=0
[[ "${1:-}" == "--nginx" ]] && SYNC_NGINX=1

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[失败] %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/update.sh"
cd "$APP_DIR"

BEFORE="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '-')"
log "拉取最新代码（当前 $BEFORE）"
if [[ -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --depth=1 origin main
  sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard origin/main
else
  die "$APP_DIR 不是 git 仓库。用压缩包部署的话，请重新解压覆盖后手动执行 npm ci && systemctl restart roguetank"
fi
AFTER="$(git -C "$APP_DIR" rev-parse --short HEAD)"
echo "  现在 $AFTER"

if [[ "$BEFORE" == "$AFTER" ]]; then
  echo "  没有新提交，仍执行重启（用于清掉长时间运行累积的内存）"
fi

log "安装依赖"
sudo -u "$APP_USER" npm ci --omit=dev

if [[ "$SYNC_NGINX" -eq 1 ]]; then
  log "同步 Nginx 配置"
  install -m 644 deploy/nginx.conf /etc/nginx/conf.d/roguetank.conf
  nginx -t || die "Nginx 配置有误，已保留原文件未 reload"
fi

# 保留榜单数据：.data 在 .gitignore 里，reset --hard 不会碰它
mkdir -p .data && chown -R "$APP_USER:$APP_USER" .data

log "重启服务"
systemctl restart roguetank
sleep 1.5
curl -fsS --max-time 3 http://127.0.0.1:5173/healthz || { journalctl -u roguetank -n 40 --no-pager; die "健康检查失败"; }

[[ "$SYNC_NGINX" -eq 1 ]] && systemctl reload nginx

log "自测"
echo "  https://$DOMAIN/        → $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$DOMAIN/" || echo 失败)"
echo "  https://$DOMAIN/healthz → $(curl -s --max-time 5 "https://$DOMAIN/healthz" || echo 失败)"

printf '\n\033[1;32m更新完成：%s → %s\033[0m\n' "$BEFORE" "$AFTER"
