// 会话条目单存储：按调查 seq、代次守卫、重试不串、usage 汇总、工具执行记录。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { InboundMessage } from "../../src/domain/types.ts";
import { routeInbound } from "../../src/intake/router.ts";
import { memoryStore, testConfig } from "../helpers.ts";

function inbound(): InboundMessage {
  return {
    provider: "feishu",
    accountId: "default",
    externalMessageId: "om_1",
    chatId: "oc_1",
    chatType: "group",
    mentionedBot: true,
    text: "checkout-service 下单接口报 500",
    receivedAt: 1_000,
  };
}

function entry(id: string, parentId: string | null): { id: string; parentId: string | null; type: string; timestamp: string } {
  return { id, parentId, type: "message", timestamp: new Date(1_000).toISOString() };
}

test("session_entries：seq、去重、代次守卫、重试不串、usage 汇总", () => {
  const store = memoryStore();
  const cfg = testConfig();
  routeInbound(store, cfg, inbound());

  // 第一次尝试
  const t0 = Date.now();
  const c1 = store.claimNextRun("w1", 1, t0)!;
  assert.equal(
    store.appendSessionEntry({
      investigationId: c1.run.investigation_id,
      runId: c1.run.id,
      attemptId: c1.attemptId,
      generation: c1.generation,
      entry: entry("e1", null),
    }),
    true,
  );
  // 同 entry_id 再写 → 去重，不新增 seq
  assert.equal(
    store.appendSessionEntry({
      investigationId: c1.run.investigation_id,
      runId: c1.run.id,
      attemptId: c1.attemptId,
      generation: c1.generation,
      entry: entry("e1", null),
    }),
    false,
  );
  store.recordSessionUsage({
    runId: c1.run.id,
    attemptId: c1.attemptId,
    generation: c1.generation,
    inputTokens: 10,
    outputTokens: 5,
    cacheTokens: 0,
    totalTokens: 15,
  });

  // 租约过期 → 重试（generation 递增）
  const t1 = t0 + 1_000;
  assert.equal(store.recoverExpiredLeases(t1), 1);
  const c2 = store.claimNextRun("w2", 60_000, t1)!;
  assert.notEqual(c2.attemptId, c1.attemptId);
  assert.equal(
    store.appendSessionEntry({
      investigationId: c2.run.investigation_id,
      runId: c2.run.id,
      attemptId: c2.attemptId,
      generation: c2.generation,
      entry: entry("e2", "e1"),
    }),
    true,
  );
  store.recordSessionUsage({
    runId: c2.run.id,
    attemptId: c2.attemptId,
    generation: c2.generation,
    inputTokens: 20,
    outputTokens: 10,
    cacheTokens: 0,
    totalTokens: 30,
  });

  // 两条条目都在，seq 递增，重试不覆盖
  assert.equal(store.listSessionEntries(c1.run.investigation_id).length, 2);
  assert.equal(store.hasSessionEntriesForRun(c1.run.id), true);

  // usage 汇总为全部尝试之和
  const run = store.getRun(c1.run.id)!;
  assert.equal(run.usage_input_tokens, 30);
  assert.equal(run.usage_total_tokens, 45);

  // 过期代次不能再写会话
  assert.equal(
    store.appendSessionEntry({
      investigationId: c1.run.investigation_id,
      runId: c1.run.id,
      attemptId: c1.attemptId,
      generation: 1,
      entry: entry("stale", "e2"),
    }),
    false,
  );
  assert.equal(store.listSessionEntries(c1.run.investigation_id).length, 2);
});

test("tool_executions：记录工具执行（可观测，T3）", () => {
  const store = memoryStore();
  const cfg = testConfig();
  routeInbound(store, cfg, inbound());
  const claimed = store.claimNextRun("w1", 60_000)!;
  store.recordToolExecution({
    investigationId: claimed.run.investigation_id,
    runId: claimed.run.id,
    attemptId: claimed.attemptId,
    callId: "call-1",
    tool: "query_logs",
    input: { service: "checkout-service" },
    ok: true,
    durationMs: 12,
    outputChars: 42,
  });
  const row = store.db
    .prepare("SELECT tool, ok, duration_ms FROM tool_executions WHERE call_id = ?")
    .get("call-1") as { tool: string; ok: number; duration_ms: number };
  assert.equal(row.tool, "query_logs");
  assert.equal(row.ok, 1);
  assert.equal(row.duration_ms, 12);
});
