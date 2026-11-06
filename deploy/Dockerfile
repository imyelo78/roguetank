# 极简镜像：只跑 server.mjs，不需要构建步骤（前端是原生 ES Module，直接托管）
FROM node:20-alpine

WORKDIR /app

# 先只装依赖，利用镜像层缓存：代码改动不会导致重装 node_modules
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# 榜单落盘目录，运行时用 -v 挂出来，否则容器重建即丢分
RUN mkdir -p /app/.data
VOLUME ["/app/.data"]

# 容器内监听 0.0.0.0，宿主机通过 -p 映射
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

# 用非 root 用户运行
RUN addgroup -S tank && adduser -S tank -G tank && chown -R tank:tank /app
USER tank

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.mjs"]
