// 中立观测事件与 Sink 接口（观测方案 §3/§6）。
//
// 约束：
//   * 事件必须是可 JSON 序列化的普通对象：进程执行模式下经 Runner stdout NDJSON 传给 Host。
//   * 业务身份（investigation/run/attempt/generation）不进事件正文：Host 从实际派发任务注入，
//     不信任 Runner 自报身份。事件只携带观测结构，并经 scopeId 关联到本次 attempt 范围。
//   * ObservationSink.record 绝不向业务抛错：采集是 best-effort，失败允许丢弃，业务会话不受影响。
//   * 不逐 token 建观测：每次模型调用一个 generation，每次工具调用一个 tool。
import { randomUUID } from "node:crypto";

export const OBSERVATION_SCHEMA_VERSION = 1;

export type ObservationStatus = "ok" | "error" | "aborted";

/** 模型请求的业务目的：正常诊断请求 vs pi 内部压缩/总结请求（同一 streamFunction 承载）。 */
export type ModelCallPurpose = "diagnosis" | "compaction";

/**
 * 采集证据层级（观测方案 §5.1）：
 *   * effective_context —— 包装点看到的真正有效模型上下文（总有）；
 *   * provider_payload  —— 原 SDK onPayload 回调给出的实际请求 body（provider 触发时才有）。
 * 若 provider 不触发 onPayload，明确只有 effective_context，不编造 payload。
 */
export type ObservationCaptureLevel = "effective_context" | "provider_payload";

/** 截断后的文本：按 UTF-8 字节计预算（不用 JS 字符串长度），附截断标记与原始字节数。 */
export interface ObservationText {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

/** usage 只在来源可靠时携带；error/aborted 或零初始化值不得伪造成真实消费。 */
export interface ObservationUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

interface ObservationBase {
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  eventId: string;
  /** 同一 emitter 内单调递增；Host 用于 FIFO 完整性校验。 */
  seq: number;
  /** ISO8601。 */
  timestamp: string;
  logicalObservationId: string;
  parentLogicalId?: string;
}

export type ObservationEvent =
  | (ObservationBase & {
      kind: "phase_start";
      /** attempt=诊断（主会话）；audit=独立审计会话（OQ-30，每轮一个）。 */
      phase: "attempt" | "audit";
      input?: ObservationText;
      metadata?: Record<string, unknown>;
    })
  | (ObservationBase & {
      kind: "phase_end";
      phase: "attempt" | "audit";
      status: ObservationStatus;
      output?: ObservationText;
      error?: string;
      metadata?: Record<string, unknown>;
    })
  | (ObservationBase & {
      kind: "model_start";
      model: string;
      provider?: string;
      callPurpose: ModelCallPurpose;
      captureLevel: ObservationCaptureLevel;
      input?: ObservationText;
      metadata?: Record<string, unknown>;
    })
  | (ObservationBase & {
      kind: "model_end";
      status: ObservationStatus;
      output?: ObservationText;
      stopReason?: string;
      errorMessage?: string;
      usage?: ObservationUsage;
      metadata?: Record<string, unknown>;
    })
  | (ObservationBase & {
      kind: "tool_start";
      tool: string;
      toolCallId: string;
      input?: ObservationText;
      metadata?: Record<string, unknown>;
    })
  | (ObservationBase & {
      kind: "tool_end";
      tool: string;
      toolCallId: string;
      status: ObservationStatus;
      output?: ObservationText;
      outputChars?: number;
      error?: string;
      durationMs: number;
      metadata?: Record<string, unknown>;
    });

export interface ObservationSink {
  record(event: ObservationEvent): void;
}

/** 事件公共信封：schemaVersion/eventId/seq/timestamp 由构造器统一填充。 */
export interface ObservationEnvelope {
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  eventId: string;
  seq: number;
  timestamp: string;
}

/** 统一事件信封构造：保证版本号与序列号的一致性，避免各产生点漂移。 */
export function envelope(seq: number): ObservationEnvelope {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    eventId: randomUUID(),
    seq,
    timestamp: new Date().toISOString(),
  };
}

/** 引擎一次运行（= 一次 attempt）的观测范围：scopeId 由调用方（Host/Runner）生成。 */
export interface AttemptObservationScope {
  scopeId: string;
  sink: ObservationSink;
}

/** 可序列化兜底：循环引用等异常对象降级为占位文本，不影响采集。 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return '"[unserializable]"';
  }
}

/** 按 UTF-8 字节预算取最大前缀（二分，避免代理对被切断后产生无效字符）。 */
function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/** 采集快照：超预算按字节截断，保留原始字节数；不改变业务实际收发的内容。 */
export function observeText(value: unknown, maxBytes: number): ObservationText {
  const text = typeof value === "string" ? value : safeStringify(value);
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes };
  return { text: truncateToBytes(text, maxBytes), truncated: true, originalBytes };
}
