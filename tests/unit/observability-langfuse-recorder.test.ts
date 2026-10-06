// Langfuse 观测记录器（langfuse.ts）单元测试：用内存 spy SpanProcessor 验证 span 树结构与属性，
// 不发任何网络请求（观测方案 §11：导出器只把目标 observation 发给 Langfuse；这里验证结构与门控）。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Span } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createLangfuseRecorder } from "../../src/observability/langfuse.ts";
import type { ObservationEvent } from "../../src/observability/types.ts";

const CONFIG = {
  enabled: true,
  baseUrl: "http://127.0.0.1:19999",
  publicKey: "pk-lf-test",
  secretKey: "sk-lf-test",
  environment: "test",
  maxEventBytes: 524_288,
  shutdownMs: 100,
};

const IDENTITY = { investigationId: "inv-1", runId: "run-1", attemptId: "att-1", generation: 1 };

/** 内存 spy processor：收集已结束 span（含父子引用），替代 LangfuseSpanProcessor。 */
function spyProcessor() {
  const ended: ReadableSpan[] = [];
  const processor: SpanProcessor = {
    onStart(_span: Span) {},
    onEnd(span: ReadableSpan) {
      ended.push(span);
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  return { processor, ended };
}

const scopeId = (key: string) => `${IDENTITY.investigationId}:${IDENTITY.runId}:${IDENTITY.attemptId}:${IDENTITY.generation}`;

function modelStart(id: string): ObservationEvent {
  return {
    schemaVersion: 1,
    eventId: "e1",
    seq: 1,
    timestamp: new Date().toISOString(),
    kind: "model_start",
    logicalObservationId: id,
    parentLogicalId: scopeId("k"),
    model: "deepseek-v4-flash",
    provider: "deepseek",
    callPurpose: "diagnosis",
    captureLevel: "effective_context",
    input: { text: "{}", truncated: false, originalBytes: 2 },
  };
}

function modelEnd(id: string): ObservationEvent {
  return {
    schemaVersion: 1,
    eventId: "e2",
    seq: 2,
    timestamp: new Date().toISOString(),
    kind: "model_end",
    logicalObservationId: id,
    parentLogicalId: scopeId("k"),
    status: "ok",
    stopReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 },
  };
}

test("门控：未启用或缺配置返回 undefined，不创建 exporter", () => {
  assert.equal(createLangfuseRecorder({ ...CONFIG, enabled: false }), undefined);
  const warn = console.error;
  let warned = 0;
  console.error = () => warned++;
  try {
    assert.equal(createLangfuseRecorder({ ...CONFIG, publicKey: undefined }, spyProcessor().processor), undefined);
    assert.equal(createLangfuseRecorder({ ...CONFIG, baseUrl: undefined }, spyProcessor().processor), undefined);
  } finally {
    console.error = warn;
  }
  assert.equal(warned, 2, "缺配置必须打印清晰错误（不含秘密）");
});

test("span 树：trace 根 → diagnosis-attempt(agent) → model-request(generation)；usage 进 usageDetails", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  const k = recorder.beginAttempt(IDENTITY, { question: "下单接口报 500", engine: "pi" })!;
  assert.ok(k);

  recorder.record(modelStart("gen-1"), IDENTITY);
  recorder.record(modelEnd("gen-1"), IDENTITY);
  recorder.endAttempt(IDENTITY, { status: "ok", kind: "report", summary: "ok" });
  assert.equal(ended.length, 3, "agent/generation/root 三个 span 全部结束");

  const root = ended.find((s) => s.name === "diagnose-turn")!;
  const agent = ended.find((s) => s.name === "diagnosis-attempt")!;
  const gen = ended.find((s) => s.name === "model-request")!;
  // 父子关系：gen → agent → root（spanContext.traceId 一致，parentSpanId 链式）
  assert.equal(gen.spanContext().traceId, root.spanContext().traceId);
  assert.equal(agent.spanContext().spanId, gen.parentSpanContext?.spanId);
  assert.equal(root.parentSpanContext, undefined);

  const rootAttrs = root.attributes as Record<string, unknown>;
  assert.equal(rootAttrs["langfuse.trace.name"], "diagnose-turn");
  assert.equal(rootAttrs["session.id"], "inv-1");
  const genAttrs = gen.attributes as Record<string, unknown>;
  assert.equal(genAttrs["langfuse.observation.type"], "generation");
  assert.equal(genAttrs["langfuse.observation.model.name"], "deepseek-v4-flash");
  // helper 把 usage_details 序列化为 JSON 字符串（Langfuse OTel 约定）
  const usage = JSON.parse(genAttrs["langfuse.observation.usage_details"] as string) as Record<string, number>;
  assert.equal(usage.input, 10);
  assert.equal(usage.output, 5);
});

test("tool span：名称为工具名，type=tool；身份不匹配的事件被忽略", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  recorder.record(
    {
      schemaVersion: 1,
      eventId: "t0",
      seq: 1,
      timestamp: new Date().toISOString(),
      kind: "tool_start",
      logicalObservationId: "tool-1",
      parentLogicalId: scopeId("k"),
      tool: "query_logs",
      toolCallId: "call-1",
    },
    IDENTITY,
  );
  recorder.record(
    {
      schemaVersion: 1,
      eventId: "t1",
      seq: 2,
      timestamp: new Date().toISOString(),
      kind: "tool_end",
      logicalObservationId: "tool-1",
      parentLogicalId: scopeId("k"),
      tool: "query_logs",
      toolCallId: "call-1",
      status: "ok",
      durationMs: 5,
    },
    IDENTITY,
  );
  // 陌生身份的事件必须被忽略（Runner 身份不可信由 Host 侧过滤兜底）
  recorder.record(modelStart("gen-x"), { ...IDENTITY, attemptId: "att-rogue" });
  recorder.endAttempt(IDENTITY, { status: "ok", kind: "report", summary: "ok" });
  const tool = ended.find((s) => s.name === "query_logs")!;
  assert.equal(tool.attributes["langfuse.observation.type"], "tool");
  assert.equal(ended.find((s) => s.name === "model-request"), undefined, "陌生身份不产生 span");
});

