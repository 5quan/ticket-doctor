// 评测 → Langfuse 推送（方案 A，OQ-30 评测线，独立于生产观测）。
//
// Langfuse v4（本机 4.50.0，LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only）：
//   * trace/observation 必须走 OTLP → 复用依赖 `@langfuse/otel` 的 LangfuseSpanProcessor；
//   * `/api/public/ingestion` 在 events_only 下**只接受 score 事件** → 分数用 score-create 推送；
//   * traceId 确定性派生（experiment.ts）：OTLP span 以 NonRecordingSpan 父上下文承载该
//     traceId，重复同步得到同一 trace（B2 幂等）；分数以它关联，score id 同样确定性。
//
// 权威源：本推送只写“程序分/观测”；人工裁决以 Langfuse 为准，本地快照只读。
import { createHash, randomUUID } from "node:crypto";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api";
import { createTraceAttributes, LangfuseOtelSpanAttributes as LF } from "@langfuse/tracing";
import type { TrialExperimentPayload } from "./experiment.ts";

export interface EvalLangfuseConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  environment?: string;
  release?: string;
}

export interface TrialMetric {
  name: string;
  value: number | boolean;
  comment?: string;
}

export interface TrialPush {
  suite: string;
  caseId: string;
  trialId: string;
  engine: string;
  scorerVersion: string;
  input?: string;
  output?: string;
  metadata?: Record<string, unknown>;
  metrics: TrialMetric[];
}

/**
 * v4 实验关联（events_only）：dataset-run-items 换取确定性 experimentId 后，
 * OTel span 携带 `langfuse.experiment.*` 属性完成 trace↔实验↔dataset item 关联
 * （服务端 OtelIngestionProcessor.extractExperimentFields 消费这些键）。
 */
export interface ExperimentLink {
  experimentId: string;
  experimentName: string;
  datasetId: string;
  datasetItemId: string;
}

export interface EvalLangfuse {
  pushTrial(trial: TrialPush): Promise<string | undefined>;
  /** B1：推送一个 trial 的完整实验载荷（逐轮子观测 + 全量分数）；返回确定性 traceId。 */
  pushExperimentTrial(payload: TrialExperimentPayload, link?: ExperimentLink): Promise<string>;
  shutdown(): Promise<void>;
}

function jsonAttr(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return '"[unserializable]"';
  }
}

