// 日志源端口 + 本地文件实现。
//
// 端口存在的意义：第一版用本地文件跑通，之后换 SLS/ELK 适配器时，
// 上层编排与工具定义一行不改。权限与时间窗约束落在实现里。
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { LogEntry } from "../domain/types.ts";
import { paginate, parseCursor, type SourcePage } from "./page.ts";

export interface LogQueryIntent {
  service: string;
  /** epoch ms，闭区间。 */
  from: number;
  to: number;
  /** 任一命中即保留；为空表示不过滤。 */
  keywords: string[];
  /** 继续查询位置（上一页的 nextCursor）；缺省从第 0 条开始。 */
  cursor?: string;
}

export interface LogSource {
  readonly name: string;
  query(intent: LogQueryIntent, signal: AbortSignal): Promise<SourcePage<LogEntry>>;
}

export class LogAccessError extends Error {}

export interface FileLogSourceOptions {
  dir: string;
  maxEntries?: number;
  /**
   * 授权语义（方案 §10.2）：
   *   * `undefined` —— 未配置授权，保持既有默认（不限服务）；生产入口未设 TD_ALLOWED_SERVICES 时的行为。
   *   * `[]`       —— 显式空授权：拒绝一切查询（评测逐轮授权为空时不得打开全部服务）。
   *   * 非空数组   —— 服务白名单，越权直接报错。
   */
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
  private readonly denyAll: boolean;

  constructor(opts: FileLogSourceOptions) {
    this.dir = opts.dir;
    this.maxEntries = opts.maxEntries ?? 20;
    if (opts.allowedServices === undefined) {
      this.allowed = undefined;
      this.denyAll = false;
    } else if (opts.allowedServices.length === 0) {
      this.allowed = undefined;
      this.denyAll = true;
    } else {
      this.allowed = new Set(opts.allowedServices);
      this.denyAll = false;
    }
    this.name = `file-log-source(${opts.dir})`;
  }

  async query(intent: LogQueryIntent, signal: AbortSignal): Promise<SourcePage<LogEntry>> {
    signal.throwIfAborted();
    if (!intent.service.trim()) throw new LogAccessError("query_logs：service 不能为空");
    if (this.denyAll) {
      throw new LogAccessError("query_logs：服务授权列表为空，拒绝访问（未授权 = 不开放，而非开放全部）");
    }
    if (this.allowed && !this.allowed.has(intent.service)) {
      throw new LogAccessError(`query_logs：服务 ${intent.service} 不在授权范围内`);
    }
    if (intent.from > intent.to) throw new LogAccessError("query_logs：时间窗非法（from > to）");

    const file = assertSafeService(intent.service, this.dir);
    // 真实位置核验：resolve 不解析符号链接/junction，目录别名可借此逃逸（审计新增缺口）。
    // 对请求文件与日志根都取 realpath 后再做包含判断，链接逃逸同样被拒。
    let realFile: string;
    let realRoot: string;
    try {
      realFile = await realpath(file);
      realRoot = await realpath(this.dir);
    } catch {
      throw new LogAccessError(`日志文件不存在：${file}`);
    }
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
      throw new LogAccessError(`query_logs：真实路径 ${realFile} 越出日志目录 ${realRoot}（链接/别名逃逸被拒）`);
    }
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
    // 命中总数精确可知（全文件已扫描）；分页只影响本页返回，不再用返回条数冒充总数。
    return paginate(entries, { offset: parseCursor(intent.cursor), limit: this.maxEntries });
  }
}
