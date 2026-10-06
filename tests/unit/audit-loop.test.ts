// 有界补证循环（OQ-30）：审计建议 continue 且预算足够时回主诊断补证，再审计；有上限、共享预算。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AuditResult, EvidenceAuditor } from "../../src/agent/audit-types.ts";
import type { DiagnosisEngine, EngineResult, SessionSink, Toolbox } from "../../src/agent/types.ts";
import type { ReportDraft } from "../../src/domain/types.ts";
import { renderSupplementPrompt, runDiagnosisLoop, shouldSupplement } from "../../src/diagnosis/diagnosis-loop.ts";

function draft(cause: string): ReportDraft {
  return {
    completeness: "partial",
    summary: cause,
    confirmedFacts: [],
    hypotheses: [{ cause, confidence: "high", status: "supported", evidenceIds: [] }],
    uncertainties: [],
    nextSteps: [],
    missingMaterial: [],
  };
}

function reportResult(cause: string): EngineResult {
  return { kind: "report", draft: draft(cause), toolCalls: 0, modelTurns: 1, model: "stub" };
}

function scriptedEngine(results: EngineResult[]): { engine: DiagnosisEngine; calls: () => number } {
  let i = 0;
  return {
    engine: {
      name: "stub",
      async run() {
        const r = results[Math.min(i, results.length - 1)]!;
        i += 1;
        return r;
      },
    },
    calls: () => i,
  };
}

type LoopSession = SessionSink & { appendUserMessage(text: string): void };
function sessionStub(): { session: LoopSession; userMessages: string[] } {
  const entries: SessionEntry[] = [];
  const userMessages: string[] = [];
  return {
    userMessages,
    session: {
      priorEntries: entries,
      resumed: false,
      appendEntry: (e) => void entries.push(e),
      recordTool: () => {},
      appendUserMessage: (text) => void userMessages.push(text),
    },
  };
}

function scriptedAuditor(results: AuditResult[]): { auditor: EvidenceAuditor; calls: () => number } {
  let i = 0;
  return {
    auditor: {
      name: "scripted",
      async audit() {
        const r = results[Math.min(i, results.length - 1)]!;
        i += 1;
        return { result: r, modelTurns: 1 };
      },
    },
    calls: () => i,
  };
}

const continueAdvice: AuditResult = {
  claimVerdicts: [],
  missingEvidence: [{ hypothesisIndex: 0, what: "订单日志" }],
  stopAdvice: { action: "continue", reason: "缺证据" },
};
const stopAdvice: AuditResult = {
  claimVerdicts: [{ hypothesisIndex: 0, verdict: "supported", reason: "ok" }],
  missingEvidence: [],
  stopAdvice: { action: "stop", reason: "够了" },
};

function loopDeps(over: Partial<Parameters<typeof runDiagnosisLoop>[0]>): Parameters<typeof runDiagnosisLoop>[0] {
  return {
    engine: scriptedEngine([reportResult("v1")]).engine,
    auditor: undefined,
    auditConfig: { enabled: true, allowRetrieval: false, failBlocks: false, maxRounds: 1 },
    maxRounds: 1,
    signal: new AbortController().signal,
    input: { investigationId: "i", runId: "r", question: "q", receivedAt: 1 },
    scope: { services: [], repos: [] },
    toolbox: { toolCalls: 0, maxToolCalls: 12 } as unknown as Toolbox,
    session: sessionStub().session,
    evidence: () => [],
    executionLimits: () => [],
    ...over,
  };
}

test("补证循环：审计建议 continue 且预算足够 → 回主诊断一轮后重新审计", async () => {
  const { engine, calls } = scriptedEngine([reportResult("v1"), reportResult("v2")]);
  const { session, userMessages } = sessionStub();
  const { auditor, calls: auditCalls } = scriptedAuditor([continueAdvice, stopAdvice]);

  const result = await runDiagnosisLoop(loopDeps({ engine, auditor, session }));

  assert.equal(calls(), 2, "补证应回主诊断一次");
  assert.equal(auditCalls(), 2, "补证后应重新审计");
  assert.equal(userMessages.length, 1, "补证指令应写回同一会话");
  assert.match(userMessages[0]!, /补证/);
  assert.equal(result.auditRounds, 1);
  assert.equal(result.modelTurns, 4, "2 次引擎 + 2 次审计模型轮次");
  assert.equal(result.audit?.stopAdvice.action, "stop");
});

