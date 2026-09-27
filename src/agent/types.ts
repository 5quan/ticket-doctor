// Agent 层端口：诊断引擎只面向"工具箱"与"会话槽"，不直接碰 SDK 与外部系统。
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DiagnosisInput, ReportDraft } from "../domain/types.ts";

export interface LogQueryArgs {
  service: string;
  from: number;
  to: number;
  keywords: string[];
}
export interface CodeSearchArgs {
  pattern: string;
  glob?: string;
  repoId?: string;
}
export interface CodeReadArgs {
  path: string;
  startLine?: number;
  endLine?: number;
  repoId?: string;
}

export interface Toolbox {
  readonly hasCode: boolean;
  readonly toolCalls: number;
  readonly maxToolCalls: number;
  queryLogs(args: LogQueryArgs): Promise<string>;
  searchCode(args: CodeSearchArgs): Promise<string>;
  readCode(args: CodeReadArgs): Promise<string>;
}

/** 一次工具执行记录（可观测，backlog T3）。 */
export interface ToolExecutionRecord {
  /** pi 的 toolCallId，用于关联 assistant 的 tool_call 与 tool_result。 */
  callId: string;
  tool: string;
  input: unknown;
  ok: boolean;
  durationMs: number;
  outputChars?: number;
  error?: string;
}

/**
 * 会话槽：本轮诊断的持久化会话。
 *
 * 引擎从这里读历史条目（用于重建），把运行中新增的 pi 条目写回；不感知落盘介质。
 * 实现由编排层提供（当前落 SQLite `session_entries`）。
 */
export interface SessionSink {
  /** 已落库的历史 pi 条目（完整 SessionEntry），用于重建会话。 */
  readonly priorEntries: SessionEntry[];
  /** 本轮是否已追加过用户消息：true 表示应 continue（恢复），false 表示应 prompt（首次）。 */
  readonly resumed: boolean;
  /** 追加一条 pi 会话条目。 */
  appendEntry(entry: SessionEntry): void;
  /** 记录一次工具执行（可观测）。 */
  recordTool(record: ToolExecutionRecord): void;
}

export interface EngineReportResult {
  kind: "report";
  draft: ReportDraft;
  toolCalls: number;
  modelTurns: number;
  model?: string;
}

/** 非诊断回复：闲聊或向用户追问缺失信息（反问）。 */
export interface EngineReplyResult {
  kind: "reply";
  reason: "chat" | "clarify";
  text: string;
  toolCalls: number;
  modelTurns: number;
  model?: string;
}

export type EngineResult = EngineReportResult | EngineReplyResult;

export interface DiagnosisEngine {
  readonly name: string;
  run(input: DiagnosisInput, toolbox: Toolbox, signal: AbortSignal, session?: SessionSink): Promise<EngineResult>;
}
