// 交付 A：案例装配 + 准入闸门 + 通用数据集 builder 测试。
//   * qualified 草稿可装配校验，但默认 loadCase 必须拒绝（未审定不得运行）；
//   * 日志视图只含 .log；Agent 输入不泄漏私有 oracle/答案；
//   * 数据集 builder 只纳入 admitted，其余显式跳过。
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRsiBootstrapManifest, selectFirstBatch } from "../../src/evolve/materials/catalog.ts";
import { materializeCase } from "../../src/evolve/materials/materialize.ts";
import { buildBootstrapCases, MATERIAL_VIEW } from "../../src/evolve/materials/build-cases.ts";
import { buildBootstrapDataset, listRsiCases } from "../../src/evolve/materials/dataset.ts";
import { loadCase, loadCatalog, loadTruth, loadRoundMessage } from "../../src/eval/lf/internals/load.ts";
import { validatePairing } from "../../src/eval/lf/internals/schema.ts";
import { rubricHash, writeReview, type RubricReview } from "../../src/evolve/materials/review.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function setup() {
  const materialsRoot = mkdtempSync(join(tmpdir(), "evolve-mat-"));
  const evalRoot = mkdtempSync(join(tmpdir(), "evolve-eval-"));
  const reviewRoot = mkdtempSync(join(tmpdir(), "evolve-rev-"));
  const manifest = loadRsiBootstrapManifest(ROOT);
  const cases = selectFirstBatch(manifest);
  for (const c of cases) materializeCase(ROOT, materialsRoot, c);
  buildBootstrapCases(ROOT, evalRoot, undefined, { materialsRoot, reviewRoot });
  return { materialsRoot, evalRoot, reviewRoot, cases };
}

test("装配：qualified 草稿可校验，但默认准入闸门拒绝运行", () => {
  const { evalRoot } = setup();
  const catalog = loadCatalog(evalRoot);
  assert.deepEqual(catalog.cases.map((c) => c.caseId).sort(), ["rcb-001", "rcb-004", "rcb-007"]);
  for (const entry of catalog.cases) {
    // 未审定（qualified）→ 默认拒绝。
    assert.throws(() => loadCase(evalRoot, entry, ROOT), /admitted/);
    // 制作侧可读，且字段正确。
    const desc = loadCase(evalRoot, entry, ROOT, { requireAdmitted: false });
    assert.equal(desc.admission, "qualified");
    assert.equal(desc.sourceTier, "public_simulated");
    assert.ok(["train", "validation"].includes(desc.split));
    assert.deepEqual(desc.rounds[0]!.repos, []);
    const truth = loadTruth(evalRoot, entry);
    assert.equal(truth.review.provisional, true);
    validatePairing(desc, truth);
  }
});

test("隔离：日志视图只含 .log，Agent 输入不泄漏私有 oracle", () => {
  const { evalRoot, cases } = setup();
  const catalog = loadCatalog(evalRoot);
  for (const c of cases) {
    const entry = catalog.cases.find((e) => e.caseId === c.caseId)!;
    const caseDir = join(evalRoot, entry.publicDir);
    const viewFiles = readdirSync(join(caseDir, MATERIAL_VIEW));
    assert.ok(viewFiles.length > 0);
    assert.ok(viewFiles.every((f) => f.endsWith(".log")), `视图只应含 .log：${viewFiles.join(",")}`);
    const desc = loadCase(evalRoot, entry, ROOT, { requireAdmitted: false });
    const question = loadRoundMessage(caseDir, desc.rounds[0]!.messageRef);
    assert.doesNotMatch(question, /root_cause_commit|ground_truth|5642d6b|7dacc6c|4f3740c|leeway|decoy|oracle/i);
  }
});

test("数据集 builder：未审定案例全部跳过，产出 0 条", () => {
  const { evalRoot, reviewRoot } = setup();
  const built = buildBootstrapDataset(evalRoot, ROOT, { reviewRoot });
  assert.equal(built.items.length, 0);
  assert.deepEqual(built.skipped.map((s) => s.caseId).sort(), ["rcb-001", "rcb-004", "rcb-007"]);
  assert.ok(built.skipped.every((s) => s.admission === "qualified"));
});

test("数据集 builder：经复核准入后才纳入，input 不含私有内容且带 split", () => {
  const { evalRoot, materialsRoot, reviewRoot } = setup();
  // 模拟人工复核通过：写批准记录后重建。
  const truth = loadTruth(evalRoot, loadCatalog(evalRoot).cases.find((e) => e.caseId === "rcb-001")!);
  const review: RubricReview = { schemaVersion: "rsi-rubric-review/v0", caseId: "rcb-001", rubricHash: rubricHash(truth), reviewer: "tester", reviewedAt: "t", decision: "approved" };
  writeReview(ROOT, review, { reviewRoot });
  buildBootstrapCases(ROOT, evalRoot, undefined, { materialsRoot, reviewRoot });

  const built = buildBootstrapDataset(evalRoot, ROOT, { reviewRoot });
  assert.equal(built.items.length, 1);
  const item = built.items[0]!;
  assert.equal(item.metadata.caseId, "rcb-001");
  assert.equal(item.metadata.split, "train");
  assert.equal(item.metadata.sourceType, "public_simulated");
  assert.match(item.metadata.casePublicHash, /^[0-9a-f]{64}$/);
  const inputText = JSON.stringify(item.input);
  assert.doesNotMatch(inputText, /truth\.private|root-cause|ground_truth/);
  assert.ok(item.expectedOutput.rounds[0]!.requiredFacts.length > 0);
  // listRsiCases 读得到全部 3 条（含被跳过的草稿）。
  assert.equal(listRsiCases(evalRoot, ROOT).length, 3);
});
