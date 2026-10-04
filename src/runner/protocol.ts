// Host ↔ Agent Runner 的结构化进程通信协议（NDJSON over stdio）。
//
// 约定（对齐平台文档 04/05）：
//   * Host 通过 stdin 下发任务（一行 JSON），可后续下发 cancel / evidence_ack / evidence_reject；
//   * Runner 通过 stdout 逐行上报结构化消息，业务结果与运行日志分离（日志走 stderr）；
//   * Runner 不碰数据库：会话条目 / 工具执行 / 证据批次 / 进度 / 结果都由 Host 校验后代为落库；
//   * 协议版本硬校验（D12）：不匹配即拒绝本轮，不做双向协商（Runner 由 Host 同仓库 spawn）。
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolExecutionRecord } from "../agent/types.ts";
import type { DiagnosisConfig, ObservabilityConfig, SourcesConfig } from "../config/index.ts";
import type { EvidenceItem, EvidenceRef } from "../evidence/types.ts";
import type { MaterialScope, ReportDraft } from "../domain/types.ts";
import type { ObservationEvent } from "../observability/types.ts";

/** 证据持久化协议版本（docs/evidence-uid-design.md §6 / D12）。v3：+observation 观测消息与 RunnerTask.observability。 */
export const EVIDENCE_PROTOCOL_VERSION = 3;

export interface RunnerTaskObservability {
  /** Host 侧观测已启用且初始化成功；false 时 Runner 不产生观测事件。 */
  enabled: boolean;
  /** 单事件字节预算，与 Host 保持一致。 */
  maxEventBytes: number;
  /** Host 生成并注册的 scope ID：Runner 的观测事件以它关联到本次 attempt。 */
  scopeId: string;
}

export interface RunnerTask {
  runId: string;
  attemptId: string;
  generation: number;
  investigationId: string;
  /** 本轮原始输入文本（含或不含会话标号均可，Runner 内部剥离）。 */
  text: string;
  receivedAt: number;
  /** 协议版本：与 EVIDENCE_PROTOCOL_VERSION 不一致即拒绝执行。 */
  protocolVersion: number;
  service?: string;
  environment?: string;
  contextSummary?: string;
  /** Host 从 SQLite 读回的历史 pi 条目，供 Runner 重建会话。 */
  priorEntries: SessionEntry[];
  /** 本轮是否已有条目：true 表示 continue（恢复），false 表示 prompt（首次）。 */
  resumed: boolean;
  /** 恢复用（§8/D5）：已提交批次重建的工具结果，按 toolCallId 命中后补记进会话。 */
  savedToolResults?: Array<{ toolCallId: string; toolName: string; text: string; isError: boolean }>;
  engine: "fake" | "pi";
  diagnosis: DiagnosisConfig;
  sources: SourcesConfig;
  /** 观测开关与 scope（v3）：身份由 Host 注入，Runner 不自报。 */
  observability?: RunnerTaskObservability;
}

export type RunnerResult =
  | {
      kind: "report";
      draft: ReportDraft;
      scope: MaterialScope;
      missingMaterial: string[];
      toolCalls: number;
      modelTurns: number;
      model?: string;
    }
  | {
      kind: "reply";
      reason: "chat" | "clarify";
      text: string;
      toolCalls: number;
      modelTurns: number;
      model?: string;
    };

export type RunnerMessage =
  | { type: "ready"; protocolVersion: number }
  | { type: "session_entry"; entry: SessionEntry }
  | { type: "tool_execution"; record: ToolExecutionRecord }
  | { type: "observation"; event: ObservationEvent }
  | { type: "progress"; name: string; payload?: unknown }
  | { type: "result"; result: RunnerResult }
  | { type: "error"; error: { code: string; message: string } }
  // 工具两阶段提交（D3/D4）：Runner 只带批次内容，身份由 Host 从实际派发任务注入
  | {
      type: "evidence_commit";
      batchId: string;
      tool: string;
      toolCallId: string;
      payloadHash: string;
      items: EvidenceItem[];
      result: unknown;
    };

/** Host → Runner 的控制消息（与 cancel 共用 stdin 通道）。 */
export type RunnerControl =
  | { type: "cancel" }
  | { type: "evidence_ack"; batchId: string; refs: EvidenceRef[] }
  | {
      type: "evidence_reject";
      batchId: string;
      code: "lease_lost" | "conflict" | "content_conflict" | "internal";
      message: string;
    };

/** 一行一个 JSON 消息的编解码。 */
export function encodeMessage(message: RunnerMessage | RunnerControl): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeMessage(line: string): RunnerMessage {
  return JSON.parse(line) as RunnerMessage;
}
