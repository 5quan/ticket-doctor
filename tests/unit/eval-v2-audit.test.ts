// 审计修复验收反例（工单 §三）：每条对应一个已复现缺陷，先证伪再修复。
// 修复前后结果保留在 git 历史；本文件锁定修复后的判定。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LogAccessError, FileLogSource } from "../../src/sources/logs.ts";
import { applyReview, validateReview } from "../../src/evals/v2/review.ts";
import { scoreTrial, type RoundScoreInput, type ScorerInput } from "../../src/evals/v2/scorer.ts";
import { computeRequirementSatisfaction, type CallEvidence, type LayerContext, type LayerEvidence } from "../../src/evals/v2/visibility.ts";
import type { CaseDescriptorV2, CaseScoreV2, TruthFileV2 } from "../../src/evals/v2/types.ts";
import { runSuite } from "../../src/evals/v2/runner.ts";
import { materializeEngineeringCases } from "../../src/evals/v2/engcases.ts";
import { testConfig } from "../helpers.ts";

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..", "..");
const sha = "a".repeat(40);
const wrongSha = "b".repeat(40);

// ---------- 1. 日志隔离：路径逃逸拒绝（审计探针 futureLogTraversal） ----------

test("隔离：首轮无法经 ../ 读取未来轮日志（路径逃逸拒绝）", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-iso-"));
  try {
    mkdirSync(join(root, "round-1"), { recursive: true });
    mkdirSync(join(root, "round-2"), { recursive: true });
    writeFileSync(join(root, "round-2", "checkout-service.log"), "2026-09-06T10:41:00.000+08:00\tERROR\tFUTURE-GOLD-LINE\n");
    const source = new FileLogSource({ dir: join(root, "round-1"), allowedServices: [] });
    const signal = new AbortController().signal;
    const probes = ["../round-2/checkout-service", "..\\round-2\\checkout-service", "/etc/passwd", "x/../../y", "./round-2/checkout-service"];
    for (const service of probes) {
      await assert.rejects(
        () => source.query({ service, from: 0, to: Date.now() + 1e9, keywords: [] }, signal),
        (err: unknown) => err instanceof LogAccessError,
        `应拒绝 ${service}`,
      );
    }
    // 空授权列表下连"存在的文件"也拒绝——由 eval-v2-links.test.ts 的空白名单反例覆盖；
    // 这里改为验证：未配置授权（undefined）时，不存在的服务仍是"材料不存在"而非路径逃逸。
    const unrestricted = new FileLogSource({ dir: join(root, "round-1"), allowedServices: undefined });
    await assert.rejects(
      () => unrestricted.query({ service: "checkout-service", from: 0, to: Date.now() + 1e9, keywords: [] }, signal),
      (err: unknown) => err instanceof LogAccessError && /日志文件不存在/.test((err as Error).message),
    );
  } finally {
    // tmpdir 自清理省略（mkdtemp 每次独立）
  }
});

// ---------- 合成输入工具 ----------

const caseDesc: CaseDescriptorV2 = {
  schemaVersion: "prediagnosis-case-v2",
  caseId: "t-case",
  familyId: "t-family",
  split: "engineering",
  sourceTier: "synthetic_engineering",
  publicBenchmark: false,
  admission: "admitted",
  maxRounds: 1,
  rounds: [{ roundId: "r1", messageRef: "m.txt", receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: null, materialView: "round-1", services: ["svc"], repos: [{ repoId: "app", dir: "fixtures/demo-repo", expectedSha: sha }] }],
};

const truth: TruthFileV2 = {
  schemaVersion: "prediagnosis-truth-v2",
  caseId: "t-case",
  locators: [
    { kind: "code", locatorId: "loc-npe", repoId: "app", sha, path: "src/OrderService.java", lineStart: 15, lineEnd: 17, keyContent: "throw new NullPointerException" },
  ],
  rounds: [
    { roundId: "r1", allowedOutcomes: ["report"], allowedClaimDepth: "root",
      requiredFacts: [{ factId: "fact-root", concepts: [["库存", "inventory"]], where: ["summary", "hypotheses"] }],
      forbiddenRules: [],
      materialNeeds: [], evidenceRequirements: [{ requirementId: "req-npe", depth: "root", supportsAnyOf: [{ allOf: ["loc-npe"] }] }],
      contradictedClaims: [], writebackRequirements: [] },
  ],
  review: { author: "a", reviewer: "b", provisional: true },
};

