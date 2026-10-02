// 人工语义复核工件（方案 §9.3）：导入、校验、逐项绑定、重评分。
//
// 边界：
//   * review 只允许覆盖语义类指标（claimSupport / clarificationSuccess /
//     contradictionUpdateSuccess / writebackSuccess）与 semanticReview 标记；
//     确定性硬失败（wrong_sha / citation_unresolvable / forbidden_assertion …）不可被
//     review 覆盖——模型裁判不得覆盖确定性失败。
//   * 工件必须绑定 suiteRunId/caseId/trialId；roundId 必须存在于该 case；
//     verdict/枚举校验失败整份拒绝，不做部分导入。
//   * 未被 review 覆盖的语义项保持 unscored/null，不悄悄计成功。
import type { CaseDescriptorV2, CaseScoreV2, MetricValue, OutputStage } from "./types.ts";
import { deterministicWritebackOk, type RoundScoreInput, type ScorerInput } from "./scorer.ts";

export type ClaimVerdict = "supported" | "plausible_candidate" | "unsupported" | "contradicted" | "unscorable";
export type SimpleVerdict = "ok" | "fail" | "unscorable";

export interface ReviewClaim {
  roundId: string;
  stage: OutputStage;
  field: "summary" | "confirmedFacts" | "hypotheses" | "nextSteps";
  /** field=hypotheses 时的假设下标（0-based）；其他字段可省略。 */
  index?: number;
  verdict: ClaimVerdict;
  rationale: string;
}

export interface ReviewFileV2 {
  schemaVersion: "prediagnosis-review-v2";
  suiteRunId: string;
  caseId: string;
  trialId: string;
  review: { author: string; reviewer: string; rubricHash?: string; provisional: boolean; notes?: string };
  claims?: ReviewClaim[];
  clarifications?: Array<{ roundId: string; verdict: SimpleVerdict; rationale: string }>;
  contradictions?: Array<{ roundId: string; claimId: string; verdict: SimpleVerdict; rationale: string }>;
  writeback?: Array<{ roundId: string; verdict: SimpleVerdict; rationale: string }>;
}

export interface ReviewIssue {
  path: string;
  message: string;
}

const CLAIM_VERDICTS: ClaimVerdict[] = ["supported", "plausible_candidate", "unsupported", "contradicted", "unscorable"];
const SIMPLE_VERDICTS: SimpleVerdict[] = ["ok", "fail", "unscorable"];

