"""调用 TS 批量评测桥梁 scripts/evolve-batch.ts（stdin JSON → stdout JSON）。

不拼 shell：用参数数组 + stdin。个别执行失败由桥梁记 task_error；系统性失败返回退出码 3。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path


class BridgeError(RuntimeError):
    """桥梁协议/一般错误。"""


class SystematicBridgeError(BridgeError):
    """系统性失败（材料 hash/隔离/加载）——应终止整轮。"""


def node_bin() -> str:
    return os.environ.get("TD_NODE_BIN") or ("node24" if shutil.which("node24") else "node")


def run_batch(project_root: str | Path, request: dict, *, node: str | None = None, timeout: int = 3600) -> dict:
    project_root = Path(project_root)
    script = project_root / "scripts" / "evolve-batch.ts"
    if not script.exists():
        raise SystematicBridgeError(f"缺少桥梁脚本：{script}")
    args = [node or node_bin()]
    if os.environ.get("TD_NODE_STRIP_TYPES", "1") == "1":
        args.append("--experimental-strip-types")
    args.append(str(script))
    proc = subprocess.run(
        args,
        input=json.dumps(request),
        capture_output=True,
        text=True,
        cwd=str(project_root),
        timeout=timeout,
    )
    if proc.returncode != 0:
        last = (proc.stderr or "").strip().splitlines()
        detail = last[-1] if last else "(no stderr)"
        if proc.returncode == 3:
            raise SystematicBridgeError(f"桥梁系统性失败：{detail}")
        raise BridgeError(f"桥梁退出码 {proc.returncode}：{detail}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:  # 协议被破坏
        raise BridgeError(f"桥梁 stdout 不是合法 JSON：{e}") from e
