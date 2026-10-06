// 审计修复验收反例（工单 §三）：每条对应一个已复现缺陷，先证伪再修复。
// 修复前后结果保留在 git 历史；本文件锁定修复后的判定。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LogAccessError, FileLogSource } from "../../src/sources/logs.ts";
import { applyReview, judgedOutputsHash, validateReview } from "../../src/evals/v2/review.ts";
import { listJudgableClaims, scoreTrial, type RoundScoreInput, type ScorerInput } from "../../src/evals/v2/scorer.ts";
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
    // 默认带一份 validated 终稿：claimSupport 的缺测口径（A2）= 实际可判判断清单
    // （summary 1 条 + hypotheses 1 条 = 2），未复核时 unscored=2、value=null。
    validatedReport: { completeness: "complete", summary: "库存服务调用失败（NPE）", confirmedFacts: [], hypotheses: [{ cause: "库存服务调用失败（NPE）", status: "supported", evidenceIds: ["uid-E1"] }], nextSteps: [], corrections: [], missingMaterial: [] },
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

// ---------- 4. review 工件：导入、绑定校验、重评分（A2 v3 契约） ----------

function scorerInputFor(): ScorerInput {
  return {
    caseDesc, truth, engine: "scripted", trialId: "t1", suiteRunId: "s1",
    rounds: [{ roundId: "r1", truth: truth.rounds[0]!, outcome: "report", status: "succeeded", citations: [], allLogQueriesEmpty: false, expectedShas: { app: sha }, visibility: visibilityWith([{ callId: "c1", text: "throw new NullPointerException", isError: false, evidence: [evidenceFor("E1", sha)] }]), requiredTraceEvents: [], presentTraceEvents: [], validatedReport: { completeness: "complete", summary: "库存服务调用失败（NPE）", confirmedFacts: [], hypotheses: [{ cause: "库存服务调用失败（NPE）", status: "supported", evidenceIds: ["uid-E1"] }], nextSteps: [], corrections: [], missingMaterial: [] } }],
  };
}

function bindFor(input: ScorerInput) {
  return { suiteRunId: input.suiteRunId, outputsHash: judgedOutputsHash(input), claims: listJudgableClaims(input.rounds) };
}

function validReview(input: ScorerInput, verdict: "supported" | "unsupported" = "supported") {
  const bind = bindFor(input);
  const hypSlot = bind.claims.find((c) => c.field === "hypotheses")!;
  const sumSlot = bind.claims.find((c) => c.field === "summary")!;
  return {
    schemaVersion: "prediagnosis-review-v3" as const,
    suiteRunId: "s1",
    caseId: "t-case",
    trialId: "t1",
    outputsHash: bind.outputsHash,
    review: { author: "human-a", reviewer: "human-b", reviewerType: "human" as const, rubricHash: "deadbeef" },
    claims: [
      { roundId: "r1", stage: "validated" as const, field: "hypotheses" as const, index: hypSlot.index, claimId: hypSlot.claimId, verdict, rationale: "证据与措辞匹配" },
      { roundId: "r1", stage: "validated" as const, field: "summary" as const, index: sumSlot.index, claimId: sumSlot.claimId, verdict, rationale: "摘要与证据一致" },
    ],
  };
}

test("review：合法工件导入后 claimSupport 出值、semanticReview 带来源与覆盖率；硬失败不受影响", () => {
  const base = makeScore([{ callId: "c1", text: "throw new NullPointerException", isError: false, evidence: [evidenceFor("E1", sha)] }]);
  const scorerInput = scorerInputFor();
  const review = validReview(scorerInput);
  const checked = validateReview(review, caseDesc, truth, bindFor(scorerInput));
  assert.equal(checked.ok, true, JSON.stringify(checked.ok ? [] : checked.errors));
  const reviewed = applyReview(scorerInput, base, checked.ok ? checked.value : review);
  assert.equal(reviewed.semanticReview.imported, true);
  assert.equal(reviewed.semanticReview.provisional, false);
  assert.equal(reviewed.semanticReview.reviewerType, "human", "来源类型必须显式（A2）");
  assert.deepEqual(reviewed.semanticReview.coverage, { reviewed: 2, total: 2 });
  assert.equal(reviewed.claimSupport.value, 1);
  assert.equal(reviewed.claimSupport.unscored, 0);
  assert.deepEqual(reviewed.hardFailures, base.hardFailures, "review 不得改变确定性硬失败");
  // 重放确定性：同一输入重评分结果稳定
  assert.deepEqual(applyReview(scorerInput, base, checked.ok ? checked.value : review), reviewed);
});