/** 工件校验：绑定与枚举；任何问题都整份拒绝。 */
export function validateReview(raw: unknown, caseDesc: CaseDescriptorV2): { ok: true; value: ReviewFileV2 } | { ok: false; errors: ReviewIssue[] } {
  const errors: ReviewIssue[] = [];
  const r = raw as ReviewFileV2;
  if (!raw || typeof raw !== "object") return { ok: false, errors: [{ path: "", message: "不是对象" }] };
  if (r.schemaVersion !== "prediagnosis-review-v2") {
    errors.push({ path: "schemaVersion", message: `期望 prediagnosis-review-v2，得到 ${String(r.schemaVersion)}` });
  }
  if (r.caseId !== caseDesc.caseId) errors.push({ path: "caseId", message: `绑定不匹配：${String(r.caseId)} ≠ ${caseDesc.caseId}` });
  if (typeof r.trialId !== "string" || !r.trialId) errors.push({ path: "trialId", message: "缺失" });
  if (!r.review || typeof r.review !== "object") errors.push({ path: "review", message: "缺失" });
  else {
    if (typeof r.review.author !== "string" || !r.review.author) errors.push({ path: "review.author", message: "缺失" });
    if (typeof r.review.reviewer !== "string" || !r.review.reviewer) errors.push({ path: "review.reviewer", message: "缺失" });
    if (typeof r.review.provisional !== "boolean") errors.push({ path: "review.provisional", message: "必须是 boolean" });
    else if (r.review.provisional) errors.push({ path: "review.provisional", message: "导入的复核不得再标记 provisional" });
  }
  const roundIds = new Set(caseDesc.rounds.map((x) => x.roundId));
  const checkRound = (path: string, roundId: string) => {
    if (!roundIds.has(roundId)) errors.push({ path, message: `roundId ${roundId} 不属于 case ${caseDesc.caseId}` });
  };
  (r.claims ?? []).forEach((c, i) => {
    const p = `claims[${i}]`;
    checkRound(`${p}.roundId`, c.roundId ?? "");
    if (!["raw", "validated"].includes(c.stage)) errors.push({ path: `${p}.stage`, message: `非法 stage：${String(c.stage)}` });
    if (!["summary", "confirmedFacts", "hypotheses", "nextSteps"].includes(c.field)) errors.push({ path: `${p}.field`, message: `非法 field：${String(c.field)}` });
    if (!CLAIM_VERDICTS.includes(c.verdict)) errors.push({ path: `${p}.verdict`, message: `非法 verdict：${String(c.verdict)}` });
    if (typeof c.rationale !== "string" || !c.rationale.trim()) errors.push({ path: `${p}.rationale`, message: "必须给出理由" });
    if (c.index !== undefined && (!Number.isInteger(c.index) || c.index < 0)) errors.push({ path: `${p}.index`, message: "必须是非负整数" });
  });
  (r.clarifications ?? []).forEach((c, i) => {
    checkRound(`clarifications[${i}].roundId`, c.roundId ?? "");
    if (!SIMPLE_VERDICTS.includes(c.verdict)) errors.push({ path: `clarifications[${i}].verdict`, message: `非法 verdict：${String(c.verdict)}` });
  });
  (r.contradictions ?? []).forEach((c, i) => {
    checkRound(`contradictions[${i}].roundId`, c.roundId ?? "");
    if (!SIMPLE_VERDICTS.includes(c.verdict)) errors.push({ path: `contradictions[${i}].verdict`, message: `非法 verdict：${String(c.verdict)}` });
  });
  (r.writeback ?? []).forEach((c, i) => {
    checkRound(`writeback[${i}].roundId`, c.roundId ?? "");
    if (!SIMPLE_VERDICTS.includes(c.verdict)) errors.push({ path: `writeback[${i}].verdict`, message: `非法 verdict：${String(c.verdict)}` });
  });
  return errors.length === 0 ? { ok: true, value: r } : { ok: false, errors };
}

function metricOf(num: number, den: number, unscored: number): MetricValue {
  return { numerator: num, denominator: den, notApplicable: 0, unscored, value: den > 0 && unscored === 0 ? num / den : null };
}

/**
 * 应用 review：返回重评分后的 score（不修改入参）。
 * 覆盖范围：claimSupport（按 claims 逐项）、clarificationSuccess、contradictionUpdateSuccess、
 * writebackSuccess（按轮覆盖；未覆盖轮保持原确定性判定）。硬失败与可见性指标不受影响。
 */
