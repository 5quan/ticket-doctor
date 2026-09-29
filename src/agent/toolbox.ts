// 工具箱：引擎能做的只读操作的唯一入口。
//
// 约束集中在这里，而不是散落在各引擎：
//   * 工具调用次数上限（超过即抛错，由编排层判定为预算耗尽）。
//   * 证据两阶段提交（D8/D9）：先 sink.commit 持久化成功，再渲染返回给模型；
//     commit 失败 → 抛错 → 本轮失败（fail-closed），绝不把未确认材料交给模型。
//   * 单条证据入库前按 maxEvidenceChars 截断；单次工具返回文本按 maxToolResultChars 截断。
//   * 不提供任何 Shell、写文件、业务写操作。
import { randomUUID } from "node:crypto";
import type { MaterialScope } from "../domain/types.ts";
import type { EvidenceItem, EvidenceRef, EvidenceSink } from "../evidence/types.ts";
import { evidencePayloadHash } from "../evidence/util.ts";
import { renderEvidenceResult, iso } from "../evidence/render.ts";
import type { MultiRepoCodeSource } from "../sources/code.ts";
import type { LogSource } from "../sources/logs.ts";
import type { CodeListArgs, CodeReadArgs, CodeSearchArgs, LogQueryArgs, Toolbox } from "./types.ts";

export class ToolBudgetExceeded extends Error {}

export interface ToolboxDeps {
  logs: LogSource;
  code?: MultiRepoCodeSource;
  /** 证据 Sink：内联路径用 StoreEvidenceSink，Runner 路径用 IpcEvidenceSink（阶段 3）。 */
  sink: EvidenceSink;
  scope: MaterialScope;
  maxToolCalls: number;
  /** 单次工具返回给模型的总字符数上限（渲染期截断）。 */
  maxToolResultChars: number;
  /** 单条证据 excerpt 的入库上限（先截断再 commit，入库内容 = 模型可见内容）。 */
  maxEvidenceChars: number;
  /** 本轮运行的取消信号，穿透到所有材料查询。 */
  signal: AbortSignal;
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

  /** 入库前截断单条 excerpt：持久化内容与模型可见内容保持同一事实。 */
  private truncateItem(item: EvidenceItem): EvidenceItem {
    if (item.excerpt.length <= this.deps.maxEvidenceChars) return item;
    return { ...item, excerpt: `${item.excerpt.slice(0, this.deps.maxEvidenceChars)}…`, truncated: true };
  }

  /** 两阶段提交：生成批次身份 → sink.commit 等待确认。失败即抛错（D9）。 */
  private async commitItems(
    tool: string,
    toolCallId: string | undefined,
    items: EvidenceItem[],
    result: unknown,
  ): Promise<EvidenceRef[]> {
    const { refs } = await this.deps.sink.commit({
      batchId: randomUUID(),
      tool,
      toolCallId: toolCallId ?? randomUUID(),
      payloadHash: evidencePayloadHash(items),
      items,
      result,
    });
    return refs;
  }

  async queryLogs(args: LogQueryArgs, toolCallId?: string): Promise<string> {
    this.spend();
    const intent = { service: args.service, from: args.from, to: args.to, keywords: args.keywords };
    const entries = await this.deps.logs.query(intent, this.deps.signal);
    if (entries.length === 0) return "（时间窗内没有匹配的日志条目）";
    const provenance = `${this.deps.logs.name} service=${args.service} window=[${iso(args.from)}~${iso(args.to)}] keywords=[${args.keywords.join(",")}]`;
    const items = entries.map((e) =>
      this.truncateItem({
        kind: "log",
        source: provenance,
        excerpt: e.message,
        time: e.time,
        level: e.level,
      }),
    );
    const refs = await this.commitItems("query_logs", toolCallId, items, { ...intent, count: entries.length });
    return renderEvidenceResult("query_logs", items, refs, { maxResultChars: this.deps.maxToolResultChars });
  }

  /** 路径层：列出钉死版本的文件路径，先缩小范围再 search/read。 */
  async listFiles(args: CodeListArgs, toolCallId?: string): Promise<string> {
    this.spend();
    if (!this.deps.code) throw new Error("list_files 未启用：本次运行没有可用的源码");
    const target = this.deps.code.pick(args.repoId);
    const sha = target.revision!;
    const paths = await this.deps.code.listFiles({ glob: args.glob, repoId: args.repoId }, this.deps.signal);
    if (paths.length === 0) return "（没有匹配的文件路径）";
    const item = this.truncateItem({
      kind: "code",
      source: `${target.repoId}@${sha.slice(0, 10)} 路径清单${args.glob ? ` glob=${args.glob}` : ""}`,
      excerpt: paths.join("\n"),
    });
    const refs = await this.commitItems("list_files", toolCallId, [item], {
      glob: args.glob,
      repoId: args.repoId,
      count: paths.length,
    });
    return renderEvidenceResult("list_files", [item], refs, { maxResultChars: this.deps.maxToolResultChars });
  }

  async searchCode(args: CodeSearchArgs, toolCallId?: string): Promise<string> {
    this.spend();
    if (!this.deps.code) throw new Error("search_code 未启用：本次运行没有可用的源码");
    const target = this.deps.code.pick(args.repoId);
    const sha = target.revision!;
    const snippets = await target.search(args, this.deps.signal);
    if (snippets.length === 0) return "（没有匹配的代码片段）";
    const items = snippets.map((s) =>
      this.truncateItem({
        kind: "code",
        excerpt: s.text,
        codeRef: { repoId: target.repoId, sha, path: s.path, startLine: s.line, endLine: s.line },
      }),
    );
    const refs = await this.commitItems("search_code", toolCallId, items, {
      pattern: args.pattern,
      glob: args.glob,
      repoId: args.repoId,
      count: snippets.length,
    });
    return renderEvidenceResult("search_code", items, refs, { maxResultChars: this.deps.maxToolResultChars });
  }

  async readCode(args: CodeReadArgs, toolCallId?: string): Promise<string> {
    this.spend();
    if (!this.deps.code) throw new Error("read_code 未启用：本次运行没有可用的源码");
    const target = this.deps.code.pick(args.repoId);
    const sha = target.revision!;
    const snippets = await target.read(args, this.deps.signal);
    if (snippets.length === 0) return "（文件在该版本中不存在或为空）";
    const first = snippets[0]!.line;
    const last = snippets[snippets.length - 1]!.line;
    const item = this.truncateItem({
      kind: "code",
      excerpt: snippets.map((s) => `${s.line}\t${s.text}`).join("\n"),
      codeRef: { repoId: target.repoId, sha, path: snippets[0]!.path, startLine: first, endLine: last },
    });
    const refs = await this.commitItems("read_code", toolCallId, [item], {
      path: args.path,
      startLine: args.startLine,
      endLine: args.endLine,
      lines: snippets.length,
    });
    return renderEvidenceResult("read_code", [item], refs, { maxResultChars: this.deps.maxToolResultChars });
  }
}
