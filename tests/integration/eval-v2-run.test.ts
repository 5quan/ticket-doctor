// 评测 v2 集成：多轮运行（生产编排路径）+ 正式回写捕获 + manifest + 可见性 + 离线重放。
// 工程自测 case 由 materializeEngineeringCases 生成到临时目录（synthetic，不声称真实诊断质量）。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeEngineeringCases } from "../../src/evals/v2/engcases.ts";
import { runSuite } from "../../src/evals/v2/runner.ts";
import { scoreTrial, type ScorerInput } from "../../src/evals/v2/scorer.ts";
import type { CaseScoreV2, SuiteSummaryV2 } from "../../src/evals/v2/types.ts";
import { testConfig } from "../helpers.ts";

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..", "..");

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "eval-v2-int-"));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function trialScore(summary: SuiteSummaryV2, caseId: string, trialId: string): CaseScoreV2 {
  const c = summary.cases.find((x) => x.caseId === caseId);
  assert.ok(c, `summary 缺少 case ${caseId}`);
  const t = c.trials.find((x) => x.trialId === trialId);
  assert.ok(t, `case ${caseId} 缺少 trial ${trialId}`);
  return t;
}

test("多轮运行：补问→补证→限定结论 + 反证→降级，全程生产编排与捕获回写", async () => {
  const root = tmpRoot();
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    const summary = await runSuite({
      projectRoot: PROJECT_ROOT,
      evalV2Root: root,
      suiteRunId: "int-a",
      engine: "scripted",
      repeat: 2,
      baseConfig: testConfig(),
    });

    // ---- 执行与评分（行为类 case 必须全绿；版本漂移类 case 预期失败，另行在 version 测试断言） ----
    for (const c of summary.cases.filter((x) => x.familyId === "eng-checkout")) {
      for (const t of c.trials) {
        assert.equal(t.executionSuccess, true, `${c.caseId}/${t.trialId} 应执行成功：${JSON.stringify(t.hardFailures)}`);
        assert.deepEqual(t.hardFailures, []);
      }
    }

    const clarify = trialScore(summary, "eng-clarify", "t1");
    assert.equal(clarify.roundScores[0].outcome, "clarify", "首轮应产出补问");
    assert.equal(clarify.clarificationSuccess.value, 1);
    assert.equal(clarify.roundScores[1].outcome, "report");
    assert.equal(clarify.recall.C1!.value, 1, "补证后 gold 应工具可见");
    assert.equal(clarify.writebackSuccess.value, 1);

    const counter = trialScore(summary, "eng-counter-evidence", "t1");
    assert.equal(counter.contradictionUpdateSuccess.value, 1, "收到反证后应降级旧判断");

    // ---- trial 隔离：两次 trial 会话标号不同（全新调查/Store） ----
    const t1 = JSON.parse(readFileSync(join(root, "runs", "int-a", "eng-clarify", "t1", "outputs.json"), "utf8")) as { artifacts: { rounds: Array<{ writebackText?: string }> } };
    const t2 = JSON.parse(readFileSync(join(root, "runs", "int-a", "eng-clarify", "t2", "outputs.json"), "utf8")) as { artifacts: { rounds: Array<{ writebackText?: string }> } };
    const codeOf = (text: string | undefined) => text?.match(/\[TD-([0-9a-z]{8})\]/i)?.[1];
    // reply 回写不带标号（生产行为）；报告回写带 → 用 r2 报告提取会话标号。
    const code1 = codeOf(t1.artifacts.rounds[1].writebackText);
    const code2 = codeOf(t2.artifacts.rounds[1].writebackText);
    assert.ok(code1 && code2 && code1 !== code2, "两次 trial 必须是独立调查");

    // ---- manifest：完整 HEAD、材料 hash、truth hash（答案在私有侧） ----
    const manifest = readJson(join(root, "runs", "int-a", "manifest.json")) as { project: { head: string }; cases: Array<{ caseId: string; truthHash: string; rounds: Array<{ material: { viewHash: string; files: Array<{ path: string }> } }> }> };
    assert.ok(/^[0-9a-f]{40}$/.test(manifest.project.head), "manifest 必须记录项目完整 HEAD");
    assert.ok(manifest.cases.every((c) => /^[0-9a-f]{64}$/.test(c.truthHash)), "私有标准必须以 hash 入账");
    const clarifyManifest = manifest.cases.find((c) => c.caseId === "eng-clarify")!;
    assert.equal(clarifyManifest.rounds[0].material.files.length, 0, "r1 空材料视图应如实记录");
    assert.ok(clarifyManifest.rounds[1].material.files.some((f) => f.path.endsWith("checkout-service.log")));

    // ---- trace：事件流完整，含派生工具事件 ----
    const traceText = readFileSync(join(root, "runs", "int-a", "eng-clarify", "t1", "trace.jsonl"), "utf8");
    const eventTypes = traceText.trim().split("\n").map((l) => (JSON.parse(l) as { eventType: string }).eventType);
    for (const required of ["trial_started", "round_input", "scope_resolved", "tool_returned", "evidence_committed", "engine_result_raw", "output_persisted", "delivery_captured", "round_finished", "trial_finished"]) {
      assert.ok(eventTypes.includes(required), `trace 缺少事件 ${required}`);
    }
    const toolReturned = traceText.trim().split("\n").map((l) => JSON.parse(l) as { eventType: string; payload?: { derived?: boolean; returnedText?: string | null } }).filter((e) => e.eventType === "tool_returned");
    assert.ok(toolReturned.every((e) => e.payload?.derived === true), "持久化导出事件必须标 derived");
    assert.ok(toolReturned.some((e) => (e.payload?.returnedText ?? "").includes("InventoryClient")), "tool_returned 应携带模型可见文本");

    // ---- 三阶段输出：raw / validated / writeback 可对照 ----
    const r2Raw = t1.artifacts.rounds[1] as { rawDraft?: { hypotheses: Array<{ status: string }> }; report?: { hypotheses: Array<{ status: string }>; corrections: string[] }; writebackText?: string };
    assert.equal(r2Raw.rawDraft?.hypotheses[0].status, "supported");
    assert.equal(r2Raw.report?.hypotheses[0].status, "supported");
    assert.ok((r2Raw.writebackText ?? "").includes("预检报告"), "回写应为正式渲染报告");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("可见性反例：入库但被渲染截断 → B 命中而 C1 不命中（方案 §8 验收）", async () => {
  const root = tmpRoot();
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    const cfg = { ...testConfig(), diagnosis: { ...testConfig().diagnosis, maxToolResultChars: 1200 } };
    const summary = await runSuite({
      projectRoot: PROJECT_ROOT,
      evalV2Root: root,
      suiteRunId: "int-trunc",
      engine: "scripted",
      repeat: 1,
      baseConfig: cfg,
      caseIds: ["eng-truncation"],
    });
    const s = trialScore(summary, "eng-truncation", "t1");
    assert.equal(s.recall.B!.numerator, 1, "gold 已入库（B 层）");
    assert.equal(s.recall.C1!.numerator, 0, "gold 被渲染预算截断，模型不可见（C1 层）");
    assert.equal(s.recall.D!.numerator, 0, "模型不可能引用未见内容（D 层）");
    assert.deepEqual(s.hardFailures, [], "如实报告截断不是诊断失败——可见性缺口由指标暴露");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("隔离阻断：未来材料与首轮同视图的 case 被拒于评测之外", async () => {
  const root = tmpRoot();
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    // 构造违规 case：两轮共用同一材料视图 → 未来材料首轮即可读。
    const caseDir = join(root, "public", "eng-bad-isolation");
    const privateDir = join(root, "private", "eng-bad-isolation");
    mkdirSync(caseDir, { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    mkdirSync(join(caseDir, "round-1"), { recursive: true });
    writeFileSync(join(caseDir, "r1-message.txt"), "第一轮");
    writeFileSync(join(caseDir, "r2-message.txt"), "第二轮补充材料");
    writeFileSync(join(caseDir, "round-1", "svc.log"), "第二轮补充材料\n");
    writeFileSync(join(caseDir, "case.json"), JSON.stringify({
      schemaVersion: "prediagnosis-case-v2", caseId: "eng-bad-isolation", familyId: "eng-checkout", split: "engineering",
      sourceTier: "synthetic_engineering", publicBenchmark: false, admission: "admitted", maxRounds: 2,
      rounds: [
        { roundId: "r1", messageRef: "r1-message.txt", receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: null, materialView: "round-1", services: ["svc"], repos: [{ repoId: "app", dir: "fixtures/demo-repo" }] },
        { roundId: "r2", messageRef: "r2-message.txt", receivedAt: "2026-09-06T10:40:00+08:00", occurredAt: null, materialView: "round-1", services: ["svc"], repos: [{ repoId: "app", dir: "fixtures/demo-repo" }] },
      ],
    }));
    writeFileSync(join(privateDir, "truth.private.json"), JSON.stringify({
      schemaVersion: "prediagnosis-truth-v2", caseId: "eng-bad-isolation", locators: [],
      rounds: [
        { roundId: "r1", allowedOutcomes: ["report"], allowedClaimDepth: "root", requiredFacts: [], forbiddenRules: [], materialNeeds: [], evidenceRequirements: [], contradictedClaims: [], writebackRequirements: [] },
        { roundId: "r2", allowedOutcomes: ["report"], allowedClaimDepth: "root", requiredFacts: [], forbiddenRules: [], materialNeeds: [], evidenceRequirements: [], contradictedClaims: [], writebackRequirements: [] },
      ],
      review: { author: "a", reviewer: "b", provisional: true },
    }));
    const catalogPath = join(root, "catalog", "catalog.json");
    const catalog = readJson(catalogPath) as { cases: Array<{ caseId: string; publicDir: string; privateDir: string }> };
    catalog.cases.push({ caseId: "eng-bad-isolation", publicDir: "public/eng-bad-isolation", privateDir: "private/eng-bad-isolation" });
    writeFileSync(catalogPath, JSON.stringify(catalog));

    const summary = await runSuite({
      projectRoot: PROJECT_ROOT,
      evalV2Root: root,
      suiteRunId: "int-blocked",
      engine: "scripted",
      repeat: 1,
      baseConfig: testConfig(),
      caseIds: ["eng-bad-isolation"],
    });
    assert.equal(summary.cases.length, 0, "隔离失败的 case 不得进入评测");
    // A3：终态显式入账——caseStatuses 记 isolation_blocked，计划口径可对账。
    assert.equal(summary.caseStatuses.length, 1);
    assert.equal(summary.caseStatuses[0]!.phase, "isolation_blocked");
    assert.match(summary.caseStatuses[0]!.reason ?? "", /隔离预检失败/);
    assert.equal(summary.planned.cases, 1);
    assert.equal(summary.planned.trials, 1);
    const blocked = readJson(join(root, "runs", "int-blocked", "blocked.json")) as { caseStatuses: Array<{ caseId: string; phase: string; reason: string }> };
    assert.equal(blocked.caseStatuses.length, 1);
    assert.match(blocked.caseStatuses[0]!.reason, /隔离预检失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("离线重放：outputs.json 里的评分输入重算后与 score.json 一致", async () => {
  const root = tmpRoot();
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    await runSuite({
      projectRoot: PROJECT_ROOT,
      evalV2Root: root,
      suiteRunId: "int-replay",
      engine: "scripted",
      repeat: 1,
      baseConfig: testConfig(),
      caseIds: ["eng-clarify"],
    });
    const trialDir = join(root, "runs", "int-replay", "eng-clarify", "t1");
    const { scorerInput } = JSON.parse(readFileSync(join(trialDir, "outputs.json"), "utf8")) as { scorerInput: ScorerInput };
    const rescored = scoreTrial(scorerInput);
    const saved = readJson(trialDir + "/score.json") as CaseScoreV2;
    assert.deepEqual(JSON.parse(JSON.stringify(rescored)), JSON.parse(JSON.stringify(saved)), "评分必须可离线重放且逐字段一致");
    assert.ok(existsSync(join(root, "runs", "int-replay", "manifest.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
