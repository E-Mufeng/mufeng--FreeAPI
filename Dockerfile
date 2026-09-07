# Free API 工作台 — 容器化部署（Task D）
#
# 构建（本地）：
#   docker build -t free-api-workbench .
# 运行：
#   docker run -d --name free-api -p 8787:8787 \
#     -v /path/to/your/config.json:/app/proxy/config.json \
#     free-api-workbench
#
# 说明：
#   - 代理默认监听 127.0.0.1；容器内需对外暴露时，把 config.json 的 host 改为 0.0.0.0 再挂载。
#   - 若挂载的 config.json 缺失，代理会从 config.example.json 自动生成默认配置（见 proxy 首次启动引导）。
#   - 密钥仅在本机 config.json，绝不进镜像（.dockerignore 已排除 proxy/config.json）。
#   - better-sqlite3 为原生模块：runtime 阶段装 python3/make/g++ 兜底源码编译，确保预编译缺失也能用。

# ---------------- 构建阶段 ----------------
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------------- 运行阶段 ----------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# better-sqlite3 原生编译兜底（linux 无预编译包时源码编译必然成功）
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY proxy ./proxy
COPY catalog ./catalog
COPY build.js ./build.js
COPY src ./src
COPY index.html ./index.html
COPY start.sh ./start.sh

# 非 root 运行，降低容器逃逸风险
RUN useradd -m -s /usr/sbin/nologin appuser \
  && mkdir -p proxy/logs \
  && chown -R appuser:appuser /app
USER appuser

EXPOSE 8787

# 健康探活：直连本容器代理的 /health（v0.11.0 起提供，免鉴权）。
# 默认代理监听 127.0.0.1:8787；若用 PORT/HOST 环境变量改了监听地址，需同步调整此处 URL。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})" || exit 1

CMD ["node", "proxy/proxy.js"]
