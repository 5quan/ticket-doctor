// Langfuse OTel 适配（观测方案 §6/§8）：Host 侧 SDK 初始化、显式 observation registry、导出与关闭。
//
// 设计约束：
//   * 只用 LangfuseSpanProcessor + BasicTracerProvider 手动建 span：显式指定父子 context，
//     跨 IPC/回调不依赖 AsyncLocalStorage 自动延续（观测方案 §6）；
//   * 不加载 Node 自动埋点（@opentelemetry/auto-instrumentations 等），避免 HTTP/DB 噪声 span；
//   * 未启用/缺配置 → 不创建 exporter、不连云端；启用但缺配置打印不含秘密的错误并降级 noop；
//   * best-effort：采集异常自捕获、告警节流，绝不穿透到业务协议路径；
//   * 关闭有界：shutdown 与 TD_OBSERVABILITY_SHUTDOWN_MS 竞速，不阻塞进程退出。
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { ROOT_CONTEXT, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import {
  createObservationAttributes,
  createTraceAttributes,
  LangfuseOtelSpanAttributes as LF,
  type ObservationLevel,
} from "@langfuse/tracing";
import type { ObservabilityConfig } from "../config/index.ts";
import type { DiagnosisReport } from "../domain/types.ts";
import type { ObservationEvent, ObservationStatus } from "./types.ts";

/** Host 注入的运行身份（Runner 事件不携带身份，映射由 Host 持有）。 */
export interface ObservationRunIdentity {
  investigationId: string;
  runId: string;
  attemptId: string;
  generation: number;
}

export interface AttemptBeginMeta {
  /** 本轮原始用户问题（trace 根 input）。 */
  question: string;
  service?: string;
  environment?: string;
  engine: string;
}

export interface AttemptOutcome {
  status: ObservationStatus;
  /** report / reply(chat|clarify) / 终态错误码等稳定结果类型。 */
  kind?: string;
  summary?: string;
  error?: string;
}

const levelOf = (status: ObservationStatus): ObservationLevel =>
  status === "ok" ? "DEFAULT" : "ERROR";

function jsonAttr(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return '"[unserializable]"';
  }
}

interface AttemptRecord {
  root: Span;
  agent: Span;
  /** logicalObservationId → 在飞 span（generation/tool）。 */
  children: Map<string, Span>;
  /** agent 节点是否已由 phase_end 关闭。 */
  agentEnded: boolean;
}

export interface ObservationRecorder {
  /** attempt 开始：建 trace 根与 diagnosis-attempt agent 节点；返回 scopeId（失败返回 undefined）。 */
  beginAttempt(identity: ObservationRunIdentity, meta: AttemptBeginMeta): string | undefined;
  /** 记录 Runner 转发或本进程产生的中立事件；异常自捕获。 */
  record(event: ObservationEvent, identity: ObservationRunIdentity): void;
  /** report-validation span：草稿 → 校验后报告与程序修正。 */
  recordReportValidation(
    identity: ObservationRunIdentity,
    data: { draft: unknown; report: DiagnosisReport; startedAt: number },
  ): void;
  /** attempt 终态：关 agent（若未关）与 trace 根，清理 registry。幂等。 */
  endAttempt(identity: ObservationRunIdentity, outcome: AttemptOutcome): void;
  /** 有界关闭：flush 导出；超过 config.shutdownMs 不阻塞退出。 */
  shutdown(): Promise<void>;
}

const identityKey = (id: ObservationRunIdentity): string =>
  `${id.investigationId}:${id.runId}:${id.attemptId}:${id.generation}`;

