// Langfuse 观测记录器（langfuse.ts）单元测试：用内存 spy SpanProcessor 验证 span 树结构与属性，
// 不发任何网络请求（观测方案 §11：导出器只把目标 observation 发给 Langfuse；这里验证结构与门控）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { context, trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { getPropagatedAttributesFromContext, propagateAttributes } from "@langfuse/core";
import { BasicTracerProvider, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { getLangfuseTracerProvider, setLangfuseTracerProvider, startObservation } from "@langfuse/tracing";
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
function spyProcessor(propagateContextAttributes = false) {
  const ended: ReadableSpan[] = [];
  let flushes = 0;
  let shutdowns = 0;
  const processor: SpanProcessor = {
    onStart(span: Span, parentContext) {
      // 5.13.1 由 LangfuseSpanProcessor.onStart 应用传播属性；仅实验用 spy 模拟这部分。
      if (propagateContextAttributes) span.setAttributes(getPropagatedAttributesFromContext(parentContext));
    },
    onEnd(span: ReadableSpan) {
      ended.push(span);
    },
    forceFlush: async () => { flushes++; },
    shutdown: async () => { shutdowns++; },
  };
  return { processor, ended, get flushes() { return flushes; }, get shutdowns() { return shutdowns; } };
}

const scopeId = (key: string) => `${IDENTITY.investigationId}:${IDENTITY.runId}:${IDENTITY.attemptId}:${IDENTITY.generation}`;

function modelStart(id: string): Extract<ObservationEvent, { kind: "model_start" }> {
  return {
    schemaVersion: 1,
    eventId: `model-start-${id}`,
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

function modelEnd(id: string): Extract<ObservationEvent, { kind: "model_end" }> {
  return {
    schemaVersion: 1,
    eventId: `model-end-${id}`,
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

function auditPhaseStart(id: string, round: number): Extract<ObservationEvent, { kind: "phase_start" }> {
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
function auditPhaseEnd(id: string, status: "ok" | "error" = "ok"): Extract<ObservationEvent, { kind: "phase_end" }> {
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
const modelStartUnder = (id: string, parent: string) => ({ ...modelStart(id), parentLogicalId: parent });
const modelEndUnder = (id: string, parent: string) => ({ ...modelEnd(id), parentLogicalId: parent });

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
  assert.ok((rootAttrs["langfuse.observation.output"] as string).includes("boom"));
  assert.equal(gen.attributes["langfuse.observation.level"], "ERROR");
  assert.equal(root.attributes["langfuse.observation.level"], "ERROR");
});

function modelStartPurpose(id: string, callPurpose: "diagnosis" | "compaction"): Extract<ObservationEvent, { kind: "model_start" }> {
  return {
    schemaVersion: 1,
    eventId: `ev-${id}`,
    seq: 1,
    timestamp: new Date().toISOString(),
    kind: "model_start",
    logicalObservationId: id,
    parentLogicalId: scopeId("k"),
    model: "deepseek-v4-flash",
    provider: "deepseek",
    callPurpose,
    captureLevel: "effective_context",
    input: { text: `purpose=${callPurpose}`, truncated: false, originalBytes: 20 },
  };
}

test("诊断 generation 关联原生 prompt；压缩/审计 generation 不关联", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor, { prompt: { name: "ticket-doctor-diagnosis", version: 2 } })!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  // 主诊断 generation（parent=attempt scopeId）应带 prompt 关联
  recorder.record(modelStartPurpose("gen-diag", "diagnosis"), IDENTITY);
  recorder.record(modelEnd("gen-diag"), IDENTITY);
  // 压缩调用（callPurpose=compaction）不得关联诊断提示词
  recorder.record(modelStartPurpose("gen-compact", "compaction"), IDENTITY);
  recorder.record(modelEnd("gen-compact"), IDENTITY);
  recorder.record(auditPhaseStart("audit-prompt", 0), IDENTITY);
  recorder.record({ ...modelStartPurpose("gen-audit", "diagnosis"), parentLogicalId: "audit-prompt" }, IDENTITY);
  recorder.record(modelEndUnder("gen-audit", "audit-prompt"), IDENTITY);
  recorder.record(auditPhaseEnd("audit-prompt"), IDENTITY);
  recorder.endAttempt(IDENTITY, { status: "ok", kind: "report" });
  const gens = ended.filter((s) => s.name === "model-request");
  assert.equal(gens.length, 3);
  const audit = ended.find((s) => s.name === "audit#1")!;
  for (const gen of gens) {
    const attrs = gen.attributes as Record<string, unknown>;
    const isAudit = gen.parentSpanContext?.spanId === audit.spanContext().spanId;
    const isDiag = !isAudit && String(gen.attributes["langfuse.observation.input"] ?? "").includes("diagnosis");
    if (isDiag) {
      assert.equal(attrs["langfuse.observation.prompt.name"], "ticket-doctor-diagnosis");
      assert.equal(attrs["langfuse.observation.prompt.version"], 2);
    } else {
      assert.equal(attrs["langfuse.observation.prompt.name"], undefined, "压缩及审计调用不得关联诊断提示词");
      assert.equal(attrs["langfuse.observation.prompt.version"], undefined);
    }
  }
});

function toolStart(id: string, parent = scopeId("k")): Extract<ObservationEvent, { kind: "tool_start" }> {
  return {
    schemaVersion: 1, eventId: `tool-start-${id}`, seq: 3,
    timestamp: new Date().toISOString(), kind: "tool_start",
    logicalObservationId: id, parentLogicalId: parent,
    tool: "query_logs", toolCallId: `call-${id}`,
    input: { text: "service=orders", truncated: false, originalBytes: 14 },
  };
}

function toolEnd(id: string, parent = scopeId("k")): Extract<ObservationEvent, { kind: "tool_end" }> {
  return {
    schemaVersion: 1, eventId: `tool-end-${id}`, seq: 4,
    timestamp: new Date().toISOString(), kind: "tool_end",
    logicalObservationId: id, parentLogicalId: parent,
    tool: "query_logs", toolCallId: `call-${id}`, status: "ok", durationMs: 25,
    output: { text: "matching log", truncated: false, originalBytes: 12 },
  };
}

function hrTimeMs(value: [number, number]): number {
  return value[0] * 1_000 + value[1] / 1_000_000;
}

test("generation 和 tool 是 diagnosis agent 下同一 trace 的兄弟，保留事件时间和内容", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  const start = "2026-10-09T01:00:00.125Z";
  const finish = "2026-10-09T01:00:00.875Z";
  recorder.record({ ...modelStart("timed-gen"), timestamp: start, metadata: { requestId: "req-1" } }, IDENTITY);
  recorder.record({ ...toolStart("timed-tool"), timestamp: start }, IDENTITY);
  recorder.record({ ...modelEnd("timed-gen"), timestamp: finish, output: { text: "diagnosis", truncated: false, originalBytes: 9 } }, IDENTITY);
  recorder.record({ ...toolEnd("timed-tool"), timestamp: finish }, IDENTITY);
  recorder.endAttempt(IDENTITY, { status: "ok", kind: "report" });
  const agent = ended.find((s) => s.name === "diagnosis-attempt")!;
  const gen = ended.find((s) => s.name === "model-request")!;
  const tool = ended.find((s) => s.name === "query_logs")!;
  for (const child of [gen, tool]) {
    assert.equal(child.parentSpanContext?.spanId, agent.spanContext().spanId);
    assert.equal(child.spanContext().traceId, agent.spanContext().traceId);
    assert.equal(hrTimeMs(child.startTime), Date.parse(start));
    assert.equal(hrTimeMs(child.endTime), Date.parse(finish));
  }
  assert.equal(gen.attributes["langfuse.observation.type"], "generation");
  assert.equal(tool.attributes["langfuse.observation.type"], "tool");
  assert.match(String(gen.attributes["langfuse.observation.input"]), /\{\}/);
  assert.match(String(gen.attributes["langfuse.observation.output"]), /diagnosis/);
  assert.match(String(tool.attributes["langfuse.observation.output"]), /matching log/);
  assert.equal(gen.attributes["langfuse.observation.metadata.requestId"], "req-1");
});

test("四个业务身份字段分别隔离，共用 logical ID/event ID 不串写或错误结束", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  const identities = [
    IDENTITY,
    { ...IDENTITY, investigationId: "inv-2" },
    { ...IDENTITY, runId: "run-2" },
    { ...IDENTITY, attemptId: "att-2" },
    { ...IDENTITY, generation: 2 },
  ];
  const keys = identities.map((identity) => recorder.beginAttempt(identity, { question: "q", engine: "pi" })!);
  assert.equal(new Set(keys).size, identities.length);
  identities.forEach((identity, index) => {
    recorder.record({ ...modelStart("shared-gen"), parentLogicalId: keys[index], input: { text: `identity-${index}`, truncated: false, originalBytes: 10 } }, identity);
  });
  // 一条陌生身份不能结束现有同名 generation。
  recorder.record(modelEnd("shared-gen"), { ...IDENTITY, generation: 99 });
  assert.equal(ended.length, 0);
  identities.forEach((identity, index) => {
    recorder.record({ ...modelEnd("shared-gen"), parentLogicalId: keys[index] }, identity);
    recorder.endAttempt(identity, { status: "ok", kind: "report", summary: `identity-${index}` });
  });
  const gens = ended.filter((span) => span.name === "model-request");
  assert.equal(gens.length, identities.length);
  assert.equal(new Set(gens.map((span) => span.spanContext().traceId)).size, identities.length);
  for (const gen of gens) {
    const agent = ended.find((span) => span.spanContext().spanId === gen.parentSpanContext?.spanId)!;
    assert.equal(agent.attributes["langfuse.observation.type"], "agent");
    assert.equal(agent.spanContext().traceId, gen.spanContext().traceId);
  }
});

test("重复 model/tool/audit 事件与 phase_end 幂等，已结束 logical ID 不重开", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  const events = [auditPhaseStart("duplicate-audit", 0), modelStart("duplicate-gen"), toolStart("duplicate-tool")];
  for (const event of events) {
    recorder.record(event, IDENTITY);
    recorder.record(event, IDENTITY);
    recorder.record({ ...event, eventId: `${event.eventId}-redelivered` }, IDENTITY);
  }
  for (const event of [modelEnd("duplicate-gen"), toolEnd("duplicate-tool"), auditPhaseEnd("duplicate-audit")]) {
    recorder.record(event, IDENTITY);
    recorder.record(event, IDENTITY);
    recorder.record({ ...event, eventId: `${event.eventId}-redelivered` }, IDENTITY);
  }
  for (const event of events) recorder.record({ ...event, eventId: `${event.eventId}-late-start` }, IDENTITY);
  const phaseEnd: ObservationEvent = {
    ...auditPhaseEnd(scopeId("k")), phase: "attempt", eventId: "attempt-phase-end",
  };
  recorder.record(phaseEnd, IDENTITY);
  recorder.record({ ...phaseEnd, eventId: "attempt-phase-end-again" }, IDENTITY);
  recorder.endAttempt(IDENTITY, { status: "ok", kind: "report" });
  recorder.endAttempt(IDENTITY, { status: "error", kind: "duplicate" });
  assert.equal(ended.length, 5, "root/diagnosis/audit/generation/tool 各结束一次");
  assert.equal(new Set(ended.map((span) => span.spanContext().spanId)).size, ended.length);
  assert.ok(ended.every((span) => span.status.code !== SpanStatusCode.ERROR), "重复事件不得把正常节点变成残留错误");
});

