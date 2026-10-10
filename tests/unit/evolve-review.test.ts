// 交付 A：rubric 复核与准入测试。
//   * rubric 指纹随内容变化；批准后 rubric 变更自动失效；
//   * 未复核保持 qualified；approved 且指纹一致才 admitted；
//   * admitted 必须有匹配批准记录，否则数据集 builder 拒绝纳入。
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRsiBootstrapManifest, selectFirstBatch } from "../../src/evolve/materials/catalog.ts";
import { materializeCase } from "../../src/evolve/materials/materialize.ts";
import { buildBootstrapCases } from "../../src/evolve/materials/build-cases.ts";
import { buildBootstrapDataset } from "../../src/evolve/materials/dataset.ts";
import {
  ReviewError,
  admissionVerdict,
  applyAdmission,
  assertAdmissionIntegrity,
  loadReview,
  rubricHash,
  writeReview,
  type RubricReview,
} from "../../src/evolve/materials/review.ts";
import type { TruthFileV2 } from "../../src/eval/lf/internals/types.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function setup() {
  const materialsRoot = mkdtempSync(join(tmpdir(), "evolve-rev-mat-"));
  const evalRoot = mkdtempSync(join(tmpdir(), "evolve-rev-eval-"));
  const reviewRoot = mkdtempSync(join(tmpdir(), "evolve-rev-store-"));
  for (const c of selectFirstBatch(loadRsiBootstrapManifest(ROOT))) materializeCase(ROOT, materialsRoot, c);
  buildBootstrapCases(ROOT, evalRoot, undefined, { materialsRoot, reviewRoot });
  return { materialsRoot, evalRoot, reviewRoot };
}

function readTruth(evalRoot: string, caseId: string): TruthFileV2 {
  return JSON.parse(readFileSync(join(evalRoot, "private", caseId, "truth.private.json"), "utf8")) as TruthFileV2;
}

function approve(reviewRoot: string, caseId: string, rubric: string): RubricReview {
  const review: RubricReview = {
    schemaVersion: "rsi-rubric-review/v0",
    caseId,
    rubricHash: rubric,
    reviewer: "human-reviewer",
    reviewedAt: "2026-10-11T00:00:00Z",
    decision: "approved",
  };
  writeReview(ROOT, review, { reviewRoot });
  return review;
}

test("rubric 指纹：内容变化即变化", () => {
  const a: TruthFileV2 = { schemaVersion: "prediagnosis-truth-v2", caseId: "x", locators: [], rounds: [], review: { author: "a", reviewer: "r", provisional: true } };
  const b: TruthFileV2 = { ...a, review: { author: "a", reviewer: "r", provisional: false } };
  assert.equal(rubricHash(a), rubricHash(b), "review 字段不参与指纹（避免循环）");
  const c: TruthFileV2 = { ...a, locators: [{ kind: "log", locatorId: "l1", keyContent: "panic" }] };
  assert.notEqual(rubricHash(a), rubricHash(c));
});

test("准入判定：无记录/未批准/指纹过期 均不可准入", () => {
  const truth: TruthFileV2 = { schemaVersion: "prediagnosis-truth-v2", caseId: "rcb-x", locators: [], rounds: [], review: { author: "a", reviewer: "r", provisional: true } };
  const store = mkdtempSync(join(tmpdir(), "evolve-rev-"));
  assert.equal(applyAdmission(ROOT, truth, { reviewRoot: store }).admission, "qualified");
  writeReview(ROOT, { schemaVersion: "rsi-rubric-review/v0", caseId: "rcb-x", rubricHash: rubricHash(truth), reviewer: "r", reviewedAt: "t", decision: "changes_requested" }, { reviewRoot: store });
  assert.equal(admissionVerdict(ROOT, "rcb-x", truth, { reviewRoot: store }).admissible, false);
  writeReview(ROOT, { schemaVersion: "rsi-rubric-review/v0", caseId: "rcb-x", rubricHash: "deadbeef", reviewer: "r", reviewedAt: "t", decision: "approved" }, { reviewRoot: store });
  const v = admissionVerdict(ROOT, "rcb-x", truth, { reviewRoot: store });
  assert.equal(v.admissible, false);
  assert.match(v.reason, /rubric 已变更/);
});

test("重建不丢批准：approved 指纹一致则 case.json 置 admitted 且 review 非 provisional", () => {
  const { materialsRoot, evalRoot, reviewRoot } = setup();
  const truth = readTruth(evalRoot, "rcb-001");
  // 初次未复核 → qualified
  assert.equal(JSON.parse(readFileSync(join(evalRoot, "public", "rcb-001", "case.json"), "utf8")).admission, "qualified");
  approve(reviewRoot, "rcb-001", rubricHash(truth));
  buildBootstrapCases(ROOT, evalRoot, undefined, { materialsRoot, reviewRoot });
  const caseDesc = JSON.parse(readFileSync(join(evalRoot, "public", "rcb-001", "case.json"), "utf8")) as { admission: string };
  assert.equal(caseDesc.admission, "admitted");
  const t2 = readTruth(evalRoot, "rcb-001");
  assert.equal(t2.review.provisional, false);
  assert.equal(t2.review.reviewer, "human-reviewer");
  assert.equal(loadReview(ROOT, "rcb-001", { reviewRoot })!.decision, "approved");
  // 数据集 builder 现在纳入该案例
  const built = buildBootstrapDataset(evalRoot, ROOT, { reviewRoot });
  assert.equal(built.items.length, 1);
  assert.equal(built.items[0]!.metadata.caseId, "rcb-001");
});

test("标准漂移：批准后改 rubric → 完整性检查失败、数据集拒绝纳入", () => {
  const { evalRoot, reviewRoot } = setup();
  const truth = readTruth(evalRoot, "rcb-004");
  approve(reviewRoot, "rcb-004", rubricHash(truth));
  // 篡改 rubric（模拟复核后又被改）
  const tampered: TruthFileV2 = { ...truth, rounds: [{ ...truth.rounds[0]!, requiredFacts: [...truth.rounds[0]!.requiredFacts, { factId: "extra", concepts: [["x"]], where: ["summary"] }] }] };
  assert.throws(() => assertAdmissionIntegrity(ROOT, tampered, { reviewRoot }), ReviewError);
  const verdict = admissionVerdict(ROOT, "rcb-004", tampered, { reviewRoot });
  assert.equal(verdict.admissible, false);
});

test("已验证的 admitted 案例通过完整性检查；无记录即拒绝", () => {
  const { evalRoot, reviewRoot } = setup();
  const truth = readTruth(evalRoot, "rcb-007");
  assert.throws(() => assertAdmissionIntegrity(ROOT, truth, { reviewRoot }), /无复核记录/);
  approve(reviewRoot, "rcb-007", rubricHash(truth));
  assert.doesNotThrow(() => assertAdmissionIntegrity(ROOT, truth, { reviewRoot }));
});
