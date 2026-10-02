// 评分器 v3 正反例（方案 §9.4）：先证明不会乱给分，也证明不会把正确答案一律判错。
// 全部为确定性判定；语义等价（claimSupport）在 review 导入前必须保持 null。
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertsGroup, assertsConcepts, scoreTrial, type RoundScoreInput, type ScorerInput } from "../../src/evals/v2/scorer.ts";
import { computeRequirementSatisfaction, layerBByInvestigation, type LayerContext, type LayerEvidence, type SqliteLike } from "../../src/evals/v2/visibility.ts";
import type { CaseDescriptorV2, TruthFileV2 } from "../../src/evals/v2/types.ts";

// ---------- 概念断言：否定窗口（§9.4 否定正确原因 / 重复禁用断言） ----------

test("否定正确原因：『并非库存超时，而是 Redis』不算断言库存超时", () => {
  assert.equal(assertsGroup("并非库存超时，而是 Redis 连接池问题", ["库存", "inventory"]), false);
  assert.equal(assertsGroup("并非库存超时，而是 Redis 连接池问题", ["超时", "timeout"]), false);
});

test("重复禁用断言：先否定后肯定，肯定那次命中", () => {
  const text = "不是 Redis 导致的。综合看，就是 Redis 连接池打满造成的";
  assert.equal(assertsGroup(text, ["redis", "Redis"]), true);
});

test("断言判定：多组 AND 语义（concept groups）", () => {
  assert.equal(assertsConcepts("库存服务调用超时导致下单失败", [["库存"], ["超时", "timeout"]]), true);
  assert.equal(assertsConcepts("库存服务正常但下单失败", [["库存"], ["超时", "timeout"]]), false);
});

// ---------- 合成输入构造 ----------

const caseDesc: CaseDescriptorV2 = {
  schemaVersion: "prediagnosis-case-v2",
  caseId: "t-case",
  familyId: "t-family",
  split: "engineering",
  sourceTier: "synthetic_engineering",
  publicBenchmark: false,
  admission: "admitted",
  maxRounds: 2,
  rounds: [
    { roundId: "r1", messageRef: "m.txt", receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: null, materialView: "round-1", services: ["svc"], repos: [{ repoId: "app", dir: "fixtures/demo-repo" }] },
  ],
};

const truthBase = {
  schemaVersion: "prediagnosis-truth-v2" as const,
  caseId: "t-case",
  locators: [
    { kind: "log" as const, locatorId: "loc-timeout", keyContent: "InventoryClient 调用库存服务失败 timeout", level: "ERROR" },
    { kind: "code" as const, locatorId: "loc-npe", repoId: "app", sha: "a".repeat(40), path: "src/OrderService.java", lineStart: 15, lineEnd: 17, keyContent: "throw new NullPointerException" },
  ],
  review: { author: "t", reviewer: "t", provisional: true },
};

const sha = "a".repeat(40);

function logEv(id: string, excerpt: string, opts?: { sha?: string }): LayerEvidence {
  return { evidenceId: id, evidenceUid: `uid-${id}`, runId: "r", kind: "log", excerpt, truncated: false, level: "ERROR" };
}

function codeEv(id: string, excerpt: string, path = "src/OrderService.java", codeSha = sha): LayerEvidence {
  return { evidenceId: id, evidenceUid: `uid-${id}`, runId: "r", kind: "code", excerpt, truncated: false, codeRef: { repoId: "app", sha: codeSha, path, startLine: 15, endLine: 17 } };
}

const sqliteStub = (rows: Array<Record<string, unknown>>): SqliteLike => ({
  prepare() {
    return { all: () => rows, get: () => rows[0] };
  },
});

interface RoundOverrides {
  truthRound?: Partial<TruthFileV2["rounds"][number]>;
  raw?: RoundScoreInput["rawDraft"];
  validated?: RoundScoreInput["validatedReport"];
  citations?: RoundScoreInput["citations"];
  allLogQueriesEmpty?: boolean;
  persisted?: LayerEvidence[];
  toolReturnText?: string;
  cited?: LayerEvidence[];
  sourceEntries?: Array<{ level: string; message: string }>;
  outcome?: RoundScoreInput["outcome"];
  status?: string;
  writebackText?: string;
  replyText?: string;
}