test("end-before-start 及子事件早于 audit 父节点，补齐后保留正确父子和时间", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  const start = "2026-10-09T01:00:00.100Z";
  const finish = "2026-10-09T01:00:00.200Z";
  recorder.record({ ...modelEndUnder("early-gen", "early-audit"), timestamp: finish }, IDENTITY);
  recorder.record({ ...modelStartUnder("early-gen", "early-audit"), timestamp: start }, IDENTITY);
  recorder.record({ ...toolEnd("early-tool"), timestamp: finish }, IDENTITY);
  recorder.record({ ...toolStart("early-tool"), timestamp: start }, IDENTITY);
  recorder.record({ ...auditPhaseEnd("early-audit"), timestamp: finish }, IDENTITY);
  recorder.record({ ...auditPhaseStart("early-audit", 0), timestamp: "2026-10-09T01:00:00.050Z" }, IDENTITY);
  recorder.endAttempt(IDENTITY, { status: "ok", kind: "report" });
  const audit = ended.find((span) => span.name === "audit#1")!;
  const gen = ended.find((span) => span.name === "model-request")!;
  const tool = ended.find((span) => span.name === "query_logs")!;
  assert.equal(gen.parentSpanContext?.spanId, audit.spanContext().spanId);
  assert.equal(hrTimeMs(audit.startTime), Date.parse("2026-10-09T01:00:00.050Z"));
  assert.equal(hrTimeMs(audit.endTime), Date.parse(finish));
  for (const child of [gen, tool]) {
    assert.equal(hrTimeMs(child.startTime), Date.parse(start));
    assert.equal(hrTimeMs(child.endTime), Date.parse(finish));
    assert.equal(child.status.code, SpanStatusCode.OK);
  }
  assert.equal(ended.length, 5);
});

