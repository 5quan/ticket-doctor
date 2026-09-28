// Host ↔ Agent Runner 的结构化进程通信协议（NDJSON over stdio）。
//
// 约定（对齐平台文档 04/05）：
//   * Host 通过 stdin 下发任务（一行 JSON），可后续下发 {type:"cancel"}；
//   * Runner 通过 stdout 逐行上报结构化消息，业务结果与运行日志分离（日志走 stderr）；
//   * Runner 不碰数据库：会话条目 / 工具执行 / 进度 / 结果都由 Host 校验后代为落库。
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolExecutionRecord } from "../agent/types.ts";
import type { DiagnosisConfig, SourcesConfig } from "../config/index.ts";
import type { EvidenceRecord, MaterialScope, ReportDraft } from "../domain/types.ts";

export interface RunnerTask {
  runId: string;
  attemptId: string;
  generation: number;
  investigationId: string;
  /** 本轮原始输入文本（含或不含会话标号均可，Runner 内部剥离）。 */
  text: string;
  receivedAt: number;
  service?: string;
  environment?: string;
  contextSummary?: string;
  /** Host 从 SQLite 读回的历史 pi 条目，供 Runner 重建会话。 */
  priorEntries: SessionEntry[];
  /** 本轮是否已有条目：true 表示 continue（恢复），false 表示 prompt（首次）。 */
  resumed: boolean;
  engine: "fake" | "pi";
  diagnosis: DiagnosisConfig;
  sources: SourcesConfig;
}

export type RunnerResult =
  | {
      kind: "report";
      draft: ReportDraft;
      evidence: EvidenceRecord[];
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
  | { type: "ready" }
  | { type: "session_entry"; entry: SessionEntry }
  | { type: "tool_execution"; record: ToolExecutionRecord }
  | { type: "progress"; name: string; payload?: unknown }
  | { type: "result"; result: RunnerResult }
  | { type: "error"; error: { code: string; message: string } };

export interface RunnerControl {
  type: "cancel";
}

/** 一行一个 JSON 消息的编解码。 */
export function encodeMessage(message: RunnerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeMessage(line: string): RunnerMessage {
  return JSON.parse(line) as RunnerMessage;
}