test("report-validation：兄弟节点挂在 trace 根下；endAttempt 幂等", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  recorder.recordReportValidation(IDENTITY, {
    draft: { summary: "d" },
    report: { corrections: ["c1"], summary: "r", completeness: "complete", scope: { services: [], repos: [] }, confirmedFacts: [], hypotheses: [], uncertainties: [], nextSteps: [], missingMaterial: [], executionLimits: [] },
    startedAt: Date.now() - 10,
  });
  recorder.endAttempt(IDENTITY, { status: "ok", kind: "report" });
  recorder.endAttempt(IDENTITY, { status: "error", kind: "again" });
  const validation = ended.find((s) => s.name === "report-validation")!;
  const root = ended.find((s) => s.name === "diagnose-turn")!;
  assert.equal(validation.parentSpanContext?.spanId, root.spanContext().spanId, "report-validation 是 trace 根的直接子节点");
  assert.equal(ended.length, 3, "幂等 endAttempt 不产生额外 span");
});

function auditPhaseStart(id: string, round: number): ObservationEvent {
  return {
    schemaVersion: 1,
    eventId: `aps-${id}`,
    seq: 1,
    timestamp: new Date().toISOString(),
    kind: "phase_start",
    phase: "audit",
    logicalObservationId: id,
    metadata: { round, policyVersion: "1.0.0" },
  };
}
function auditPhaseEnd(id: string, status: "ok" | "error" = "ok"): ObservationEvent {
  return {
    schemaVersion: 1,
    eventId: `ape-${id}`,
    seq: 2,
    timestamp: new Date().toISOString(),
    kind: "phase_end",
    phase: "audit",
    logicalObservationId: id,
    status,
  };
}
const modelStartUnder = (id: string, parent: string): ObservationEvent => ({ ...modelStart(id), parentLogicalId: parent });
const modelEndUnder = (id: string, parent: string): ObservationEvent => ({ ...modelEnd(id), parentLogicalId: parent });

test("独立审计：audit agent 挂在 trace 根下，审计 generation 挂 audit 下（与诊断分离）", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  recorder.record(auditPhaseStart("audit-scope-1", 0), IDENTITY);
  recorder.record(modelStartUnder("agen-1", "audit-scope-1"), IDENTITY);
  recorder.record(modelEndUnder("agen-1", "audit-scope-1"), IDENTITY);
  recorder.record(auditPhaseEnd("audit-scope-1"), IDENTITY);
  recorder.endAttempt(IDENTITY, { status: "ok", kind: "report" });

  const root = ended.find((s) => s.name === "diagnose-turn")!;
  const audit = ended.find((s) => s.name === "audit#1")!;
  const gen = ended.find((s) => s.name === "model-request")!;
  assert.ok(audit, "应创建 audit#1 agent");
  assert.equal(audit.attributes["langfuse.observation.type"], "agent");
  assert.equal(audit.parentSpanContext?.spanId, root.spanContext().spanId, "audit 是 trace 根的直接子节点");
  assert.equal(gen.parentSpanContext?.spanId, audit.spanContext().spanId, "审计 generation 挂在 audit 下，而非诊断 agent");
});

test("独立审计：补证两轮 → audit#1/audit#2 两个兄弟节点", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  for (const [round, id] of [[0, "a1"], [1, "a2"]] as const) {
    recorder.record(auditPhaseStart(id, round), IDENTITY);
    recorder.record(auditPhaseEnd(id), IDENTITY);
  }
  recorder.endAttempt(IDENTITY, { status: "ok", kind: "report" });
  assert.ok(ended.find((s) => s.name === "audit#1"));
  assert.ok(ended.find((s) => s.name === "audit#2"));
});

test("recordAuditApplication：audit-apply span 挂在 trace 根下", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  recorder.recordAuditApplication(IDENTITY, {
    policyVersion: "1.0.0",
    audit: { claimVerdicts: [], missingEvidence: [], stopAdvice: { action: "stop", reason: "x" } },
    report: {
      corrections: ["审计：降级"],
      summary: "r",
      completeness: "partial",
      scope: { services: [], repos: [] },
      confirmedFacts: [],
      hypotheses: [],
      uncertainties: [],
      nextSteps: [],
      missingMaterial: [],
      executionLimits: [],
    },
    startedAt: Date.now() - 5,
  });
  recorder.endAttempt(IDENTITY, { status: "ok", kind: "report" });
  const apply = ended.find((s) => s.name === "audit-apply")!;
  const root = ended.find((s) => s.name === "diagnose-turn")!;
  assert.equal(apply.parentSpanContext?.spanId, root.spanContext().spanId);
});

test("attempt 异常路径：残留子观测收敛为 ERROR，root status=ERROR", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  recorder.record(modelStart("gen-2"), IDENTITY);
  recorder.endAttempt(IDENTITY, { status: "error", kind: "engine_error", error: "boom" });
  const gen = ended.find((s) => s.name === "model-request")!;
  const root = ended.find((s) => s.name === "diagnose-turn")!;
  assert.equal(gen.status.code, 2, "SpanStatusCode.ERROR");
  assert.equal(root.status.code, 2);
  const rootAttrs = root.attributes as Record<string, unknown>;
  assert.ok((rootAttrs["langfuse.trace.output"] as string).includes("boom"));
});
