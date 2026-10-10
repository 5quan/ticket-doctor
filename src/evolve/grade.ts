// 自改进方案交付 B：固定评分器（§7）。
//
// 只做**确定性**判定：执行完整性、引用有效性、必需事实（概念组，含否定窗口）、
// 禁用断言、四层可见性充分性、行为边界。语义裁判（模型）留待人工标注校准后另接，
// 本文件不冒充语义正确率。
//
// fitness（§7.3）：0.50×结论支持度 + 0.30×证据充分度 + 0.20×判断边界正确度，
// 适用项归一化；硬失败单独阻断并置 0，不靠平均值掩盖。

import type { CaseRunResult } from "../eval/lf/run-case.ts";
import type { RoundTruthV2, TruthFileV2 } from "../eval/lf/internals/types.ts";

export interface GradeRoundDetail {
  roundId: string;
  outcome: string;
  factsTotal: number;
  factsSatisfied: number;
  forbiddenTriggered: string[];
  visibilityApplicable: number;
  visibilitySatisfied: number;
  citationsValidated: number;
  citationsValid: number;
}

export interface GradeResult {
  status: "scored" | "unscored";
  /** 0..1；硬失败时为 0；无可评项时为 null。 */
  score: number | null;
  metrics: Record<string, number | null>;
  hardFailures: string[];
  feedback: string;
  rounds: GradeRoundDetail[];
}

const NEGATION_RE = /(并非|不是|没有|不|非|未|无|not\b|no\b|never\b|n't\b)/i;
const NEGATION_WINDOW = 12;

/** 字面量是否被"断言"出现在文本中（否定窗口内的出现不算断言）。 */
export function literalAsserted(text: string, literal: string): boolean {
  const hay = text.toLowerCase();
  const needle = literal.toLowerCase();
  let from = 0;
  while (true) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) return false;
    const window = hay.slice(Math.max(0, idx - NEGATION_WINDOW), idx);
    if (!NEGATION_RE.test(window)) return true;
    from = idx + needle.length;
  }
}

/** 概念组（any-of）：组内任一字面量被断言即满足。 */
export function groupSatisfied(text: string, group: string[]): boolean {
  return group.some((lit) => literalAsserted(text, lit));
}

/** 概念组序列（组间 AND）：全部组满足（用于必需事实，允许跨字段/跨句）。 */
export function groupsSatisfied(text: string, groups: string[][]): boolean {
  return groups.every((g) => groupSatisfied(text, g));
}

