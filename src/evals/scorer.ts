// 打分器 v2：证据召回率、引用精确率、决策正确率（校准口径，OQ-41）。
//
// v1 的 correct 只判"top 假设 supported 且引用 ≥1 条 gold 证据"，不看根因内容——
// 错误根因 + 顺手引证也能判对，只能叫"引证支持率"。
// v2 把 correct 拆成三层联合判定（docs/eval-calibration-and-doc-consistency.md §A.3）：
//   causeMatched（根因概念匹配，确定性） && evidenceSupported（引用 gold） && !distractorOnly（非干扰独证）
//   且 top.status === "supported"。
// gold 缺 requiredConcepts = 未注解（legacy）：correct 退回 v1 口径并显式标注，不得当校准结果报数。
// 引用集合先按证据身份去重（uid 优先，其次 runId|evidenceId），重复引用不再放大精确率分母。
import type { DiagnosisReport, EvidenceRecord, RootCauseHypothesis } from "../domain/types.ts";
import { describeLocator, evidenceMatches } from "./benchmark.ts";
import type { BenchmarkCase, CaseScore, CauseCheck, GoldSpec } from "./types.ts";

/** 打分器版本：改判定语义必须 bump，不同版本禁止同表对比。 */
export const SCORER_VERSION = "2.0.0";

const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function topHypothesis(report: DiagnosisReport): RootCauseHypothesis | undefined {
  return [...report.hypotheses].sort(
    (a, b) => (CONFIDENCE_RANK[a.confidence] ?? 9) - (CONFIDENCE_RANK[b.confidence] ?? 9),
  )[0];
}

// ---------- 根因概念匹配（确定性，§A.5） ----------

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, "");
const NEG = /(不|非|并非|不是|排除|未|无|而不是|而非|not|no|without|rather than)/;

function containsGroup(cause: string, group: string[]): boolean {
  const n = norm(cause);
  return group.some((w) => n.includes(norm(w)));
}

/** 该概念是否被"断言"（排除否定语境：约 12 字符前窗内有否定词则不算）。 */
function assertsGroup(cause: string, group: string[]): boolean {
  const n = norm(cause);
  for (const w of group) {
    const i = n.indexOf(norm(w));
    if (i < 0) continue;
    const pre = n.slice(Math.max(0, i - 12), i);
    if (!NEG.test(pre)) return true;
  }
  return false;
}

export interface CauseMatch {
  checked: boolean;
  matched: boolean | null;
  missingGroups: string[];
  forbiddenHit: string[];
}

export function matchCause(cause: string, gold: GoldSpec): CauseMatch {
  const missing = (gold.requiredConcepts ?? []).filter((g) => !containsGroup(cause, g));
  const forbidden = (gold.forbiddenConcepts ?? []).filter((g) => assertsGroup(cause, g));
  const checked = (gold.requiredConcepts?.length ?? 0) > 0;
  return {
    checked,
    matched: checked ? missing.length === 0 && forbidden.length === 0 : null,
    missingGroups: missing.map((g) => g.join("|")),
    forbiddenHit: forbidden.map((g) => g.join("|")),
  };
}

// ---------- 引用集合（按证据身份去重） ----------

function citationKey(e: EvidenceRecord): string {
  return e.evidenceUid ? `uid:${e.evidenceUid}` : `${e.runId}|${e.evidenceId}`;
}

/** 报告引用 → 去重后的证据记录（uid 优先解析，其次 run 级 E#）。 */
export function distinctCitations(report: DiagnosisReport, byId: Map<string, EvidenceRecord>): EvidenceRecord[] {
  const seen = new Set<string>();
  const out: EvidenceRecord[] = [];
  for (const id of report.hypotheses.flatMap((h) => h.evidenceIds)) {
    const e = byId.get(id);
    if (!e) continue;
    const key = citationKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// ---------- 打分 ----------

export function scoreCase(c: BenchmarkCase, evidence: EvidenceRecord[], report: DiagnosisReport): CaseScore {
  const gold = c.gold.evidence;
  const goldMatch = (e: EvidenceRecord) => gold.some((g) => evidenceMatches(e, g));

  const matchedGold = gold.filter((g) => evidence.some((e) => evidenceMatches(e, g)));
  const missedGold = gold.filter((g) => !matchedGold.includes(g)).map(describeLocator);

  // 报告 v2 的 evidenceIds 是 evidence_uid，v1 是 run 级 E#；两种都建索引。
  const byId = new Map<string, EvidenceRecord>();
  for (const e of evidence) {
    byId.set(e.evidenceId, e);
    if (e.evidenceUid) byId.set(e.evidenceUid, e);
  }
  const cited = distinctCitations(report, byId);
  const citedGold = cited.filter(goldMatch);
  const citedDistractor = cited.filter((e) => c.distractors.some((d) => evidenceMatches(e, d)));
  const citedNonGold = cited.filter((e) => !goldMatch(e)).map((e) => citationKey(e));

  // gold 为空（材料不足类）时召回率记 1，不因"没证据可找"而扣分。
  const recall = gold.length === 0 ? 1 : matchedGold.length / gold.length;
  // 引用已按身份去重：重复引用不再放大分母。
  const precision = cited.length === 0 ? (c.expect === "insufficient" ? 1 : 0) : citedGold.length / cited.length;
  const distractorCitationRate = cited.length === 0 ? 0 : citedDistractor.length / cited.length;

  const top = topHypothesis(report);
  const cause = matchCause(top?.cause ?? "", c.gold);
  // evidenceSupported 按 top 假设自身的引用判定（未经去重，语义是"是否引用了 ≥1 条 gold"）。
  const evidenceSupported =
    !!top &&
    top.evidenceIds.some((id) => {
      const e = byId.get(id);
      return !!e && goldMatch(e);
    });
  const distractorOnly = cited.length > 0 && citedGold.length === 0;

  let correct: boolean;
  let correctBasis: CaseScore["correctBasis"];
  if (c.expect === "insufficient") {
    correct = report.completeness === "partial" && report.hypotheses.every((h) => h.status !== "supported");
    correctBasis = "insufficient";
  } else if (cause.checked) {
    // 校准口径：根因概念匹配 + 引用 gold + 非干扰独证，三者同时满足
    correct = !!top && top.status === "supported" && cause.matched === true && evidenceSupported && !distractorOnly;
    correctBasis = "cause+evidence";
  } else {
    // legacy 兼容（gold 未注解）：退回 v1 仅引证口径，不得当校准结果报数
    correct = !!top && top.status === "supported" && evidenceSupported;
    correctBasis = "evidence-only(legacy)";
  }

  const causeCheck: CauseCheck | null = cause.checked
    ? { missingGroups: cause.missingGroups, forbiddenHit: cause.forbiddenHit }
    : null;

  return {
    id: c.id,
    recall,
    precision,
    distractorCitationRate,
    correct,
    causeMatched: cause.checked ? cause.matched : null,
    causeCheck,
    evidenceSupported,
    distractorOnly,
    correctBasis,
    matchedGold: matchedGold.map(describeLocator),
    missedGold,
    citedDistractor: citedDistractor.map((e) => e.evidenceId),
    citedNonGold,
    ...(top ? { topCause: top.cause } : {}),
    ...(c.expect === "insufficient"
      ? { note: correct ? "正确地未臆断" : "材料不足却给出 supported 结论" }
      : {}),
  };
}