test("结束事件必须匹配节点类型、父引用和 toolCallId，错误事件不提前关闭真实节点", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  recorder.record(modelStart("protected-gen"), IDENTITY);
  recorder.record(toolStart("protected-tool"), IDENTITY);
  recorder.record({ ...modelEnd("protected-gen"), parentLogicalId: "foreign-audit" }, IDENTITY);
  recorder.record(toolEnd("protected-gen"), IDENTITY);
  recorder.record({ ...toolEnd("protected-tool"), toolCallId: "foreign-call" }, IDENTITY);
  assert.equal(ended.length, 0);
  recorder.record({ ...modelEnd("protected-gen"), eventId: "correct-gen-end" }, IDENTITY);
  recorder.record({ ...toolEnd("protected-tool"), eventId: "correct-tool-end" }, IDENTITY);
  recorder.endAttempt(IDENTITY, { status: "ok", kind: "report" });
  assert.equal(ended.length, 4);
  assert.ok(ended.every((span) => span.status.code === SpanStatusCode.OK));
});

test("processor 故障不向业务调用方抛错，后续终态仍可结束其他节点", () => {
  const spy = spyProcessor();
  const processor: SpanProcessor = {
    ...spy.processor,
    onEnd(span) {
      if (span.name === "model-request") throw new Error("simulated exporter failure");
      spy.processor.onEnd(span);
    },
  };
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  recorder.record(modelStart("failed-export-gen"), IDENTITY);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => recorder.record(modelEnd("failed-export-gen"), IDENTITY));
    assert.doesNotThrow(() => recorder.endAttempt(IDENTITY, { status: "ok", kind: "report" }));
  } finally {
    console.warn = warn;
  }
  assert.equal(spy.ended.length, 2, "generation 导出失败不影响 agent/root 的关闭");
});