export function applyReview(input: ScorerInput, score: CaseScoreV2, review: ReviewFileV2): CaseScoreV2 {
  const s: CaseScoreV2 = structuredClone(score);

  // ---- claimSupport：按 claims 逐项 ----
  const claims = review.claims ?? [];
  const scored = claims.filter((c) => c.verdict !== "unscorable");
  const good = scored.filter((c) => c.verdict === "supported" || c.verdict === "plausible_candidate").length;
  const bad = scored.filter((c) => c.verdict === "unsupported" || c.verdict === "contradicted").length;
  const unscorable = claims.length - scored.length;
  // 未覆盖的"重要判断"仍算缺测：分母以确定性代理计数为下界估计（requiredFacts 数）。
  const estimateTotal = Math.max(input.rounds.reduce((n, r) => n + r.truth.requiredFacts.length, 0), claims.length);
  s.claimSupport = {
    ...metricOf(good, good + bad, unscorable + Math.max(0, estimateTotal - claims.length)),
    ...(claims.length === 0 ? { value: null } : {}),
  };

  // ---- 逐轮覆盖 ----
  const overrideRound = (roundId: string, verdict: SimpleVerdict, kind: "clarification" | "contradiction" | "writeback"): void => {
    const rs = s.roundScores.find((r) => r.roundId === roundId);
    if (!rs) return;
    if (kind === "clarification") rs.clarificationSuccess = verdict === "ok" ? true : verdict === "fail" ? false : null;
    if (kind === "contradiction") rs.contradictionUpdate = verdict === "ok" ? true : verdict === "fail" ? false : null;
  };

  const clarifyMetric = metricFromRounds(
    input.rounds.map((r) => r.truth.materialNeeds.length > 0),
    (roundId) => review.clarifications?.find((c) => c.roundId === roundId),
    s.roundScores,
    "clarification",
  );
  s.clarificationSuccess = clarifyMetric;
  const contradictionMetric = metricFromRounds(
    input.rounds.map((r) => (r.truth.contradictedClaims ?? []).length > 0),
    (roundId) => review.contradictions?.find((c) => c.roundId === roundId),
    s.roundScores,
    "contradiction",
  );
  s.contradictionUpdateSuccess = contradictionMetric;
  // writeback：review 逐轮覆盖；未覆盖轮回落到确定性判定（与 scoreTrial 同一函数，口径不漂移）。
  const writebackOk: boolean[] = input.rounds.map((r) => {
    const reviewed = review.writeback?.find((c) => c.roundId === r.roundId);
    if (!reviewed) return deterministicWritebackOk(r);
    const rs = s.roundScores.find((x) => x.roundId === r.roundId);
    if (rs && reviewed.verdict !== "unscorable") rs.contradictionUpdate = rs.contradictionUpdate; // no-op 保持形状
    if (reviewed.verdict === "unscorable") {
      s.writebackSuccess = { ...s.writebackSuccess, unscored: s.writebackSuccess.unscored + 1 };
      return false;
    }
    return reviewed.verdict === "ok";
  });
  const wbNum = writebackOk.filter(Boolean).length;
  const wbDen = writebackOk.length;
  const wbUnscored = s.writebackSuccess.unscored;
  s.writebackSuccess = {
    numerator: wbNum,
    denominator: wbDen,
    notApplicable: 0,
    unscored: wbUnscored,
    value: wbDen > 0 && wbUnscored === 0 ? wbNum / wbDen : null,
  };

  s.semanticReview = { imported: true, provisional: review.review.provisional };
  return s;
}

function metricFromRounds(
  applicable: boolean[],
  find: (roundId: string) => { verdict: SimpleVerdict } | undefined,
  roundScores: CaseScoreV2["roundScores"],
  kind: "clarification" | "contradiction",
): MetricValue {
  let num = 0;
  let den = 0;
  let unscored = 0;
  applicable.forEach((isApplicable, i) => {
    if (!isApplicable) return;
    den += 1;
    const roundId = roundScores[i]!.roundId;
    const reviewed = find(roundId);
    if (!reviewed || reviewed.verdict === "unscorable") {
      unscored += 1;
      return;
    }
    overrideRoundScore(roundScores, roundId, kind, reviewed.verdict);
    if (reviewed.verdict === "ok") num += 1;
  });
  return { numerator: num, denominator: den, notApplicable: 0, unscored, value: den > 0 && unscored === 0 ? num / den : null };
}

function overrideRoundScore(
  roundScores: CaseScoreV2["roundScores"],
  roundId: string,
  kind: "clarification" | "contradiction",
  verdict: SimpleVerdict,
): void {
  const rs = roundScores.find((r) => r.roundId === roundId);
  if (!rs) return;
  if (kind === "clarification") rs.clarificationSuccess = verdict === "ok" ? true : verdict === "fail" ? false : null;
  else rs.contradictionUpdate = verdict === "ok" ? true : verdict === "fail" ? false : null;
}
