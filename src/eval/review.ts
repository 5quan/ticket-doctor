// 人工复核（E4）辅助：生成复核清单、合并复核结论。
// 语义正确性第一版必须人工判定；未复核一律 unscored，不得把材料命中当正确。
import type { DiagnosisReport } from "../domain/types.ts";
import type { EvalRecord } from "./report.ts";
import type { CaseReview } from "./scorer.ts";

/** 合并一条复核结论（不改原对象）。 */
export function mergeReview(
  existing: Record<string, CaseReview>,
  caseId: string,
  correct: boolean,
  note?: string,
): Record<string, CaseReview> {
  return { ...existing, [caseId]: { correct, ...(note ? { note } : {}) } };
}

/** 复核清单：每个 case 取最近一条记录，展示报告结论/证据命中情况，供人工判断。 */
export function formatReviewSheet(records: EvalRecord[]): string {
  const byCase = new Map<string, EvalRecord>();
  for (const r of records) byCase.set(r.caseId, r);
  const lines: string[] = [];
  for (const [id, r] of byCase) {
    lines.push(`case ${id}：${r.score.reviewStatus}（当前 semanticCorrect=${r.score.semanticCorrect}；运行 ${r.fingerprint.engine}/${r.fingerprint.model} audit=${r.fingerprint.auditEnabled ? "on" : "off"}）`);
    const report = r.report as DiagnosisReport | undefined;
    if (!report) {
      lines.push(`  无报告：${r.error ?? r.kind ?? "?"}`);
    } else {
      lines.push(`  completeness=${report.completeness}`);
      report.hypotheses.forEach((h, i) => lines.push(`  [${i}] (${h.status ?? "?"}) ${h.cause}`));
      if (report.missingMaterial.length > 0) lines.push(`  missingMaterial：${report.missingMaterial.join("；")}`);
    }
    lines.push(
      `  recall=${r.score.evidenceRecall ?? "-"} precision=${r.score.evidencePrecision ?? "-"} cited=${r.score.citedTotal} distractor=${r.score.citedDistractor} invalidRef=${r.score.citationInvalid}`,
    );
  }
  return lines.join("\n");
}
