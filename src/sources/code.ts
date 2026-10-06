// 源码源端口 + Git 只读实现。
//
// 关键约束：
//   * 只读：execFile 无 shell，pattern/path 都是 argv，不是命令行字符串。
//   * 版本钉死：构造时把引用解析成完整 SHA；之后所有 search/read 只读这一个版本，
//     不让 HEAD 漂移。第一版不强制工单给 commit：没给就用当前 HEAD 解析出的 SHA，
//     并在报告"材料范围"里如实标注。
//   * 路径白名单：拒绝绝对路径、反斜杠、`..`、控制字符。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodeSnippet, RepositoryRef } from "../domain/types.ts";
import { emptyPage, pageFromWindow, paginate, parseCursor, type SourcePage } from "./page.ts";

const execFileP = promisify(execFile);
const MAX_SNIPPET_CHARS = 2_000;
const MAX_PATTERN = 200;
const MAX_PATH = 512;
/** 单次 search_code 返回的命中上限（分页页大小）。 */
const SEARCH_PAGE_SIZE = 50;
/** 单次 read_code 返回的行数上限（分页页大小）。 */
const READ_PAGE_LINES = 200;

export interface CodeSearchIntent {
  pattern: string;
  glob?: string;
  repoId?: string;
  /** 继续查询位置（上一页的 nextCursor）。 */
  cursor?: string;
}

export interface CodeReadIntent {
  path: string;
  startLine?: number;
  endLine?: number;
  repoId?: string;
}

/** 路径层（对应 pi 的 ls/find）：只列路径，不做内容检索。 */
export interface CodeListIntent {
  /** 按路径子串过滤。 */
  glob?: string;
  repoId?: string;
  limit?: number;
  /** 继续查询位置（上一页的 nextCursor）。 */
  cursor?: string;
}

export interface CodeSource {
  readonly name: string;
  readonly repoId: string;
  readonly revision: string | undefined;
  search(intent: CodeSearchIntent, signal: AbortSignal): Promise<SourcePage<CodeSnippet>>;
  read(intent: CodeReadIntent, signal: AbortSignal): Promise<SourcePage<CodeSnippet>>;
  listFiles(intent: CodeListIntent, signal: AbortSignal): Promise<SourcePage<string>>;
}

export class CodeAccessError extends Error {}

