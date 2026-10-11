#!/usr/bin/env bash
# 旧机：打包迁移资产（含密钥，注意保密；默认不含 3.2G Langfuse 数据卷）。
#
# 用法：
#   bash scripts/migrate-export.sh [--with-data] [--with-langfuse] [--with-images] [-o OUT]
#
#   （默认）       3 个密钥文件 + compose/unit（可重建，但图省事一并带上）
#   --with-data   追加 Host 运行数据 data/（SQLite/会话/评测，约 100M）
#   --with-langfuse 追加 Langfuse 命名卷（约 3.2G；会先 down compose）
#   --with-images docker save Langfuse 六个镜像（新机无法拉镜像时用）
#
# 产物：OUT（默认 /tmp/ticket-doctor-migration-<date>.tar.gz）+ 打印 sha256。
set -euo pipefail

ROOT="${TD_ROOT:-/opt/ticket-doctor}"
OUT="/tmp/ticket-doctor-migration-$(date +%Y%m%d).tar.gz"
WITH_DATA=0; WITH_LANGFUSE=0; WITH_IMAGES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --with-data) WITH_DATA=1;;
    --with-langfuse) WITH_LANGFUSE=1;;
    --with-images) WITH_IMAGES=1;;
    -o) OUT="$2"; shift;;
    *) echo "未知参数：$1" >&2; exit 2;;
  esac
  shift
done

[ -d "$ROOT" ] || { echo "找不到仓库：$ROOT（用 TD_ROOT 指定）" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/secrets" "$STAGE/deploy-langfuse" "$STAGE/systemd"

echo "[export] 收集密钥文件（权限保持 600）"
install -m600 "$ROOT/.env" "$STAGE/secrets/host.env"
[ -f /etc/ticket-doctor-adapter.env ] && install -m600 /etc/ticket-doctor-adapter.env "$STAGE/secrets/adapter.env" || echo "  ! 缺 /etc/ticket-doctor-adapter.env（新机需另填）"
[ -f "$ROOT/deploy/langfuse/.env" ] && install -m600 "$ROOT/deploy/langfuse/.env" "$STAGE/secrets/langfuse.env" || echo "  ! 缺 deploy/langfuse/.env（新机空库可重建）"

echo "[export] 收集 compose 与 systemd 单元"
cp -a "$ROOT/deploy/langfuse/compose.yml" "$ROOT/deploy/langfuse/compose.mirror.cn.yml" "$STAGE/deploy-langfuse/"
cp -a "$ROOT/deploy/systemd/." "$STAGE/systemd/"

if [ "$WITH_DATA" = 1 ]; then
  echo "[export] 打包 data/（Host 运行数据）"
  tar -C "$ROOT" -czf "$STAGE/data.tgz" data
fi

if [ "$WITH_LANGFUSE" = 1 ]; then
  echo "[export] 停 Langfuse 并打包命名卷（约 3.2G）"
  ( cd "$ROOT/deploy/langfuse" && docker compose --env-file .env -f compose.yml -f compose.mirror.cn.yml down ) || true
  tar -C /data/docker/volumes -czf "$STAGE/langfuse-volumes.tgz" \
    langfuse_langfuse_postgres_data langfuse_langfuse_clickhouse_data \
    langfuse_langfuse_clickhouse_logs langfuse_langfuse_minio_data langfuse_langfuse_redis_data
fi

if [ "$WITH_IMAGES" = 1 ]; then
  echo "[export] docker save 六个镜像（体积较大，可选）"
  docker save -o "$STAGE/langfuse-images.tar" \
    m.daocloud.io/docker.io/langfuse/langfuse:4.50.0 \
    m.daocloud.io/docker.io/langfuse/langfuse-worker:4.50.0 \
    m.daocloud.io/docker.io/clickhouse/clickhouse-server:25.12 \
    m.daocloud.io/docker.io/library/postgres:17 \
    m.daocloud.io/docker.io/library/redis:7 \
    cgr.dev/chainguard/minio:latest
fi

echo "[export] 生成 $OUT"
tar -C "$STAGE" -czf "$OUT" .
( cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" )
echo "[export] 完成。含密钥，请走加密通道传输（scp/rsync），用后删除。"
