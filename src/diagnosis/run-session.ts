// 本轮诊断的会话槽：把 pi 会话条目持久化进 SQLite（单存储，取代 JSONL）。
//
// 引擎从这里读历史条目、把运行中新增的条目写回；usage 累计到本轮结束再写库。
import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SavedToolResult, SessionSink, ToolExecutionRecord } from "../agent/types.ts";
import { buildSavedToolResults } from "../evidence/recovery.ts";
import type { Store } from "../storage/store.ts";

export interface RunSessionIds {
  investigationId: string;
  runId: string;
  attemptId: string;
  generation: number;
}

interface RawUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
}

/** usage 挂在 assistant 消息 / compaction 上（pi 0.84.x 无独立 usage entry）。 */
export function usageOf(entry: SessionEntry): Usage | undefined {
  const e = entry as { type: string; message?: { usage?: RawUsage }; usage?: RawUsage };
  const u = e.type === "message" ? e.message?.usage : e.usage;
  if (!u) return undefined;
  return {
    inputTokens: u.input ?? 0,
    outputTokens: u.output ?? 0,
    cacheTokens: (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
    totalTokens: u.totalTokens ?? 0,
  };
}

export class RunSession implements SessionSink {
  readonly priorEntries: SessionEntry[];
  readonly resumed: boolean;
  readonly savedToolResults?: ReadonlyMap<string, SavedToolResult>;
  private usage: Usage = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0 };
  private readonly store: Store;
  private readonly ids: RunSessionIds;

  constructor(store: Store, ids: RunSessionIds, maxToolResultChars?: number) {
    this.store = store;
    this.ids = ids;
    this.priorEntries = store.listSessionEntries(ids.investigationId) as SessionEntry[];
    this.resumed = store.hasSessionEntriesForRun(ids.runId);
    // 崩溃恢复（§8）：内联路径与进程路径同权——已提交批次重建为可直接补记的结果
    if (maxToolResultChars !== undefined) {
      const map = buildSavedToolResults(store, ids.runId, this.priorEntries, maxToolResultChars);
      if (map.size > 0) this.savedToolResults = map;
    }
  }

  appendEntry(entry: SessionEntry): void {
    // 带代次守卫：过期/僵尸执行者的写入会被 store 丢弃。
    if (!this.store.appendSessionEntry({ ...this.ids, entry })) return;
    const usage = usageOf(entry);
    if (!usage) return;
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.usage.cacheTokens += usage.cacheTokens;
    this.usage.totalTokens += usage.totalTokens;
  }

  /**
   * 首次执行时把本轮用户输入落成一条 user 消息（恢复时不追加，避免重复）。
   * 之后引擎据此 `continue`，而不是重新 `prompt`。
   */
  appendUserMessage(text: string): void {
    const entry = {
      type: "message",
      id: randomUUID(),
      parentId: this.priorEntries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: text, timestamp: Date.now() },
    } as unknown as SessionEntry;
    this.appendEntry(entry);
    this.priorEntries.push(entry);
  }

  recordTool(record: ToolExecutionRecord): void {
    this.store.recordToolExecution({ ...this.ids, ...record });
  }

  /** 引擎结束后调用：把本轮累计 usage 写回库（attempt 维度 + run 汇总）。 */
  finish(): void {
    this.store.recordSessionUsage({ ...this.ids, ...this.usage });
  }
}