export async function resolveRepoSha(repoDir: string, rev: string): Promise<string> {
  const ref = rev.trim() || "HEAD";
  if (!/^[0-9a-fA-F]{7,40}|HEAD$|^[\w./-]+$/.test(ref)) {
    throw new CodeAccessError(`非法代码引用：${rev}`);
  }
  try {
    const { stdout } = await execFileP("git", ["-C", repoDir, "rev-parse", `${ref}^{commit}`], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const sha = stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new CodeAccessError(`rev-parse 返回异常：${sha}`);
    return sha;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const tail = (e.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "";
    throw new CodeAccessError(`无法解析代码版本 ${rev}：${tail || e.message || "git 失败"}`);
  }
}

/**
 * 按时间解析版本：取 ref 上“提交时间不晚于 at”的最近提交。
 * 找不到返回 undefined（由调用方按“缺失材料”处理，而不是默默用错版本）。
 */
export async function resolveRepoShaAt(repoDir: string, atMs: number, ref = "HEAD"): Promise<string | undefined> {
  const before = new Date(atMs).toISOString();
  try {
    const { stdout } = await execFileP("git", ["-C", repoDir, "rev-list", "-1", `--before=${before}`, ref], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const tail = (e.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "";
    throw new CodeAccessError(`无法按时间解析 ${repoDir} 的版本：${tail || e.message || "git 失败"}`);
  }
}

/** 版本钉死的依据：显式指定 / 按发生时间 / 当前 HEAD。 */
export type CodePinBasis = "explicit" | "time" | "head";

export class GitCodeSource implements CodeSource {
  readonly repoId: string;
  readonly pinnedBy: CodePinBasis;
  private readonly repoDir: string;
  private sha: string;

  private constructor(repoDir: string, repoId: string, sha: string, pinnedBy: CodePinBasis) {
    this.repoDir = repoDir;
    this.repoId = repoId;
    this.sha = sha;
    this.pinnedBy = pinnedBy;
  }

  /**
   * 钉版本：显式 rev 优先；否则按 at（发生时间）解析；都没有则当前 HEAD。
   * 按时间解析不到时抛错（记为缺失），**不默默回退到 HEAD 读错版本**。
   */
  static async create(repoDir: string, ref: { repoId: string; rev?: string; at?: number }): Promise<GitCodeSource> {
    if (ref.rev) {
      const sha = await resolveRepoSha(repoDir, ref.rev);
      return new GitCodeSource(repoDir, ref.repoId, sha, "explicit");
    }
    if (ref.at !== undefined) {
      const sha = await resolveRepoShaAt(repoDir, ref.at);
      if (sha === undefined) {
        throw new CodeAccessError(
          `仓库 ${ref.repoId} 在 ${new Date(ref.at).toISOString()} 之前没有可用提交，无法钉版本`,
        );
      }
      return new GitCodeSource(repoDir, ref.repoId, sha, "time");
    }
    const sha = await resolveRepoSha(repoDir, "HEAD");
    return new GitCodeSource(repoDir, ref.repoId, sha, "head");
  }

  get name(): string {
    return `git(${this.repoId}@${this.sha.slice(0, 10)})`;
  }

  get revision(): string {
    return this.sha;
  }

  private async git(args: string[], signal: AbortSignal): Promise<string> {
    try {
      const { stdout } = await execFileP("git", ["-C", this.repoDir, ...args], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        signal,
      });
      return stdout;
    } catch (err) {
      const e = err as { code?: number | string; killed?: boolean; stderr?: string; message?: string };
      if (e.killed) throw new CodeAccessError("代码查询被中止");
      throw new CodeAccessError((e.stderr ?? e.message ?? "git 命令失败").trim());
    }
  }

  async search(intent: CodeSearchIntent, signal: AbortSignal): Promise<SourcePage<CodeSnippet>> {
    const pattern = intent.pattern.trim();
    if (!pattern || pattern.length > MAX_PATTERN) {
      throw new CodeAccessError("search_code：pattern 必须是 1~200 个字符");
    }
    let stdout: string;
    try {
      const result = await execFileP("git", ["-C", this.repoDir, "grep", "-n", "-F", "-e", pattern, this.sha, "--", "."], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        signal,
      });
      stdout = result.stdout;
    } catch (err) {
      const e = err as { code?: number | string; killed?: boolean; stderr?: string; message?: string };
      if (e.killed) throw new CodeAccessError("代码查询被中止");
      // git grep：无命中退出码 1，是正常空结果
      if (Number(e.code) === 1) return emptyPage<CodeSnippet>();
      throw new CodeAccessError((e.stderr ?? e.message ?? "git grep 失败").trim());
    }
    // 钉死 SHA 上输出稳定：全量扫描统计 total，只在本页窗口内造 snippet（避免为分页建全量数组）。
    const offset = parseCursor(intent.cursor);
    const items: CodeSnippet[] = [];
    let total = 0;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line) continue;
      const c1 = line.indexOf(":");
      const c2 = c1 >= 0 ? line.indexOf(":", c1 + 1) : -1;
      const c3 = c2 >= 0 ? line.indexOf(":", c2 + 1) : -1;
      if (c1 < 0 || c2 < 0 || c3 < 0) continue;
      const path = line.slice(c1 + 1, c2);
      const lineno = Number(line.slice(c2 + 1, c3));
      const text = line.slice(c3 + 1);
      if (!path || !Number.isInteger(lineno)) continue;
      if (intent.glob && !path.includes(intent.glob)) continue;
      if (total >= offset && items.length < SEARCH_PAGE_SIZE) {
        items.push({
          path,
          line: lineno,
          text: text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS)}…` : text,
        });
      }
      total += 1;
    }
    return pageFromWindow(items, total, offset);
  }

  async listFiles(intent: CodeListIntent, signal: AbortSignal): Promise<SourcePage<string>> {
    const stdout = await this.git(["ls-tree", "-r", "--name-only", this.sha], signal);
    const all = stdout.split(/\r?\n/).filter(Boolean);
    const glob = intent.glob?.trim();
    const filtered = glob ? all.filter((p) => p.includes(glob)) : all;
    return paginate(filtered, { offset: parseCursor(intent.cursor), limit: intent.limit ?? 200 });
  }

  async read(intent: CodeReadIntent, signal: AbortSignal): Promise<SourcePage<CodeSnippet>> {
    const path = intent.path.trim();
    if (!path || path.length > MAX_PATH) throw new CodeAccessError("read_code：path 非法");
    if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || /[\x00-\x1f:]/.test(path)) {
      throw new CodeAccessError(`read_code：path 含非法段：${path}`);
    }
    const content = await this.git(["show", `${this.sha}:${path}`], signal);
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const start = Math.max(1, Math.floor(intent.startLine ?? 1));
    const requestedEnd = Math.max(start, Math.floor(intent.endLine ?? start + READ_PAGE_LINES - 1));
    // 三重上限：文件末尾 / 请求终点 / 单页行数。
    const returnedEnd = Math.min(total, requestedEnd, start + READ_PAGE_LINES - 1);
    const items: CodeSnippet[] = [];
    for (let line = start; line <= returnedEnd; line++) {
      const text = lines[line - 1] ?? "";
      items.push({
        path,
        line,
        text: text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS)}…` : text,
      });
    }
    const truncated = returnedEnd < requestedEnd; // 被单页行数上限截断
    const hasMore = returnedEnd < total; // 文件后面还有行
    return {
      items,
      total,
      truncated,
      hasMore,
      nextCursor: hasMore ? String(returnedEnd + 1) : undefined,
    };
  }
}

