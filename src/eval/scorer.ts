// 评测打分器（MVP）：只做**材料命中**与**引用有效性**的确定性判定；
// 语义正确性第一版靠人工复核，未复核一律标 `unscored`，绝不把“命中 gold”冒充“诊断正确”。
import type { DiagnosisReport, MaterialScope } from "../domain/types.ts";
import type { EvidenceRef } from "../evidence/types.ts";
import type { ValidationIssue } from "../diagnosis/validate.ts";
import { EVAL_SCORER_VERSION, type EvalCase, type EvidenceLocator } from "./benchmark.ts";

export interface CaseReview {
  correct: boolean;
  note?: string;
}

export interface EvalScore {
  scorerVersion: string;
  /** material-only：只评材料/引用；reviewed：叠加人工语义复核。 */
  gradeMode: "material-only" | "reviewed";
  /** 未经人工复核不得称为“校准正确率”。 */
  calibrated: boolean;
  evidenceRecall: number | null;
  evidencePrecision: number | null;
  goldTotal: number;
  goldMatched: number;
  citedTotal: number;
  citedDistractor: number;
  semanticCorrect: boolean | "unscored";
  reviewStatus: "unreviewed" | "reviewed";
  /** 引用无法解析/版本不符/历史版本冒充本轮 的条数。 */
  citationInvalid: number;
  note: string;
}

/** 证据引用是否命中某个源级定位（日志：level+substring；代码：repo/path/行区间，可选 sha）。 */
export function locatorMatches(ref: EvidenceRef, loc: EvidenceLocator): boolean {
  if (loc.kind !== ref.kind) return false;
  if (loc.kind === "log") {
    if (loc.level && ref.level !== loc.level) return false;
    if (loc.substring && !ref.excerpt.includes(loc.substring)) return false;
    return true;
  }
  if (!ref.codeRef) return false;
  if (loc.repoId && ref.codeRef.repoId !== loc.repoId) return false;
  if (loc.path && ref.codeRef.path !== loc.path) return false;
  if (loc.sha && ref.codeRef.sha !== loc.sha) return false;
  if (loc.lineStart !== undefined && loc.lineEnd !== undefined) {
    if (ref.codeRef.endLine < loc.lineStart || ref.codeRef.startLine > loc.lineEnd) return false;
  }
  return true;
}

/** 报告实际引用的证据（按 uid 解析后去重）。 */
export function citedEvidence(report: DiagnosisReport, evidence: EvidenceRef[]): EvidenceRef[] {
  const byUid = new Map(evidence.map((e) => [e.evidenceUid, e]));
  const seen = new Set<string>();
  const cited: EvidenceRef[] = [];
  for (const h of report.hypotheses) {
    for (const id of h.evidenceIds) {
      const ref = byUid.get(id);
      if (!ref || seen.has(ref.evidenceUid)) continue;
      seen.add(ref.evidenceUid);
      cited.push(ref);
    }
  }
  return cited;
}

function invalidCitationCount(issues: ValidationIssue[] | undefined): number {
  if (!issues) return 0;
  const codes = new Set(["evidence_not_found", "version_mismatch", "stale_version_support"]);
  return issues.filter((i) => codes.has(i.code)).length;
}

export function scoreCase(
  c: EvalCase,
  data: {
    report: DiagnosisReport;
    evidence: EvidenceRef[];
    scope?: MaterialScope;
    validationIssues?: ValidationIssue[];
    review?: CaseReview;
  },
): EvalScore {
  void data.scope;
  const gold = c.gold.evidence;
  const cited = citedEvidence(data.report, data.evidence);

  const goldMatched = gold.filter((loc) => cited.some((ref) => locatorMatches(ref, loc))).length;
  const citedDistractor = cited.filter((ref) => !gold.some((loc) => locatorMatches(ref, loc))).length;

  const evidenceRecall = gold.length > 0 ? goldMatched / gold.length : null;
  const evidencePrecision = cited.length > 0 ? (cited.length - citedDistractor) / cited.length : null;

  const reviewed = data.review !== undefined;
  return {
    scorerVersion: EVAL_SCORER_VERSION,
    gradeMode: reviewed ? "reviewed" : "material-only",
    calibrated: reviewed,
    evidenceRecall,
    evidencePrecision,
    goldTotal: gold.length,
    goldMatched,
    citedTotal: cited.length,
    citedDistractor,
    semanticCorrect: reviewed ? data.review!.correct : "unscored",
    reviewStatus: reviewed ? "reviewed" : "unreviewed",
    citationInvalid: invalidCitationCount(data.validationIssues),
    note: reviewed
      ? data.review!.note ?? "人工复核"
      : "仅材料/引用判定；语义正确性未复核（unscored）",
  };
}
