// 评分器 v3（方案 §9）：确定性硬检查 → 逐轮行为/断言复核 → 分维度汇总。
//
// 口径规则：
//   * SCORER_VERSION 独立于旧 2.0.0；不同版本禁止同表对比。
//   * 语义等价判定（根因措辞是否可接受）属人工 rubric：review 导入前 claimSupport 记
//     unscored（value=null），不用关键词冒充语义分（§9.3）。
//   * 确定性层覆盖 §9.4 机器可判反例：否定豁免、重复断言、入库未返回（可见性召回层差）、
//     截断、错误 SHA、错根因+正确引用（claimSupport 引用条件+归因）、合理追问、空日志推健康、
//     摘要越界、反证后固执、引用不可解析等。
//   * 所有比率带 numerator/denominator/notApplicable/unscored；null 不参与平均。
import type {
  AssertionRuleV2,
  CaseDescriptorV2,
  CaseScoreV2,
  HardFailure,
  MetricValue,
  RoundTruthV2,
  StageFinding,
  TruthFileV2,
  RequirementSatisfaction,
} from "./types.ts";

export const SCORER_VERSION = "3.1.0";

// ---------- 概念断言判定（否定窗口豁免，逐次出现判定） ----------

const NEGATION_SHORT = /(不|非|未|无|没)/;
const NEGATION_LONG = /(并非|不是|而不是|而非|排除|没有|not|no|without|rather than)/;
/** 单字否定词贴身才算（3 字符）；多字否定短语允许 12 字符前窗。 */
const NEG_WINDOW_SHORT = 3;
const NEG_WINDOW_LONG = 12;

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

/**
 * 单组概念是否被"断言"：存在至少一次无否定前窗的命中。
 * 逐次出现判定：先否定后肯定 → 肯定那次命中（§9.4"重复禁用断言"）；
 * "并非库存超时" → 每次出现都被否定豁免 → 不算断言。
 * 窗口分两档，避免"日志没有异常，服务健康"这类远距无/没误伤正常断言。
 */
export function assertsGroup(text: string, group: string[]): boolean {
  const n = normalize(text);
  for (const word of group) {
    const w = normalize(word);
    if (!w) continue;
    let idx = n.indexOf(w);
    while (idx >= 0) {
      const pre = n.slice(Math.max(0, idx - NEG_WINDOW_LONG), idx);
      const preShort = n.slice(Math.max(0, idx - NEG_WINDOW_SHORT), idx);
      if (!NEGATION_SHORT.test(preShort) && !NEGATION_LONG.test(pre)) return true;
      idx = n.indexOf(w, idx + w.length);
    }
  }
  return false;
}

/** 全部概念组都命中（组内 any-of，组间 AND）才算断言成立。 */
export function assertsConcepts(text: string, groups: string[][]): boolean {
  return groups.every((g) => assertsGroup(text, g));
}

// ---------- 评分输入（runner 构造，outputs.json 落盘供离线重放） ----------

export interface CitationRecord {
  rawId: string;
  stage: "raw" | "validated";
  roundId: string;
  resolved: boolean;
  /** 解析后证据（可解析时）。 */
  evidence?: { evidenceId: string; evidenceUid?: string; kind: string; excerpt: string; truncated: boolean; level?: string | null; codeRef?: { repoId: string; sha: string; path: string; startLine: number; endLine: number } | null };
  /** 代码证据版本与本轮 expectedSha 不一致。 */
  wrongSha?: boolean;
}

export interface RoundScoreInput {
  roundId: string;
  truth: RoundTruthV2;
  outcome: "report" | "clarify" | "chat" | "error";
  status: string;
  errorCode?: string | null;
  rawDraft?: { completeness?: string; summary: string; confirmedFacts: string[]; hypotheses: Array<{ cause: string; status?: string; evidenceIds?: string[] }>; nextSteps: string[]; corrections?: string[]; missingMaterial?: string[] };
  validatedReport?: { completeness: string; summary: string; confirmedFacts: string[]; hypotheses: Array<{ cause: string; status?: string; evidenceIds?: string[] }>; nextSteps: string[]; corrections: string[]; missingMaterial: string[] };
  replyText?: string;
  writebackText?: string;
  /** 引用解析记录（raw 与 validated 分别登记）。 */
  citations: CitationRecord[];
  /** 本轮全部日志查询是否空结果。 */
  allLogQueriesEmpty: boolean;
  /** 本轮实际材料范围的 repoId → expectedSha（版本核对基准）。 */
  expectedShas: Record<string, string>;
  /**
   * 预检出的范围版本错配（resolved ≠ expected）。钉定失败必须在取证前暴露（P2），
   * 这里是 runner 在本轮开始前/后核对 scope 的结果；非空 → wrong_sha 硬失败。
   */
  scopeShaMismatch?: Array<{ repoId: string; expected: string; resolved: string | null }>;
  visibility: RequirementSatisfaction[];
  requiredTraceEvents: string[];
  presentTraceEvents: string[];
}