function baseTruthRound(over: Partial<TruthFileV2["rounds"][number]> = {}): TruthFileV2["rounds"][number] {
  return {
    roundId: "r1",
    allowedOutcomes: ["report"],
    allowedClaimDepth: "root",
    requiredFacts: [],
    forbiddenRules: [],
    materialNeeds: [],
    evidenceRequirements: [{ requirementId: "req-timeout", depth: "root", supportsAnyOf: [{ allOf: ["loc-timeout"] }] }],
    contradictedClaims: [],
    writebackRequirements: [],
    ...over,
  };
}

function visibilityFor(truth: TruthFileV2, persisted: LayerEvidence[], toolReturnText: string, cited: LayerEvidence[], sourceEntries: Array<{ level: string; message: string }> = []): RoundScoreInput["visibility"] {
  const ctx: LayerContext = {
    sourceCalls: sourceEntries.length > 0 ? [{ tool: "query_logs", args: { service: "svc", from: 0, to: 1, keywords: [] }, entries: sourceEntries.map((e) => ({ time: 0, level: e.level, message: e.message })) }] : [],
    persisted,
    // 合成上下文：单次调用，文本=toolReturnText，批次证据=persisted（与 runner 组装同构）。
    callEvidence: [{ callId: "call-1", text: toolReturnText, isError: false, evidence: persisted }],
    cited,
    observationLevel: "b-c1-d",
    c2Reason: "no request observation",
  };
  return computeRequirementSatisfaction({ caseRoundIds: ["r1"], truth, roundId: "r1", ctx });
}

function makeInput(roundOver: RoundOverrides): ScorerInput {
  const truth: TruthFileV2 = { ...truthBase, rounds: [baseTruthRound(roundOver.truthRound)] };
  const persisted = roundOver.persisted ?? [];
  const toolReturnText = roundOver.toolReturnText ?? "";
  const cited = roundOver.cited ?? [];
  const visibility = visibilityFor(truth, persisted, toolReturnText, cited, roundOver.sourceEntries ?? []);
  const round: RoundScoreInput = {
    roundId: "r1",
    truth: truth.rounds[0]!,
    outcome: roundOver.outcome ?? "report",
    status: roundOver.status ?? "succeeded",
    rawDraft: roundOver.raw,
    validatedReport: roundOver.validated,
    replyText: roundOver.replyText,
    writebackText: roundOver.writebackText,
    citations: roundOver.citations ?? [],
    allLogQueriesEmpty: roundOver.allLogQueriesEmpty ?? false,
    expectedShas: { app: sha },
    visibility,
    requiredTraceEvents: ["round_input", "output_persisted"],
    presentTraceEvents: ["round_input", "output_persisted"],
  };
  return { caseDesc, truth, engine: "scripted", trialId: "t1", suiteRunId: "s1", rounds: [round] };
}

const TIMEOUT_EXCERPT = "2026-09-06T10:01:58 ERROR InventoryClient 调用库存服务失败 timeout after 3000ms traceId=tr_9f2c81";
type ValidatedReport = NonNullable<RoundScoreInput["validatedReport"]>;
const goodReport = (evidenceIds: string[] = ["E1"], over: Partial<ValidatedReport> = {}): ValidatedReport => ({
  completeness: "complete",
  summary: "库存服务调用超时导致下单失败",
  confirmedFacts: ["InventoryClient 调用库存服务失败 timeout after 3000ms"],
  hypotheses: [{ cause: "库存服务调用超时（InventoryClient 3000ms）导致下单失败", status: "supported", evidenceIds }],
  nextSteps: [],
  corrections: [],
  missingMaterial: [],
  ...over,
});

// ---------- 反例逐条 ----------

