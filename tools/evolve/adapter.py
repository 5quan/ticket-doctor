"""GEPAAdapter 实现：把 GEPA 的候选规则映射到 TS 桥梁的一次批量评测。

契约要点（方案 §6.1/§6.2）：
  * 候选只含一个组件 {"diagnosis_rules": 规则全文}；基础 prompt 由桥梁拼接，不重复注入。
  * repeat 不改变 batch 长度：一个 case 一个均值分，全部原始 trial 存进 trajectory。
  * 个别失败由桥梁记 task_error（分数 0），不抛异常；系统性失败抛 SystematicBridgeError。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .bridge import SystematicBridgeError, run_batch
from .config import SearchConfig


@dataclass(frozen=True)
class CaseInst:
    """GEPA DataInst：一个案例。"""

    caseId: str


def _case_id(inst: Any) -> str:
    if isinstance(inst, CaseInst):
        return inst.caseId
    if isinstance(inst, dict):
        return str(inst["caseId"])
    return str(getattr(inst, "caseId"))


class TicketDoctorAdapter:
    """GEPAAdapter 的结构子类型（鸭子类型，无需继承 Protocol）。"""

    def __init__(
        self,
        project_root: str | Path,
        config: SearchConfig,
        *,
        runner: Callable[[str | Path, dict], dict] = run_batch,
        run_id_prefix: str = "gepa",
        budget_mode: str = "monitor",
    ) -> None:
        self.project_root = Path(project_root)
        self.config = config
        self.runner = runner
        self.run_id_prefix = run_id_prefix
        self.budget_mode = budget_mode
        self._seq = 0
        self.tokens_used = 0
        # 供 make_reflective_dataset 取回最近一次 evaluate 的逐 trial（trajectory 已足够，这里仅兜底）。
        self._last_items: dict[str, list[dict]] = {}

    def evaluate(self, batch: list[Any], candidate: dict[str, str], capture_traces: bool = False):
        from gepa.core.adapter import EvaluationBatch

        rules = str(candidate.get("diagnosis_rules", ""))
        baseline = rules.strip() == ""
        by_split: dict[str, list[str]] = {}
        for inst in batch:
            cid = _case_id(inst)
            split = self.config.split_of(cid)
            if split is None:
                raise SystematicBridgeError(f"案例 {cid} 不在冻结搜索配置的划分里")
            if split == "holdout":
                raise SystematicBridgeError(f"holdout 案例不得参与搜索：{cid}")
            by_split.setdefault(split, []).append(cid)

        cases: dict[str, dict] = {}
        items_by_case: dict[str, list[dict]] = {}
        for split, ids in by_split.items():
            self._seq += 1
            request = {
                "runId": f"{self.run_id_prefix}-{split}-{self._seq}",
                "candidateId": "baseline" if baseline else "candidate",
                "baseline": baseline,
                "rulesText": rules,
                "caseIds": ids,
                "split": split,
                "repeat": self.config.repeat,
                "captureTraces": capture_traces,
                "budget": self.config.budget,
                "budgetMode": self.budget_mode,
            }
            out = self.runner(self.project_root, request)
            for c in out.get("cases", []):
                cases[c["caseId"]] = c
            for it in out.get("items", []):
                items_by_case.setdefault(it["caseId"], []).append(it)
                self.tokens_used += int((it.get("metrics") or {}).get("total_tokens") or 0)

        outputs: list[dict] = []
        scores: list[float] = []
        trajectories: list[dict] | None = [] if capture_traces else None
        for inst in batch:
            cid = _case_id(inst)
            c = cases.get(cid)
            mean = c.get("meanScore") if c else None
            payload = {
                "caseId": cid,
                "meanScore": mean,
                "scores": (c or {}).get("scores", []),
                "hardFailures": (c or {}).get("hardFailures", []),
                "trials": items_by_case.get(cid, []),
            }
            outputs.append(payload)
            scores.append(float(mean) if mean is not None else 0.0)
            if trajectories is not None:
                trajectories.append(payload)
        self._last_items = items_by_case

        num_metric_calls = sum(len(v) for v in items_by_case.values()) or len(batch)
        return EvaluationBatch(outputs=outputs, scores=scores, trajectories=trajectories, num_metric_calls=num_metric_calls)

    def make_reflective_dataset(self, candidate: dict[str, str], eval_batch, components_to_update: list[str]) -> dict[str, list[dict]]:
        records: list[dict] = []
        for traj in eval_batch.trajectories or []:
            cid = traj.get("caseId")
            outputs_text: list[Any] = []
            feedback_lines: list[str] = []
            for tr in traj.get("trials", []):
                outputs_text.append(tr.get("output"))
                fb = str(tr.get("feedback", ""))
                hard = tr.get("hardFailures") or []
                if hard:
                    fb += f"；硬失败：{','.join(hard)}"
                feedback_lines.append(f"[{tr.get('trialId')}] score={tr.get('score')} {fb}")
            records.append(
                {
                    "Inputs": {"caseId": cid},
                    "Generated Outputs": outputs_text,
                    "Feedback": "\n".join(feedback_lines),
                    "score": traj.get("meanScore"),
                }
            )
        # 只优化一个组件；components_to_update 正常就是 ["diagnosis_rules"]。
        comps = components_to_update or ["diagnosis_rules"]
        return {comp: records for comp in comps}
