// A1 验收（交付一）：审计补证循环的**多调用归属** + 费用边界。
//
// 背景缺陷（审查确认）：
//   1. 原始草稿按"每个用户轮取一条"绑定——审计补证让一次 run 产生多次引擎调用，
//      下一轮会拿到上一轮的补证稿（capture 指针错位）。
//   2. 环境配置为 pi 时，工程自测开启审计会隐式构建真实模型审计器（费用边界）。
//
// 本文件锁定修复后的行为：
//   * 每个用户轮保存**全部**引擎调用（initial/supplement），初稿错误与终稿分离归属；
//   * trace 逐调用事件绑定 roundId/runId/attemptId；
//   * scripted 评测即使环境诊断为 pi、凭据存在，审计也必须确定性（真实模型调用为零）。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeEngineeringCases } from "../../src/evals/v2/engcases.ts";
import { runSuite } from "../../src/evals/v2/runner.ts";
import { ScriptedAuditor } from "../../src/evals/v2/scripted-engine.ts";
import type { SuiteSummaryV2, TrialArtifacts } from "../../src/evals/v2/types.ts";
import { testConfig } from "../helpers.ts";

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..", "..");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function auditConfig() {
  const cfg = testConfig();
  // maxRounds=1：最多一次补证；failBlocks=false：审计异常降级不阻断（与生产默认一致）。
  cfg.diagnosis.audit = { enabled: true, allowRetrieval: false, failBlocks: false, maxRounds: 1 };
  return cfg;
}