test("审计未启用（无 auditor）：不审计、不发 onAudit", async () => {
  const { engine } = scriptedEngine([reportResult("v1")]);
  let auditEvents = 0;
  const result = await runDiagnosisLoop(
    loopDeps({ engine, auditor: undefined, onAudit: () => void (auditEvents += 1) }),
  );
  assert.equal(auditEvents, 0);
  assert.equal(result.auditRounds, 0);
  assert.equal(result.audit, undefined);
});

test("审计未启用（无 auditor）：不审计、不发 onAudit", async () => {
  const { engine } = scriptedEngine([reportResult("v1")]);
  let auditEvents = 0;
  const result = await runDiagnosisLoop(
    loopDeps({ engine, auditor: undefined, onAudit: () => void (auditEvents += 1) }),
  );
  assert.equal(auditEvents, 0);
  assert.equal(result.auditRounds, 0);
  assert.equal(result.audit, undefined);
});

test("补证循环：审计建议 stop → 不补证（单次审计）", async () => {
  const { engine, calls } = scriptedEngine([reportResult("v1")]);
  const { auditor, calls: auditCalls } = scriptedAuditor([stopAdvice]);
  const result = await runDiagnosisLoop(loopDeps({ engine, auditor }));
  assert.equal(calls(), 1);
  assert.equal(auditCalls(), 1);
  assert.equal(result.auditRounds, 0);
});

test("补证循环：maxRounds=0 时即使建议 continue 也不补证", async () => {
  const { engine, calls } = scriptedEngine([reportResult("v1")]);
  const { auditor } = scriptedAuditor([continueAdvice]);
  const result = await runDiagnosisLoop(
    loopDeps({ engine, auditor, maxRounds: 0, auditConfig: { enabled: true, allowRetrieval: false, failBlocks: false, maxRounds: 0 } }),
  );
  assert.equal(calls(), 1);
  assert.equal(result.auditRounds, 0);
});

test("补证循环：工具预算耗尽时不补证（避免必然失败的轮次）", async () => {
  const { engine, calls } = scriptedEngine([reportResult("v1")]);
  const { auditor } = scriptedAuditor([continueAdvice]);
  const result = await runDiagnosisLoop(
    loopDeps({ engine, auditor, toolbox: { toolCalls: 12, maxToolCalls: 12 } as unknown as Toolbox }),
  );
  assert.equal(calls(), 1);
  assert.equal(result.auditRounds, 0);
});

test("补证轮变成 reply：以该结果为准但仍保留审计判定", async () => {
  const { engine } = scriptedEngine([
    reportResult("v1"),
    { kind: "reply", reason: "clarify", text: "请补充 traceId", toolCalls: 0, modelTurns: 1, model: "stub" },
  ]);
  const { auditor } = scriptedAuditor([continueAdvice]);
  const result = await runDiagnosisLoop(loopDeps({ engine, auditor }));
  assert.equal(result.result.kind, "reply");
  assert.equal(result.auditRounds, 1);
  assert.ok(result.audit, "应保留已得审计判定");
});

test("shouldSupplement：continue+补证项+预算内 才为真", () => {
  const base = { rounds: 0, maxRounds: 1, toolCalls: 0, maxToolCalls: 12 };
  assert.equal(shouldSupplement(continueAdvice, base), true);
  assert.equal(shouldSupplement(stopAdvice, base), false);
  assert.equal(shouldSupplement(continueAdvice, { ...base, rounds: 1 }), false);
  assert.equal(shouldSupplement(continueAdvice, { ...base, toolCalls: 12 }), false);
  assert.equal(shouldSupplement({ ...continueAdvice, missingEvidence: [] }, base), false);
  assert.equal(shouldSupplement(undefined, base), false);
});

test("renderSupplementPrompt：列出缺证项与建议动作", () => {
  const text = renderSupplementPrompt(continueAdvice, 1);
  assert.match(text, /订单日志/);
  assert.match(text, /结论 1/);
  assert.match(text, /candidate/);
});