test("终态清理所有残留 generation/tool/audit 为 ERROR，并拒绝终态后的延迟事件", () => {
  const { processor, ended } = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, processor)!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  recorder.record(auditPhaseStart("unfinished-audit", 0), IDENTITY);
  recorder.record(modelStartUnder("unfinished-gen", "unfinished-audit"), IDENTITY);
  recorder.record(toolStart("unfinished-tool"), IDENTITY);
  recorder.endAttempt(IDENTITY, { status: "aborted", kind: "cancelled", error: "cancelled" });
  for (const name of ["model-request", "query_logs", "audit#1", "diagnosis-attempt", "diagnose-turn"]) {
    const span = ended.find((candidate) => candidate.name === name)!;
    assert.ok(span, name);
    assert.equal(span.status.code, SpanStatusCode.ERROR, name);
    assert.equal(span.attributes["langfuse.observation.level"], "ERROR", name);
    assert.ok(span.attributes["langfuse.observation.status_message"], name);
  }
  recorder.record(modelEndUnder("unfinished-gen", "unfinished-audit"), IDENTITY);
  recorder.record(modelStart("late-gen"), IDENTITY);
  recorder.endAttempt(IDENTITY, { status: "ok", kind: "duplicate" });
  assert.equal(ended.length, 5);
});

