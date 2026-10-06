// 人工语义复核工件（方案 §9.3 / A2 契约）：导入、校验、逐项绑定、重评分。
//
// v3 契约（A2，破坏性升级）：
//   * 绑定五元组 + 输出内容：suiteRunId / caseId / trialId / roundId / stage 必须逐一匹配，
//     另有文件级 outputsHash（judgedOutputsHash）——被复核输出变了一字即整份拒绝。
//   * 判断清单基准：claims 只允许指向 **validated 终稿**的实际可判声明
//     （listJudgableClaims 枚举），必须携带与内容绑定的稳定 claimId；
//     未知槽位、越界下标、重复记录、raw 跨阶段记录一律整份拒绝，不做部分导入。
//   * 身份与来源：review.reviewerType 必须显式声明 human|model——模型裁判分不得伪装人工分。
//   * 反证按被推翻 claim 逐条记录（roundId+claimId），不再按轮整体覆盖。
//   * 分母来自实际适用判断清单，不来自"提交了几条 review"；未复核部分保持缺测并显示覆盖率。
//   * review 只允许覆盖语义类指标；确定性硬失败不可被覆盖——模型裁判不得覆盖确定性失败。
import type { CaseDescriptorV2, CaseScoreV2, MetricValue, TruthFileV2 } from "./types.ts";
import { deterministicWritebackOk, listJudgableClaims, type ClaimSlot, type RoundScoreInput, type ScorerInput } from "./scorer.ts";
import { createHash } from "node:crypto";

export type ClaimVerdict = "supported" | "plausible_candidate" | "unsupported" | "contradicted" | "unscorable";
export type SimpleVerdict = "ok" | "fail" | "unscorable";
export type ReviewerType = "human" | "model";

export interface ReviewClaim {
  roundId: string;
  /** 只允许 validated（A2）：语义支持评的是终稿；raw 阶段的错误由确定性硬检查覆盖。 */
  stage: "validated";
  field: "summary" | "confirmedFacts" | "hypotheses" | "nextSteps";
  /** 槽位下标（0-based，必填；summary 恒为 0）。 */
  index: number;
  /** 稳定内容 ID（listJudgableClaims 生成）；与被复核输出内容绑定。 */
  claimId: string;
  verdict: ClaimVerdict;
  rationale: string;
}

export interface ReviewFileV2 {
  schemaVersion: "prediagnosis-review-v3";
  suiteRunId: string;
  caseId: string;
  trialId: string;
  /** 被复核输出的内容指纹（review.ts#judgedOutputsHash）。 */
  outputsHash: string;
  review: { author: string; reviewer: string; reviewerType: ReviewerType; rubricHash?: string; notes?: string };
  claims?: ReviewClaim[];
  clarifications?: Array<{ roundId: string; verdict: SimpleVerdict; rationale?: string }>;
  contradictions?: Array<{ roundId: string; claimId: string; verdict: SimpleVerdict; rationale?: string }>;
  writeback?: Array<{ roundId: string; verdict: SimpleVerdict; rationale?: string }>;
}

export interface ReviewIssue {
  path: string;
  message: string;
}

const CLAIM_VERDICTS: ClaimVerdict[] = ["supported", "plausible_candidate", "unsupported", "contradicted", "unscorable"];
const SIMPLE_VERDICTS: SimpleVerdict[] = ["ok", "fail", "unscorable"];

/** 被复核输出的内容指纹：对"逐轮被判断的输出字段"做规范化 JSON 哈希（A2）。 */
export function judgedOutputsHash(input: ScorerInput): string {
  const payload = input.rounds.map((r) => ({
    roundId: r.roundId,
    outcome: r.outcome,
    rawDraft: r.rawDraft ?? null,
    validatedReport: r.validatedReport ?? null,
    replyText: r.replyText ?? null,
    writebackText: r.writebackText ?? null,
  }));
  return sha256Text(JSON.stringify(payload));
}

