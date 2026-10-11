"""读取冻结搜索配置（evolve/config/search-v1.json）。

只做读取与字段校验；不做 hash 校验（那由 `npm run evolve:config:verify` 在 optimize 前跑）。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SearchConfig:
    raw: dict
    path: Path

    @property
    def dataset_name(self) -> str:
        return self.raw["datasetName"]

    @property
    def train(self) -> list[str]:
        return list(self.raw["splits"]["train"])

    @property
    def validation(self) -> list[str]:
        return list(self.raw["splits"]["validation"])

    @property
    def holdout(self) -> list[str]:
        return list(self.raw["splits"]["holdout"])

    @property
    def repeat(self) -> int:
        return int(self.raw["repeat"])

    @property
    def budget(self) -> dict:
        return dict(self.raw["budget"])

    @property
    def gepa(self) -> dict:
        return dict(self.raw["gepa"])

    @property
    def model(self) -> dict:
        return dict(self.raw["model"])

    def split_of(self, case_id: str) -> str | None:
        for split in ("train", "validation", "holdout"):
            if case_id in self.raw["splits"][split]:
                return split
        return None


def load_config(path: str | Path, project_root: str | Path) -> SearchConfig:
    p = Path(path)
    if not p.is_absolute():
        p = Path(project_root) / p
    raw = json.loads(p.read_text(encoding="utf-8"))
    if raw.get("schemaVersion") != "rsi-search-config/v0":
        raise ValueError(f"非法搜索配置 schemaVersion：{raw.get('schemaVersion')!r}")
    for key in ("datasetName", "splits", "repeat", "budget", "gepa", "model"):
        if key not in raw:
            raise ValueError(f"搜索配置缺少字段：{key}")
    return SearchConfig(raw=raw, path=p)