test("§9.4 入库未返回：gold 在 B 不在 C1 → 工具可见召回为 0，入库召回为 1", () => {
  const input = makeInput({
    truthRound: { evidenceRequirements: [{ requirementId: "req-timeout", depth: "root", supportsAnyOf: [{ allOf: ["loc-timeout"] }] }] },
    persisted: [logEv("E1", TIMEOUT_EXCERPT)],
    toolReturnText: "命中 3 条日志：\n[E1] 前两条无关日志（截断提示）",
    validated: goodReport(["E1"]),
    citations: [{ rawId: "uid-E1", stage: "validated", roundId: "r1", resolved: true, evidence: { evidenceId: "E1", evidenceUid: "uid-E1", kind: "log", excerpt: "无关", truncated: false, level: "ERROR" } }],
  });
  const s = scoreTrial(input);
  assert.equal(s.recall.B!.numerator, 1);
  assert.equal(s.recall.C1!.numerator, 0, "入库但未展示的内容不得计可见召回");
  assert.equal(s.recall.C1!.value, 0);
});

test("§9.4 截断：codeRef 命中行区间但关键内容不在 excerpt → B/C1 都不计", () => {
  const truth: TruthFileV2 = {
    ...truthBase,
    rounds: [baseTruthRound({ evidenceRequirements: [{ requirementId: "req-npe", depth: "root", supportsAnyOf: [{ allOf: ["loc-npe"] }] }] })],
  };
  const truncatedBody = codeEv("E1", "src/OrderService.java:15-17（内容被截断…）");
  const visibility = visibilityFor(truth, [truncatedBody], "", []);
  const input: ScorerInput = {
    caseDesc,
    truth,
    engine: "scripted",
    trialId: "t1",
    suiteRunId: "s1",
    rounds: [{ roundId: "r1", truth: truth.rounds[0]!, outcome: "report", status: "succeeded", citations: [], allLogQueriesEmpty: false, expectedShas: { app: sha }, visibility, requiredTraceEvents: [], presentTraceEvents: [] }],
  };
  const s = scoreTrial(input);
  assert.equal(s.recall.B!.numerator, 0, "区间重叠但关键内容缺失不算命中");
  assert.equal(s.recall.C1!.numerator, 0);
});

test("§9.4 错误 SHA：路径行号相同、版本不同 → wrong_sha 硬失败且引用有效性下降", () => {
  const wrongShaEv = codeEv("E1", "throw new NullPointerException(...)", "src/OrderService.java", "b".repeat(40));
  const input = makeInput({
    truthRound: { evidenceRequirements: [{ requirementId: "req-npe", depth: "root", supportsAnyOf: [{ allOf: ["loc-npe"] }] }] },
    persisted: [wrongShaEv],
    toolReturnText: "throw new NullPointerException",
    validated: goodReport(["uid-E1"]),
    citations: [{ rawId: "uid-E1", stage: "validated", roundId: "r1", resolved: true, evidence: { evidenceId: "E1", evidenceUid: "uid-E1", kind: "code", excerpt: wrongShaEv.excerpt, truncated: false, codeRef: wrongShaEv.codeRef }, wrongSha: true }],
  });
  const s = scoreTrial(input);
  assert.ok(s.hardFailures.some((f) => f.code === "wrong_sha"), "版本错配必须硬失败");
  assert.equal(s.citationValidity.value, 0);
});

test("§9.4 无关片段：引用有效但不支持当前结论 → 引用有效与语义支持分别记录", () => {
  const input = makeInput({
    persisted: [logEv("E1", TIMEOUT_EXCERPT)],
    toolReturnText: TIMEOUT_EXCERPT,
    validated: goodReport(["uid-E1"]),
    citations: [{ rawId: "uid-E1", stage: "validated", roundId: "r1", resolved: true, evidence: { evidenceId: "E1", evidenceUid: "uid-E1", kind: "log", excerpt: "完全无关的健康检查日志", truncated: false, level: "INFO" } }],
  });
  const s = scoreTrial(input);
  assert.equal(s.citationValidity.value, 1, "引用本身可解析且版本正确 → 有效");
  assert.equal(s.recall.D!.numerator, 0, "但引用内容不支持需求 → D 层不命中");
});

