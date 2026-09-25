// Agent 层端口：诊断引擎只面向"工具箱"，不直接碰 SDK 与外部系统。
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

/** 会话日志端口：引擎/工具箱用它追加可回放的 typed 事件，不感知落盘介质。 */
export interface RunSessionLog {
  append(type: string, data: Record<string, unknown>, opts?: { parentId?: string | null }): number;
  recordUsage(usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheTokens?: number;
    totalTokens?: number;
    provider?: string;
    model?: string;
    note?: string;
    parentId?: string | null;
  }): number;
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
  run(input: DiagnosisInput, toolbox: Toolbox, signal: AbortSignal, log?: RunSessionLog): Promise<EngineResult>;
}
