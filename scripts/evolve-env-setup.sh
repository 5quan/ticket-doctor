#!/usr/bin/env bash
# 自改进交付 C 的运行环境安装（幂等，Ubuntu）。
# 目标：Node 24.9.0 + Python 3.13 + gepa==0.1.4（方案 §5 固定测试环境）。
# 只安装到独立位置（/opt），不改系统默认 node/python，避免影响现有 CI/测试。
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-24.9.0}"
PYPI_SPEC="${GEPA_SPEC:-gepa==0.1.4}"
VENV="${GEPA_VENV:-/opt/venvs/ticket-doctor-gepa}"

echo "[env] 安装 Python 3.13（apt）"
if ! command -v python3.13 >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq python3.13 python3.13-venv python3.13-dev
fi
python3.13 --version

echo "[env] 创建 venv 并安装 ${PYPI_SPEC} → ${VENV}"
python3.13 -m venv "${VENV}"
"${VENV}/bin/pip" install -q --upgrade pip
"${VENV}/bin/pip" install -q "${PYPI_SPEC}"
"${VENV}/bin/python" -c "import gepa; from gepa.core.adapter import GEPAAdapter; print('gepa ok:', [m for m in ('evaluate','make_reflective_dataset') if hasattr(GEPAAdapter, m)])"

echo "[env] 安装 Node ${NODE_VERSION}（独立目录，不覆盖系统 node）"
DEST="/opt/node-v${NODE_VERSION}-linux-x64"
if [ ! -x "${DEST}/bin/node" ]; then
  TAR="node-v${NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSL -o "/tmp/${TAR}" "https://nodejs.org/dist/v${NODE_VERSION}/${TAR}"
  tar -xJf "/tmp/${TAR}" -C /opt
fi
ln -sf "${DEST}/bin/node" /usr/local/bin/node24
ln -sf "${DEST}/bin/npm" /usr/local/bin/npm24
node24 -v

echo "[env] 完成。"
echo "  Node 24.9: ${DEST}/bin/node（别名 node24 / npm24）"
echo "  Python venv: ${VENV}/bin/python"
echo "  验证：node24 -v && ${VENV}/bin/python -c 'import gepa'"
