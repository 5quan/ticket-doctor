// 交付二 B1/B2 反例与验收：Experiment 封装（确定性幂等 + 白名单内容 + 逐轮子观测 + 同步状态机）。
// 不触网：OTLP/ingestion 传输层不在本文件测试范围（无凭据时可离线构建载荷与状态）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeEngineeringCases } from "../../src/evals/v2/engcases.ts";
import { runSuite } from "../../src/evals/v2/runner.ts";
import { applyReview, judgedOutputsHash, reviewedBindingValid, validateReview } from "../../src/evals/v2/review.ts";
import { listJudgableClaims, SCORER_VERSION } from "../../src/evals/v2/scorer.ts";
import {
  applySyncResult,
  buildTrialPayload,
  deterministicId,
  emptySyncState,
  shouldSync,
} from "../../src/evals/v2/experiment.ts";
import { deterministicScoreId } from "../../src/evals/v2/langfuse.ts";
import type { CaseScoreV2 } from "../../src/evals/v2/types.ts";
import { testConfig } from "../helpers.ts";

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..", "..");

test("B1 实验载荷：逐轮子观测携带报告全文/回写/工具返回/审计事件；确定性 traceId", async () => {
  const root = mkdtempSync(join(tmpdir(), "b1-payload-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    const cfg = testConfig();
    cfg.diagnosis.audit = { enabled: true, allowRetrieval: false, failBlocks: false, maxRounds: 1 };
    await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "b1-s", engine: "scripted", repeat: 1,
      baseConfig: cfg, caseIds: ["eng-audit-loop"],
    });
    const runDir = join(root, "runs", "b1-s");
    const score = JSON.parse(readFileSync(join(runDir, "eng-audit-loop", "t1", "score.json"), "utf8")) as CaseScoreV2;

    const build = () =>
      buildTrialPayload({
        suiteRunId: "b1-s", caseId: "eng-audit-loop", trialId: "t1", runDir,
        familyId: "eng-checkout", split: "engineering", sourceTier: "synthetic_engineering",
        score, reviewed: null, input: "公开题面（白名单内容）",
      });
    const payload = build();
    const payload2 = build();

    // B2 幂等根基：重复构建得到同一 traceId / experimentId
    assert.equal(payload.traceId, payload2.traceId);
    assert.match(payload.traceId, /^[0-9a-f]{32}$/);
    assert.equal(payload.experimentId, deterministicId("experiment", "b1-s"));

    // B1 逐轮子观测：两轮；报告全文 + 回写 + 工具返回 + 审计事件（带原始时间）
    assert.equal(payload.rounds.length, 2);
    const r1 = payload.rounds[0]!;
    assert.ok(r1.report, "轮 1 必须携带正式报告全文");
    assert.match(JSON.stringify(r1.report), /库存服务调用超时/);
    assert.ok(r1.writebackText && r1.writebackText.includes("预检报告"), "实际投递文本必须上报");
    assert.ok(r1.toolCalls.length >= 2, "工具返回必须上报");
    assert.ok(r1.auditEvents.length >= 3, `审计事件必须上报：${r1.auditEvents.length}`);
    assert.ok(r1.auditEvents.every((e) => typeof e.occurredAt === "number" && e.occurredAt! > 0), "审计事件保留原始时间");
    assert.ok(r1.auditEvents.some((e) => e.auditType === "audit_applied"));
    // 初稿与终稿可对照（A1 归属语义）
    assert.match(r1.rawDraftSummary ?? "", /Redis/, "初稿摘要保留");

    // output = 实际投递全文（末轮回写）
    assert.match(payload.output, /预检报告|结论不变/);
    // input 白名单：公开题面
    assert.equal(payload.input, "公开题面（白名单内容）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B1 防泄漏：私有标准（truth/locator/requirementId）不得进入实验载荷", async () => {
  const root = mkdtempSync(join(tmpdir(), "b1-leak-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "b1-leak-s", engine: "scripted", repeat: 1,
      baseConfig: testConfig(), caseIds: ["eng-counter-evidence"],
    });
    const runDir = join(root, "runs", "b1-leak-s");
    const score = JSON.parse(readFileSync(join(runDir, "eng-counter-evidence", "t1", "score.json"), "utf8")) as CaseScoreV2;
    const payload = buildTrialPayload({
      suiteRunId: "b1-leak-s", caseId: "eng-counter-evidence", trialId: "t1", runDir,
      familyId: "eng-checkout", split: "engineering", sourceTier: "synthetic_engineering",
      score, reviewed: null, input: "公开题面",
    });
    const serialized = JSON.stringify(payload);
    // 这些 id/措辞只存在于 truth.private.json（LocatorV2/EvidenceRequirementV2/标注）：
    for (const secret of ["loc-inventory-error", "req-inventory-error", "eval-v2-builder", "provisional-self"]) {
      assert.ok(!serialized.includes(secret), `私有标准 ${secret} 不得出现在实验载荷`);
    }
    // 公开材料内容（日志文本）允许出现——它本来就是模型可见的 C1 内容。
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B2 同步状态机：confirmed 跳过、failed 续传、force 重推、attempts 累计", () => {
  const state = emptySyncState("s1");
  assert.equal(shouldSync(state, "c/t1", false), true, "未同步 → 需要同步");
  applySyncResult(state, "c/t1", { ok: true, traceId: "a".repeat(32), scores: 13, rounds: 2 });
  assert.equal(shouldSync(state, "c/t1", false), false, "已确认 → 跳过（不重复计分）");
  assert.equal(shouldSync(state, "c/t1", true), true, "force → 重推");
  applySyncResult(state, "c/t2", { ok: false, traceId: "", scores: 0, rounds: 0, error: "HTTP 503" });
  assert.equal(shouldSync(state, "c/t2", false), true, "失败 → 续传");
  assert.equal(state.trials["c/t2"]!.status, "failed");
  assert.equal(state.trials["c/t2"]!.lastError, "HTTP 503", "失败原因留档");
  assert.equal(state.trials["c/t2"]!.attempts, 1);
  applySyncResult(state, "c/t2", { ok: true, traceId: "b".repeat(32), scores: 13, rounds: 2 });
  assert.equal(state.trials["c/t2"]!.attempts, 2, "attempts 累计");
  assert.equal(state.trials["c/t2"]!.status, "confirmed");
  // 同步失败不影响本地产物：状态只是旁路文件
  assert.equal(state.schemaVersion, "prediagnosis-lf-sync-v1");
});

test("B2 确定性 score id：同 (traceId,name) 幂等、不同 name 区分程序分/复核分", () => {
  const traceId = "c".repeat(32);
  const a1 = deterministicScoreId(traceId, "claimSupport");
  const a2 = deterministicScoreId(traceId, "claimSupport");
  const b = deterministicScoreId(traceId, "claimSupport.reviewed");
  const c = deterministicScoreId("d".repeat(32), "claimSupport");
  assert.equal(a1, a2, "同键同 id（重复同步不重复计分）");
  assert.notEqual(a1, b, "程序分/复核分不互相覆盖");
  assert.notEqual(a1, c, "不同 trial 不同 id");
  assert.match(a1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("B1 复核分侧车：reviewed 载荷带 .reviewed 后缀且与程序分并列", async () => {
  const root = mkdtempSync(join(tmpdir(), "b1-review-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "b1-rs", engine: "scripted", repeat: 1,
      baseConfig: testConfig(), caseIds: ["eng-clarify"],
    });
    const runDir = join(root, "runs", "b1-rs");
    const outputs = JSON.parse(readFileSync(join(runDir, "eng-clarify", "t1", "outputs.json"), "utf8")) as { scorerInput: Parameters<typeof listJudgableClaims>[0] extends never ? never : import("../../src/evals/v2/scorer.ts").ScorerInput };
    const score = JSON.parse(readFileSync(join(runDir, "eng-clarify", "t1", "score.json"), "utf8")) as CaseScoreV2;
    // 构造合法 v3 review（覆盖全部槽位）并应用
    const bind = {
      suiteRunId: "b1-rs",
      outputsHash: judgedOutputsHash(outputs.scorerInput),
      claims: listJudgableClaims(outputs.scorerInput.rounds),
      writebackPresentByRound: Object.fromEntries(outputs.scorerInput.rounds.map((r) => [r.roundId, !!r.writebackText])),
    };
    const slots = bind.claims;
    const review = {
      schemaVersion: "prediagnosis-review-v3" as const,
      suiteRunId: "b1-rs", caseId: "eng-clarify", trialId: "t1",
      outputsHash: bind.outputsHash,
      review: { author: "b1", reviewer: "human-b1", reviewerType: "human" as const },
      claims: slots.map((s) => ({ roundId: s.roundId, stage: "validated" as const, field: s.field, index: s.index, claimId: s.claimId, verdict: "supported" as const, rationale: "B1 验收" })),
    };
    const checked = validateReview(review, outputs.scorerInput.caseDesc, outputs.scorerInput.truth, bind);
    assert.equal(checked.ok, true, JSON.stringify(checked.ok ? [] : checked.errors));
    const reviewedScore = applyReview(outputs.scorerInput, score, checked.ok ? checked.value : review);
    reviewedScore.reviewMeta = { outputsHash: bind.outputsHash, reviewHash: "x".repeat(64), reviewArtifact: "t", baseScorerVersion: SCORER_VERSION, rescoredAt: 1 };
    assert.equal(reviewedBindingValid(reviewedScore, outputs.scorerInput), true);

    const payload = buildTrialPayload({
      suiteRunId: "b1-rs", caseId: "eng-clarify", trialId: "t1", runDir,
      familyId: "eng-checkout", split: "engineering", sourceTier: "synthetic_engineering",
      score, reviewed: reviewedScore, input: "公开题面",
    });
    const names = payload.scores.map((s) => s.name);
    assert.ok(names.includes("requiredFactCoverage"), "程序分在列");
    assert.ok(names.includes("requiredFactCoverage.reviewed"), "复核分以 .reviewed 后缀并列");
    assert.ok(!names.includes("claimSupport"), "程序分 claimSupport 未复核为 null，不得冒充上报");
    assert.ok(names.includes("claimSupport.reviewed"), "复核分 claimSupport.reviewed 在列");
    assert.equal(payload.metadata.scoreSource, "review:human/human-b1");
    assert.equal(payload.metadata.c2, null, "C2 未接通保持 null，不冒充");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
