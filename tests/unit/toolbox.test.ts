// 工具箱：单次结果总量上限，防止信息爆炸。
import assert from "node:assert/strict";
import { test } from "node:test";
import { DiagnosisToolbox } from "../../src/agent/toolbox.ts";
import { EvidenceRegistry } from "../../src/diagnosis/evidence.ts";
import type { LogSource } from "../../src/sources/logs.ts";
import type { MaterialScope } from "../../src/domain/types.ts";

const scope: MaterialScope = { services: ["svc"], repos: [] };

function toolboxWith(logs: LogSource, maxToolResultChars: number): DiagnosisToolbox {
  return new DiagnosisToolbox({
    logs,
    evidence: new EvidenceRegistry("run-1", 4_000),
    scope,
    maxToolCalls: 12,
    maxToolResultChars,
    signal: new AbortController().signal,
  });
}

test("query_logs 结果总量超过预算时截断并提示", async () => {
  const logs: LogSource = {
    name: "stub",
    async query() {
      return Array.from({ length: 20 }, (_, i) => ({
        time: 1_700_000_000_000 + i,
        level: "ERROR",
        message: "x".repeat(500),
      }));
    },
  };
  const toolbox = toolboxWith(logs, 1_000);
  const out = await toolbox.queryLogs({ service: "svc", from: 0, to: 2_000_000_000_000, keywords: [] });

  assert.match(out, /命中 20 条日志/);
  assert.match(out, /结果已截断/);
  assert.ok(out.length < 1_600, `输出应接近预算，实际 ${out.length}`);
});

test("条目较少时不截断", async () => {
  const logs: LogSource = {
    name: "stub",
    async query() {
      return [{ time: 1_700_000_000_000, level: "ERROR", message: "boom" }];
    },
  };
  const toolbox = toolboxWith(logs, 8_000);
  const out = await toolbox.queryLogs({ service: "svc", from: 0, to: 2_000_000_000_000, keywords: [] });
  assert.match(out, /\[E1\]/);
  assert.doesNotMatch(out, /结果已截断/);
});