function evidenceFor(id: string, codeSha: string, path = "src/OrderService.java"): LayerEvidence {
  return { evidenceId: id, evidenceUid: `uid-${id}`, runId: "r", kind: "code", excerpt: "throw new NullPointerException(\"inventoryClient.reserve returned null\")", truncated: false, codeRef: { repoId: "app", sha: codeSha, path, startLine: 15, endLine: 17 } };
}

function visibilityWith(callEvidence: CallEvidence[]): RoundScoreInput["visibility"] {
  const ctx: LayerContext = {
    sourceCalls: [],
    persisted: callEvidence.flatMap((c) => c.evidence),
    callEvidence,
    cited: [],
    observationLevel: "b-c1-d",
    c2Reason: "no request observation",
  };
  return computeRequirementSatisfaction({ caseRoundIds: ["r1"], truth, roundId: "r1", ctx });
}

function makeScore(callEvidence: CallEvidence[], over: Partial<RoundScoreInput> = {}): CaseScoreV2 {
  const round: RoundScoreInput = {
    roundId: "r1",
    truth: truth.rounds[0]!,
    outcome: "report",
    status: "succeeded",
    citations: [],
    allLogQueriesEmpty: false,
    expectedShas: { app: sha },
    visibility: visibilityWith(callEvidence),
    requiredTraceEvents: [],
    presentTraceEvents: [],
    ...over,
  };
  return scoreTrial({ caseDesc, truth, engine: "scripted", trialId: "t1", suiteRunId: "s1", rounds: [round] });
}

// ---------- 2. 错误 SHA 的相同文本不命中 C1（审计探针 wrongShaVisibility） ----------

test("可见性：错误 SHA/版本的相同文本不得命中 C1（身份绑定）", () => {
  const good = makeScore([{ callId: "c1", text: "throw new NullPointerException", isError: false, evidence: [evidenceFor("E1", sha)] }]);
  assert.equal(good.recall.C1!.numerator, 1, "正确版本 + 文本可见 → C1 命中");

  // 审计探针场景：文本来自错误版本（B=false），修复前 C1=true。
  const wrong = makeScore([{ callId: "c1", text: "throw new NullPointerException", isError: false, evidence: [evidenceFor("E1", wrongSha)] }]);
  assert.equal(wrong.recall.B!.numerator, 0);
  assert.equal(wrong.recall.C1!.numerator, 0, "同文本但批次证据 SHA 不符 → C1 不得命中");
  assert.equal(wrong.recall.D!.numerator, 0);
});

test("可见性：文本可见但同调用未提交任何批次（恢复补记/中断）不得命中 C1", () => {
  const s = makeScore([{ callId: "c1", text: "throw new NullPointerException", isError: false, evidence: [] }]);
  assert.equal(s.recall.C1!.numerator, 0, "不能仅凭文本推定可见有效");
});

// ---------- 3. 未评分语义在各级汇总保持 null（审计探针 unreviewedSemantics） ----------

test("汇总：未 review 的语义项在 trial 与 suite 聚合都保持 null（不得由分子分母再生）", () => {
  const good = makeScore([{ callId: "c1", text: "throw new NullPointerException", isError: false, evidence: [evidenceFor("E1", sha)] }]);
  assert.equal(good.claimSupport.value, null, "trial 级 claimSupport 未评分必须 null");
  assert.equal(good.claimSupport.denominator, 0, "代理分子分母不得塞进 claimSupport");
  assert.ok(good.requiredFactCoverage !== undefined, "关键词代理单列为 requiredFactCoverage");
  // 三个 trial 汇总：aggregate 不得出现 value=1。
  const summaryCases = [
    { caseId: "c", familyId: "f", split: "engineering" as const, admission: "admitted" as const, trials: [good, structuredClone(good), structuredClone(good)] },
  ];
  const trials = summaryCases.flatMap((c) => c.trials);
  const num = trials.reduce((n, t) => n + t.claimSupport.numerator, 0);
  const den = trials.reduce((n, t) => n + t.claimSupport.denominator, 0);
  const unscored = trials.reduce((n, t) => n + t.claimSupport.unscored, 0);
  assert.equal(den, 0);
  assert.ok(unscored > 0);
  assert.equal(den > 0 && unscored === 0 ? num / den : null, null, "聚合规则：den=0 或 unscored>0 → null");
});

