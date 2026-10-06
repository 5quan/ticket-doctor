// 确定性假审计器：零模型成本，用于离线 demo 与框架自检。
// 判定口径（首版）：引用可在证据快照中解析 → supported；无引用 → unsupported；引用解析不到 → undecidable。
import type { AttemptObservationScope } from "../observability/types.ts";
import type { AuditInput, AuditOutcome, AuditResult, ClaimAudit, EvidenceAuditor } from "./audit-types.ts";

export class FakeEvidenceAuditor implements EvidenceAuditor {
  readonly name = "fake-audit";

  async audit(input: AuditInput, signal: AbortSignal, _obs?: AttemptObservationScope): Promise<AuditOutcome> {
    signal.throwIfAborted();
    const claimVerdicts: ClaimAudit[] = input.draft.hypotheses.map((h, i) => {
      const cites = h.evidenceIds ?? [];
      if (cites.length === 0) {
        return { hypothesisIndex: i, verdict: "unsupported", reason: "该结论未引用任何证据" };
      }
      const resolved = cites.filter((c) =>
        input.evidence.some((e) => e.evidenceUid === c || e.evidenceId === c),
      );
      if (resolved.length === 0) {
        return { hypothesisIndex: i, verdict: "undecidable", reason: "引用无法在证据快照中解析" };
      }
      return { hypothesisIndex: i, verdict: "supported", reason: "引用可在证据快照中解析", evidenceUids: resolved };
    });
    const missingEvidence = input.draft.hypotheses
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => (h.evidenceIds ?? []).length === 0)
      .map(({ h, i }) => ({ hypothesisIndex: i, what: `支撑「${h.cause}」的证据` }));
    const result: AuditResult = {
      claimVerdicts,
      missingEvidence,
      stopAdvice: { action: "stop", reason: "确定性假审计完成" },
    };
    return { result, modelTurns: 1 };
  }
}