test("§9.4 错根因+正确引用：不能被引证救回（forbidden rule + supported）", () => {
  const input = makeInput({
    truthRound: {
      forbiddenRules: [{ ruleId: "no-redis-root", where: ["hypotheses"], assertAnyOf: [["redis", "连接池"]], onlyWhenStatus: "supported" }],
    },
    persisted: [logEv("E1", TIMEOUT_EXCERPT)],
    toolReturnText: TIMEOUT_EXCERPT,
    validated: goodReport(["uid-E1"], { hypotheses: [{ cause: "Redis 连接池打满导致下单失败", status: "supported", evidenceIds: ["uid-E1"] }] }),
    citations: [{ rawId: "uid-E1", stage: "validated", roundId: "r1", resolved: true, evidence: { evidenceId: "E1", evidenceUid: "uid-E1", kind: "log", excerpt: TIMEOUT_EXCERPT, truncated: false, level: "ERROR" } }],
  });
  const s = scoreTrial(input);
  assert.ok(s.hardFailures.some((f) => f.code === "forbidden_assertion"), "错误根因被引证也必须判错");
});

test("§9.4 合理追问：关键材料缺失且补问命中 → 补证成功，不要求 report", () => {
  const input = makeInput({
    truthRound: {
      allowedOutcomes: ["clarify"],
      materialNeeds: [{ needId: "need-time", description: "发生时间", clarifyConcepts: [["时间", "什么时候"], ["服务", "哪个服务"]] }],
      evidenceRequirements: [],
    },
    outcome: "clarify",
    replyText: "请补充故障发生时间与所属服务，我再继续查日志。",
    status: "succeeded",
  });
  const s = scoreTrial(input);
  assert.equal(s.clarificationSuccess.value, 1);
  assert.equal(s.executionSuccess, true, "clarify 是合法业务产出");
});

test("§9.4 空日志：不能断言服务健康或故障不存在", () => {
  const input = makeInput({
    truthRound: {
      forbiddenRules: [{ ruleId: "no-health-claim", where: ["summary", "hypotheses"], assertAnyOf: [["健康", "无故障", "没有故障", "正常"]], onlyWhenAllLogQueriesEmpty: true }],
    },
    allLogQueriesEmpty: true,
    validated: {
      completeness: "complete",
      summary: "日志查询为空。据此判断服务健康、运行正常，本次无故障发生",
      confirmedFacts: [],
      hypotheses: [],
      nextSteps: [],
      corrections: [],
      missingMaterial: [],
    },
  });
  const s = scoreTrial(input);
  assert.ok(s.hardFailures.some((f) => f.code === "forbidden_assertion" && f.message.includes("no-health-claim")));
});

test("§9.4 摘要越界：hypotheses 无 supported，summary 已断言根因 → 判越界", () => {
  const input = makeInput({
    truthRound: {
      forbiddenRules: [{ ruleId: "no-root-in-summary", where: ["summary"], assertAnyOf: [["库存", "inventory"]] }],
    },
    validated: {
      completeness: "partial",
      summary: "疑似库存服务问题导致的失败",
      confirmedFacts: [],
      hypotheses: [{ cause: "待查", status: "candidate" }],
      nextSteps: [],
      corrections: [],
      missingMaterial: ["日志"],
    } as ValidatedReport,
  });
  const s = scoreTrial(input);
  assert.ok(s.hardFailures.some((f) => f.code === "forbidden_assertion"));
});