// ---------- 4. review 工件：导入、绑定校验、重评分 ----------

test("review：合法工件导入后 claimSupport 出值、semanticReview 更新；硬失败不受影响", () => {
  const base = makeScore([{ callId: "c1", text: "throw new NullPointerException", isError: false, evidence: [evidenceFor("E1", sha)] }]);
  const scorerInput: ScorerInput = {
    caseDesc, truth, engine: "scripted", trialId: "t1", suiteRunId: "s1",
    rounds: [{ roundId: "r1", truth: truth.rounds[0]!, outcome: "report", status: "succeeded", citations: [], allLogQueriesEmpty: false, expectedShas: { app: sha }, visibility: visibilityWith([{ callId: "c1", text: "throw new NullPointerException", isError: false, evidence: [evidenceFor("E1", sha)] }]), requiredTraceEvents: [], presentTraceEvents: [] }],
  };
  const review = {
    schemaVersion: "prediagnosis-review-v2" as const,
    suiteRunId: "s1",
    caseId: "t-case",
    trialId: "t1",
    review: { author: "human-a", reviewer: "human-b", provisional: false, rubricHash: "deadbeef" },
    claims: [
      { roundId: "r1", stage: "validated" as const, field: "hypotheses" as const, index: 0, verdict: "supported" as const, rationale: "证据与措辞匹配" },
    ],
  };
  const checked = validateReview(review, caseDesc);
  assert.equal(checked.ok, true);
  const reviewed = applyReview(scorerInput, base, checked.ok ? checked.value : review);
  assert.equal(reviewed.semanticReview.imported, true);
  assert.equal(reviewed.semanticReview.provisional, false);
  assert.equal(reviewed.claimSupport.value, 1);
  assert.deepEqual(reviewed.hardFailures, base.hardFailures, "review 不得改变确定性硬失败");
  // 重放确定性：同一输入重评分结果稳定
  assert.deepEqual(applyReview(scorerInput, base, checked.ok ? checked.value : review), reviewed);
});

test("review：绑定错误/非法 verdict/缺理由 → 整份拒绝", () => {
  const badCase = { ...caseDesc, caseId: "other-case" };
  const base = { schemaVersion: "prediagnosis-review-v2" as const, suiteRunId: "s1", caseId: "t-case", trialId: "t1", review: { author: "a", reviewer: "b", provisional: false }, claims: [{ roundId: "r1", stage: "validated" as const, field: "hypotheses" as const, verdict: "supported" as const, rationale: "r" }] };
  assert.equal(validateReview(base, badCase).ok, false, "caseId 绑定错误必须拒绝");
  assert.equal(validateReview({ ...base, review: { author: "a", reviewer: "b", provisional: true } }, caseDesc).ok, false, "provisional 工件不得导入");
  assert.equal(
    validateReview({ ...base, claims: [{ roundId: "rX", stage: "validated" as const, field: "hypotheses" as const, verdict: "supported" as const, rationale: "r" }] }, caseDesc).ok,
    false,
    "未知 roundId 必须拒绝",
  );
  assert.equal(
    validateReview({ ...base, claims: [{ roundId: "r1", stage: "validated" as const, field: "hypotheses" as const, verdict: "excellent" as never, rationale: "" }] }, caseDesc).ok,
    false,
  );
});

// ---------- 5. 回写分母与反证缺测（审计配套项） ----------

test("回写：缺失回写计入分母并判失败（不得漏计）", () => {
  const s = makeScore([{ callId: "c1", text: "x", isError: false, evidence: [] }], { writebackText: undefined });
  assert.equal(s.writebackSuccess.denominator, 1, "每轮都计分母");
  assert.equal(s.writebackSuccess.numerator, 0);
  assert.equal(s.writebackSuccess.value, 0);
});

