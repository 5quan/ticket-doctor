// 冻结搜索配置测试：结构、坐标比对、split 隔离/准入一致性。
import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSearchConfig, verifySearchConfig, type SearchConfig, type SearchState } from "../../src/evolve/config.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function cfg(over: Partial<SearchConfig> = {}): SearchConfig {
  return {
    schemaVersion: "rsi-search-config/v0",
    configId: "test",
    frozenAt: "2026-10-11",
    datasetName: "ds",
    basePromptHash: "a".repeat(64),
    scorerHash: "b".repeat(64),
    rubricsSourceHash: "c".repeat(64),
    splits: { train: ["rcb-001"], validation: ["rcb-005"], holdout: ["rcb-008"] },
    repeat: 3,
    model: { provider: "deepseek", model: "deepseek-flash" },
    candidate: { component: "diagnosis_rules", maxChars: 20000, forbidden: [] },
    budget: { maxTokens: 1000, maxUsd: null, maxWallMs: 1000, maxTrials: 10 },
    gepa: { maxCandidates: 12, maxMetricCalls: 200, concurrency: 2, maxNoImprovement: 4, timeLimitMin: 60 },
    selection: { disallowNewHardFailures: true, disallowRegressionOnBaselinePassing: true, minMeanGain: 0.02, holdoutReserved: true },
    ...over,
  };
}
function state(over: Partial<SearchState> = {}): SearchState {
  return { basePromptHash: "a".repeat(64), scorerHash: "b".repeat(64), rubricsSourceHash: "c".repeat(64), admittedTrain: ["rcb-001"], admittedValidation: ["rcb-005"], holdoutCaseIds: ["rcb-008"], ...over };
}

test("搜索配置：仓库内配置可解析且字段完整", () => {
  const c = loadSearchConfig(ROOT);
  assert.equal(c.schemaVersion, "rsi-search-config/v0");
  assert.ok(c.splits.train.length > 0 && c.splits.validation.length > 0);
  assert.ok(c.splits.holdout.length > 0);
  assert.equal(c.candidate.component, "diagnosis_rules");
});

test("搜索配置：一致状态通过", () => {
  assert.deepEqual(verifySearchConfig(cfg(), state()), []);
});

test("搜索配置：指纹过期被发现", () => {
  const issues = verifySearchConfig(cfg(), state({ scorerHash: "d".repeat(64) }));
  assert.ok(issues.some((i) => i.includes("scorerHash 过期")));
});

test("搜索配置：holdout 被准入或混入搜索被发现", () => {
  const issues = verifySearchConfig(cfg(), state({ admittedTrain: ["rcb-001", "rcb-008"] }));
  assert.ok(issues.some((i) => i.includes("holdout 案例被准入")));
});

test("搜索配置：已准入案例漏出配置被发现", () => {
  const issues = verifySearchConfig(cfg(), state({ admittedTrain: ["rcb-001", "rcb-002"] }));
  assert.ok(issues.some((i) => i.includes("未纳入配置")));
});

test("搜索配置：跨 split 重复与候选范围非法被发现", () => {
  const issues = verifySearchConfig(cfg({ splits: { train: ["rcb-001"], validation: ["rcb-001"], holdout: ["rcb-008"] }, candidate: { component: "diagnosis_rules", maxChars: 999999, forbidden: [] } }), state());
  assert.ok(issues.some((i) => i.includes("重复")));
  assert.ok(issues.some((i) => i.includes("maxChars")));
});
