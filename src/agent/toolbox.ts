// 工具箱：引擎能做的只读操作的唯一入口。
//
// 约束集中在这里，而不是散落在各引擎：
//   * 工具调用次数上限（超过即抛错，由编排层判定为预算耗尽）。
//   * 日志/源码结果限长。
//   * 每次材料采集都登记证据并回填来源/版本/行号。
//   * 不提供任何 Shell、写文件、业务写操作。
import { randomUUID } from "node:crypto";
import type { MaterialScope } from "../domain/types.ts";
import type { EvidenceRegistry } from "../diagnosis/evidence.ts";
import type { MultiRepoCodeSource } from "../sources/code.ts";
import type { LogSource } from "../sources/logs.ts";
import type { CodeReadArgs, CodeSearchArgs, LogQueryArgs, RunSessionLog, Toolbox } from "./types.ts";

export class ToolBudgetExceeded extends Error {}

export interface ToolboxDeps {
  logs: LogSource;
  code?: MultiRepoCodeSource;
  evidence: EvidenceRegistry;
  scope: MaterialScope;
  maxToolCalls: number;
  /** 单次工具返回给模型的总字符数上限（防信息爆炸）。 */
  maxToolResultChars: number;
  /** 本轮运行的取消信号，穿透到所有材料查询。 */
  signal: AbortSignal;
  /** 会话日志（可选）：逐次工具调用的入参/结果/耗时/成败落到这里。 */
  log?: RunSessionLog;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class DiagnosisToolbox implements Toolbox {
  readonly maxToolCalls: number;
  private calls = 0;
  private readonly deps: ToolboxDeps;

  constructor(deps: ToolboxDeps) {
    this.deps = deps;
    this.maxToolCalls = deps.maxToolCalls;
  }

  get toolCalls(): number {
    return this.calls;
  }

  get hasCode(): boolean {
    return this.deps.code !== undefined;
  }

  private spend(): void {
    this.calls += 1;
    if (this.calls > this.maxToolCalls) {
      throw new ToolBudgetExceeded(`工具调用次数超过上限 ${this.maxToolCalls}`);
    }
  }

  /** 按总量预算拼装多行结果，超出即截断并提示，避免单次结果撑爆上下文。 */
  private assemble(header: string, lines: string[]): string {
    const budget = this.deps.maxToolResultChars;
    const kept: string[] = [];
    let used = header.length + 1;
    for (const line of lines) {
      if (kept.length > 0 && used + line.length + 1 > budget) break;
      kept.push(line);
      used += line.length + 1;
    }
    if (kept.length === lines.length) return `${header}\n${kept.join("\n")}`;
    return `${header}\n${kept.join("\n")}\n（结果已截断：共 ${lines.length} 条，展示前 ${kept.length} 条；请缩小时间窗/关键词或指定文件范围）`;
  }

  /** 包一次工具执行：记录 tool_started / tool_completed（入参、结果、耗时、成败、调用 ID）。 */
  private async withToolLog<T>(name: string, input: unknown, fn: () => Promise<T>): Promise<T> {
    const log = this.deps.log;
    const callId = randomUUID();
    const started = Date.now();
    if (log) log.append("tool_started", { tool: name, callId, input }, { parentId: null });
    try {
      const result = await fn();
      const text = typeof result === "string" ? result : JSON.stringify(result);
      if (log) {
        log.append("tool_completed", {
          tool: name,
          callId,
          ok: true,
          durationMs: Date.now() - started,
          outputChars: text.length,
          output: text,
        });
      }
      return result;
    } catch (err) {
      if (log) {
        log.append("tool_completed", {
          tool: name,
          callId,
          ok: false,
          durationMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  async queryLogs(args: LogQueryArgs): Promise<string> {
    this.spend();
    return this.withToolLog("query_logs", args, async () => {
      const intent = { service: args.service, from: args.from, to: args.to, keywords: args.keywords };
      const entries = await this.deps.logs.query(intent, this.deps.signal);
      if (entries.length === 0) return "（时间窗内没有匹配的日志条目）";
      const provenance = `${this.deps.logs.name} service=${args.service} window=[${iso(args.from)}~${iso(args.to)}] keywords=[${args.keywords.join(",")}]`;
      const lines = entries.map((e) => {
        const record = this.deps.evidence.register({
          kind: "log",
          source: provenance,
          excerpt: e.message,
          time: e.time,
          level: e.level,
        });
        return `[${record.evidenceId}] ${iso(e.time)}\t${e.level}\t${record.excerpt}`;
      });
      return this.assemble(`命中 ${entries.length} 条日志：`, lines);
    });
  }

  async searchCode(args: CodeSearchArgs): Promise<string> {
    this.spend();
    return this.withToolLog("search_code", args, async () => {
      if (!this.deps.code) throw new Error("search_code 未启用：本次运行没有可用的源码");
      const target = this.deps.code.pick(args.repoId);
      const sha = target.revision!;
      const snippets = await target.search(args, this.deps.signal);
      if (snippets.length === 0) return "（没有匹配的代码片段）";
      const lines = snippets.map((s) => {
        const record = this.deps.evidence.register({
          kind: "code",
          excerpt: s.text,
          codeRef: { repoId: target.repoId, sha, path: s.path, startLine: s.line, endLine: s.line },
        });
        return `[${record.evidenceId}] ${s.path}:${s.line}: ${record.excerpt}`;
      });
      return this.assemble(`命中 ${snippets.length} 处代码：`, lines);
    });
  }

  async readCode(args: CodeReadArgs): Promise<string> {
    this.spend();
    return this.withToolLog("read_code", args, async () => {
      if (!this.deps.code) throw new Error("read_code 未启用：本次运行没有可用的源码");
      const target = this.deps.code.pick(args.repoId);
      const sha = target.revision!;
      const snippets = await target.read(args, this.deps.signal);
      if (snippets.length === 0) return "（文件在该版本中不存在或为空）";
      const first = snippets[0].line;
      const last = snippets[snippets.length - 1].line;
      const record = this.deps.evidence.register({
        kind: "code",
        excerpt: snippets.map((s) => `${s.line}\t${s.text}`).join("\n"),
        codeRef: { repoId: target.repoId, sha, path: snippets[0].path, startLine: first, endLine: last },
      });
      // 只回已登记（并按 maxResultChars 截断）的正文，别再回一份未截断的 200 行原文。
      return `[${record.evidenceId}] ${snippets[0].path}:${first}-${last}\n${record.excerpt}`;
    });
  }
}
