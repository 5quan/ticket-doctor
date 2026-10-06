// 审计的程序控制器（OQ-30）：模型出判定，程序确定性应用。
//
// 分工：
//   * 审计会话（src/agent/pi-auditor.ts）只产出结构化判定，不直接改报告。
//   * 这里把判定落到**具体结论**：contradicted→refuted；unsupported/undecidable 把 supported 降为 candidate；
//     missingEvidence 并入 missingMaterial；只有当“原标 supported 的结论被降级”或有补证项时才判 partial。
//   * 审计失败（failBlocks=false）显式降级：partial + 标注“未经独立复核”，不阻断发布。
import type { AuditConfig } from "../config/index.ts";
import type { DiagnosisReport, MaterialScope, ReportDraft } from "../domain/types.ts";
import { AUDIT_POLICY_VERSION, type AuditInput, type AuditResult, type ClaimVerdict, type EvidenceAuditor } from "../agent/audit-types.ts";
import type { EvidenceRef } from "../evidence/types.ts";
import type { AttemptObservationScope } from "../observability/types.ts";

const VERDICT_LABEL: Record<ClaimVerdict, string> = {
  supported: "支持",
  unsupported: "不支持",
  contradicted: "与证据矛盾",
  undecidable: "无法判定",
};

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

/** 从证据池挑审计快照：优先草稿引用的证据，其余按顺序补足到 max，控制上下文规模。 */
export function selectAuditEvidence(draft: ReportDraft, evidence: EvidenceRef[], max = 120): EvidenceRef[] {
  const cited = new Set(draft.hypotheses.flatMap((h) => h.evidenceIds ?? []));
  const byUid = new Map(evidence.map((e) => [e.evidenceUid, e]));
  const byShort = new Map(evidence.map((e) => [e.evidenceId, e]));
  const picked: EvidenceRef[] = [];
  const seen = new Set<string>();
  const add = (ref: EvidenceRef | undefined): void => {
    if (!ref || seen.has(ref.evidenceUid)) return;
    seen.add(ref.evidenceUid);
    picked.push(ref);
  };
  for (const c of cited) add(byUid.get(c) ?? byShort.get(c));
  for (const e of evidence) {
    if (picked.length >= max) break;
    add(e);
  }
  return picked;
}

/** 组装审计输入：裁剪证据快照（引用的在前）并绑定范围/执行限制。 */
export function buildAuditInput(args: {
  question: string;
  service?: string;
  environment?: string;
  scope: MaterialScope;
  draft: ReportDraft;
  evidence: EvidenceRef[];
  executionLimits: string[];
}): AuditInput {
  return {
    question: args.question,
    service: args.service,
    environment: args.environment,
    scope: args.scope,
    draft: args.draft,
    evidence: selectAuditEvidence(args.draft, args.evidence),
    executionLimits: args.executionLimits,
  };
}

/** 应用审计判定：只降级、不升级；返回新的报告（不改原对象）。 */
export function applyAudit(report: DiagnosisReport, audit: AuditResult): DiagnosisReport {
  const hypotheses = report.hypotheses.map((h) => ({ ...h, evidenceIds: [...h.evidenceIds] }));
  const corrections = [...report.corrections];
  const uncertainties = [...report.uncertainties];
  const missingMaterial = [...report.missingMaterial];
  let degradedSupported = false;

  for (const claim of audit.claimVerdicts) {
    const h = hypotheses[claim.hypothesisIndex];
    if (!h) continue;
    if (claim.verdict === "supported") continue;

    if (claim.verdict === "contradicted") {
      if (h.status === "supported") degradedSupported = true;
      if (h.status !== "refuted") {
        corrections.push(`审计：假设 ${claim.hypothesisIndex + 1} 与证据矛盾，status→refuted（${claim.reason}）`);
        h.status = "refuted";
        h.confidence = "low";
      }
      uncertainties.push(`审计对假设 ${claim.hypothesisIndex + 1} 的判定：与证据矛盾（${claim.reason}）`);
      continue;
    }

    // unsupported / undecidable：只能把 supported 降为 candidate
    if (h.status === "supported") {
      corrections.push(
        `审计：假设 ${claim.hypothesisIndex + 1} 被判为${VERDICT_LABEL[claim.verdict]}，status→candidate（${claim.reason}）`,
      );
      h.status = "candidate";
      h.confidence = "low";
      degradedSupported = true;
    }
    uncertainties.push(`审计对假设 ${claim.hypothesisIndex + 1} 的判定：${VERDICT_LABEL[claim.verdict]}（${claim.reason}）`);
  }

  for (const missing of audit.missingEvidence) {
    const target = missing.hypothesisIndex >= 0 ? `（针对假设 ${missing.hypothesisIndex + 1}）` : "";
    missingMaterial.push(`审计补证${target}：${missing.what}`);
  }
  if (degradedSupported) {
    missingMaterial.push(`审计策略 ${AUDIT_POLICY_VERSION}：有结论原标 supported 但未获证据支持`);
  }

  const completeness = missingMaterial.length > 0 ? "partial" : report.completeness;
  if (completeness !== report.completeness) {
    corrections.push(`审计后 completeness 由 ${report.completeness} 降为 ${completeness}`);
  }
  return {
    ...report,
    completeness,
    hypotheses,
    corrections: dedupe(corrections),
    uncertainties: dedupe(uncertainties),
    missingMaterial: dedupe(missingMaterial),
  };
}

/** 审计失败且不阻断时的显式降级：报告照常提交，但标注“未经独立复核”。 */
export function applyAuditFailure(report: DiagnosisReport, failure: string): DiagnosisReport {
  return {
    ...report,
    completeness: "partial",
    corrections: dedupe([
      ...report.corrections,
      `审计策略 ${AUDIT_POLICY_VERSION}：独立审计未完成（${failure}），结论未经独立复核`,
    ]),
    missingMaterial: dedupe([...report.missingMaterial, `独立审计未完成：${failure}`]),
  };
}

export interface AuditPhaseOutcome {
  audit?: AuditResult;
  failure?: string;
  modelTurns: number;
  policyVersion: string;
}

/**
 * 跑一次审计并处理失败策略：failBlocks=true 时抛错（由调用方 failRun）；
 * false 时返回 failure，由 Host 侧 applyAuditFailure 显式降级。
 */
export async function runAuditPhase(opts: {
  auditor: EvidenceAuditor | undefined;
  config: AuditConfig;
  input: AuditInput;
  signal: AbortSignal;
  /** 审计会话观测范围（每轮一个 scopeId）；未提供时不采集。 */
  obs?: AttemptObservationScope;
}): Promise<AuditPhaseOutcome> {
  if (!opts.auditor || !opts.config.enabled) {
    return { modelTurns: 0, policyVersion: AUDIT_POLICY_VERSION };
  }
  try {
    const outcome = await opts.auditor.audit(opts.input, opts.signal, opts.obs);
    return { audit: outcome.result, modelTurns: outcome.modelTurns, policyVersion: AUDIT_POLICY_VERSION };
  } catch (err) {
    if (opts.config.failBlocks) throw err;
    return {
      failure: err instanceof Error ? err.message : String(err),
      modelTurns: 0,
      policyVersion: AUDIT_POLICY_VERSION,
    };
  }
}
