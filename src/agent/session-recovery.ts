// 会话恢复：把"被中断的会话尾巴"补成自洽状态。
//
// 关键约束：pi 的 `Agent.continue()` 要求"最后一条消息必须是 user 或 tool-result"
// （见 pi-agent-core `agent.d.ts`）。崩溃可能停在"assistant 带 tool_call、但没有 tool_result"，
// 此时必须先把缺失的结果补进会话树，否则无法 continue。
//
// 工具全是只读的，所以补"结果未知"是安全的（不需要像 dsh 那样担心副作用），
// 目的主要是审计诚实 + 让会话可继续。
import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** 未决工具结果的模型可见文案（对齐 dsh 的 CLOSER_TEXT 语义）。 */
export const TOOL_OUTCOME_UNKNOWN =
  "该工具调用在会话被中断前已发起，但没有落盘其结果，因此结果未知。" +
  "只读操作可安全重试；若有副作用，请先核对外部状态，不要盲目重试。";

export interface ReconcileResult {
  /** 补齐后的完整条目序列（可直接灌进 SessionManager.inMemory）。 */
  entries: SessionEntry[];
  /** 本次新补的条目（调用方需落库）。 */
  added: SessionEntry[];
}

function toolCallIds(entry: SessionEntry): Array<{ id: string; name: string }> {
  if (entry.type !== "message") return [];
  const message = entry.message as { role?: string; content?: unknown };
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: Array<{ id: string; name: string }> = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; id?: unknown; name?: unknown };
    if (b.type === "toolCall" && typeof b.id === "string") {
      calls.push({ id: b.id, name: typeof b.name === "string" ? b.name : "tool" });
    }
  }
  return calls;
}

function toolResultId(entry: SessionEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message as { role?: string; toolCallId?: unknown };
  return message.role === "toolResult" && typeof message.toolCallId === "string"
    ? message.toolCallId
    : undefined;
}

export interface SavedToolResult {
  toolName: string;
  text: string;
  isError: boolean;
}

/**
 * 扫描会话中"已发起但无结果"的 tool_call（按出现顺序）。
 * reconcile 与 Host 构建 savedToolResults 共用同一判定，保证恢复语义一致。
 */
export function pendingToolCallIds(entries: SessionEntry[]): Array<{ id: string; name: string }> {
  const pending = new Map<string, { name: string }>();
  const resolved = new Set<string>();
  for (const entry of entries) {
    for (const call of toolCallIds(entry)) pending.set(call.id, { name: call.name });
    const done = toolResultId(entry);
    if (done) resolved.add(done);
  }
  const out: Array<{ id: string; name: string }> = [];
  for (const [id, info] of pending) {
    if (!resolved.has(id)) out.push({ id, name: info.name });
  }
  return out;
}

/**
 * 扫描日志，给"已发起但无结果"的 tool_call 补一条 tool_result。
 * savedResults 命中（该调用的证据批次已持久化）→ 补保存的原文（isError:false，D5/§8）；
 * 未命中 → 补 `outcome unknown`（不编造成功）。已结束历史不改，补记天然不重复。
 */
export function reconcileSession(
  entries: SessionEntry[],
  savedResults?: ReadonlyMap<string, SavedToolResult>,
): ReconcileResult {
  const pending = new Map<string, { name: string }>();
  const resolved = new Set<string>();
  for (const entry of entries) {
    for (const call of toolCallIds(entry)) pending.set(call.id, { name: call.name });
    const done = toolResultId(entry);
    if (done) resolved.add(done);
  }

  const added: SessionEntry[] = [];
  let parentId = entries.at(-1)?.id ?? null;
  for (const [callId, info] of pending) {
    if (resolved.has(callId)) continue;
    const saved = savedResults?.get(callId);
    const entry = {
      type: "message",
      id: randomUUID(),
      parentId,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: saved?.toolName ?? info.name,
        content: [{ type: "text", text: saved?.text ?? TOOL_OUTCOME_UNKNOWN }],
        isError: saved?.isError ?? true,
        timestamp: Date.now(),
      },
    } as unknown as SessionEntry;
    added.push(entry);
    parentId = entry.id;
  }

  return { entries: entries.concat(added), added };
}