/** 确定性 score id（8-4-4-4-12）：同 (traceId, name) 重复同步幂等（B2）。 */
export function deterministicScoreId(traceId: string, name: string): string {
  const h = createHash("sha256").update(`score\u0000${traceId}\u0000${name}`).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function createEvalLangfuse(config: EvalLangfuseConfig | undefined): EvalLangfuse | undefined {
  if (!config) return undefined;
  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.environment ?? "eval",
    ...(config.release ? { release: config.release } : {}),
    shouldExportSpan: () => true,
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const tracer = provider.getTracer("ticket-doctor-eval");
  const base = config.baseUrl.replace(/\/$/, "");
  const auth = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;

  return {
    async pushTrial(trial: TrialPush): Promise<string | undefined> {
      const span = tracer.startSpan(`eval/${trial.caseId}`, {
        attributes: {
          ...createTraceAttributes({ input: trial.input ?? null, output: trial.output ?? null }),
          [LF.TRACE_NAME]: `eval/${trial.caseId}`,
          [LF.TRACE_SESSION_ID]: trial.suite,
          [LF.TRACE_METADATA]: jsonAttr({
            suite: trial.suite,
            caseId: trial.caseId,
            trialId: trial.trialId,
            engine: trial.engine,
            scorerVersion: trial.scorerVersion,
            ...(trial.metadata ?? {}),
          }),
        },
      });
      const traceId = span.spanContext().traceId;
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      await provider.forceFlush();

      const now = new Date().toISOString();
      const batch = trial.metrics.map((m) => ({
        id: randomUUID(),
        type: "score-create" as const,
        timestamp: now,
        body: {
          traceId,
          name: m.name,
          value: typeof m.value === "boolean" ? (m.value ? 1 : 0) : m.value,
          dataType: typeof m.value === "boolean" ? "BOOLEAN" : "NUMERIC",
          ...(m.comment ? { comment: m.comment } : {}),
        },
      }));
      if (batch.length > 0) {
        const res = await fetch(`${base}/api/public/ingestion`, {
          method: "POST",
          headers: { authorization: auth, "content-type": "application/json" },
          body: JSON.stringify({ batch }),
        });
        if (!res.ok && res.status !== 207) {
          throw new Error(`Langfuse ingestion 失败：HTTP ${res.status}`);
        }
        const body = (await res.json()) as { errors?: Array<{ message?: string }> };
        if (body.errors && body.errors.length > 0) {
          throw new Error(`Langfuse 分数推送部分失败：${body.errors.map((e) => e.message).join("; ")}`);
        }
      }
      return traceId;
    },

    // B1：完整实验载荷上报。根 span = trial（确定性 traceId），每个用户轮一个子 span，
    // 携带正式报告全文/回写/工具返回/审计过程（保留原始时间）；分数走 ingestion（确定性 id）。
    // link 存在时（v4 events_only）根 span 额外携带 langfuse.experiment.* 完成实验关联。
    async pushExperimentTrial(payload: TrialExperimentPayload, link?: ExperimentLink): Promise<string> {
      // 以 non-recording 父上下文承载确定性 traceId：真实子 span 继承该 traceId（B2 幂等）。
      const parentCtx = trace.wrapSpanContext({
        traceId: payload.traceId,
        spanId: payload.traceId.slice(0, 16),
        traceFlags: TraceFlags.SAMPLED,
      });
      const ctx = trace.setSpan(ROOT_CONTEXT, parentCtx);

      const span = tracer.startSpan(
        payload.name,
        {
          attributes: {
            ...createTraceAttributes({ input: payload.input ?? null, output: payload.output ?? null }),
            [LF.TRACE_NAME]: payload.name,
            [LF.TRACE_SESSION_ID]: payload.sessionId,
            [LF.TRACE_METADATA]: jsonAttr({
              experimentId: payload.experimentId,
              ...payload.metadata,
            }),
            ...(link
              ? {
                  "langfuse.experiment.id": link.experimentId,
                  "langfuse.experiment.name": link.experimentName,
                  "langfuse.experiment.dataset.id": link.datasetId,
                  "langfuse.experiment.item.id": link.datasetItemId,
                  // 服务端要求 experiment_item_root_span_id = span_id 才认实验 item 根
                  //（repository.ts whereRaw），缺省不回填 → 必须显式携带自身 spanId。
                  "langfuse.experiment.item.root_observation_id": "",
                }
              : {}),
          },
        },
        ctx,
      );
      if (link) {
        span.setAttribute("langfuse.experiment.item.root_observation_id", span.spanContext().spanId);
      }
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();

      for (const round of payload.rounds) {
        const roundSpan = tracer.startSpan(
          `round/${round.roundId}`,
          {
            attributes: {
              ...createTraceAttributes({
                input: null,
                output: jsonAttr({
                  outcome: round.outcome,
                  status: round.status,
                  report: round.report,
                  writebackText: round.writebackText,
                  rawDraftSummary: round.rawDraftSummary,
                  replyText: round.replyText,
                  corrections: round.corrections,
                }),
              }),
              [LF.TRACE_METADATA]: jsonAttr({
                roundId: round.roundId,
                runId: round.runId,
                toolCalls: round.toolCalls,
                auditEvents: round.auditEvents,
                metrics: round.metrics,
              }),
              "eval.round.outcome": round.outcome,
              "eval.round.run_id": round.runId ?? "",
            },
          },
          ctx,
        );
        roundSpan.setStatus({ code: SpanStatusCode.OK });
        roundSpan.end();
      }
      await provider.forceFlush();

      // 分数（ingestion）：确定性 id → 平台侧按 id 幂等，重复同步不产生重复分数。
      const now = new Date().toISOString();
      const batch = payload.scores.map((m) => ({
        id: deterministicScoreId(payload.traceId, m.name),
        type: "score-create" as const,
        timestamp: now,
        body: {
          traceId: payload.traceId,
          name: m.name,
          value: typeof m.value === "boolean" ? (m.value ? 1 : 0) : m.value,
          dataType: typeof m.value === "boolean" ? "BOOLEAN" : "NUMERIC",
          ...(m.comment ? { comment: m.comment } : {}),
        },
      }));
      if (batch.length > 0) {
        const res = await fetch(`${base}/api/public/ingestion`, {
          method: "POST",
          headers: { authorization: auth, "content-type": "application/json" },
          body: JSON.stringify({ batch }),
        });
        if (!res.ok && res.status !== 207) {
          throw new Error(`Langfuse ingestion 失败：HTTP ${res.status}`);
        }
        const body = (await res.json()) as { errors?: Array<{ message?: string }> };
        if (body.errors && body.errors.length > 0) {
          throw new Error(`Langfuse 分数推送部分失败：${body.errors.map((e) => e.message).join("; ")}`);
        }
      }
      return payload.traceId;
    },

    async shutdown(): Promise<void> {
      await provider.forceFlush().catch(() => {});
      await provider.shutdown().catch(() => {});
    },
  };
}
