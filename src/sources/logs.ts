// 日志源端口 + 本地文件实现。
//
// 端口存在的意义：第一版用本地文件跑通，之后换 SLS/ELK 适配器时，
// 上层编排与工具定义一行不改。权限与时间窗约束落在实现里。
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { LogEntry } from "../domain/types.ts";

export interface LogQueryIntent {
  service: string;
  /** epoch ms，闭区间。 */
  from: number;
  to: number;
  /** 任一命中即保留；为空表示不过滤。 */
  keywords: string[];
}

export interface LogSource {
  readonly name: string;
  query(intent: LogQueryIntent, signal: AbortSignal): Promise<LogEntry[]>;
}

export class LogAccessError extends Error {}

export interface FileLogSourceOptions {
  dir: string;
  maxEntries?: number;
  /** 非空时作为服务白名单，越权访问直接报错。 */
  allowedServices?: string[];
}

/**
 * 服务名是标识符，不是路径。模型传参完全可控，历史实现直接 `join(dir, service + ".log")`，
 * `../` 可逃逸出日志目录读到任意同后缀文件（审计探针 futureLogTraversal）。
 * 这里拒绝一切路径语法，并在解析后核验真实位置仍在日志目录内。
 */
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function assertSafeService(service: string, dir: string): string {
  const name = service.trim();
  if (!name || !SERVICE_RE.test(name) || name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new LogAccessError(`query_logs：非法服务名 ${JSON.stringify(service.slice(0, 80))}（服务名不允许包含路径语法）`);
  }
  const file = join(dir, `${name}.log`);
  const root = resolve(dir);
  const resolved = resolve(file);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new LogAccessError(`query_logs：解析路径 ${resolved} 越出日志目录 ${root}`);
  }
  return file;
}

export class FileLogSource implements LogSource {
  readonly name: string;
  private readonly dir: string;
  private readonly maxEntries: number;
  private readonly allowed: Set<string> | undefined;

  constructor(opts: FileLogSourceOptions) {
    this.dir = opts.dir;
    this.maxEntries = opts.maxEntries ?? 20;
    this.allowed = opts.allowedServices && opts.allowedServices.length > 0 ? new Set(opts.allowedServices) : undefined;
    this.name = `file-log-source(${opts.dir})`;
  }

  async query(intent: LogQueryIntent, signal: AbortSignal): Promise<LogEntry[]> {
    signal.throwIfAborted();
    if (!intent.service.trim()) throw new LogAccessError("query_logs：service 不能为空");
    if (this.allowed && !this.allowed.has(intent.service)) {
      throw new LogAccessError(`query_logs：服务 ${intent.service} 不在授权范围内`);
    }
    if (intent.from > intent.to) throw new LogAccessError("query_logs：时间窗非法（from > to）");

    const file = assertSafeService(intent.service, this.dir);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      // 文件不存在是"材料拿不到"，必须显式报错，不能静默返回空
      throw new LogAccessError(`日志文件不存在：${file}`);
    }

    const keywords = intent.keywords.map((k) => k.toLowerCase());
    const entries: LogEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const tab1 = line.indexOf("\t");
      const tab2 = line.indexOf("\t", tab1 + 1);
      if (tab1 < 0 || tab2 < 0) continue;
      const time = Date.parse(line.slice(0, tab1));
      if (Number.isNaN(time) || time < intent.from || time > intent.to) continue;
      const level = line.slice(tab1 + 1, tab2);
      const message = line.slice(tab2 + 1);
      if (keywords.length > 0 && !keywords.some((k) => message.toLowerCase().includes(k))) continue;
      entries.push({ time, level, message });
    }
    entries.sort((a, b) => b.time - a.time);
    return entries.slice(0, this.maxEntries);
  }
}