/** 某字面量被断言的**位置**（否定窗口内的出现不计）。 */
export function assertedPositions(text: string, literal: string): number[] {
  const hay = text.toLowerCase();
  const needle = literal.toLowerCase();
  const out: number[] = [];
  let from = 0;
  while (true) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    const window = hay.slice(Math.max(0, idx - NEGATION_WINDOW), idx);
    if (!NEGATION_RE.test(window)) out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

/** 概念组内全部被断言字面量的位置并集（已排序）。 */
export function groupPositions(text: string, group: string[]): number[] {
  const set = new Set<number>();
  for (const lit of group) for (const p of assertedPositions(text, lit)) set.add(p);
  return [...set].sort((a, b) => a - b);
}

/**
 * 禁用断言：所有概念组必须在同一“断言窗口”内**共现**（默认 40 字）。
 * 必需事实用 groupsSatisfied（可跨句）；禁用断言必须共现，否则会把
 * “下游服务是受害者” + “另一处说真正根因”这种正确报告误伤成硬失败。
 */
export function groupsColocated(text: string, groups: string[][], window = 40): boolean {
  const positions = groups.map((g) => groupPositions(text, g));
  if (positions.some((p) => p.length === 0)) return false;
  for (const p of positions[0]!) {
    if (positions.every((ps) => ps.some((q) => Math.abs(q - p) <= window))) return true;
  }
  return false;
}

/** 从报告对象提取指定字段的可匹配文本。 */
export function reportFieldText(report: unknown, field: "summary" | "confirmedFacts" | "hypotheses" | "nextSteps"): string {
  if (!report || typeof report !== "object") return "";
  const r = report as Record<string, unknown>;
  if (field === "summary") return typeof r.summary === "string" ? r.summary : "";
  if (field === "confirmedFacts") return Array.isArray(r.confirmedFacts) ? r.confirmedFacts.map(String).join("\n") : "";
  if (field === "nextSteps") return Array.isArray(r.nextSteps) ? r.nextSteps.map(String).join("\n") : "";
  if (field === "hypotheses") {
    const hs = r.hypotheses;
    if (!Array.isArray(hs)) return "";
    return hs
      .map((h) => {
        if (!h || typeof h !== "object") return String(h);
        const o = h as Record<string, unknown>;
        return [o.cause, o.summary, o.statement, o.description].filter((x) => typeof x === "string").join(" ");
      })
      .join("\n");
  }
  return "";
}

function roundReportText(report: unknown): string {
  return (["summary", "confirmedFacts", "hypotheses"] as const).map((f) => reportFieldText(report, f)).join("\n");
}

/** 指定状态的假设文本（用于 forbiddenRules.onlyWhenStatus：只对“已支持”的断言判定）。 */
export function hypothesesByStatus(report: unknown, status: "supported" | "candidate" | "refuted"): string {
  if (!report || typeof report !== "object") return "";
  const hs = (report as Record<string, unknown>).hypotheses;
  if (!Array.isArray(hs)) return "";
  return hs
    .filter((h) => h && typeof h === "object" && (h as Record<string, unknown>).status === status)
    .map((h) => {
      const o = h as Record<string, unknown>;
      return [o.cause, o.summary, o.statement, o.description].filter((x) => typeof x === "string").join(" ");
    })
    .join("\n");
}

function weighted(components: Array<{ w: number; v: number | null }>): number | null {
  const applicable = components.filter((c) => c.v !== null);
  if (applicable.length === 0) return null;
  const totalW = applicable.reduce((a, c) => a + c.w, 0);
  return applicable.reduce((a, c) => a + c.w * (c.v as number), 0) / totalW;
}

/** 对一次 CaseRunResult 做确定性评分。 */
export function gradeCase(result: CaseRunResult, truth: TruthFileV2): GradeResult {
  const hardFailures: string[] = [];
  const rounds: GradeRoundDetail[] = [];
  let factsTotal = 0;
  let factsSatisfied = 0;
  let visApplicable = 0;
  let visSatisfied = 0;
  let citValidated = 0;
  let citValid = 0;
  let boundary = 1;

  if (!result.isolation?.ok) hardFailures.push(`isolation_failed${result.isolation?.violationText ? `:${result.isolation.violationText.slice(0, 120)}` : ""}`);

  for (const round of result.rounds) {
    const rt: RoundTruthV2 | undefined = truth.rounds.find((r) => r.roundId === round.roundId);
    if (!rt) {
      hardFailures.push(`missing_truth:${round.roundId}`);
      continue;
    }
    const text = roundReportText(round.report);

    // 行为边界：outcome 必须在允许集合内。
    if (!rt.allowedOutcomes.includes(round.outcome as "report" | "clarify" | "blocked")) {
      hardFailures.push(`outcome_not_allowed:${round.roundId}=${round.outcome}`);
      boundary = 0;
    }
    // 非预期阻断或运行错误。
    if (round.blocked && !rt.allowedOutcomes.includes("blocked")) hardFailures.push(`unexpected_blocked:${round.roundId}`);
    if (round.status !== "succeeded" && !round.blocked) hardFailures.push(`run_error:${round.roundId}=${round.status}`);

    // 必需事实：仅对有报告文本的轮评（合理追问轮不适用）。
    let roundFactsTotal = 0;
    let roundFactsSatisfied = 0;
    if (text.trim().length > 0) {
      for (const fact of rt.requiredFacts) {
        roundFactsTotal++;
        factsTotal++;
        const fields = fact.where.map((f) => reportFieldText(round.report, f)).join("\n");
        if (groupsSatisfied(fields, fact.concepts)) {
          factsSatisfied++;
          roundFactsSatisfied++;
        }
      }
    }
    // 禁用断言。
    const forbiddenTriggered: string[] = [];
    for (const rule of rt.forbiddenRules) {
      // onlyWhenStatus：只对指定状态的假设判定（candidate/低置信不能当肯定断言）；
      // 没有该状态的假设则不触发。其余规则按 where 字段（已共现窗口约束）。
      const fields = rule.onlyWhenStatus
        ? hypothesesByStatus(round.report, rule.onlyWhenStatus)
        : rule.where.map((f) => reportFieldText(round.report, f)).join("\n");
      if (rule.onlyWhenStatus && fields.trim().length === 0) continue;
      if (groupsColocated(fields, rule.assertAnyOf)) {
        forbiddenTriggered.push(rule.ruleId);
        hardFailures.push(`forbidden_assertion:${round.roundId}/${rule.ruleId}`);
        boundary = 0;
      }
    }
    // 证据充分性（B∧C1∧D）。
    visApplicable += round.visibility.applicable;
    visSatisfied += round.visibility.fullySatisfiedBc1d;
    // 引用有效性（validated）。
    const validated = round.citations.filter((c) => c.stage === "validated");
    for (const c of validated) {
      citValidated++;
      if (c.resolved && !c.wrongSha) citValid++;
      else hardFailures.push(`citation_invalid:${round.roundId}/${c.rawId}${c.wrongSha ? "(wrongSha)" : "(unresolved)"}`);
    }

    rounds.push({
      roundId: round.roundId,
      outcome: round.outcome,
      factsTotal: roundFactsTotal,
      factsSatisfied: roundFactsSatisfied,
      forbiddenTriggered,
      visibilityApplicable: round.visibility.applicable,
      visibilitySatisfied: round.visibility.fullySatisfiedBc1d,
      citationsValidated: validated.length,
      citationsValid: validated.filter((c) => c.resolved && !c.wrongSha).length,
    });
  }

  const claimSupport = factsTotal > 0 ? factsSatisfied / factsTotal : null;
  const evidenceSufficiency = visApplicable > 0 ? visSatisfied / visApplicable : null;
  const citationValidity = citValidated > 0 ? citValid / citValidated : null;
  const boundaryScore = boundary;

  const raw = weighted([
    { w: 0.5, v: claimSupport },
    { w: 0.3, v: evidenceSufficiency },
    { w: 0.2, v: boundaryScore },
  ]);
  const hasHard = hardFailures.length > 0;
  const score = raw === null ? null : hasHard ? 0 : raw;

  const metrics: Record<string, number | null> = {
    claim_support: claimSupport,
    evidence_sufficiency: evidenceSufficiency,
    citation_validity: citationValidity,
    boundary: boundaryScore,
    facts_satisfied: factsSatisfied,
    facts_total: factsTotal,
    visibility_satisfied: visSatisfied,
    visibility_applicable: visApplicable,
    citations_valid: citValid,
    citations_total: citValidated,
    tool_calls: result.rounds.reduce((a, r) => a + r.toolCalls, 0),
    total_tokens: result.rounds.reduce((a, r) => a + (r.usage.totalTokens ?? 0), 0),
    wall_ms: result.wall.ms,
  };

  const feedbackParts: string[] = [];
  if (hardFailures.length > 0) feedbackParts.push(`硬失败：${hardFailures.join("; ")}`);
  feedbackParts.push(
    `事实 ${factsSatisfied}/${factsTotal}；证据 B∧C1∧D ${visSatisfied}/${visApplicable}；引用有效 ${citValid}/${citValidated}；边界 ${boundaryScore}`,
  );
  for (const r of rounds) {
    if (r.outcome === "clarify") feedbackParts.push(`${r.roundId} 追问（未出报告，事实项不适用）`);
    if (r.forbiddenTriggered.length > 0) feedbackParts.push(`${r.roundId} 触发禁用断言：${r.forbiddenTriggered.join(",")}`);
  }

  return {
    status: "scored",
    score,
    metrics,
    hardFailures,
    feedback: feedbackParts.join(" | "),
    rounds,
  };
}