function sha256Text(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** 工件校验：绑定（suite/case/trial/输出内容）、身份、逐槽位 claimId、重复与跨阶段；任何问题整份拒绝。 */
export function validateReview(
  raw: unknown,
  caseDesc: CaseDescriptorV2,
  truth: TruthFileV2,
  bind: { suiteRunId: string; outputsHash: string; claims: ClaimSlot[] },
): { ok: true; value: ReviewFileV2 } | { ok: false; errors: ReviewIssue[] } {
  const errors: ReviewIssue[] = [];
  const r = raw as ReviewFileV2;
  if (!raw || typeof raw !== "object") return { ok: false, errors: [{ path: "", message: "不是对象" }] };
  if (r.schemaVersion !== "prediagnosis-review-v3") {
    errors.push({
      path: "schemaVersion",
      message: `期望 prediagnosis-review-v3，得到 ${String(r.schemaVersion)}（v2 工件已废弃：v3 要求 reviewerType/outputsHash/claimId）`,
    });
  }
  if (r.caseId !== caseDesc.caseId) errors.push({ path: "caseId", message: `绑定不匹配：${String(r.caseId)} ≠ ${caseDesc.caseId}` });
  if (r.suiteRunId !== bind.suiteRunId) {
    errors.push({ path: "suiteRunId", message: `绑定不匹配：${String(r.suiteRunId)} ≠ ${bind.suiteRunId}` });
  }
  if (typeof r.trialId !== "string" || !r.trialId) errors.push({ path: "trialId", message: "缺失" });
  if (typeof r.outputsHash !== "string" || !r.outputsHash) {
    errors.push({ path: "outputsHash", message: "缺失（被复核输出必须以 outputsHash 绑定）" });
  } else if (r.outputsHash !== bind.outputsHash) {
    errors.push({ path: "outputsHash", message: `输出内容指纹不匹配：工件针对 ${r.outputsHash.slice(0, 12)}…，当前 trial 为 ${bind.outputsHash.slice(0, 12)}…（trial 可能已重跑）` });
  }
  if (!r.review || typeof r.review !== "object") {
    errors.push({ path: "review", message: "缺失" });
  } else {
    if (typeof r.review.author !== "string" || !r.review.author) errors.push({ path: "review.author", message: "缺失" });
    if (typeof r.review.reviewer !== "string" || !r.review.reviewer) errors.push({ path: "review.reviewer", message: "缺失" });
    if (!["human", "model"].includes(r.review.reviewerType)) {
      errors.push({ path: "review.reviewerType", message: `必须是 human|model，得到 ${String(r.review.reviewerType)}` });
    }
    if ((r.review as { provisional?: unknown }).provisional === true) {
      errors.push({ path: "review.provisional", message: "导入的复核不得标记 provisional" });
    }
  }
  const roundIds = new Set(caseDesc.rounds.map((x) => x.roundId));
  const checkRound = (path: string, roundId: string) => {
    if (!roundIds.has(roundId)) errors.push({ path, message: `roundId ${roundId} 不属于 case ${caseDesc.caseId}` });
  };
  const slotKey = (roundId: string, field: string, index: number) => `${roundId}\u0000${field}\u0000${index}`;
  const slotMap = new Map<string, ClaimSlot>();
  for (const s of bind.claims) slotMap.set(slotKey(s.roundId, s.field, s.index), s);
  const seen = new Set<string>();
  (r.claims ?? []).forEach((c, i) => {
    const p = `claims[${i}]`;
    checkRound(`${p}.roundId`, c.roundId ?? "");
    if (c.stage !== "validated") errors.push({ path: `${p}.stage`, message: `语义判断只允许 validated 终稿（得到 ${String(c.stage)}）` });
    if (!["summary", "confirmedFacts", "hypotheses", "nextSteps"].includes(c.field)) errors.push({ path: `${p}.field`, message: `非法 field：${String(c.field)}` });
    if (!CLAIM_VERDICTS.includes(c.verdict)) errors.push({ path: `${p}.verdict`, message: `非法 verdict：${String(c.verdict)}` });
    if (typeof c.rationale !== "string" || !c.rationale.trim()) errors.push({ path: `${p}.rationale`, message: "必须给出理由" });
    if (!Number.isInteger(c.index) || (c.index as number) < 0) errors.push({ path: `${p}.index`, message: "必须是非负整数（必填）" });
    if (typeof c.claimId !== "string" || !c.claimId) {
      errors.push({ path: `${p}.claimId`, message: "缺失（必须携带与内容绑定的稳定 claimId）" });
    } else {
      const slot = slotMap.get(slotKey(c.roundId ?? "", c.field, c.index as number));
      if (!slot) {
        errors.push({ path: `${p}.claimId`, message: `指向不存在的判断槽位：round=${c.roundId} field=${c.field} index=${String(c.index)}（清单以当前 outputs 为准）` });
      } else if (slot.claimId !== c.claimId) {
        errors.push({ path: `${p}.claimId`, message: `claimId 与当前输出内容不符：期望 ${slot.claimId}，得到 ${c.claimId}` });
      }
    }
    const key = slotKey(c.roundId ?? "", c.field, c.index as number) + `#${c.claimId ?? ""}`;
    if (seen.has(key)) errors.push({ path: `${p}`, message: "重复的复核记录" });
    seen.add(key);
  });
  const truthRoundBy = new Map(truth.rounds.map((x) => [x.roundId, x]));
  const seenContradiction = new Set<string>();
  (r.contradictions ?? []).forEach((c, i) => {
    const p = `contradictions[${i}]`;
    checkRound(`${p}.roundId`, c.roundId ?? "");
    if (!SIMPLE_VERDICTS.includes(c.verdict)) errors.push({ path: `${p}.verdict`, message: `非法 verdict：${String(c.verdict)}` });
    if (typeof c.claimId !== "string" || !c.claimId) {
      errors.push({ path: `${p}.claimId`, message: "缺失（反证复核必须指认被推翻 claim）" });
    } else {
      const truthRound = truthRoundBy.get(c.roundId ?? "");
      const known = truthRound?.contradictedClaims?.some((cc) => cc.claimId === c.claimId);
      if (!known) errors.push({ path: `${p}.claimId`, message: `round ${c.roundId} 的 truth 中不存在被推翻 claim：${c.claimId}` });
    }
    const key = `${c.roundId}\u0000${c.claimId ?? ""}`;
    if (seenContradiction.has(key)) errors.push({ path: `${p}`, message: "重复的复核记录" });
    seenContradiction.add(key);
  });
  (r.clarifications ?? []).forEach((c, i) => {
    checkRound(`clarifications[${i}].roundId`, c.roundId ?? "");
    if (!SIMPLE_VERDICTS.includes(c.verdict)) errors.push({ path: `clarifications[${i}].verdict`, message: `非法 verdict：${String(c.verdict)}` });
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
 * 覆盖范围：claimSupport（按实际判断清单逐槽位）、clarificationSuccess（按轮）、
 * contradictionUpdateSuccess（按被推翻 claim 逐条）、writebackSuccess（按轮覆盖；
 * 未覆盖轮保持原确定性判定）。硬失败与可见性指标不受影响。
 */
export function applyReview(input: ScorerInput, score: CaseScoreV2, review: ReviewFileV2): CaseScoreV2 {
  const s: CaseScoreV2 = structuredClone(score);

  // ---- claimSupport：分母 = 实际可判判断清单（A2），与提交了多少条 review 无关 ----
  const slots = listJudgableClaims(input.rounds);
  const reviewByKey = new Map<string, ReviewClaim>();
  for (const c of review.claims ?? []) reviewByKey.set(`${c.roundId}\u0000${c.field}\u0000${c.index}`, c);
  let good = 0;
  let unscoredClaims = 0;
  let reviewedCount = 0;
  for (const slot of slots) {
    const reviewed = reviewByKey.get(`${slot.roundId}\u0000${slot.field}\u0000${slot.index}`);
    if (!reviewed || reviewed.verdict === "unscorable") {
      unscoredClaims += 1;
      continue;
    }
    reviewedCount += 1;
    if (reviewed.verdict === "supported" || reviewed.verdict === "plausible_candidate") good += 1;
  }
  s.claimSupport = metricOf(good, slots.length, unscoredClaims);
  const claimCoverage = { reviewed: reviewedCount, total: slots.length };

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

  // ---- 反证：按被推翻 claim 逐条（A2）----
  // 与程序口径同构：error/无正式报告轮的 claim 保持缺测；review 只能覆盖"可判"的 claim。
  const contradictionByKey = new Map<string, SimpleVerdict>();
  for (const c of review.contradictions ?? []) contradictionByKey.set(`${c.roundId}\u0000${c.claimId}`, c.verdict);
  let cNum = 0;
  let cDen = 0;
  let cUnscored = 0;
  const roundVerdicts = new Map<string, Array<boolean | null>>();
  for (const round of input.rounds) {
    const claims = round.truth.contradictedClaims ?? [];
    if (claims.length === 0) continue;
    const judgeable = round.outcome !== "error" && !!round.validatedReport;
    const perClaim: Array<boolean | null> = [];
    for (const claim of claims) {
      const reviewedVerdict = contradictionByKey.get(`${round.roundId}\u0000${claim.claimId}`);
      let verdict: boolean | null;
      if (!judgeable) verdict = null; // 程序口径：无正式报告不可判，review 不得代判
      else if (!reviewedVerdict || reviewedVerdict === "unscorable") verdict = null;
      else verdict = reviewedVerdict === "ok";
      perClaim.push(verdict);
      if (verdict === null) cUnscored += 1;
      else {
        cDen += 1;
        if (verdict) cNum += 1;
      }
    }
    roundVerdicts.set(round.roundId, perClaim);
  }
  s.contradictionUpdateSuccess = cDen + cUnscored === 0 ? metricOf(0, 0, 0) : metricOf(cNum, cDen, cUnscored);
  // roundScores：一轮内全部 claim 可判且全部 ok → true；任一 fail → false；任一缺测 → null。
  for (const rs of s.roundScores) {
    const perClaim = roundVerdicts.get(rs.roundId);
    if (!perClaim || perClaim.length === 0) continue;
    rs.contradictionUpdate = perClaim.some((v) => v === null) ? null : perClaim.every((v) => v === true);
  }  // writeback：review 逐轮覆盖；未覆盖轮回落到确定性判定（与 scoreTrial 同一函数，口径不漂移）。
  const writebackOk: boolean[] = input.rounds.map((r) => {
    const reviewed = review.writeback?.find((c) => c.roundId === r.roundId);
    if (!reviewed) return deterministicWritebackOk(r);
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

  s.semanticReview = {
    imported: true,
    provisional: false,
    author: review.review.author,
    reviewer: review.review.reviewer,
    reviewerType: review.review.reviewerType,
    coverage: { ...claimCoverage },
  };
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
