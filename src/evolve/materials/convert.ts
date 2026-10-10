// 自改进方案交付 A：保真材料转换器（docs/self-improvement-implementation-plan.md §4.3）。
//
// 把冻结案例的 NDJSON 遥测转换成现有 `FileLogSource` 可消费的「每服务一个 .log」格式：
//   <timestamp>\t<severity>\t<message>
// 规则（方案 §4.3）：
//   * 原 timestamp、severity、msg 原样保留；
//   * 其余字段（trace_id、http.route、stack 等）附入消息，键按字典序稳定排序；
//   * 多行值（如 stack）折叠成单行（换行 → " | "），不丢异常关键上下文；
//   * 每个输出行记录到原始文件行号的映射；原件字节 sha256 入账。
//
// 转换是纯函数 + 确定性：同输入必得同输出，便于把结果 hash 写进 manifest。
// 转换在 Agent 运行前完成并冻结，优化器不得编辑转换后的资料。

import { sha256Bytes } from "../../eval/lf/internals/hash.ts";

/** FileLogSource / assertSafeService 允许的服务名（与 src/sources/logs.ts 保持一致）。 */
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** NDJSON 一个日志行里除核心四字段外，其余作为附加字段。 */
const CORE_FIELDS = new Set(["timestamp", "service", "severity_text", "msg"]);

export class MaterialConversionError extends Error {}

export interface ConvertedLine {
  /** 输出文件内 1-based 行号。 */
  outputLine: number;
  /** 源 NDJSON 文件内 1-based 行号（含空行计数）。 */
  sourceLine: number;
  timestamp: string;
  severity: string;
  /** 最终写入 .log 的消息文本（原 msg + 附加字段）。 */
  message: string;
  /** 附加字段（键 → 折叠后的字符串值），用于核对与评分定位。 */
  extras: Record<string, string>;
}

export interface ConvertedServiceLog {
  service: string;
  /** 输出文件名（<service>.log）。 */
  fileName: string;
  /** 文件内容（每行以 \n 结尾）。 */
  content: string;
  bytes: number;
  sha256: string;
  lines: ConvertedLine[];
}

export interface CaseMaterialConversion {
  caseId: string;
  /** 源文件相对项目根的 posix 路径。 */
  sourceFile: string;
  sourceBytes: number;
  sourceSha256: string;
  services: ConvertedServiceLog[];
}

function foldValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.replace(/\r\n|\r|\n/g, " | ");
  return JSON.stringify(value);
}

/**
 * 从一行 NDJSON 记录产出 .log 消息文本：原 msg + 附加字段（键排序，空格分隔）。
 * 多行值折叠成单行，避免破坏 FileLogSource 的逐行解析。
 */
export function buildLogMessage(record: Record<string, unknown>): { message: string; extras: Record<string, string> } {
  const msg = record.msg;
  if (typeof msg !== "string") throw new MaterialConversionError(`日志行缺少字符串 msg：${JSON.stringify(record).slice(0, 120)}`);
  const extras: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    if (CORE_FIELDS.has(key)) continue;
    extras[key] = foldValue(record[key]);
  }
  const suffix = Object.entries(extras)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return { message: suffix ? `${msg} ${suffix}` : msg, extras };
}

/**
 * 转换一个案例的 logs.ndjson。要求每行都是合法 JSON 且含 timestamp/service/severity_text/msg；
 * 任何一行不合法即整体失败（不静默跳过，避免"少了几条日志"污染评分）。
 */
export function convertLogsNdjson(caseId: string, sourceFile: string, raw: string): CaseMaterialConversion {
  const byService = new Map<string, ConvertedLine[]>();
  const rawLines = raw.split(/\r?\n/);
  let parsed = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i];
    if (!text.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new MaterialConversionError(`${sourceFile}:${i + 1} 不是合法 JSON`);
    }
    const { timestamp, service, severity_text: severity } = record as { timestamp?: unknown; service?: unknown; severity_text?: unknown };
    if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
      throw new MaterialConversionError(`${sourceFile}:${i + 1} timestamp 非法：${String(timestamp)}`);
    }
    if (typeof service !== "string" || !SERVICE_RE.test(service)) {
      throw new MaterialConversionError(`${sourceFile}:${i + 1} service 非法（必须是安全标识符）：${JSON.stringify(service)}`);
    }
    if (typeof severity !== "string" || !severity) {
      throw new MaterialConversionError(`${sourceFile}:${i + 1} 缺少 severity_text`);
    }
    const { message, extras } = buildLogMessage(record);
    const lines = byService.get(service) ?? [];
    lines.push({
      outputLine: lines.length + 1,
      sourceLine: i + 1,
      timestamp,
      severity,
      message,
      extras,
    });
    byService.set(service, lines);
    parsed++;
  }
  if (parsed === 0) throw new MaterialConversionError(`${sourceFile}: 没有可转换的日志行`);

  const services: ConvertedServiceLog[] = [...byService.keys()].sort().map((service) => {
    const lines = byService.get(service)!;
    const content = lines.map((l) => `${l.timestamp}\t${l.severity}\t${l.message}`).join("\n") + "\n";
    const bytes = Buffer.byteLength(content, "utf8");
    return { service, fileName: `${service}.log`, content, bytes, sha256: sha256Bytes(content), lines };
  });

  return {
    caseId,
    sourceFile,
    sourceBytes: Buffer.byteLength(raw, "utf8"),
    sourceSha256: sha256Bytes(raw),
    services,
  };
}
