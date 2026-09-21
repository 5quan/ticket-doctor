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

const execFileP = promisify(execFile);
const MAX_SNIPPET_CHARS = 2_000;
const MAX_PATTERN = 200;
const MAX_PATH = 512;

export interface CodeSearchIntent {
  pattern: string;
  glob?: string;
  repoId?: string;
}

export interface CodeReadIntent {
  path: string;
  startLine?: number;
  endLine?: number;
  repoId?: string;
}

export interface CodeSource {
  readonly name: string;
  readonly repoId: string;
  readonly revision: string | undefined;
  search(intent: CodeSearchIntent, signal: AbortSignal): Promise<CodeSnippet[]>;
  read(intent: CodeReadIntent, signal: AbortSignal): Promise<CodeSnippet[]>;
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

export class GitCodeSource implements CodeSource {
  readonly repoId: string;
  private readonly repoDir: string;
  private sha: string;

  private constructor(repoDir: string, repoId: string, sha: string) {
    this.repoDir = repoDir;
    this.repoId = repoId;
    this.sha = sha;
  }

  /** 解析并钉死版本。resolveRev 失败时抛出 CodeAccessError（调用方记为缺失材料）。 */
  static async create(repoDir: string, ref: { repoId: string; rev?: string }): Promise<GitCodeSource> {
    const sha = await resolveRepoSha(repoDir, ref.rev ?? "HEAD");
    return new GitCodeSource(repoDir, ref.repoId, sha);
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

  async search(intent: CodeSearchIntent, signal: AbortSignal): Promise<CodeSnippet[]> {
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
      if (Number(e.code) === 1) return [];
      throw new CodeAccessError((e.stderr ?? e.message ?? "git grep 失败").trim());
    }
    const snippets: CodeSnippet[] = [];
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
      snippets.push({
        path,
        line: lineno,
        text: text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS)}…` : text,
      });
      if (snippets.length >= 50) break;
    }
    return snippets;
  }

  async read(intent: CodeReadIntent, signal: AbortSignal): Promise<CodeSnippet[]> {
    const path = intent.path.trim();
    if (!path || path.length > MAX_PATH) throw new CodeAccessError("read_code：path 非法");
    if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || /[\x00-\x1f:]/.test(path)) {
      throw new CodeAccessError(`read_code：path 含非法段：${path}`);
    }
    const content = await this.git(["show", `${this.sha}:${path}`], signal);
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const start = Math.max(1, Math.floor(intent.startLine ?? 1));
    const end = Math.min(lines.length, Math.floor(intent.endLine ?? start + 199));
    const out: CodeSnippet[] = [];
    for (let line = start; line <= end && out.length < 200; line++) {
      const text = lines[line - 1] ?? "";
      out.push({
        path,
        line,
        text: text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS)}…` : text,
      });
    }
    return out;
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

  search(intent: CodeSearchIntent, signal: AbortSignal): Promise<CodeSnippet[]> {
    return this.pick(intent.repoId).search(intent, signal);
  }

  read(intent: CodeReadIntent, signal: AbortSignal): Promise<CodeSnippet[]> {
    return this.pick(intent.repoId).read(intent, signal);
  }

  /** 各仓解析后的版本，供报告"材料范围"使用。 */
  scopes(): Array<{ repoId: string; sha: string }> {
    return [...this.sources.values()].map((s) => ({ repoId: s.repoId, sha: s.revision }));
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
