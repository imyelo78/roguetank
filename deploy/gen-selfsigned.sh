#!/bin/sh
# 生成自签证书（纯 IP 场景用）
#
# 只有在你想让「复制邀请链接」按钮能用（依赖安全上下文）时才需要。
# 用法：
#   sh gen-selfsigned.sh 1.2.3.4
#
# 产出：
#   certs/tank.key  certs/tank.crt
#
# 然后给 roguetank.service 加：
#   Environment=TLS_CERT=/opt/roguetank/deploy/certs/tank.crt
#   Environment=TLS_KEY=/opt/roguetank/deploy/certs/tank.key
#   Environment=PORT=8443

set -e

IP="$1"
if [ -z "$IP" ]; then
  echo "用法: sh gen-selfsigned.sh <公网IP>" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "没找到 openssl，先装一下：apt-get install -y openssl 或 yum install -y openssl" >&2
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$DIR"

# SAN 必须带 IP，否则 Chrome 会以 ERR_CERT_COMMON_NAME_INVALID 直接拒绝
cat > /tmp/tank-openssl.cnf <<EOF
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[dn]
CN = $IP

[v3_req]
subjectAltName = @alt
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt]
IP.1 = $IP
DNS.1 = localhost
EOF

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$DIR/tank.key" -out "$DIR/tank.crt" \
  -days 3650 -config /tmp/tank-openssl.cnf >/dev/null 2>&1

chmod 600 "$DIR/tank.key"
rm -f /tmp/tank-openssl.cnf

echo "已生成："
echo "  $DIR/tank.crt"
echo "  $DIR/tank.key"
echo ""
echo "接下来："
echo "  1. 给 roguetank.service 加 TLS_CERT / TLS_KEY / PORT=8443"
echo "  2. systemctl daemon-reload && systemctl restart roguetank"
echo "  3. 访问 https://$IP:8443/ ，浏览器警告点「高级 → 继续前往」"