test("审计补证循环：轮 1 保存初稿+补证稿两次调用，初稿错误保留、终稿单独评价（A1）", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-auditloop-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    const summary = await runSuite({
      projectRoot: PROJECT_ROOT,
      evalV2Root: root,
      suiteRunId: "audit-loop-1",
      engine: "scripted",
      repeat: 1,
      baseConfig: auditConfig(),
      caseIds: ["eng-audit-loop"],
    });
    const caseEntry = summary.cases.find((c) => c.caseId === "eng-audit-loop");
    assert.ok(caseEntry, `summary 缺少 eng-audit-loop：${JSON.stringify(summary.caseStatuses)}`);
    const trial = caseEntry.trials[0]!;
    assert.equal(trial.executionSuccess, true, `应执行成功：${JSON.stringify(trial.hardFailures)}`);

    const outputs = readJson(join(root, "runs", "audit-loop-1", "eng-audit-loop", "t1", "outputs.json")) as { artifacts: TrialArtifacts };
    const [r1, r2] = outputs.artifacts.rounds;

    // ---- 轮 1：两次引擎调用，归属正确 ----
    assert.equal(r1!.engineCalls.length, 2, `轮 1 应有初稿+补证稿两次调用：${JSON.stringify(r1!.engineCalls.map((c) => c.phase))}`);
    assert.equal(r1!.engineCalls[0]!.phase, "initial");
    assert.equal(r1!.engineCalls[1]!.phase, "supplement");
    // 初稿（Redis 猜想）与终稿（库存超时）内容不同且分别保存：
    const initialDraft = r1!.rawDraft as { hypotheses: Array<{ cause: string }> };
    const finalReport = r1!.report as { hypotheses: Array<{ cause: string; status: string }>; corrections?: string[] };
    assert.match(initialDraft.hypotheses[0]!.cause, /Redis/, "rawDraft 必须是本轮**首次**调用（初稿）");
    assert.match(finalReport.hypotheses[0]!.cause, /库存/, "report 必须是补证后的终稿（初稿错误不覆盖终稿评价）");
    assert.equal(finalReport.hypotheses[0]!.status, "supported");
    assert.equal(r1!.outcome, "report", "outcome 取自本轮最后一次调用（final），而非初稿");

    // ---- 轮 2：新草稿独立（不得拿到轮 1 的补证稿）----
    assert.equal(r2!.engineCalls.length, 1, `轮 2 应只有一次调用：${JSON.stringify(r2!.engineCalls.map((c) => c.phase))}`);
    assert.equal(r2!.engineCalls[0]!.phase, "initial");
    const r2Report = r2!.report as { summary: string; hypotheses: Array<{ cause: string }> };
    assert.match(r2Report.summary, /结论不变/, "轮 2 草稿必须是轮 2 自己的脚本步骤");

    // ---- trace：逐调用事件绑定 roundId/runId/attemptId ----
    const tracePath = join(root, "runs", "audit-loop-1", "eng-audit-loop", "t1", "trace.jsonl");
    assert.ok(existsSync(tracePath));
    const events = traceTextEvents(tracePath);
    const r1Calls = events.filter((e) => e.roundId === "r1" && e.eventType === "engine_call");
    const r2Calls = events.filter((e) => e.roundId === "r2" && e.eventType === "engine_call");
    assert.equal(r1Calls.length, 2);
    assert.equal(r2Calls.length, 1);
    assert.deepEqual(r1Calls.map((e) => (e.payload as { phase: string }).phase), ["initial", "supplement"]);
    for (const e of [...r1Calls, ...r2Calls]) {
      assert.ok(e.runId, "engine_call 必须绑定 runId");
      assert.ok(e.attemptId, "engine_call 必须绑定 attemptId");
    }
    // engine_result_raw 仍存在且为终稿摘要（requiredTraceEvents 语义不变）
    const r1Raw = events.find((e) => e.roundId === "r1" && e.eventType === "engine_result_raw");
    assert.equal((r1Raw!.payload as { engineCallCount: number }).engineCallCount, 2);

    // ---- manifest：实际引擎与审计引擎入账 ----
    const manifest = readJson(join(root, "runs", "audit-loop-1", "manifest.json")) as {
      engine: string; engineActual: string;
      diagnosis: { audit: { engine: string | null; enabled: boolean } };
    };
    assert.equal(manifest.engineActual, "scripted");
    assert.equal(manifest.diagnosis.audit.engine, "scripted-audit", "审计实际引擎必须写入 manifest（A1）");
    // 真实模型调用为零：scripted 全程 usage=0
    assert.equal(outputs.artifacts.usage?.totalTokens ?? 0, 0, "确定性引擎 + 确定性审计不得产生模型用量");
    // 冻结复核（A3）：eng-audit-loop 的脚本与审计脚本指纹入账
    const manifestFull = readJson(join(root, "runs", "audit-loop-1", "manifest.json")) as { cases: Array<{ caseId: string; scriptHash: string | null; auditScriptHash: string | null }>; freezeCheck: { ok: boolean } };
    const auditCase = manifestFull.cases.find((c) => c.caseId === "eng-audit-loop")!;
    assert.match(auditCase.scriptHash ?? "", /^[0-9a-f]{64}$/);
    assert.match(auditCase.auditScriptHash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(manifestFull.freezeCheck.ok, true, "运行前后材料指纹不得漂移");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("费用边界：环境诊断为 pi 且凭据存在，scripted 评测的审计仍为确定性（不回落真实模型）", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-feeboundary-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    const cfg = auditConfig();
    // 模拟"环境配置 TD_ENGINE=pi 且 key 存在"：若审计器按环境配置构建，将隐式调用真实模型。
    cfg.diagnosis.engine = "pi";
    cfg.diagnosis.apiKey = "sk-dummy-if-used-test-fails";
    const summary = await runSuite({
      projectRoot: PROJECT_ROOT,
      evalV2Root: root,
      suiteRunId: "fee-boundary-1",
      engine: "scripted",
      repeat: 1,
      baseConfig: cfg,
      caseIds: ["eng-audit-loop"],
    });
    const caseEntry = summary.cases.find((c) => c.caseId === "eng-audit-loop");
    assert.ok(caseEntry, `summary 缺少 eng-audit-loop：${JSON.stringify(summary.caseStatuses)}`);
    assert.equal(caseEntry.trials[0]!.executionSuccess, true, "确定性审计下补证循环应正常完成");
    const manifest = readJson(join(root, "runs", "fee-boundary-1", "manifest.json")) as {
      diagnosis: { audit: { engine: string | null } };
    };
    assert.equal(manifest.diagnosis.audit.engine, "scripted-audit", "scripted 评测不得回落 pi 审计器");
    const outputs = readJson(join(root, "runs", "fee-boundary-1", "eng-audit-loop", "t1", "outputs.json")) as { artifacts: { usage?: { totalTokens: number } } };
    assert.equal(outputs.artifacts.usage?.totalTokens ?? 0, 0, "真实模型调用次数必须为零");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ScriptedAuditor：脚本耗尽默认放行；failure 步骤抛错（failBlocks 语义由编排层处理）", async () => {
  const exhausted = new ScriptedAuditor([]);
  const outcome = await exhausted.audit(
    { question: "q", scope: { services: [], repos: [] }, draft: { completeness: "complete", summary: "s", confirmedFacts: [], hypotheses: [{ cause: "h", confidence: "low", status: "candidate", evidenceIds: [] }], uncertainties: [], nextSteps: [], missingMaterial: [] }, evidence: [], executionLimits: [] },
    new AbortController().signal,
  );
  assert.equal(outcome.result.stopAdvice.action, "stop", "脚本耗尽 → 停止（不要求补证）");
  assert.equal(outcome.result.claimVerdicts[0]!.verdict, "supported", "耗尽后默认放行，不降级");

  const failing = new ScriptedAuditor([{ failure: "审计器确定性故障注入" }]);
  await assert.rejects(
    () => failing.audit({ question: "q", scope: { services: [], repos: [] }, draft: { completeness: "complete", summary: "s", confirmedFacts: [], hypotheses: [], uncertainties: [], nextSteps: [], missingMaterial: [] }, evidence: [], executionLimits: [] }, new AbortController().signal),
    /确定性故障注入/,
  );
});

function traceTextEvents(path: string): Array<{ eventType: string; roundId?: string; runId?: string; attemptId?: string; payload?: unknown }> {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { eventType: string; roundId?: string; runId?: string; attemptId?: string; payload?: unknown });
}

function assertSummaryHas(summary: SuiteSummaryV2, caseId: string): void {
  assert.ok(summary.cases.some((c) => c.caseId === caseId));
}
