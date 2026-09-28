# Host / Runner 运行镜像。
# 注意：应用代码与 Node 运行时打进镜像；被诊断的源码与日志运行时只读挂载（见 docker-compose.yml）。
FROM node:22-bookworm-slim

# git：源码工具在只读仓库镜像上执行 git ls-tree/grep/show。
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
COPY fixtures ./fixtures

ENV NODE_ENV=production \
    TD_DATA_DIR=/data \
    TD_HOST=0.0.0.0 \
    TD_HOST_PORT=3000

VOLUME ["/data"]
EXPOSE 3000

# 生产默认独立 Runner 子进程；飞书由 Go 接入适配器转发（TD_FEISHU_DIRECT=false）。
CMD ["npm", "run", "host"]