test("shutdown 清理残留且幂等；自有 provider 只 flush/shutdown 一次", async () => {
  const spy = spyProcessor();
  const recorder = createLangfuseRecorder(CONFIG, spy.processor)!;
  recorder.beginAttempt(IDENTITY, { question: "q", engine: "pi" });
  recorder.record(auditPhaseStart("shutdown-audit", 0), IDENTITY);
  recorder.record(modelStartUnder("shutdown-gen", "shutdown-audit"), IDENTITY);
  await Promise.all([recorder.shutdown(), recorder.shutdown()]);
  await recorder.shutdown();
  assert.equal(spy.ended.length, 4);
  assert.ok(spy.ended.every((span) => span.status.code === SpanStatusCode.ERROR));
  assert.ok(spy.ended.every((span) => span.attributes["langfuse.observation.level"] === "ERROR"));
  assert.equal(spy.flushes, 1);
  assert.equal(spy.shutdowns, 1);
  assert.equal(recorder.beginAttempt(IDENTITY, { question: "late", engine: "pi" }), undefined);
});

test("多个借用 provider 的 recorder 交错创建不会串写，shutdown 不关闭或 flush 借用资源", async () => {
  const a = spyProcessor();
  const b = spyProcessor();
  const providerA = new BasicTracerProvider({ spanProcessors: [a.processor] });
  const providerB = new BasicTracerProvider({ spanProcessors: [b.processor] });
  const recorderA = createLangfuseRecorder(CONFIG, undefined, { tracerProvider: providerA })!;
  recorderA.beginAttempt(IDENTITY, { question: "provider-A", engine: "pi" });
  const recorderB = createLangfuseRecorder(CONFIG, undefined, { tracerProvider: providerB })!;
  recorderB.beginAttempt(IDENTITY, { question: "provider-B", engine: "pi" });
  recorderA.record(modelStart("provider-a-gen"), IDENTITY);
  recorderB.record(modelStart("provider-b-gen"), IDENTITY);
  recorderA.record(modelEnd("provider-a-gen"), IDENTITY);
  recorderB.record(modelEnd("provider-b-gen"), IDENTITY);
  await recorderA.shutdown();
  recorderB.endAttempt(IDENTITY, { status: "ok", kind: "report" });
  await recorderB.shutdown();
  for (const spy of [a, b]) {
    assert.equal(spy.ended.length, 3);
    assert.equal(spy.flushes, 0);
    assert.equal(spy.shutdowns, 0);
    assert.equal(new Set(spy.ended.map((span) => span.spanContext().traceId)).size, 1);
  }
  assert.notEqual(a.ended[0].spanContext().traceId, b.ended[0].spanContext().traceId);
  const stillUsable = providerA.getTracer("owner").startSpan("owner-after-recorder-shutdown");
  stillUsable.end();
  assert.equal(a.ended.at(-1)?.name, "owner-after-recorder-shutdown");
  await Promise.all([providerA.shutdown(), providerB.shutdown()]);
  assert.equal(a.shutdowns, 1);
  assert.equal(b.shutdowns, 1);
});

test("recorder 恢复 SDK 默认全局回退，后来注册的 provider 仍接收 SDK observation", async () => {
  const previousGlobal = trace.getTracerProvider();
  const previousLangfuse = getLangfuseTracerProvider();
  const own = spyProcessor();
  const external = spyProcessor();
  const externalProvider = new BasicTracerProvider({ spanProcessors: [external.processor] });
  trace.disable();
  setLangfuseTracerProvider(null);
  const recorder = createLangfuseRecorder(CONFIG, own.processor)!;
  try {
    recorder.beginAttempt(IDENTITY, { question: "q", engine: "fake" });
    recorder.endAttempt(IDENTITY, { status: "ok" });
    await recorder.shutdown();
    trace.disable();
    assert.equal(trace.setGlobalTracerProvider(externalProvider), true);
    startObservation("external-after-recorder").end();
    assert.equal(external.ended.length, 1);
    assert.equal(external.ended[0].name, "external-after-recorder");
    assert.equal(getLangfuseTracerProvider(), trace.getTracerProvider());
  } finally {
    await recorder.shutdown();
    trace.disable();
    trace.setGlobalTracerProvider(previousGlobal);
    setLangfuseTracerProvider(previousLangfuse === previousGlobal ? null : previousLangfuse);
    await externalProvider.shutdown();
  }
});

