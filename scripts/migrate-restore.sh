#!/usr/bin/env bash
# 新机：解包迁移资产并部署（配合 scripts/migrate-export.sh）。
#
# 前置：
#   1) 已 clone 仓库到 /opt/ticket-doctor 并 git checkout main、npm ci
#   2) 已装 Docker/Compose、Node 22、Go（仅重建适配器需要）
# 用法：
#   sudo bash scripts/migrate-restore.sh <bundle.tar.gz> [--with-langfuse]
#
# 会：装 3 个密钥文件(600) →（可选）恢复 data/ 与 Langfuse 卷 → 起 Langfuse →
#     装 systemd 单元并启动 host/adapter → 打印需你手改的 IP 相关项。
set -euo pipefail

ROOT="${TD_ROOT:-/opt/ticket-doctor}"
BUNDLE="${1:?用法: migrate-restore.sh <bundle.tar.gz> [--with-langfuse]}"
WITH_LANGFUSE=0
[ "${2:-}" = "--with-langfuse" ] && WITH_LANGFUSE=1

[ -d "$ROOT" ] || { echo "先在 $ROOT clone 仓库" >&2; exit 1; }
[ -f "$BUNDLE" ] || { echo "找不到 bundle：$BUNDLE" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$BUNDLE" -C "$STAGE"

echo "[restore] 安装密钥（600）"
install -m600 "$STAGE/secrets/host.env" "$ROOT/.env"
[ -f "$STAGE/secrets/adapter.env" ] && install -m600 "$STAGE/secrets/adapter.env" /etc/ticket-doctor-adapter.env
if [ -f "$STAGE/secrets/langfuse.env" ]; then
  mkdir -p "$ROOT/deploy/langfuse"
  install -m600 "$STAGE/secrets/langfuse.env" "$ROOT/deploy/langfuse/.env"
fi

if [ -f "$STAGE/data.tgz" ]; then
  echo "[restore] 恢复 Host 运行数据 data/"
  tar -xzf "$STAGE/data.tgz" -C "$ROOT"
fi

if [ "$WITH_LANGFUSE" = 1 ] && [ -f "$STAGE/langfuse-volumes.tgz" ]; then
  echo "[restore] 恢复 Langfuse 命名卷（需 Docker 数据根为空/无同名卷）"
  DOCKER_ROOT="$(docker info -f '{{.DockerRootDir}}')"
  mkdir -p "$DOCKER_ROOT/volumes"
  tar -xzf "$STAGE/langfuse-volumes.tgz" -C "$DOCKER_ROOT/volumes"
fi

echo "[restore] 启动 Langfuse 六容器"
( cd "$ROOT/deploy/langfuse" \
  && docker compose --env-file .env -f compose.yml -f compose.mirror.cn.yml up -d )

echo "[restore] 装 systemd 单元并启动 Host/Adapter"
cp "$ROOT/deploy/systemd/"*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ticket-doctor-host ticket-doctor-adapter

cat <<'EOF'

[restore] 完成。还需你手动确认：
  1) deploy/langfuse/.env 的 NEXTAUTH_URL、两个 MINIO *_ENDPOINT 改成新机地址（或 localhost + SSH 隧道），
     改完 `docker compose ... up -d` 重建 web。
  2) 若走 webhook 模式（非长连接），更新飞书后台回调地址；长连接模式无需改。
  3) 安全组放行：3000（Host）、3001（Langfuse）、19090（MinIO，仅用附件时）。
  4) 验证：
       curl -s http://127.0.0.1:3000/api/agent/capabilities
       curl -s http://127.0.0.1:3001/api/public/health
       journalctl -u ticket-doctor-adapter -n 20 --no-pager   # 应见「已启动长连接事件源」
EOF
