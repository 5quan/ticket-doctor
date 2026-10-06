// 评测人工复核辅助（E4）：合并结论 + 复核清单。
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReviewSheet, mergeReview } from "../../src/eval/review.ts";
import type { EvalRecord } from "../../src/eval/report.ts";

function record(caseId: string, over: Partial<EvalRecord> = {}): EvalRecord {
  return {
    fingerprint: {} as EvalRecord["fingerprint"],
    caseId,
    runIndex: 0,
    ok: true,
    kind: "report",
    report: {
      completeness: "partial",
      summary: "s",
      scope: { services: [], repos: [] },
      confirmedFacts: [],
      hypotheses: [{ cause: "库存超时导致 NPE", confidence: "low", status: "candidate", evidenceIds: ["u1"] }],
      uncertainties: [],
      nextSteps: [],
      missingMaterial: ["缺少库存服务日志"],
      corrections: [],
      executionLimits: [],
    },
    evidence: [],
    score: {
      scorerVersion: "mvp-0.1.0",
      gradeMode: "material-only",
      calibrated: false,
      evidenceRecall: 0.5,
      evidencePrecision: 0.5,
      goldTotal: 4,
      goldMatched: 2,
      citedTotal: 4,
      citedDistractor: 2,
      semanticCorrect: "unscored",
      reviewStatus: "unreviewed",
      citationInvalid: 0,
      note: "",
    },
    metrics: { toolCalls: 2, modelTurns: 1, auditRounds: 0, durationMs: 10, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ...over,
  };
}

test("mergeReview：写入/覆盖单条结论，不改原对象", () => {
  const before = { a: { correct: true } };
  const after = mergeReview(before, "b", false, "只答现象");
  assert.deepEqual(after, { a: { correct: true }, b: { correct: false, note: "只答现象" } });
  assert.deepEqual(Object.keys(before), ["a"], "原对象不被修改");
  const overwritten = mergeReview(after, "a", false);
  assert.equal(overwritten.a!.correct, false);
});

test("formatReviewSheet：每 case 取最近记录，展示结论与命中", () => {
  const sheet = formatReviewSheet([record("c1"), record("c1", { runIndex: 1 }), record("c2")]);
  assert.match(sheet, /case c1/);
  assert.match(sheet, /case c2/);
  assert.match(sheet, /库存超时导致 NPE/);
  assert.match(sheet, /recall=0.5 precision=0.5/);
});
