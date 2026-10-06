// 证据恢复（docs/evidence-uid-design.md §8 / §11 阶段 4）：
// reconcileSession 的 savedResults 补记语义 + buildSavedToolResults 的批次重建。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { reconcileSession, TOOL_OUTCOME_UNKNOWN } from "../../src/agent/session-recovery.ts";
import type { EvidenceItem } from "../../src/evidence/types.ts";
import { evidencePayloadHash } from "../../src/evidence/util.ts";
import { buildSavedToolResults } from "../../src/evidence/recovery.ts";
import { memoryStore } from "../helpers.ts";

function assistantToolCall(callId: string): SessionEntry {
  return {
    type: "message",
    id: randomUUID(),
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "query_logs" }] },
  } as unknown as SessionEntry;
}

function toolResult(callId: string, text: string, isError: boolean): SessionEntry {
  return {
    type: "message",
    id: randomUUID(),
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "toolResult", toolCallId: callId, toolName: "query_logs", content: [{ type: "text", text }], isError },
  } as unknown as SessionEntry;
}

test("reconcile：批次命中 → 补记保存原文（isError:false）；未命中 → 结果未知", () => {
  const entries = [assistantToolCall("call-saved"), assistantToolCall("call-lost")];
  const saved = new Map([["call-saved", { toolName: "query_logs", text: "[E1] 保存的日志原文", isError: false }]]);

  const { added } = reconcileSession(entries, saved);
  assert.equal(added.length, 2, "两个未决调用各补一条");
  const messageOf = (e: SessionEntry) => (e as unknown as { message: { toolCallId: string; isError: boolean; content: Array<{ text: string }> } }).message;
  const first = messageOf(added[0]!);
  const second = messageOf(added[1]!);
  assert.equal(first.toolCallId, "call-saved");
  assert.equal(first.isError, false, "已持久化的批次按成功补记");
  assert.equal(first.content[0]!.text, "[E1] 保存的日志原文");
  assert.equal(second.toolCallId, "call-lost");
  assert.equal(second.isError, true, "未命中批次不编造成功");
  assert.equal(second.content[0]!.text, TOOL_OUTCOME_UNKNOWN);
});

test("reconcile：已有 tool_result 的调用不补记（幂等）", () => {
  const entries = [assistantToolCall("call-1"), toolResult("call-1", "原文", false)];
  const saved = new Map([["call-1", { toolName: "query_logs", text: "[E1] 保存的日志原文", isError: false }]]);
  const { added } = reconcileSession(entries, saved);
  assert.equal(added.length, 0, "已结束的调用禁止重复补记");
});

test("reconcile：无 savedResults 时行为与历史一致（全部结果未知）", () => {
  const entries = [assistantToolCall("call-1")];
  const { added } = reconcileSession(entries);
  assert.equal(added.length, 1);
  const msg = (added[0]! as unknown as { message: { isError: boolean } }).message;
  assert.equal(msg.isError, true);
});

test("buildSavedToolResults：已提交批次重建模型可见文本，且只覆盖未决调用", async () => {
  const store = memoryStore();
  const inv = store.createInvestigation({ sessionCode: `code-${randomUUID().slice(0, 8)}`, provider: "feishu", accountId: "default", chatId: "oc_1" });
  const m = store.insertMessage({ investigationId: inv.id, provider: "feishu", accountId: "default", externalMessageId: `om_${randomUUID()}`, text: "排查", receivedAt: 1 });
  const run = store.createRun({ investigationId: inv.id, messageId: m.id, maxAttempts: 3 });
  const claimed = store.claimNextRun("w1", 60_000)!;

  const items: EvidenceItem[] = [{ kind: "log", source: "stub", excerpt: "boom", time: 1_700_000_000_000, level: "ERROR" }];
  const committed = store.commitEvidenceBatch({
    batchId: randomUUID(),
    tool: "query_logs",
    toolCallId: "call-crash",
    payloadHash: evidencePayloadHash(items),
    items,
    result: { count: 1, coverage: { returned: 1, total: 7, truncated: true, hasMore: true, nextCursor: "1" } },
    investigationId: inv.id,
    runId: run.id,
    attemptId: claimed.attemptId,
    generation: claimed.generation,
  });
  assert.ok(committed.ok);

  // 会话：call-crash 已发起但无结果；call-done 已结束
  const entries = [assistantToolCall("call-crash"), assistantToolCall("call-done"), toolResult("call-done", "ok", false)];
  const map = buildSavedToolResults(store, run.id, entries, 8_000);

  assert.equal(map.size, 1, "已结束的调用不进恢复映射");
  const saved = map.get("call-crash")!;
  assert.equal(saved.isError, false);
  assert.equal(saved.toolName, "query_logs");
  assert.match(saved.text, /\[E1\] /, "重建文本带短号（与工具返回同源渲染）");
  assert.match(saved.text, /命中 1 条日志（stub）：/);
  // 覆盖信息必须能从已持久化的 result_json 还原（崩溃恢复文本 = 当时工具返回）。
  assert.match(saved.text, /返回 1\/7 条；已截断，仍有更多；续查 cursor="1"/);
  assert.match(saved.text, /boom/);

  // 无未决调用的会话 → 空映射
  assert.equal(buildSavedToolResults(store, run.id, [toolResult("call-crash", "ok", false)], 8_000).size, 0);
});