test("§9.4 正确局部定位：symptom 轮给出 symptom 结论不判错", () => {
  const input = makeInput({
    truthRound: { allowedClaimDepth: "symptom", evidenceRequirements: [] },
    validated: {
      completeness: "partial",
      summary: "下单接口在时间窗内出现 5xx，具体根因待查",
      confirmedFacts: ["时间窗内出现 5xx"],
      hypotheses: [{ cause: "下单接口 5xx，根因待进一步取证", status: "candidate" }],
      nextSteps: ["补充分配件日志"],
      corrections: [],
      missingMaterial: ["配件服务日志"],
    },
  });
  const s = scoreTrial(input);
  assert.deepEqual(s.hardFailures.filter((f) => f.code === "forbidden_assertion"), []);
  assert.equal(s.executionSuccess, true);
});

test("§9.4 合法替代证据：未固定调用顺序，等价 OR 组合命中即满足", () => {
  const truth: TruthFileV2 = {
    ...truthBase,
    locators: [
      ...truthBase.locators,
      { kind: "code" as const, locatorId: "loc-npe-alt", repoId: "app", sha: "a".repeat(40), path: "src/Other.java", lineStart: 15, lineEnd: 17, keyContent: "ALT-MARKER" },
    ],
    rounds: [
      baseTruthRound({
        evidenceRequirements: [
          { requirementId: "req-alt", depth: "root", supportsAnyOf: [{ allOf: ["loc-timeout"] }, { allOf: ["loc-npe-alt"] }] },
        ],
      }),
    ],
  };
  const alt = codeEv("E2", "ALT-MARKER here", "src/Other.java");
  const visibility = visibilityFor(truth, [alt], "ALT-MARKER here", [alt]);
  const input: ScorerInput = {
    caseDesc,
    truth,
    engine: "scripted",
    trialId: "t1",
    suiteRunId: "s1",
    rounds: [{ roundId: "r1", truth: truth.rounds[0]!, outcome: "report", status: "succeeded", citations: [], allLogQueriesEmpty: false, expectedShas: { app: sha }, visibility, requiredTraceEvents: [], presentTraceEvents: [] }],
  };
  const s = scoreTrial(input);
  assert.equal(s.recall.C1!.numerator, 1, "第二个 OR 组合满足即算召回");
});

test("§9.4 无 gold：材料不足轮次召回为 null（0/0），不按 0 或 1 报数", () => {
  const input = makeInput({
    truthRound: { allowedOutcomes: ["clarify"], evidenceRequirements: [] },
    outcome: "clarify",
    replyText: "请提供更多材料",
    status: "succeeded",
  });
  const s = scoreTrial(input);
  assert.equal(s.recall.C1!.denominator, 0);
  assert.equal(s.recall.C1!.value, null);
});

test("§9.4 校验器救正：raw 越界 supported，validated 已降级 → raw 保留失败记录，validated 无失败", () => {
  const raw: NonNullable<RoundScoreInput["rawDraft"]> = {
    completeness: "complete",
    summary: "库存超时导致失败",
    confirmedFacts: [],
    hypotheses: [{ cause: "库存服务调用超时导致下单失败", status: "supported" }],
    nextSteps: [],
  };
  const validated: ValidatedReport = {
    completeness: "complete",
    summary: "库存超时导致失败",
    confirmedFacts: [],
    hypotheses: [{ cause: "库存服务调用超时导致下单失败", status: "candidate", evidenceIds: [] }],
    nextSteps: [],
    corrections: ["假设 1 无有效证据，状态从 supported 降为 candidate"],
    missingMaterial: [],
  };
  const input = makeInput({
    truthRound: {
      forbiddenRules: [{ ruleId: "no-uncited-root", where: ["hypotheses"], assertAnyOf: [["库存", "超时"]], onlyWhenHypothesisUncited: true, onlyWhenStatus: "supported" }],
    },
    raw,
    validated,
  });
  const s = scoreTrial(input);
  const rawFinding = s.stageFindings.find((f) => f.stage === "raw");
  const validatedFinding = s.stageFindings.find((f) => f.stage === "validated");
  assert.ok(rawFinding!.hardFailures.some((f) => f.code === "forbidden_assertion"), "raw 错误不因校验器纠正而抹去");
  assert.deepEqual(validatedFinding!.hardFailures, []);
  assert.equal(s.hardFailures.length, 0, "硬失败只按 validated 口径计入总分");
});

