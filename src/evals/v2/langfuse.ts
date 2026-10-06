// 评测 → Langfuse 推送（方案 A，OQ-30 评测线，独立于生产观测）。
//
// Langfuse v4（本机 4.50.0，LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only）：
//   * trace/observation 必须走 OTLP → 复用依赖 `@langfuse/otel` 的 LangfuseSpanProcessor；
//   * `/api/public/ingestion` 在 events_only 下**只接受 score 事件** → 分数用 score-create 推送；
//   * traceId 由 OTel 生成，推送时从 span 取，分数以它关联。
//
// 权威源：本推送只写“程序分/观测”；人工裁决以 Langfuse 为准，本地不停覆盖。
import { randomUUID } from "node:crypto";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { createTraceAttributes, LangfuseOtelSpanAttributes as LF } from "@langfuse/tracing";

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

export interface EvalLangfuse {
  pushTrial(trial: TrialPush): Promise<string | undefined>;
  shutdown(): Promise<void>;
}

function jsonAttr(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return '"[unserializable]"';
  }
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
    async shutdown(): Promise<void> {
      await provider.forceFlush().catch(() => {});
      await provider.shutdown().catch(() => {});
    },
  };
}
