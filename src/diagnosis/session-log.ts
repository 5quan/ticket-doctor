// 会话日志：模型层逐条事件（消息 / 工具调用 / 用量 / 压缩）的 append-only JSONL 记录。
//
// 这是"可回放"的真相源（source of truth）：首行 header，之后每行一个带单调 seq 的 typed event。
// SQLite 里的 runs 只存指向该文件与 token 汇总的指针，细节到这里回放。
// 原则照搬 pi / dsh：append-only、typed、可回放、usage 一等公民、compaction 落边界。
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RunSessionLog } from "../agent/types.ts";

export const SESSION_LOG_VERSION = 1;

export interface SessionLogSummary {
  path: string;
  lastSeq: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
}

/** JSON 序列化兜底：任何事件都不该因为序列化失败而中断落盘。 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "unserializable", preview: String(value).slice(0, 500) });
  }
}

export class SessionLog implements RunSessionLog {
  readonly path: string;
  private seq = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheTokens = 0;
  private totalTokens = 0;

  private constructor(path: string) {
    this.path = path;
  }

  static open(opts: {
    dir: string;
    runId: string;
    attemptId: string;
    investigationId: string;
    cwd: string;
    now?: number;
  }): SessionLog {
    mkdirSync(opts.dir, { recursive: true });
    // 每次尝试一个文件，避免重试时同一文件重复写 header / 交错。
    const path = join(opts.dir, `${opts.runId}-${opts.attemptId}.jsonl`);
    const log = new SessionLog(path);
    log.write({
      type: "session",
      version: SESSION_LOG_VERSION,
      runId: opts.runId,
      attemptId: opts.attemptId,
      investigationId: opts.investigationId,
      cwd: opts.cwd,
      createdAt: opts.now ?? Date.now(),
    });
    return log;
  }

  private write(value: unknown): void {
    appendFileSync(this.path, safeStringify(value) + "\n", "utf8");
  }

  append(type: string, data: Record<string, unknown>, opts: { parentId?: string | null } = {}): number {
    this.seq += 1;
    this.write({
      seq: this.seq,
      type,
      id: randomUUID(),
      parentId: opts.parentId ?? null,
      time: Date.now(),
      data,
    });
    return this.seq;
  }

  recordUsage(usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheTokens?: number;
    totalTokens?: number;
    provider?: string;
    model?: string;
    note?: string;
    parentId?: string | null;
  }): number {
    this.inputTokens += usage.inputTokens ?? 0;
    this.outputTokens += usage.outputTokens ?? 0;
    this.cacheTokens += usage.cacheTokens ?? 0;
    this.totalTokens += usage.totalTokens ?? 0;
    return this.append("usage", { ...usage });
  }

  summary(): SessionLogSummary {
    return {
      path: this.path,
      lastSeq: this.seq,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheTokens: this.cacheTokens,
      totalTokens: this.totalTokens,
    };
  }
}

/** 读取会话日志（回放用）：丢弃最后一行无法解析的半写行（torn-write 恢复），中间行损坏则抛错。 */
export function readSessionLog(path: string): Array<Record<string, unknown>> {
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
  const entries: Array<Record<string, unknown>> = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]) as Record<string, unknown>);
    } catch {
      if (i === lines.length - 1) continue; // 半写行：丢弃
      throw new Error(`会话日志损坏：第 ${i + 1} 行无法解析（${path}）`);
    }
  }
  return entries;
}