test("§9.4 引用不存在：UID 无法解析 → 硬失败", () => {
  const input = makeInput({
    validated: goodReport(["uid-ghost"]),
    citations: [{ rawId: "uid-ghost", stage: "validated", roundId: "r1", resolved: false }],
  });
  const s = scoreTrial(input);
  assert.ok(s.hardFailures.some((f) => f.code === "citation_unresolvable"));
});

test("§9.4 反证后固执：第二轮仍 supported 断言被推翻结论 → 反证更新失败；降级则成功", () => {
  const contradicted = { claimId: "redis-cause", concepts: [["redis", "连接池"]], allowCandidate: true };
  const stubborn = makeInput({
    truthRound: { contradictedClaims: [contradicted] },
    validated: { ...goodReport(["uid-E1"]), hypotheses: [{ cause: "Redis 连接池打满导致下单失败", status: "supported", evidenceIds: ["uid-E1"] }] },
    persisted: [logEv("E1", TIMEOUT_EXCERPT)],
    toolReturnText: TIMEOUT_EXCERPT,
    citations: [{ rawId: "uid-E1", stage: "validated", roundId: "r1", resolved: true, evidence: { evidenceId: "E1", evidenceUid: "uid-E1", kind: "log", excerpt: TIMEOUT_EXCERPT, truncated: false, level: "ERROR" } }],
  });
  assert.equal(scoreTrial(stubborn).contradictionUpdateSuccess.value, 0);

  const downgraded = makeInput({
    truthRound: { contradictedClaims: [contradicted] },
    validated: goodReport(["uid-E1"], { hypotheses: [{ cause: "Redis 连接池问题", status: "candidate", evidenceIds: ["uid-E1"] }] }),
  });
  assert.equal(scoreTrial(downgraded).contradictionUpdateSuccess.value, 1, "明确降级即算更新成功");
});

// ---------- 正例：完整正确 trial ----------

test("正例：证据可见、引用有效、根因正确、回写完整 → 全绿且语义分保持 null", () => {
  const input = makeInput({
    persisted: [logEv("E1", TIMEOUT_EXCERPT)],
    toolReturnText: TIMEOUT_EXCERPT,
    cited: [logEv("E1", TIMEOUT_EXCERPT)],
    validated: goodReport(["uid-E1"]),
    raw: { completeness: "complete", summary: "库存服务调用超时导致下单失败", confirmedFacts: [], hypotheses: [{ cause: "库存服务调用超时导致下单失败", status: "supported", evidenceIds: ["E1"] }], nextSteps: [] },
    citations: [{ rawId: "uid-E1", stage: "validated", roundId: "r1", resolved: true, evidence: { evidenceId: "E1", evidenceUid: "uid-E1", kind: "log", excerpt: TIMEOUT_EXCERPT, truncated: false, level: "ERROR" } }],
    writebackText: "【预检报告】库存服务调用超时导致下单失败……缺失材料：无",
  });
  const s = scoreTrial(input);
  assert.equal(s.executionSuccess, true);
  assert.equal(s.recall.C1!.value, 1);
  assert.equal(s.recall.D!.value, 1);
  assert.equal(s.citationValidity.value, 1);
  assert.equal(s.writebackSuccess.value, 1);
  assert.deepEqual(s.hardFailures, []);
  assert.equal(s.claimSupport.value, null, "语义支持未人工复核必须 null");
  assert.equal(s.semanticReview.provisional, true);
});

test("输出错类型：诊断轮闲聊 → outcome_out_of_policy", () => {
  const input = makeInput({ outcome: "chat", replyText: "你好呀", status: "succeeded" });
  const s = scoreTrial(input);
  assert.ok(s.hardFailures.some((f) => f.code === "outcome_out_of_policy"));
  assert.equal(s.executionSuccess, false);
});
