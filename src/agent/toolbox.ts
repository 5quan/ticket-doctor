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
import type { CodeListArgs, CodeReadArgs, CodeSearchArgs, LogQueryArgs, Toolbox } from "./types.ts";

export class ToolBudgetExceeded extends Error {}

/** search_code 有界输出：路径清单最多列多少个文件、预览最多多少处命中（源本身另有 ≤50 上限）。 */
const SEARCH_MAX_PATHS = 20;
const SEARCH_PREVIEW_HITS = 8;

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

  async queryLogs(args: LogQueryArgs): Promise<string> {
    this.spend();
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
  }

  /** 路径层：列出钉死版本的文件路径，先缩小范围再 search/read。 */
  async listFiles(args: CodeListArgs): Promise<string> {
    this.spend();
    if (!this.deps.code) throw new Error("list_files 未启用：本次运行没有可用的源码");
    const target = this.deps.code.pick(args.repoId);
    const sha = target.revision!;
    const paths = await this.deps.code.listFiles({ glob: args.glob, repoId: args.repoId }, this.deps.signal);
    if (paths.length === 0) return "（没有匹配的文件路径）";
    const record = this.deps.evidence.register({
      kind: "code",
      source: `${target.repoId}@${sha.slice(0, 10)} 路径清单${args.glob ? ` glob=${args.glob}` : ""}`,
      excerpt: paths.join("\n"),
    });
    return this.assemble(`[${record.evidenceId}] 命中 ${paths.length} 个文件：`, paths.map((p) => `  ${p}`));
  }

  async searchCode(args: CodeSearchArgs): Promise<string> {
    this.spend();
    if (!this.deps.code) throw new Error("search_code 未启用：本次运行没有可用的源码");
    const target = this.deps.code.pick(args.repoId);
    const sha = target.revision!;
    const snippets = await target.search(args, this.deps.signal);
    if (snippets.length === 0) return "（没有匹配的代码片段）";

    // 每处命中都登记证据（逐处可追溯）；输出改为“路径清单 + 前 K 处预览”，命中很多时不再回一堆片段。
    const records = snippets.map((s) =>
      this.deps.evidence.register({
        kind: "code",
        excerpt: s.text,
        codeRef: { repoId: target.repoId, sha, path: s.path, startLine: s.line, endLine: s.line },
      }),
    );

    const hitsByPath = new Map<string, number>();
    for (const s of snippets) hitsByPath.set(s.path, (hitsByPath.get(s.path) ?? 0) + 1);
    const pathEntries = [...hitsByPath.entries()];
    const pathLines = pathEntries.slice(0, SEARCH_MAX_PATHS).map(([path, count]) => `  ${path}: 命中 ${count} 处`);
    if (pathEntries.length > SEARCH_MAX_PATHS) {
      pathLines.push(`  （其余 ${pathEntries.length - SEARCH_MAX_PATHS} 个文件未列出，请用 glob 缩小范围）`);
    }
    const previewCount = Math.min(SEARCH_PREVIEW_HITS, snippets.length);
    const previewLines = records.slice(0, previewCount).map((r, i) => {
      const s = snippets[i]!;
      return `[${r.evidenceId}] ${s.path}:${s.line}: ${r.excerpt}`;
    });
    const omitted = snippets.length - previewCount;
    const tail = omitted > 0 ? [`（其余 ${omitted} 处未预览：按文件清单用 glob 缩小范围，或用 read_code 读取具体位置）`] : [];
    return this.assemble(
      `命中 ${snippets.length} 处代码，分布在 ${pathEntries.length} 个文件；先列文件清单，再预览前 ${previewCount} 处：`,
      [...pathLines, "", ...previewLines, ...tail],
    );
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
    // 只回已登记（并按 maxResultChars 截断）的正文，别再回一份未截断的 200 行原文。
    return `[${record.evidenceId}] ${snippets[0].path}:${first}-${last}\n${record.excerpt}`;
  }
}
