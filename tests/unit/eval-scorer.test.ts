// 评测打分器与数据集加载（MVP）：材料命中≠诊断正确；未复核标 unscored。
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadBenchmark, resolveMaterialDirs, EVAL_SCORER_VERSION, type EvalCase } from "../../src/eval/benchmark.ts";
import { citedEvidence, locatorMatches, scoreCase } from "../../src/eval/scorer.ts";
import type { DiagnosisReport } from "../../src/domain/types.ts";
import type { EvidenceRef } from "../../src/evidence/types.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function logRef(uid: string, id: string, level: string, excerpt: string): EvidenceRef {
  return { kind: "log", evidenceUid: uid, evidenceId: id, truncated: false, source: "stub", level, time: 1, excerpt };
}
function codeRef(uid: string, id: string, path: string, start: number, end: number): EvidenceRef {
  return {
    kind: "code",
    evidenceUid: uid,
    evidenceId: id,
    truncated: false,
    excerpt: "x",
    codeRef: { repoId: "app", sha: "a".repeat(40), path, startLine: start, endLine: end },
  };
}

function reportWith(evidenceIds: string[]): DiagnosisReport {
  return {
    completeness: "partial",
    summary: "s",
    scope: { services: ["checkout-service"], repos: [] },
    confirmedFacts: [],
    hypotheses: [{ cause: "c", confidence: "low", status: "candidate", evidenceIds }],
    uncertainties: [],
    nextSteps: [],
    missingMaterial: [],
    corrections: [],
    executionLimits: [],
  };
}

const CASE: EvalCase = {
  id: "c1",
  question: "q",
  gold: {
    answer: "a",
    evidence: [
      { kind: "log", level: "ERROR", substring: "timeout" },
      { kind: "code", repoId: "app", path: "A.java", lineStart: 10, lineEnd: 20 },
    ],
  },
};

test("locatorMatches：日志按 level+substring；代码按 repo/path/行区间重叠", () => {
  assert.equal(locatorMatches(logRef("u1", "E1", "ERROR", "call timeout after 3000ms"), CASE.gold.evidence[0]!), true);
  assert.equal(locatorMatches(logRef("u1", "E1", "WARN", "call timeout"), CASE.gold.evidence[0]!), false);
  assert.equal(locatorMatches(codeRef("u2", "E2", "A.java", 15, 15), CASE.gold.evidence[1]!), true);
  assert.equal(locatorMatches(codeRef("u2", "E2", "A.java", 21, 25), CASE.gold.evidence[1]!), false);
  assert.equal(locatorMatches(codeRef("u2", "E2", "B.java", 10, 20), CASE.gold.evidence[1]!), false);
});

test("scoreCase：recall 按 gold 命中，precision 按引用（干扰项计入分母）", () => {
  const evidence = [
    logRef("u1", "E1", "ERROR", "InventoryClient timeout"),
    codeRef("u2", "E2", "A.java", 12, 14),
    logRef("u3", "E3", "WARN", "RedisPool 使用率 92%"), // 干扰
  ];
  // 引用 u1（gold log）、u2（gold code）、u3（干扰）
  const score = scoreCase(CASE, { report: reportWith(["u1", "u2", "u3"]), evidence });
  assert.equal(score.evidenceRecall, 1);
  assert.equal(score.citedTotal, 3);
  assert.equal(score.citedDistractor, 1);
  assert.equal(score.evidencePrecision, 2 / 3);
  assert.equal(score.semanticCorrect, "unscored");
  assert.equal(score.reviewStatus, "unreviewed");
  assert.equal(score.calibrated, false);
});

test("scoreCase：人工复核后才给语义正确性（calibrated=true）", () => {
  const evidence = [logRef("u1", "E1", "ERROR", "timeout")];
  const score = scoreCase(CASE, {
    report: reportWith(["u1"]),
    evidence,
    review: { correct: false, note: "只答了现象未给根因" },
  });
  assert.equal(score.semanticCorrect, false);
  assert.equal(score.reviewStatus, "reviewed");
  assert.equal(score.calibrated, true);
  assert.match(score.note, /未给根因/);
});

test("scoreCase：引用无法解析不产生命中，并统计 citationInvalid", () => {
  const score = scoreCase(CASE, {
    report: reportWith(["uX"]),
    evidence: [],
    validationIssues: [{ code: "evidence_not_found", message: "引用不存在的证据" }],
  });
  assert.equal(score.evidenceRecall, 0);
  assert.equal(score.citedTotal, 0);
  assert.equal(score.citationInvalid, 1);
});

test("citedEvidence：按 uid 去重", () => {
  const evidence = [logRef("u1", "E1", "ERROR", "timeout")];
  const cited = citedEvidence(reportWith(["u1", "u1"]), evidence);
  assert.equal(cited.length, 1);
});

test("loadBenchmark：读取 demo 场景并校验", () => {
  const scenarioDir = join(ROOT, "fixtures", "evals", "demo-checkout");
  const benchmark = loadBenchmark(scenarioDir);
  assert.equal(benchmark.scenario, "demo-checkout");
  assert.equal(benchmark.cases.length, 1);
  assert.equal(benchmark.cases[0]!.id, "demo-001");
  assert.equal(EVAL_SCORER_VERSION, "mvp-0.1.0");
  const dirs = resolveMaterialDirs(benchmark, scenarioDir, ROOT);
  assert.ok(dirs.logsDir.endsWith(join("fixtures", "samples")));
  assert.ok(dirs.repoDir.endsWith(join("fixtures", "demo-repo")));
});
