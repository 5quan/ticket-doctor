// dataset 同步正反例（eval/langfuse 分支）：白名单纪律 + 幂等 + 指纹稳定。
// 纪律红线：truth 内容结构性不进 Langfuse 载荷——用标记字符串证明它泄漏不出去。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDatasetSync,
  buildDatasetItemPayload,
  datasetItemId,
  emptyDatasetSyncState,
  hashCasePublic,
  hashTruth,
} from "../../src/evals/v2/lfdataset.ts";
import type { CaseDescriptorV2 } from "../../src/evals/v2/types.ts";

function makeEvalRoot(): { root: string; caseDesc: CaseDescriptorV2; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lfdataset-"));
  const caseDir = join(root, "public", "eng-clarify");
  const privDir = join(root, "private", "eng-clarify");
  mkdirSync(caseDir, { recursive: true });
  mkdirSync(privDir, { recursive: true });
  writeFileSync(
    join(caseDir, "case.json"),
    JSON.stringify({ schemaVersion: "prediagnosis-case-v2", caseId: "eng-clarify" }),
  );
  writeFileSync(join(caseDir, "r1.txt"), "用户反馈下单超时，请预诊断");
  // 标记字符串：若出现在任何上报载荷里 = truth 泄漏（红线用例的探针）。
  writeFileSync(
    join(privDir, "truth.private.json"),
    JSON.stringify({ marker: "TRUTH-LEAK-PROBE-7f3a", requirements: [{ requirementId: "req-1" }] }),
  );
  const caseDesc = {
    schemaVersion: "prediagnosis-case-v2",
    caseId: "eng-clarify",
    familyId: "eng",
    split: "engineering",
    sourceTier: "synthetic_engineering",
    publicBenchmark: false,
    admission: "admitted",
    maxRounds: 2,
    rounds: [
      { roundId: "r1", messageRef: "r1.txt" },
      { roundId: "r2", messageRef: "missing-r2.txt" },
    ],
  } as unknown as CaseDescriptorV2;
  return { root, caseDesc, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("datasetItemId 确定性：同 caseId 恒同 id，不同 caseId 不同 id", () => {
  assert.equal(datasetItemId("eng-clarify"), datasetItemId("eng-clarify"));
  assert.notEqual(datasetItemId("eng-clarify"), datasetItemId("eng-truncation"));
});

test("载荷白名单：input 只含公开题面，expectedOutput 恒 null，truth 标记字符串零泄漏", () => {
  const { root, caseDesc, cleanup } = makeEvalRoot();
  try {
    const payload = buildDatasetItemPayload({
      datasetName: "eng-baseline",
      evalRoot: root,
      caseDesc,
      truthHash: hashTruth(root, { privateDir: join("private", "eng-clarify") }),
    });
    assert.ok(payload.input.includes("下单超时"));
    assert.equal(payload.expectedOutput, null);
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes("TRUTH-LEAK-PROBE-7f3a"), false, "truth 内容不得进入任何上报字段");
    assert.equal(serialized.includes("req-1"), false, "requirementId 等 truth 侧标识不得进入上报");
    assert.match(payload.metadata.truthHash, /^[0-9a-f]{64}$/);
    assert.equal(payload.id, datasetItemId("eng-clarify"));
  } finally {
    cleanup();
  }
});

test("公开指纹稳定：同材料重算一致；消息文本变化 → 指纹变化（驱动 dataset 版本）", () => {
  const { root, caseDesc, cleanup } = makeEvalRoot();
  try {
    const h1 = hashCasePublic(root, caseDesc);
    const h2 = hashCasePublic(root, caseDesc);
    assert.equal(h1, h2);
    writeFileSync(join(root, "public", "eng-clarify", "r1.txt"), "用户反馈支付失败，请预诊断");
    const h3 = hashCasePublic(root, caseDesc);
    assert.notEqual(h1, h3);
    assert.match(h3, /^[0-9a-f]{64}$/);
  } finally {
    cleanup();
  }
});

test("truth 指纹：无私有目录记 absent，不猜测", () => {
  const { root, cleanup } = makeEvalRoot();
  try {
    assert.equal(hashTruth(root, {}), "absent");
    assert.match(hashTruth(root, { privateDir: join("private", "eng-clarify") }), /^[0-9a-f]{64}$/);
  } finally {
    cleanup();
  }
});

test("同步状态：同指纹重复同步幂等，指纹变化记 changed", () => {
  const state = emptyDatasetSyncState("eng-baseline", "ds-1");
  const rec = { itemId: "it-1", caseHash: "a".repeat(64), truthHash: "b".repeat(64) };
  assert.deepEqual(applyDatasetSync(state, "eng-clarify", rec), { changed: true });
  assert.deepEqual(applyDatasetSync(state, "eng-clarify", { ...rec }), { changed: false });
  assert.deepEqual(applyDatasetSync(state, "eng-clarify", { ...rec, truthHash: "c".repeat(64) }), { changed: true });
  assert.equal(state.datasetName, "eng-baseline");
  assert.equal(state.datasetId, "ds-1");
  assert.equal(state.items["eng-clarify"].truthHash, "c".repeat(64));
});
