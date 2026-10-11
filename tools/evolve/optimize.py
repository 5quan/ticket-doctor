"""GEPA 搜索入口（交付 C）。

用法（在仓库根）：
  /opt/venvs/ticket-doctor-gepa/bin/python -m tools.evolve.optimize \
      --config evolve/config/search-v1.json \
      [--seed-rules <file>] [--max-metric-calls N] [--out data/evolve/gepa/run1]

前置：`npm run evolve:config:verify` 通过（本入口默认先跑一次，失败即停）。
候选只含 {"diagnosis_rules": 规则全文}；诊断与评分全部走 TS 桥梁。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import gepa

from .adapter import CaseInst, TicketDoctorAdapter
from .config import load_config
from .reflection import DeepSeekLM

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class MaxTokensStopper:
    """累计 token 超预算即停（trial 间生效；不是每次请求硬拦截，见方案 §8）。"""

    def __init__(self, adapter: TicketDoctorAdapter, max_tokens: int) -> None:
        self.adapter = adapter
        self.max_tokens = max_tokens

    def __call__(self, _state) -> bool:  # noqa: ANN001
        return self.adapter.tokens_used >= self.max_tokens


def verify_config(project_root: Path, node: str) -> None:
    proc = subprocess.run(
        [node, "--experimental-strip-types", str(project_root / "scripts" / "evolve-config.ts"), "verify"],
        cwd=str(project_root),
        capture_output=True,
        text=True,
        timeout=300,
    )
    sys.stderr.write(proc.stdout)
    if proc.returncode != 0:
        raise SystemExit(f"搜索配置校验失败：{proc.stderr.strip() or proc.stdout.strip()}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project-root", default=str(PROJECT_ROOT))
    ap.add_argument("--config", default="evolve/config/search-v1.json")
    ap.add_argument("--seed-rules", default=None, help="初始规则文件（缺省=空，即当前生产内置提示词）")
    ap.add_argument("--max-metric-calls", type=int, default=None)
    ap.add_argument("--reflection-model", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--skip-verify", action="store_true")
    args = ap.parse_args(argv)

    project_root = Path(args.project_root).resolve()
    config = load_config(args.config, project_root)
    if not args.skip_verify:
        verify_config(project_root, __import__("os").environ.get("TD_NODE_BIN") or "node24")

    out = Path(args.out) if args.out else project_root / "data" / "evolve" / "gepa" / f"{config.raw['configId']}-{int(time.time())}"
    out.mkdir(parents=True, exist_ok=True)

    seed_rules = ""
    if args.seed_rules:
        seed_rules = Path(args.seed_rules).read_text(encoding="utf-8").strip()
    seed_candidate = {"diagnosis_rules": seed_rules}

    adapter = TicketDoctorAdapter(project_root, config, run_id_prefix=config.raw["configId"])
    trainset = [CaseInst(c) for c in config.train]
    valset = [CaseInst(c) for c in config.validation]
    budget_tokens = int(config.budget.get("maxTokens") or 0)
    max_metric_calls = args.max_metric_calls or int(config.gepa.get("maxMetricCalls") or 0) or None

    stoppers = []
    if budget_tokens > 0:
        stoppers.append(MaxTokensStopper(adapter, budget_tokens))

    reflection_lm = DeepSeekLM(model=args.reflection_model)
    print(f"[optimize] config={config.raw['configId']} train={len(trainset)} val={len(valset)} "
          f"repeat={config.repeat} max_metric_calls={max_metric_calls} budget_tokens={budget_tokens}", file=sys.stderr)

    result = gepa.optimize(
        seed_candidate=seed_candidate,
        trainset=trainset,
        valset=valset,
        adapter=adapter,
        reflection_lm=reflection_lm,
        max_metric_calls=max_metric_calls,
        candidate_selection_strategy="pareto",
        run_dir=str(out / "gepa"),
        display_progress_bar=False,
        stop_callbacks=stoppers,
    )

    seed_scores = list(result.val_subscores[0]) if result.val_subscores else []
    best_idx = result.best_idx
    best_scores = list(result.val_subscores[best_idx]) if result.val_subscores else []
    baseline_mean = sum(seed_scores) / len(seed_scores) if seed_scores else 0.0
    best_mean = float(result.val_aggregate_scores[best_idx]) if result.val_aggregate_scores else 0.0
    gain = best_mean - baseline_mean
    regressions = [config.validation[i] for i in range(len(seed_scores)) if seed_scores[i] >= 1.0 and best_scores[i] < 1.0]
    min_gain = float(config.raw.get("selection", {}).get("minMeanGain", 0.0))
    verdict = "adopt-candidate" if (gain >= min_gain and not regressions) else "keep-baseline"

    best_rules = str(result.best_candidate.get("diagnosis_rules", ""))
    (out / "best-rules.md").write_text(best_rules + "\n", encoding="utf-8")
    report = {
        "configId": config.raw["configId"],
        "seedRules": seed_rules,
        "bestRules": best_rules,
        "seedValMean": baseline_mean,
        "bestValMean": best_mean,
        "gain": gain,
        "regressions": regressions,
        "verdict": verdict,
        "tokensUsed": adapter.tokens_used,
        "budgetTokens": budget_tokens,
        "totalMetricCalls": result.total_metric_calls,
        "numCandidates": result.num_candidates,
        "valScores": list(result.val_aggregate_scores),
        "runDir": str(out),
        "candidateTree": result.candidate_tree_dot if hasattr(result, "candidate_tree_dot") else None,
    }
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("verdict", "seedValMean", "bestValMean", "gain", "regressions", "tokensUsed", "totalMetricCalls", "numCandidates")}, ensure_ascii=False))
    print(f"[optimize] 制品：{out}（report.json / best-rules.md）", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
