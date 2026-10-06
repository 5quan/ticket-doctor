// 独立审计（OQ-30）：程序应用规则 + 假审计器。模型出判定，程序只降不升。
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeEvidenceAuditor } from "../../src/agent/fake-auditor.ts";
import { AUDIT_POLICY_VERSION, type AuditInput, type AuditResult } from "../../src/agent/audit-types.ts";
import { applyAudit, applyAuditFailure, buildAuditInput, selectAuditEvidence } from "../../src/diagnosis/audit.ts";
import type { DiagnosisReport } from "../../src/domain/types.ts";
import type { EvidenceRef } from "../../src/evidence/types.ts";

function evidence(uid: string, id: string): EvidenceRef {
  return { kind: "log", excerpt: `log ${uid}`, source: "stub", truncated: false, evidenceUid: uid, evidenceId: id };
}

function report(over: Partial<DiagnosisReport> = {}): DiagnosisReport {
  return {
    completeness: "complete",
    summary: "s",
    scope: { services: ["svc"], repos: [] },
    confirmedFacts: [],
    hypotheses: [
      { cause: "a", confidence: "high", status: "supported", evidenceIds: ["u1"] },
      { cause: "b", confidence: "medium", status: "candidate", evidenceIds: ["u2"] },
    ],
    uncertainties: [],
    nextSteps: [],
    missingMaterial: [],
    corrections: [],
    executionLimits: [],
    ...over,
  };
}

const stop: AuditResult["stopAdvice"] = { action: "stop", reason: "done" };

test("applyAudit：unsupported 把 supported 降为 candidate 并判 partial", () => {
  const out = applyAudit(report(), {
    claimVerdicts: [{ hypothesisIndex: 0, verdict: "unsupported", reason: "证据不支撑" }],
    missingEvidence: [],
    stopAdvice: stop,
  });
  assert.equal(out.hypotheses[0]!.status, "candidate");
  assert.equal(out.hypotheses[0]!.confidence, "low");
  assert.equal(out.completeness, "partial");
  assert.ok(out.corrections.some((c) => c.includes("status→candidate")));
  assert.ok(out.missingMaterial.some((m) => m.includes("未获证据支持")));
});

test("applyAudit：contradicted 降为 refuted", () => {
  const out = applyAudit(report(), {
    claimVerdicts: [{ hypothesisIndex: 0, verdict: "contradicted", reason: "存在反证" }],
    missingEvidence: [],
    stopAdvice: stop,
  });
  assert.equal(out.hypotheses[0]!.status, "refuted");
  assert.equal(out.hypotheses[0]!.confidence, "low");
  assert.equal(out.completeness, "partial");
  assert.ok(out.corrections.some((c) => c.includes("refuted")));
});

test("applyAudit：supported 不改动，保持 complete", () => {
  const out = applyAudit(report(), {
    claimVerdicts: [
      { hypothesisIndex: 0, verdict: "supported", reason: "ok" },
      { hypothesisIndex: 1, verdict: "supported", reason: "ok" },
    ],
    missingEvidence: [],
    stopAdvice: stop,
  });
  assert.equal(out.completeness, "complete");
  assert.equal(out.hypotheses[0]!.status, "supported");
  assert.deepEqual(out.corrections, []);
});

test("applyAudit：已是 candidate 的结论被判 unsupported 不强行降完整度，仅记不确定性", () => {
  const out = applyAudit(
    report({ hypotheses: [{ cause: "b", confidence: "low", status: "candidate", evidenceIds: ["u2"] }] }),
    {
      claimVerdicts: [{ hypothesisIndex: 0, verdict: "unsupported", reason: "证据弱" }],
      missingEvidence: [],
      stopAdvice: stop,
    },
  );
  assert.equal(out.completeness, "complete");
  assert.equal(out.hypotheses[0]!.status, "candidate");
  assert.ok(out.uncertainties.some((u) => u.includes("不支持")));
});

test("applyAudit：missingEvidence 并入缺失材料并判 partial", () => {
  const out = applyAudit(report(), {
    claimVerdicts: [],
    missingEvidence: [{ hypothesisIndex: 1, what: "调用链日志" }],
    stopAdvice: stop,
  });
  assert.equal(out.completeness, "partial");
  assert.ok(out.missingMaterial.some((m) => m.includes("审计补证") && m.includes("调用链日志")));
});

test("applyAuditFailure：显式降级为 partial 并标注未经复核", () => {
  const out = applyAuditFailure(report(), "审计超时");
  assert.equal(out.completeness, "partial");
  assert.ok(out.corrections.some((c) => c.includes(AUDIT_POLICY_VERSION) && c.includes("未经独立复核")));
  assert.ok(out.missingMaterial.some((m) => m.includes("审计超时")));
});

test("selectAuditEvidence：草稿引用的证据优先，其余补足", () => {
  const evs = [evidence("u1", "E1"), evidence("u2", "E2"), evidence("u3", "E3")];
  const draft = report({
    hypotheses: [{ cause: "x", confidence: "low", status: "supported", evidenceIds: ["u3"] }],
  });
  const picked = selectAuditEvidence(draft, evs);
  assert.equal(picked[0]!.evidenceUid, "u3");
  assert.equal(picked.length, 3);
});

test("FakeEvidenceAuditor：可解析→supported，无引用→unsupported+补证，解析不到→undecidable", async () => {
  const input: AuditInput = buildAuditInput({
    question: "q",
    scope: { services: ["svc"], repos: [] },
    draft: {
      completeness: "partial",
      summary: "s",
      confirmedFacts: [],
      hypotheses: [
        { cause: "ok", confidence: "high", status: "supported", evidenceIds: ["u1"] },
        { cause: "no evidence", confidence: "high", status: "supported", evidenceIds: [] },
        { cause: "dangling", confidence: "high", status: "supported", evidenceIds: ["uX"] },
      ],
      uncertainties: [],
      nextSteps: [],
      missingMaterial: [],
    },
    evidence: [evidence("u1", "E1")],
    executionLimits: [],
  });
  const { result, modelTurns } = await new FakeEvidenceAuditor().audit(input, new AbortController().signal);
  assert.equal(modelTurns, 1);
  assert.equal(result.claimVerdicts[0]!.verdict, "supported");
  assert.equal(result.claimVerdicts[1]!.verdict, "unsupported");
  assert.equal(result.claimVerdicts[2]!.verdict, "undecidable");
  assert.equal(result.missingEvidence.length, 1);
  assert.equal(result.missingEvidence[0]!.hypothesisIndex, 1);
});
