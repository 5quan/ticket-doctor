"""反射 LM：调用 DeepSeek 的 OpenAI 兼容接口（仅标准库，无额外依赖）。

GEPA 的 reflection_lm 需要 `(prompt: str | list[dict]) -> str` 可调用对象。
"""
from __future__ import annotations

import json
import os
import urllib.request

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"


class DeepSeekLM:
    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: int = 180,
        temperature: float = 0.7,
    ) -> None:
        self.model = model or os.environ.get("GEPA_REFLECTION_MODEL") or DEFAULT_MODEL
        self.api_key = api_key or os.environ.get("DEEPSEEK_API_KEY")
        if not self.api_key:
            raise RuntimeError("缺少 DEEPSEEK_API_KEY（反射 LM 需要）")
        self.base_url = (base_url or os.environ.get("DEEPSEEK_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.temperature = temperature
        # gepa 的 TrackingLM 会检查该属性；提供后不再二次包装。
        self.total_cost = 0.0

    def __call__(self, prompt: str | list[dict]) -> str:
        messages = [{"role": "user", "content": prompt}] if isinstance(prompt, str) else prompt
        body = json.dumps({"model": self.model, "messages": messages, "temperature": self.temperature}).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=body,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"]
