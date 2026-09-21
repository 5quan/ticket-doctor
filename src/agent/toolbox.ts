// 工具箱：引擎能做的只读操作的唯一入口。
//
// 约束集中在这里，而不是散落在各引擎：
//   * 工具调用次数上限（超过即抛错，由编排层判定为预算耗尽）。
//   * 日志/源码结果限长。
//   * 每次材料采集都登记证据并回填来源/版本/行号。
//   * 不提供任何 Shell、写文件、业务写操作。
import type { MaterialScope } from "../domain/types.ts";
import type { EvidenceRegistry } from "../diagnosis/evidence.ts";
import type { MultiRepoCodeSource } from "../sources/code.ts";
import type { LogSource } from "../sources/logs.ts";
import type { CodeReadArgs, CodeSearchArgs, LogQueryArgs, Toolbox } from "./types.ts";

export class ToolBudgetExceeded extends Error {}

export interface ToolboxDeps {
  logs: LogSource;
  code?: MultiRepoCodeSource;
  evidence: EvidenceRegistry;
  scope: MaterialScope;
  maxToolCalls: number;
  /** 本轮运行的取消信号，穿透到所有材料查询。 */
  signal: AbortSignal;
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

  async queryLogs(args: LogQueryArgs): Promise<string> {
    this.spend();
    const intent = { service: args.service, from: args.from, to: args.to, keywords: args.keywords };
    const entries = await this.deps.logs.query(intent, this.deps.signal);
    if (entries.length === 0) return "（时间窗内没有匹配的日志条目）";
    const provenance = `${this.deps.logs.name} service=${args.service} window=[${iso(args.from)}~${iso(args.to)}] keywords=[${args.keywords.join(",")}]`;
    return entries
      .map((e) => {
        const record = this.deps.evidence.register({
          kind: "log",
          source: provenance,
          excerpt: e.message,
          time: e.time,
          level: e.level,
        });
        return `[${record.evidenceId}] ${iso(e.time)}\t${e.level}\t${record.excerpt}`;
      })
      .join("\n");
  }

  async searchCode(args: CodeSearchArgs): Promise<string> {
    this.spend();
    if (!this.deps.code) throw new Error("search_code 未启用：本次运行没有可用的源码");
    const target = this.deps.code.pick(args.repoId);
    const sha = target.revision!;
    const snippets = await target.search(args, this.deps.signal);
    if (snippets.length === 0) return "（没有匹配的代码片段）";
    return snippets
      .map((s) => {
        const record = this.deps.evidence.register({
          kind: "code",
          excerpt: s.text,
          codeRef: { repoId: target.repoId, sha, path: s.path, startLine: s.line, endLine: s.line },
        });
        return `[${record.evidenceId}] ${s.path}:${s.line}: ${record.excerpt}`;
      })
      .join("\n");
  }

  async readCode(args: CodeReadArgs): Promise<string> {
    this.spend();
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
    const body = snippets.map((s) => `${s.line}\t${s.text}`).join("\n");
    return `[${record.evidenceId}] ${snippets[0].path}:${first}-${last}\n${body}`;
  }
}