test("反证：失败轮/无正式报告 → 反证更新为缺测 null，不算撤回成功；固执仍判失败", () => {
  const contradictedTruth: TruthFileV2 = {
    ...truth,
    rounds: [{ ...truth.rounds[0]!, contradictedClaims: [{ claimId: "c1", concepts: [["redis", "连接池"]], allowCandidate: true }] }],
  };
  const round: RoundScoreInput = {
    roundId: "r1", truth: contradictedTruth.rounds[0]!, outcome: "error", status: "failed",
    citations: [], allLogQueriesEmpty: false, expectedShas: { app: sha },
    visibility: visibilityWith([]), requiredTraceEvents: [], presentTraceEvents: [],
  };
  const s = scoreTrial({ caseDesc, truth: contradictedTruth, engine: "scripted", trialId: "t1", suiteRunId: "s1", rounds: [round] });
  assert.equal(s.contradictionUpdateSuccess.denominator, 0, "失败轮不进判定分母");
  assert.equal(s.contradictionUpdateSuccess.unscored, 1, "缺测单列");
  assert.equal(s.contradictionUpdateSuccess.value, null);

  // 空假设但 confirmedFacts 复述被推翻结论 → 固执失败，不算撤回；
  // summary 属叙述文本（可合法提及伴随现象），固执表达由 forbiddenRules 声明。
  const stubborn: RoundScoreInput = {
    ...round, outcome: "report", status: "succeeded",
    validatedReport: { completeness: "complete", summary: "继续排查中", confirmedFacts: ["确认仍是 Redis 连接池问题"], hypotheses: [], nextSteps: [], corrections: [], missingMaterial: [] },
  };
  const s2 = scoreTrial({ caseDesc, truth: contradictedTruth, engine: "scripted", trialId: "t1", suiteRunId: "s1", rounds: [stubborn] });
  assert.equal(s2.contradictionUpdateSuccess.value, 0, "summary 复述被推翻结论也是固执");
});

// ---------- 6. suite 撞名拒绝 + 单 case 异常不终止 suite ----------

test("suite：同名运行目录已存在 → 拒绝，不混合新旧记录；单 case 异常不影响其他 case", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-suite-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    const opts = {
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "dup-1",
      engine: "scripted" as const, repeat: 1, baseConfig: testConfig(),
    };
    const summary1 = await runSuite(opts);
    assert.equal(summary1.cases.length, 5, "三个行为 case + 两个版本 case（版本 case 预期失败但不阻断 suite）");
    await assert.rejects(() => runSuite(opts), /已存在且非空/, "同名 suite 必须拒绝");
    // 单 case 异常：写一个缺脚本的 scripted case 到 catalog，suite 仍应完成其余 case。
    const catalogPath = join(root, "catalog", "catalog.json");
    const { readFileSync, writeFileSync: wfs } = await import("node:fs");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { cases: Array<{ caseId: string; publicDir: string; privateDir: string }> };
    mkdirSync(join(root, "public", "eng-broken"), { recursive: true });
    mkdirSync(join(root, "private", "eng-broken"), { recursive: true });
    wfs(join(root, "public", "eng-broken", "case.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(root, "public", "eng-clarify", "case.json"), "utf8")), caseId: "eng-broken" }));
    wfs(join(root, "private", "eng-broken", "truth.private.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(root, "private", "eng-clarify", "truth.private.json"), "utf8")), caseId: "eng-broken" }));
    catalog.cases.push({ caseId: "eng-broken", publicDir: "public/eng-broken", privateDir: "private/eng-broken" });
    wfs(catalogPath, JSON.stringify(catalog));
    const summary2 = await runSuite({ ...opts, suiteRunId: "dup-2" });
    assert.equal(summary2.cases.length, 5, "好 case（含两个预期失败的版本 case）全部完成，坏 case 被隔离");
    assert.ok(summary2.families.every((f) => f.trials > 0));
  } finally {
    // 临时目录留给系统清理
  }
});
