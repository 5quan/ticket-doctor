// 报告校验：把模型草稿变成正式报告，并施加程序级硬规则。
//
// 分工：
//   * 模型负责"发现"——提出事实与假设，并用 evidenceId 引用证据。
//   * 程序负责"约束"——引用必须存在、版本必须一致、无证据不得宣称支持、
//     partial 不得假装完整。校验只证明材料存在，不代表推理正确。
import type {
  DiagnosisReport,
  EvidenceRecord,
  MaterialScope,
  ReportDraft,
  RootCauseHypothesis,
} from "../domain/types.ts";
import type { EvidenceRegistry } from "./evidence.ts";

export interface ValidationIssue {
  code: "evidence_not_found" | "version_mismatch" | "unverified_claim" | "completeness_forced" | "duplicate_evidence";
  message: string;
  hypothesisIndex?: number;
}

export interface ValidationResult {
  report: DiagnosisReport;
  issues: ValidationIssue[];
}

export function validateDraft(
  draft: ReportDraft,
  opts: { registry: EvidenceRegistry; scope: MaterialScope; executionLimits: string[] },
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const corrections: string[] = [];
  const hypotheses: RootCauseHypothesis[] = [];
  let validEvidence = 0;

  draft.hypotheses.forEach((h, index) => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of h.evidenceIds ?? []) {
      const entry = opts.registry.get(id) as EvidenceRecord | undefined;
      if (!entry) {
        issues.push({ code: "evidence_not_found", message: `假设 ${index + 1} 引用不存在的证据 ${id}`, hypothesisIndex: index });
        continue;
      }
      if (seen.has(id)) {
        issues.push({ code: "duplicate_evidence", message: `假设 ${index + 1} 重复引用 ${id}`, hypothesisIndex: index });
        continue;
      }
      if (entry.codeRef) {
        const bound = opts.scope.repos.find((r) => r.repoId === entry.codeRef!.repoId);
        if (!bound || bound.sha !== entry.codeRef.sha) {
          issues.push({
            code: "version_mismatch",
            message: `假设 ${index + 1} 引用的代码版本与本次运行不一致`,
            hypothesisIndex: index,
          });
          continue;
        }
      }
      seen.add(id);
      ids.push(id);
    }
    validEvidence += ids.length;

    let status = h.status ?? (ids.length > 0 ? "supported" : "candidate");
    let confidence = h.confidence;
    if (ids.length === 0) {
      if (status === "supported") {
        corrections.push(`假设 ${index + 1} 无有效证据，状态从 supported 降为 candidate`);
        issues.push({ code: "unverified_claim", message: `假设 ${index + 1} 无证据却宣称 supported`, hypothesisIndex: index });
      }
      status = "candidate";
      if (confidence !== "low") {
        corrections.push(`假设 ${index + 1} 无有效证据，置信度从 ${confidence} 降为 low`);
        confidence = "low";
      }
    }
    hypotheses.push({ cause: h.cause, confidence, status, evidenceIds: ids });
  });

  let completeness = draft.completeness;
  const missingMaterial = [...draft.missingMaterial];
  if (completeness === "complete") {
    if (missingMaterial.length > 0) {
      corrections.push("status=complete 与 missingMaterial 矛盾，已改判 partial");
      issues.push({ code: "completeness_forced", message: "complete 与缺失材料矛盾" });
      completeness = "partial";
    }
    if (draft.hypotheses.length > 0 && validEvidence === 0) {
      corrections.push("形成假设但零有效证据，已改判 partial");
      issues.push({ code: "completeness_forced", message: "有假设但无有效证据" });
      completeness = "partial";
      missingMaterial.push("支持根因假设的有效证据");
    }
  }

  const report: DiagnosisReport = {
    completeness,
    summary: draft.summary,
    scope: opts.scope,
    confirmedFacts: draft.confirmedFacts,
    hypotheses,
    uncertainties: draft.uncertainties,
    nextSteps: draft.nextSteps,
    missingMaterial,
    corrections,
    executionLimits: opts.executionLimits,
  };
  return { report, issues };
}