export function createLangfuseRecorder(
  config: ObservabilityConfig,
  /** 测试注入：替换 LangfuseSpanProcessor（内存 spy processor 验证 span 结构，不发网络请求）。 */
  processorOverride?: SpanProcessor,
): ObservationRecorder | undefined {
  if (!config.enabled) return undefined;
  const missing = [
    !config.baseUrl && "LANGFUSE_BASE_URL",
    !config.publicKey && "LANGFUSE_PUBLIC_KEY",
    !config.secretKey && "LANGFUSE_SECRET_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(
      `[ticket-doctor] 观测已启用但缺少配置：${missing.join("、")}。降级为不采集（业务不受影响）；请检查运行环境变量。`,
    );
    return undefined;
  }

  const processor = processorOverride ?? new LangfuseSpanProcessor({
    publicKey: config.publicKey!,
    secretKey: config.secretKey!,
    baseUrl: config.baseUrl!,
    environment: config.environment,
    ...(config.release ? { release: config.release } : {}),
    // 默认过滤器只放行 Langfuse 官方 tracer 名的 span，自建 tracer 会被静默丢弃；
    // 本 provider 专用（不加载 Node 自动埋点），无噪声风险，全部放行。
    shouldExportSpan: () => true,
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const tracer = provider.getTracer("ticket-doctor");
  const registry = new Map<string, AttemptRecord>();
  let warnCount = 0;
  const warnThrottled = (message: string, err: unknown): void => {
    if (warnCount >= 3) return;
    warnCount += 1;
    console.warn(`[ticket-doctor] 观测采集异常（已忽略，不影响业务）：${message}`, err instanceof Error ? err.message : err);
  };

  const childCtx = (parent: Span) => trace.setSpan(ROOT_CONTEXT, parent);

  const startObservation = (
    name: string,
    type: "generation" | "tool" | "agent" | "span",
    parent: Span,
    attrs: Record<string, unknown>,
    timestamp?: number,
  ): Span =>
    tracer.startSpan(
      name,
      { attributes: createObservationAttributes(type, attrs), ...(timestamp ? { startTime: timestamp } : {}) },
      childCtx(parent),
    );

  const endWithStatus = (span: Span, status: ObservationStatus, message?: string): void => {
    span.setStatus(
      status === "ok"
        ? { code: SpanStatusCode.OK }
        : { code: SpanStatusCode.ERROR, message: message ?? status },
    );
    span.end();
  };

  return {
    beginAttempt(identity, meta) {
      try {
        const k = identityKey(identity);
        if (registry.has(k)) return undefined;
        const root = tracer.startSpan("diagnose-turn", {
          attributes: {
            ...createTraceAttributes({ input: meta.question }),
            [LF.TRACE_NAME]: "diagnose-turn",
            [LF.TRACE_SESSION_ID]: identity.investigationId,
            [LF.TRACE_METADATA]: jsonAttr({
              runId: identity.runId,
              attemptId: identity.attemptId,
              generation: identity.generation,
              service: meta.service ?? null,
              environment: meta.environment ?? null,
            }),
            [LF.ENVIRONMENT]: config.environment,
            ...(config.release ? { [LF.RELEASE]: config.release } : {}),
          },
        });
        const agent = startObservation("diagnosis-attempt", "agent", root, {
          metadata: { attemptId: identity.attemptId, generation: identity.generation, engine: meta.engine, service: meta.service ?? null },
        });
        registry.set(k, { root, agent, children: new Map(), agentEnded: false });
        return k;
      } catch (err) {
        warnThrottled("beginAttempt", err);
        return undefined;
      }
    },

    record(event, identity) {
      try {
        const rec = registry.get(identityKey(identity));
        if (!rec) return;
        switch (event.kind) {
          case "phase_start": {
            if (event.logicalObservationId !== identityKey(identity)) return;
            rec.agent.setAttributes(
              createObservationAttributes("agent", {
                input: event.input ?? null,
                metadata: event.metadata,
              }),
            );
            return;
          }
          case "phase_end": {
            if (event.logicalObservationId !== identityKey(identity)) return;
            rec.agent.setAttributes(
              createObservationAttributes("agent", {
                output: event.output ?? null,
                metadata: event.metadata,
                level: levelOf(event.status),
                ...(event.error ? { statusMessage: event.error } : {}),
              }),
            );
            endWithStatus(rec.agent, event.status, event.error);
            rec.agentEnded = true;
            return;
          }
          case "model_start": {
            if (event.parentLogicalId !== identityKey(identity)) return;
            const span = startObservation(
              "model-request",
              "generation",
              rec.agent,
              {
                input: event.input ?? null,
                model: event.model,
                modelParameters: {},
                metadata: {
                  callPurpose: event.callPurpose,
                  captureLevel: event.captureLevel,
                  provider: event.provider ?? null,
                  ...(event.metadata ?? {}),
                },
                // 不设 completionStartTime（OQ-42）：拿不到真正的“首个输出到达时刻”，
                // 用请求开始时刻填充会让界面 TTFT ≈ 0 且不可信；按“宁缺毋假”省略该指标。
                // 方案 A（订阅 session 的 message_update，取首个 text/thinking delta）见 OQ-42，未实施。
                // generation 的总时延 / usage / 输出内容不受影响，均为可靠值。
              },
              Date.parse(event.timestamp),
            );
            rec.children.set(event.logicalObservationId, span);
            return;
          }
          case "model_end": {
            const span = rec.children.get(event.logicalObservationId);
            if (!span) return;
            rec.children.delete(event.logicalObservationId);
            span.setAttributes(
              createObservationAttributes("generation", {
                output: event.output ?? null,
                metadata: {
                  stopReason: event.stopReason ?? null,
                  errorMessage: event.errorMessage ?? null,
                  usageAvailable: event.usage !== undefined,
                  ...(event.metadata ?? {}),
                },
                ...(event.usage
                  ? {
                      usageDetails: {
                        input: event.usage.inputTokens,
                        output: event.usage.outputTokens,
                        cache_read: event.usage.cacheReadTokens,
                        cache_write: event.usage.cacheWriteTokens,
                        total: event.usage.totalTokens,
                      },
                    }
                  : {}),
                level: levelOf(event.status),
                ...(event.errorMessage ? { statusMessage: event.errorMessage } : {}),
              }),
            );
            endWithStatus(span, event.status, event.errorMessage);
            return;
          }
          case "tool_start": {
            if (event.parentLogicalId !== identityKey(identity)) return;
            const span = startObservation(
              event.tool,
              "tool",
              rec.agent,
              { input: event.input ?? null, metadata: { toolCallId: event.toolCallId, ...(event.metadata ?? {}) } },
              Date.parse(event.timestamp),
            );
            rec.children.set(event.logicalObservationId, span);
            return;
          }
          case "tool_end": {
            const span = rec.children.get(event.logicalObservationId);
            if (!span) return;
            rec.children.delete(event.logicalObservationId);
            span.setAttributes(
              createObservationAttributes("tool", {
                output: event.output ?? null,
                metadata: {
                  toolCallId: event.toolCallId,
                  outputChars: event.outputChars ?? null,
                  durationMs: event.durationMs,
                  ...(event.metadata ?? {}),
                },
                level: levelOf(event.status),
                ...(event.error ? { statusMessage: event.error } : {}),
              }),
            );
            endWithStatus(span, event.status, event.error);
            return;
          }
        }
      } catch (err) {
        warnThrottled(`record(${event.kind})`, err);
      }
    },

    recordReportValidation(identity, data) {
      try {
        const rec = registry.get(identityKey(identity));
        if (!rec) return;
        const span = startObservation(
          "report-validation",
          "span",
          rec.root,
          {
            input: data.draft ?? null,
            output: { issues: data.report.corrections, report: data.report },
            metadata: { durationMs: Date.now() - data.startedAt },
          },
          data.startedAt,
        );
        span.end();
      } catch (err) {
        warnThrottled("recordReportValidation", err);
      }
    },

    endAttempt(identity, outcome) {
      try {
        const k = identityKey(identity);
        const rec = registry.get(k);
        if (!rec) return;
        registry.delete(k);
        // 异常路径残留的在飞子观测：以 ERROR 收敛，不留悬挂节点。
        for (const span of rec.children.values()) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: "attempt_terminal" });
          span.end();
        }
        rec.children.clear();
        // agent 兜底关闭：正常路径 phase_end 已关；异常/提前终态路径在这里收敛。
        if (!rec.agentEnded) {
          rec.agent.setAttributes(
            createObservationAttributes("agent", {
              level: levelOf(outcome.status),
              ...(outcome.error ? { statusMessage: outcome.error } : {}),
            }),
          );
          rec.agent.setStatus(
            outcome.status === "ok"
              ? { code: SpanStatusCode.OK }
              : { code: SpanStatusCode.ERROR, message: outcome.error ?? outcome.status },
          );
          rec.agent.end();
          rec.agentEnded = true;
        }
        rec.root.setAttributes(createTraceAttributes({ output: outcome }));
        rec.root.setStatus(
          outcome.status === "ok"
            ? { code: SpanStatusCode.OK }
            : { code: SpanStatusCode.ERROR, message: outcome.error ?? outcome.status },
        );
        rec.root.end();
      } catch (err) {
        warnThrottled("endAttempt", err);
      }
    },

    async shutdown() {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, config.shutdownMs));
      await Promise.race([
        provider
          .forceFlush()
          .then(() => provider.shutdown())
          .catch((err: unknown) => warnThrottled("shutdown", err)),
        timeout,
      ]);
    },
  };
}