/** 多仓路由：按 repoId 分发；缺省用第一个仓。 */
export class MultiRepoCodeSource implements CodeSource {
  readonly repoId: string;
  readonly revision = undefined;
  private readonly sources: Map<string, GitCodeSource>;
  private readonly defaultRepoId: string;

  constructor(sources: GitCodeSource[]) {
    if (sources.length === 0) throw new CodeAccessError("至少需要一个代码源");
    this.sources = new Map(sources.map((s) => [s.repoId, s]));
    this.defaultRepoId = sources[0].repoId;
    this.repoId = sources.map((s) => s.repoId).join("+");
  }

  get name(): string {
    return `multi-repo(${[...this.sources.values()].map((s) => s.name).join(", ")})`;
  }

  pick(repoId?: string): GitCodeSource {
    const key = repoId ?? this.defaultRepoId;
    const picked = this.sources.get(key);
    if (!picked) throw new CodeAccessError(`未知仓库 ${key}（可用：${[...this.sources.keys()].join(", ")}）`);
    return picked;
  }

  search(intent: CodeSearchIntent, signal: AbortSignal): Promise<SourcePage<CodeSnippet>> {
    return this.pick(intent.repoId).search(intent, signal);
  }

  read(intent: CodeReadIntent, signal: AbortSignal): Promise<SourcePage<CodeSnippet>> {
    return this.pick(intent.repoId).read(intent, signal);
  }

  listFiles(intent: CodeListIntent, signal: AbortSignal): Promise<SourcePage<string>> {
    return this.pick(intent.repoId).listFiles(intent, signal);
  }

  /** 各仓解析后的版本与钉版本依据，供报告“材料范围”使用。 */
  scopes(): Array<{ repoId: string; sha: string; pinnedBy: CodePinBasis }> {
    return [...this.sources.values()].map((s) => ({ repoId: s.repoId, sha: s.revision, pinnedBy: s.pinnedBy }));
  }
}

/**
 * 按配置构建代码源：每个仓库解析一次版本；任一仓库解析失败只记录该仓缺失，
 * 不影响其余仓库（报告据此走 partial）。
 */
export async function buildCodeSource(
  repositories: RepositoryRef[],
  repoDirs: Map<string, string>,
): Promise<{ source?: MultiRepoCodeSource; missing: string[] }> {
  const missing: string[] = [];
  const built: GitCodeSource[] = [];
  for (const ref of repositories) {
    const dir = repoDirs.get(ref.repoId);
    if (!dir) {
      missing.push(`仓库 ${ref.repoId} 未配置本地路径`);
      continue;
    }
    try {
      built.push(await GitCodeSource.create(dir, ref));
    } catch (err) {
      missing.push(`仓库 ${ref.repoId} 版本解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return built.length > 0
    ? { source: new MultiRepoCodeSource(built), missing }
    : { missing };
}
