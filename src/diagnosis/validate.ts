// 报告校验：把模型草稿变成正式报告，并施加程序级硬规则。
//
// 分工：
//   * 模型负责"发现"——提出事实与假设，并用证据引用（本轮 E# 或证据 UID）支撑。
//   * 程序负责"约束"——引用必须能解析到本调查内的证据、本轮证据版本必须一致、
//     无证据不得宣称支持、历史版本不冒充本轮验证（D10）。
//   * 输入是 EvidenceResolver（docs/evidence-uid-design.md §9）：引用解析按调查进行，
//     跨调查的证据在结构上不可达；v2 报告的 evidenceIds 统一写 evidence_uid。
import type {
  DiagnosisReport,
  MaterialScope,
  ReportDraft,
  RootCauseHypothesis,
} from "../domain/types.ts";
import type { EvidenceRef, EvidenceResolver } from "../evidence/types.ts";

export interface ValidationIssue {
  code:
    | "evidence_not_found"
    | "version_mismatch"
    | "unverified_claim"
    | "completeness_forced"
    | "duplicate_evidence"
    | "stale_version_support";
  message: string;
  hypothesisIndex?: number;
}

export interface ValidationResult {
  report: DiagnosisReport;
  issues: ValidationIssue[];
}

export interface ValidateOptions {
  resolver: EvidenceResolver;
  scope: MaterialScope;
  /** 引用解析按调查进行（§9.2）；resolver 已绑定同一调查。 */
  investigationId: string;
  executionLimits: string[];
}

const E_SHORT = /^E\d+$/;

type Resolution =
  | { ok: true; ref: EvidenceRef; fromCurrentRun: boolean }
  | { ok: false; issue: ValidationIssue };

/** 引用解析（§9.2）：uid 命中 → 用 uid；E# 先查本轮、再查调查（历史重复号 → 要求用 UID）。 */
function resolveCitation(resolver: EvidenceResolver, raw: string, opts: ValidateOptions, index: number): Resolution {
  const byUid = resolver.byUid(opts.investigationId, raw);
  if (byUid) return { ok: true, ref: byUid, fromCurrentRun: false };

  if (E_SHORT.test(raw)) {
    const current = resolver.byRunShortId(resolver.currentRunId, raw);
    if (current) return { ok: true, ref: current, fromCurrentRun: true };

    const hits = resolver
      .listByInvestigation(opts.investigationId)
      .filter((r) => r.evidenceId === raw);
    if (hits.length === 1) return { ok: true, ref: hits[0]!, fromCurrentRun: false };
    if (hits.length > 1) {
      return {
        ok: false,
        issue: {
          code: "evidence_not_found",
          message: `假设 ${index + 1} 引用的 ${raw} 在调查内对应多条历史证据，请改用证据 UID`,
          hypothesisIndex: index,
        },
      };
    }
  }
  return {
    ok: false,
    issue: {
      code: "evidence_not_found",
      message: `假设 ${index + 1} 引用不存在的证据 ${raw}`,
      hypothesisIndex: index,
    },
  };
}

/** 代码证据的 sha 是否与本轮钉定版本一致（D10 的比较基准）。 */
function shaMatchesCurrentRun(ref: EvidenceRef, scope: MaterialScope): boolean {
  if (!ref.codeRef) return true; // 日志等非代码证据不参与 sha 比较
  const bound = scope.repos.find((r) => r.repoId === ref.codeRef!.repoId);
  return Boolean(bound && bound.sha === ref.codeRef.sha);
}

export function validateDraft(draft: ReportDraft, opts: ValidateOptions): ValidationResult {
  const issues: ValidationIssue[] = [];
  const corrections: string[] = [];
  const hypotheses: RootCauseHypothesis[] = [];
  let validEvidence = 0;

  draft.hypotheses.forEach((h, index) => {
    const seen = new Set<string>();
    const uids: string[] = [];
    const resolvedRefs: EvidenceRef[] = [];

    for (const raw of h.evidenceIds ?? []) {
      const resolution = resolveCitation(opts.resolver, raw, opts, index);
      if (!resolution.ok) {
        issues.push(resolution.issue);
        continue;
      }
      const { ref, fromCurrentRun } = resolution;
      if (seen.has(ref.evidenceUid)) {
        issues.push({
          code: "duplicate_evidence",
          message: `假设 ${index + 1} 重复引用 ${raw}`,
          hypothesisIndex: index,
        });
        continue;
      }
      // 本轮证据强校验 sha（D10）；历史证据不强校验，由"全部 sha 均非本轮"降级兜底
      if (fromCurrentRun && ref.codeRef && !shaMatchesCurrentRun(ref, opts.scope)) {
        issues.push({
          code: "version_mismatch",
          message: `假设 ${index + 1} 引用的代码版本与本次运行不一致`,
          hypothesisIndex: index,
        });
        continue;
      }
      seen.add(ref.evidenceUid);
      uids.push(ref.evidenceUid);
      resolvedRefs.push(ref);
    }
    validEvidence += uids.length;

    let status = h.status ?? (uids.length > 0 ? "supported" : "candidate");
    let confidence = h.confidence;
    if (uids.length === 0) {
      if (status === "supported") {
        corrections.push(`假设 ${index + 1} 无有效证据，状态从 supported 降为 candidate`);
        issues.push({ code: "unverified_claim", message: `假设 ${index + 1} 无证据却宣称 supported`, hypothesisIndex: index });
      }
      status = "candidate";
      if (confidence !== "low") {
        corrections.push(`假设 ${index + 1} 无有效证据，置信度从 ${confidence} 降为 low`);
        confidence = "low";
      }
    } else if (status === "supported") {
      // D10：全部代码证据的 sha 都 ≠ 本轮 scope sha → 不冒充本轮验证通过
      const codeRefs = resolvedRefs.filter((r) => r.codeRef !== undefined);
      if (codeRefs.length > 0 && codeRefs.every((r) => !shaMatchesCurrentRun(r, opts.scope))) {
        corrections.push(`假设 ${index + 1} 的支撑证据均非本轮钉定版本，状态从 supported 降为 candidate`);
        issues.push({
          code: "stale_version_support",
          message: `假设 ${index + 1} 仅由历史版本证据支撑`,
          hypothesisIndex: index,
        });
        status = "candidate";
      }
    }
    hypotheses.push({ cause: h.cause, confidence, status, evidenceIds: uids });
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
