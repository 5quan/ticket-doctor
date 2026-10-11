"""交付 C 适配器单测（不触网、不跑真实模型）。"""
from __future__ import annotations

import unittest
from pathlib import Path

from tools.evolve.adapter import CaseInst, TicketDoctorAdapter
from tools.evolve.bridge import SystematicBridgeError
from tools.evolve.config import SearchConfig

RAW = {
    "schemaVersion": "rsi-search-config/v0",
    "configId": "test",
    "datasetName": "ds",
    "splits": {"train": ["rcb-001", "rcb-002"], "validation": ["rcb-005"], "holdout": ["rcb-008"]},
    "repeat": 2,
    "budget": {"maxTokens": 1000, "maxUsd": None, "maxWallMs": 1000, "maxTrials": 10},
    "gepa": {"maxCandidates": 12, "maxMetricCalls": 200, "concurrency": 2, "maxNoImprovement": 4, "timeLimitMin": 60},
    "model": {"provider": "deepseek", "model": "deepseek-flash"},
    "candidate": {"component": "diagnosis_rules", "maxChars": 20000, "forbidden": []},
    "selection": {"disallowNewHardFailures": True, "disallowRegressionOnBaselinePassing": True, "minMeanGain": 0.02, "holdoutReserved": True},
}


def make_config() -> SearchConfig:
    return SearchConfig(raw=RAW, path=Path("evolve/config/search-v1.json"))


def fake_runner(seen: list[dict]):
    def _run(_project_root, request: dict) -> dict:
        seen.append(request)
        cases, items = [], []
        for cid in request["caseIds"]:
            scores = [1.0, 0.5] if request["baseline"] else [1.0, 1.0]
            cases.append({
                "caseId": cid, "trials": len(scores), "scored": len(scores),
                "meanScore": sum(scores) / len(scores), "scores": scores,
                "statuses": ["scored"] * len(scores), "hardFailures": [],
            })
            for i, s in enumerate(scores):
                items.append({
                    "caseId": cid, "trialId": f"{cid}-t{i}", "status": "scored", "score": s,
                    "metrics": {"total_tokens": 100}, "hardFailures": [], "output": {"summary": "x"},
                    "feedback": f"反馈 {cid}-{i}",
                })
        return {"cases": cases, "items": items}

    return _run


class AdapterTest(unittest.TestCase):
    def test_evaluate_aligns_with_batch_and_accumulates_tokens(self) -> None:
        seen: list[dict] = []
        adapter = TicketDoctorAdapter(Path("."), make_config(), runner=fake_runner(seen))
        batch = [CaseInst("rcb-001"), CaseInst("rcb-005")]
        out = adapter.evaluate(batch, {"diagnosis_rules": ""}, capture_traces=True)
        self.assertEqual(len(out.outputs), 2)
        self.assertEqual(len(out.scores), 2)
        self.assertEqual(len(out.trajectories), 2)
        self.assertEqual(out.scores[0], 0.75)  # baseline: mean(1.0, 0.5)
        self.assertEqual(out.scores[1], 0.75)
        self.assertEqual(adapter.tokens_used, 400)  # 2 cases × 2 trials × 100
        # 按 split 分组：train 与 validation 各一次调用
        self.assertEqual({r["split"] for r in seen}, {"train", "validation"})
        self.assertTrue(all(r["baseline"] for r in seen))

    def test_candidate_rules_are_not_baseline(self) -> None:
        seen: list[dict] = []
        adapter = TicketDoctorAdapter(Path("."), make_config(), runner=fake_runner(seen))
        adapter.evaluate([CaseInst("rcb-001")], {"diagnosis_rules": "先核对异常栈再判下游"}, capture_traces=False)
        self.assertFalse(seen[0]["baseline"])
        self.assertEqual(seen[0]["rulesText"], "先核对异常栈再判下游")

    def test_holdout_is_rejected(self) -> None:
        adapter = TicketDoctorAdapter(Path("."), make_config(), runner=fake_runner([]))
        with self.assertRaises(SystematicBridgeError):
            adapter.evaluate([CaseInst("rcb-008")], {"diagnosis_rules": ""})

    def test_unknown_case_is_rejected(self) -> None:
        adapter = TicketDoctorAdapter(Path("."), make_config(), runner=fake_runner([]))
        with self.assertRaises(SystematicBridgeError):
            adapter.evaluate([CaseInst("rcb-999")], {"diagnosis_rules": ""})

    def test_reflective_dataset_shape(self) -> None:
        adapter = TicketDoctorAdapter(Path("."), make_config(), runner=fake_runner([]))
        out = adapter.evaluate([CaseInst("rcb-001")], {"diagnosis_rules": ""}, capture_traces=True)
        ds = adapter.make_reflective_dataset({"diagnosis_rules": ""}, out, ["diagnosis_rules"])
        self.assertIn("diagnosis_rules", ds)
        self.assertEqual(len(ds["diagnosis_rules"]), 1)
        rec = ds["diagnosis_rules"][0]
        for key in ("Inputs", "Generated Outputs", "Feedback"):
            self.assertIn(key, rec)
        self.assertIn("rcb-001", rec["Feedback"])


if __name__ == "__main__":
    unittest.main()
