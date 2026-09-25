// 打分器：证据召回率、引用精确率、决策正确率。
//
// v1 正确率用确定性规则：诊断类 case 要求 top 假设 status=supported 且至少引用一条 gold 证据
// （"结论必须建立在正确证据上"）；材料不足类 case 要求 completeness=partial 且无 supported 结论。
// v2 可升级为 judge 模型做语义判定。
import type { DiagnosisReport, EvidenceRecord, RootCauseHypothesis } from "../domain/types.ts";
import { describeLocator, evidenceMatches } from "./benchmark.ts";
import type { BenchmarkCase, CaseScore } from "./types.ts";

const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function topHypothesis(report: DiagnosisReport): RootCauseHypothesis | undefined {
  return [...report.hypotheses].sort(
    (a, b) => (CONFIDENCE_RANK[a.confidence] ?? 9) - (CONFIDENCE_RANK[b.confidence] ?? 9),
  )[0];
}

export function scoreCase(c: BenchmarkCase, evidence: EvidenceRecord[], report: DiagnosisReport): CaseScore {
  const gold = c.gold.evidence;
  const matchedGold = gold.filter((g) => evidence.some((e) => evidenceMatches(e, g)));
  const missedGold = gold.filter((g) => !matchedGold.includes(g)).map(describeLocator);

  const byId = new Map(evidence.map((e) => [e.evidenceId, e]));
  const cited = report.hypotheses
    .flatMap((h) => h.evidenceIds)
    .map((id) => byId.get(id))
    .filter((e): e is EvidenceRecord => e !== undefined);
  const citedGold = cited.filter((e) => gold.some((g) => evidenceMatches(e, g)));
  const citedDistractor = cited.filter((e) => c.distractors.some((d) => evidenceMatches(e, d)));

  // gold 为空（材料不足类）时召回率记 1，不因"没证据可找"而扣分。
  const recall = gold.length === 0 ? 1 : matchedGold.length / gold.length;
  // 没有引用：材料不足类算 1（正确地不引用），诊断类算 0（结论没有证据支撑）。
  const precision = cited.length === 0 ? (c.expect === "insufficient" ? 1 : 0) : citedGold.length / cited.length;

  const top = topHypothesis(report);
  let correct: boolean;
  if (c.expect === "insufficient") {
    correct = report.completeness === "partial" && report.hypotheses.every((h) => h.status !== "supported");
  } else {
    correct =
      !!top &&
      top.status === "supported" &&
      top.evidenceIds.some((id) => {
        const e = byId.get(id);
        return !!e && gold.some((g) => evidenceMatches(e, g));
      });
  }

  return {
    id: c.id,
    recall,
    precision,
    correct,
    matchedGold: matchedGold.map(describeLocator),
    missedGold,
    citedDistractor: citedDistractor.map((e) => e.evidenceId),
    ...(top ? { topCause: top.cause } : {}),
    ...(c.expect === "insufficient"
      ? { note: correct ? "正确地未臆断" : "材料不足却给出 supported 结论" }
      : {}),
  };
}
