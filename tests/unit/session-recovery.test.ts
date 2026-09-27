// 会话恢复：给"已发起但无结果"的工具调用补合成结果，保证 continue 可用。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { TOOL_OUTCOME_UNKNOWN, reconcileSession } from "../../src/agent/session-recovery.ts";

function assistantWithCall(id: string, callId: string, name: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name, arguments: {} }],
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function toolResult(id: string, parentId: string, callId: string, name: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: name,
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 1,
    },
  } as unknown as SessionEntry;
}

function user(id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "hi", timestamp: 0 },
  } as unknown as SessionEntry;
}

test("已完成结果的调用不重复补；未决调用补 outcome-unknown", () => {
  const entries = [user("u1"), assistantWithCall("a1", "call-ok", "query_logs"), toolResult("t1", "a1", "call-ok", "query_logs"), assistantWithCall("a2", "call-pending", "read_code")];
  const { added, entries: merged } = reconcileSession(entries);
  assert.equal(added.length, 1);
  assert.equal(added[0].parentId, "a2");
  const message = (added[0] as unknown as { message: { role: string; toolCallId: string; isError: boolean; content: Array<{ text: string }> } }).message;
  assert.equal(message.role, "toolResult");
  assert.equal(message.toolCallId, "call-pending");
  assert.equal(message.isError, true);
  assert.equal(message.content[0].text, TOOL_OUTCOME_UNKNOWN);
  assert.equal(merged.length, entries.length + 1);
  assert.equal(merged.at(-1)?.id, added[0].id);
});

test("已平衡的会话不补任何东西", () => {
  const entries = [user("u1"), assistantWithCall("a1", "c1", "query_logs"), toolResult("t1", "a1", "c1", "query_logs")];
  const { added } = reconcileSession(entries);
  assert.equal(added.length, 0);
});

test("纯用户输入（首条回复生成中崩溃）不补工具结果", () => {
  const { added } = reconcileSession([user("u1")]);
  assert.equal(added.length, 0);
});
