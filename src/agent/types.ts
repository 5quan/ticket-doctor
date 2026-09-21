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

export interface EngineResult {
  draft: ReportDraft;
  toolCalls: number;
  modelTurns: number;
  model?: string;
}

export interface DiagnosisEngine {
  readonly name: string;
  run(input: DiagnosisInput, toolbox: Toolbox, signal: AbortSignal): Promise<EngineResult>;
}