test("评测多轮和脱离 active context 的延迟事件保留实验 trace/传播属性，不覆盖实验根 IO/name", async () => {
  const manager = new AsyncLocalStorageContextManager().enable();
  assert.equal(context.setGlobalContextManager(manager), true);
  const { processor, ended } = spyProcessor(true);
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const recorder = createLangfuseRecorder(CONFIG, undefined, { joinActiveContext: true, tracerProvider: provider })!;
  const rootAttributes = {
    "langfuse.observation.type": "span",
    "langfuse.trace.name": "experiment-item-run",
    "langfuse.observation.input": JSON.stringify({ item: "dataset-input" }),
    "langfuse.observation.output": JSON.stringify({ result: "experiment-output" }),
  };
  const experimentSpan = provider.getTracer("langfuse-sdk").startSpan("experiment-item-run", { attributes: rootAttributes });
  const experimentContext = trace.setSpan(context.active(), experimentSpan);
  const identities = [IDENTITY, { ...IDENTITY, attemptId: "att-follow-up", generation: 2 }];
  try {
    const keys = context.with(experimentContext, () => propagateAttributes({
      traceName: "experiment-item-run", userId: "eval-user", version: "eval-version",
      tags: ["dataset-experiment"], metadata: { datasetItemId: "item-1", experimentId: "exp-1" },
    }, () => identities.map((identity) => recorder.beginAttempt(identity, { question: "business question", engine: "pi" })!)));
    assert.equal(trace.getSpan(context.active()), undefined, "模拟 IPC 延迟事件已离开实验 active context");
    identities.forEach((identity, index) => {
      recorder.record({ ...modelStart(`delayed-gen-${index}`), parentLogicalId: keys[index] }, identity);
      recorder.record({ ...modelEnd(`delayed-gen-${index}`), parentLogicalId: keys[index] }, identity);
      recorder.endAttempt(identity, { status: "ok", kind: "report", summary: `round-${index}` });
    });
    experimentSpan.end();
    const experiment = ended.find((span) => span.name === "experiment-item-run")!;
    assert.equal(experiment.name, "experiment-item-run");
    for (const [key, value] of Object.entries(rootAttributes)) assert.equal(experiment.attributes[key], value);
    const roots = ended.filter((span) => span.name === "diagnose-turn");
    assert.equal(roots.length, 2);
    for (const root of roots) {
      assert.equal(root.parentSpanContext?.spanId, experimentSpan.spanContext().spanId);
      assert.equal(root.attributes["langfuse.trace.input"], undefined);
      assert.equal(root.attributes["langfuse.trace.output"], undefined);
      assert.match(String(root.attributes["langfuse.observation.input"]), /business question/);
    }
    for (const child of ended.filter((span) => span !== experiment)) {
      assert.equal(child.spanContext().traceId, experimentSpan.spanContext().traceId);
      assert.equal(child.attributes["langfuse.trace.name"], "experiment-item-run");
      assert.equal(child.attributes["user.id"], "eval-user");
      assert.equal(child.attributes["langfuse.version"], "eval-version");
      assert.deepEqual(child.attributes["langfuse.trace.tags"], ["dataset-experiment"]);
      assert.equal(child.attributes["langfuse.trace.metadata.datasetItemId"], "item-1");
      assert.equal(child.attributes["langfuse.trace.metadata.experimentId"], "exp-1");
    }
    await recorder.shutdown();
  } finally {
    context.disable();
    manager.disable();
    await provider.shutdown();
  }
});