export interface ScorerInput {
  caseDesc: CaseDescriptorV2;
  truth: TruthFileV2;
  engine: string;
  trialId: string;
  suiteRunId: string;
  rounds: RoundScoreInput[];
  executionError?: string;
  semanticReviewImported?: boolean;
}

// ---------- 报告字段投影 ----------

interface ClaimSet {
  summary: string;
  confirmedFacts: string[];
  causes: Array<{ cause: string; status?: string; evidenceIds?: string[] }>;
  nextSteps: string[];
}

function claimsOf(stage: "raw" | "validated", round: RoundScoreInput): ClaimSet {
  const src = stage === "raw" ? round.rawDraft : round.validatedReport;
  if (!src) return { summary: "", confirmedFacts: [], causes: [], nextSteps: [] };
  return {
    summary: src.summary ?? "",
    confirmedFacts: src.confirmedFacts ?? [],
    causes: src.hypotheses ?? [],
    nextSteps: src.nextSteps ?? [],
  };
}

// ---------- 断言规则应用 ----------

function ruleFiresOnHypothesis(rule: AssertionRuleV2, h: { cause: string; status?: string; evidenceIds?: string[] }): boolean {
  if (rule.onlyWhenHypothesisUncited && (h.evidenceIds ?? []).length > 0) return false;
  if (rule.onlyWhenStatus && (h.status ?? "supported") !== rule.onlyWhenStatus) return false;
  return assertsConcepts(h.cause, rule.assertAnyOf);
}

function applyRules(rules: AssertionRuleV2[], stage: "raw" | "validated", round: RoundScoreInput): HardFailure[] {
  const failures: HardFailure[] = [];
  const claims = claimsOf(stage, round);
  for (const rule of rules) {
    if (rule.onlyWhenAllLogQueriesEmpty && !round.allLogQueriesEmpty) continue;
    const hypothesisScoped = rule.onlyWhenHypothesisUncited || rule.onlyWhenStatus || rule.where.every((w) => w === "hypotheses");
    if (hypothesisScoped && rule.where.every((w) => w === "hypotheses")) {
      for (const h of claims.causes) {
        if (ruleFiresOnHypothesis(rule, h)) {
          failures.push({
            code: "forbidden_assertion",
            message: `假设断言踩中禁用规则 ${rule.ruleId}（status=${h.status ?? "supported"}${rule.onlyWhenHypothesisUncited ? ",无引用" : ""}）：${h.cause.slice(0, 80)}`,
            roundId: round.roundId,
            stage,
          });
        }
      }
      continue;
    }
    const targets: string[] = [];
    for (const where of rule.where) {
      if (where === "summary") targets.push(claims.summary);
      else if (where === "confirmedFacts") targets.push(...claims.confirmedFacts);
      else if (where === "hypotheses") targets.push(...claims.causes.map((h) => h.cause));
      else if (where === "nextSteps") targets.push(...claims.nextSteps);
    }
    if (targets.some((t) => t && assertsConcepts(t, rule.assertAnyOf))) {
      failures.push({
        code: "forbidden_assertion",
        message: `断言踩中禁用规则 ${rule.ruleId}`,
        roundId: round.roundId,
        stage,
      });
    }
  }
  return failures;
}