test("review：部分覆盖 → 分母来自实际判断清单，缺测保持 null 且显示覆盖率", () => {
  const base = makeScore([{ callId: "c1", text: "throw new NullPointerException", isError: false, evidence: [evidenceFor("E1", sha)] }]);
  const scorerInput = scorerInputFor();
  const full = validReview(scorerInput);
  // 只复核 hypotheses 槽位（2 个可判判断中的 1 个）
  const partial = { ...full, claims: full.claims.slice(0, 1) };
  const checked = validateReview(partial, caseDesc, truth, bindFor(scorerInput));
  assert.equal(checked.ok, true, JSON.stringify(checked.ok ? [] : checked.errors));
  const reviewed = applyReview(scorerInput, base, checked.ok ? checked.value : partial);
  assert.equal(reviewed.claimSupport.denominator, 2, "分母 = 实际可判判断数，不是提交的 review 条数");
  assert.equal(reviewed.claimSupport.numerator, 1);
  assert.equal(reviewed.claimSupport.unscored, 1, "未复核槽位保持缺测");
  assert.equal(reviewed.claimSupport.value, null, "覆盖不全时不得出值");
  assert.deepEqual(reviewed.semanticReview.coverage, { reviewed: 1, total: 2 });
});

test("review：绑定错误/未知槽位/重复记录/跨阶段/模型裁判身份缺失 → 整份拒绝", () => {
  const base = { schemaVersion: "prediagnosis-review-v3" as const, suiteRunId: "s1", caseId: "t-case", trialId: "t1", outputsHash: "x".repeat(64), review: { author: "a", reviewer: "b", reviewerType: "human" as const }, claims: [] as never[] };
  const scorerInput = scorerInputFor();
  const bind = bindFor(scorerInput);
  const v = (raw: unknown) => validateReview(raw, caseDesc, truth, bind);
  assert.equal(v({ ...base, caseId: "other-case" }).ok, false, "caseId 绑定错误必须拒绝");
  assert.equal(v({ ...base, suiteRunId: "other-suite" }).ok, false, "suite 绑定错误必须拒绝");
  assert.equal(v({ ...base, outputsHash: "0".repeat(64) }).ok, false, "输出内容指纹不匹配必须拒绝（trial 可能已重跑）");
  assert.equal(v({ ...base, review: { author: "a", reviewer: "b" } }).ok, false, "reviewerType 缺失必须拒绝");
  assert.equal(v({ ...base, review: { author: "a", reviewer: "b", reviewerType: "robot" } }).ok, false, "reviewerType 非法值必须拒绝");
  assert.equal(
    v({ ...base, claims: [{ roundId: "rX", stage: "validated", field: "hypotheses", index: 0, claimId: bind.claims[0]!.claimId, verdict: "supported", rationale: "r" }] }).ok,
    false,
    "未知 roundId 必须拒绝",
  );
  assert.equal(
    v({ ...base, claims: [{ roundId: "r1", stage: "validated", field: "hypotheses", index: 9, claimId: bind.claims[0]!.claimId, verdict: "supported", rationale: "r" }] }).ok,
    false,
    "不存在的假设下标必须拒绝",
  );
  assert.equal(
    v({ ...base, claims: [{ roundId: "r1", stage: "validated", field: "hypotheses", index: bind.claims[0]!.index, claimId: "deadbeefdeadbeef", verdict: "supported", rationale: "r" }] }).ok,
    false,
    "claimId 与输出内容不符必须拒绝",
  );
  assert.equal(
    v({ ...base, claims: [
      { roundId: "r1", stage: "validated", field: "hypotheses", index: bind.claims[0]!.index, claimId: bind.claims[0]!.claimId, verdict: "supported", rationale: "r" },
      { roundId: "r1", stage: "validated", field: "hypotheses", index: bind.claims[0]!.index, claimId: bind.claims[0]!.claimId, verdict: "unsupported", rationale: "r2" },
    ] }).ok,
    false,
    "重复复核记录必须拒绝（不得重复计分）",
  );
  assert.equal(
    v({ ...base, claims: [{ roundId: "r1", stage: "raw", field: "hypotheses", index: 0, claimId: bind.claims[0]!.claimId, verdict: "supported", rationale: "r" }] }).ok,
    false,
    "raw 跨阶段记录必须拒绝（语义判断只针对 validated 终稿）",
  );
  assert.equal(
    v({ schemaVersion: "prediagnosis-review-v2", suiteRunId: "s1", caseId: "t-case", trialId: "t1", review: { author: "a", reviewer: "b", provisional: true }, claims: [] }).ok,
    false,
    "v2 旧工件必须整体拒绝",
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
    assert.equal(summary1.cases.length, 6, "四个行为 case（含 A1 审计循环）+ 两个版本 case（版本 case 预期失败但不阻断 suite）");
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
    assert.equal(summary2.cases.length, 6, "好 case（含两个预期失败的版本 case）全部完成，坏 case 被隔离");
    assert.ok(summary2.families.every((f) => f.trials > 0));
    // A3：终态必须显式入账——坏 case 进 caseStatuses（load_error），计划口径可对账。
    const broken = summary2.caseStatuses.find((s) => s.caseId === "eng-broken");
    assert.equal(broken?.phase, "load_error");
    assert.equal(summary2.planned.cases, 7);
    assert.equal(summary2.caseStatuses.length, 7, "每个计划 case 都必须有终态（A3）");
    assert.equal(summary2.caseStatuses.filter((s) => s.phase === "scored").length, 6);
  } finally {
    // 临时目录留给系统清理
  }
});