function hardChecksForRound(round: RoundScoreInput, stage: "raw" | "validated"): HardFailure[] {
  const failures: HardFailure[] = [];

  // 0. 范围版本错配（P2）：与引用无关，属于"模型可读版本≠隔离预检版本"，必须硬失败。
  for (const m of round.scopeShaMismatch ?? []) {
    failures.push({
      code: "wrong_sha",
      message: `仓库 ${m.repoId} 实际钉定 ${m.resolved?.slice(0, 10) ?? "null"} ≠ 预检版本 ${m.expected.slice(0, 10)}（取证前版本核验失败）`,
      roundId: round.roundId,
      stage,
    });
  }

  // 1. 引用可解析性与版本（§9.4"引用不存在/跨调查→硬失败"、"错误 SHA→硬失败"）。
  for (const c of round.citations.filter((x) => x.stage === stage)) {
    if (!c.resolved) {
      failures.push({ code: "citation_unresolvable", message: `引用 ${c.rawId} 无法解析到本调查证据`, roundId: round.roundId, stage });
      continue;
    }
    if (c.wrongSha) {
      const expected = Object.entries(round.expectedShas).map(([k, v]) => `${k}=${v.slice(0, 10)}`).join(",");
      failures.push({
        code: "wrong_sha",
        message: `引用 ${c.rawId}（${c.evidence?.codeRef?.path ?? "?"}）代码版本 ${c.evidence?.codeRef?.sha?.slice(0, 10) ?? "?"} 与本轮钉定版本不符（${expected}）`,
        roundId: round.roundId,
        stage,
      });
    }
  }

  // 2. 禁用断言规则。
  failures.push(...applyRules(round.truth.forbiddenRules ?? [], stage, round));
  return failures;
}

/** 确定性回写判定（scoreTrial 与 review 重评分共用，避免两处口径漂移）。 */
export function deterministicWritebackOk(round: RoundScoreInput): boolean {
  const wb = round.writebackText ? normalize(round.writebackText) : null;
  if (wb === null) return false;
  const conceptsPresent = (groups: string[][]): boolean => {
    const words = groups.flat();
    return words.length === 0 || words.some((w) => wb.includes(normalize(w)));
  };
  return round.truth.requiredFacts.every((f) => conceptsPresent(f.concepts)) &&
    (round.truth.writebackRequirements ?? []).every((r) => conceptsPresent(r.concepts));
}

function factAsserted(fact: { concepts: string[][]; where: Array<"summary" | "confirmedFacts" | "hypotheses"> }, claims: ClaimSet): boolean {
  const texts: string[] = [];
  for (const where of fact.where) {
    if (where === "summary") texts.push(claims.summary);
    else if (where === "confirmedFacts") texts.push(...claims.confirmedFacts);
    else texts.push(...claims.causes.map((h) => h.cause));
  }
  return texts.some((t) => t && assertsConcepts(t, fact.concepts));
}

function mkMetric(num: number, den: number, na = 0, unscored = 0): MetricValue {
  return {
    numerator: num,
    denominator: den,
    notApplicable: na,
    unscored,
    value: den > 0 ? num / den : null,
  };
}

// ---------- 主评分 ----------

export function scoreTrial(input: ScorerInput): CaseScoreV2 {
  const hardFailures: HardFailure[] = [];
  const stageFindings: StageFinding[] = [];
  const attribution: CaseScoreV2["attribution"] = [];
  const roundScores: CaseScoreV2["roundScores"] = [];

  // ---- 执行成功：全部轮 succeeded 且产出合法业务输出（报告或有效补问）----
  const executionSuccess =
    !input.executionError &&
    input.rounds.length > 0 &&
    input.rounds.every((r) => r.status === "succeeded" && (r.outcome === "report" || r.outcome === "clarify"));
  if (input.executionError) {
    hardFailures.push({ code: "execution_error", message: input.executionError });
    attribution.push({ layer: "engineering", hint: `执行失败：${input.executionError.slice(0, 120)}` });
  }

  // ---- 逐轮检查 ----
  const clarifyResults: boolean[] = [];
  const contradictionResults: Array<boolean | null> = [];
  const writebackResults: boolean[] = [];
  const traceResults: boolean[] = [];

  for (const round of input.rounds) {
    const truth = round.truth;

    // 1. 产出类型策略（该问不问 / 该报不报；error/chat 视为越界——chat 不满足诊断工单，§7.2.3）。
    const outcomeOk = round.outcome === "report" || round.outcome === "clarify" ? truth.allowedOutcomes.includes(round.outcome) : false;
    if (!outcomeOk) {
      hardFailures.push({
        code: "outcome_out_of_policy",
        message: `round ${round.roundId} 产出 ${round.outcome} 不在允许集合 [${truth.allowedOutcomes.join(",")}]`,
        roundId: round.roundId,
      });
    }

    // 2. raw / validated 两阶段硬检查（raw 的错误不因校验器纠正而抹去，§9.4"校验器救正"）。
    const rawFailures = hardChecksForRound(round, "raw");
    const validatedFailures = hardChecksForRound(round, "validated");
    stageFindings.push({ stage: "raw", hardFailures: rawFailures });
    stageFindings.push({ stage: "validated", hardFailures: validatedFailures });
    hardFailures.push(...validatedFailures);

    // 3. 补问有效性（§9.4"合理追问"）：问了关键缺失信息且无越界断言。
    let clarification: boolean | null = null;
    if (truth.materialNeeds.length > 0) {
      clarification =
        round.outcome === "clarify" &&
        !!round.replyText &&
        truth.materialNeeds.some((need) => need.clarifyConcepts.some((g) => assertsGroup(round.replyText!, g))) &&
        validatedFailures.length === 0;
      clarifyResults.push(clarification);
    }

    // 4. 反证更新（§9.4"反证后固执"）：被推翻概念不得再作为事实断言出现在
    //    confirmedFacts 或 supported 假设里；只在 candidate 假设中 → 按降级判定。
    //    summary 是叙述文本，"Redis 告警为伴随现象"属合法措辞，其固执表达应由
    //    truth.forbiddenRules（where 含 summary）显式声明，不在此猜测。
    //    无正式报告（error/缺失）→ 缺测 null，不算"撤回成功"。
    let contradiction: boolean | null = null;
    if ((truth.contradictedClaims ?? []).length > 0) {
      if (round.outcome === "error" || !round.validatedReport) {
        contradiction = null;
        contradictionResults.push(null); // 缺测进分母口径：unscored，不算撤回成功
      } else {
        const claims = claimsOf("validated", round);
        const verdicts = truth.contradictedClaims.map((claim) => {
          const factsAsserted = claims.confirmedFacts.some((f) => assertsConcepts(f, claim.concepts));
          const supportedAssert = claims.causes.some((h) => h.status === "supported" && assertsConcepts(h.cause, claim.concepts));
          if (supportedAssert || factsAsserted) return false;
          const candidateAssert = claims.causes.some(
            (h) => (h.status === "candidate" || h.status === "refuted") && assertsConcepts(h.cause, claim.concepts),
          );
          if (candidateAssert) return claim.allowCandidate;
          return true; // 已撤回（报告存在且不再断言）
        });
        contradiction = verdicts.every((v) => v === true);
        contradictionResults.push(contradiction);
      }
    }

    // 5. 回写完整性：所有轮都计分母——回写缺失（无投递捕获）计失败，不允许漏计（P6）。
    writebackResults.push(deterministicWritebackOk(round));

    // 6. trace 完整性。
    const missing = round.requiredTraceEvents.filter((e) => !round.presentTraceEvents.includes(e));
    traceResults.push(missing.length === 0);
    if (missing.length > 0) {
      hardFailures.push({
        code: "trace_incomplete",
        message: `round ${round.roundId} 缺少 trace 事件：${missing.join(",")}`,
        roundId: round.roundId,
      });
    }

    roundScores.push({
      roundId: round.roundId,
      outcome: round.outcome,
      hardFailures: validatedFailures,
      clarificationSuccess: clarification,
      contradictionUpdate: contradiction,
      newC1Satisfied: round.visibility.filter((v) => v.applicable && v.satisfied.C1 === true).map((v) => v.requirementId),
    });
  }

  if (hardFailures.some((f) => f.code === "outcome_out_of_policy")) {
    attribution.push({ layer: "clarification", hint: "存在越界产出类型（该问不问或该报不报）" });
  }

  // ---- 召回（需求口径，§9.2）：末轮累计可见性；分母=适用需求；不可判=unscored ----
  const lastRound = input.rounds[input.rounds.length - 1];
  const recallOf = (key: "A" | "B" | "C1" | "C2" | "D"): MetricValue => {
    if (!lastRound) return mkMetric(0, 0);    const reqs = lastRound.visibility;
    const applicable = reqs.filter((r) => r.applicable);
    const na = reqs.length - applicable.length;
    const hit = applicable.filter((r) => r.satisfied[key] === true).length;
    const unscored = applicable.filter((r) => r.satisfied[key] === null).length;
    return mkMetric(hit, Math.max(0, applicable.length - unscored), na, unscored);
  };

  // ---- 引用有效性（validated 引用集合；无引用记 0/0 → value=null） ----
  const validCitations = input.rounds.flatMap((r) => r.citations.filter((c) => c.stage === "validated"));
  const citationValidity: MetricValue =
    validCitations.length === 0
      ? mkMetric(0, 0)
      : mkMetric(validCitations.filter((c) => c.resolved && !c.wrongSha).length, validCitations.length);

  // ---- 确定性必需事实覆盖（关键词代理，单列；不是语义评分） ----
  const factTotal = input.rounds.reduce((n, r) => n + r.truth.requiredFacts.length, 0);
  const factHit = input.rounds.reduce((n, r) => {
    const claims = claimsOf("validated", r);
    return n + r.truth.requiredFacts.filter((f) => factAsserted(f, claims)).length;
  }, 0);
  const requiredFactCoverage: MetricValue = mkMetric(factHit, factTotal);

  // ---- 越界断言率（validated：supported 但零引用的假设） ----
  const assertionCount = input.rounds.reduce((n, r) => {
    const claims = claimsOf("validated", r);
    return n + claims.causes.length + claims.confirmedFacts.length;
  }, 0);
  const unsupportedCount = input.rounds.reduce((n, r) => {
    const claims = claimsOf("validated", r);
    return n + claims.causes.filter((h) => (h.evidenceIds ?? []).length === 0 && h.status === "supported").length;
  }, 0);

  // ---- 归因提示（§11.4） ----
  if (hardFailures.some((f) => f.code === "wrong_sha" || f.code === "citation_unresolvable")) {
    attribution.push({ layer: "material", hint: "存在版本错配或不可解析引用（材料/版本层）" });
  }
  if (hardFailures.some((f) => f.code === "forbidden_assertion")) {
    attribution.push({ layer: "reasoning", hint: "存在越界/禁用断言（判断层）" });
  }
  if (clarifyResults.length > 0 && clarifyResults.some((c) => !c)) {
    attribution.push({ layer: "clarification", hint: "补问未命中关键缺失信息或未补问" });
  }
  if (contradictionResults.some((c) => c === false)) {
    attribution.push({ layer: "contradiction", hint: "收到反证后未修正被推翻的判断" });
  }
  if (input.truth.review.provisional) {
    attribution.push({ layer: "scoring", hint: "标准为 provisional（未经独立人工复核），语义结论有限" });
  }

  return {
    schemaVersion: "prediagnosis-score-v2",
    scorerVersion: SCORER_VERSION,
    suiteRunId: input.suiteRunId,
    caseId: input.caseDesc.caseId,
    familyId: input.caseDesc.familyId,
    trialId: input.trialId,
    split: input.caseDesc.split,
    sourceTier: input.caseDesc.sourceTier,
    engine: input.engine,
    executionSuccess,
    traceCompletion: mkMetric(traceResults.filter((t) => t).length, traceResults.length),
    recall: { A: recallOf("A"), B: recallOf("B"), C1: recallOf("C1"), C2: recallOf("C2"), D: recallOf("D") },
    citationValidity,
    // 语义支持：review 导入前必须保持未评分（den=0，unscored=重要判断数）；
    // 不允许关键词代理重新生成 value（P3）。
    claimSupport: { numerator: 0, denominator: 0, notApplicable: 0, unscored: factTotal, value: null },
    requiredFactCoverage,
    unsupportedAssertionRate: assertionCount === 0 ? mkMetric(0, 0) : mkMetric(unsupportedCount, assertionCount),
    clarificationSuccess:
      clarifyResults.length === 0 ? mkMetric(0, 0, 0, 0) : mkMetric(clarifyResults.filter((c) => c).length, clarifyResults.length),
    contradictionUpdateSuccess:
      contradictionResults.length === 0
        ? mkMetric(0, 0)
        : mkMetric(contradictionResults.filter((c) => c === true).length, contradictionResults.filter((c) => c !== null).length, 0, contradictionResults.filter((c) => c === null).length),
    writebackSuccess:
      writebackResults.length === 0 ? mkMetric(0, 0) : mkMetric(writebackResults.filter((w) => w).length, writebackResults.length),
    hardFailures,
    stageFindings,
    semanticReview: { imported: input.semanticReviewImported ?? false, provisional: input.truth.review.provisional },
    roundScores,
    attribution,
  };
}
