// 会话日志指针：attempt 维度留存（重试不覆盖）、run 级汇总求和、代次守卫。
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

test("recordSessionLog：attempt 维度留存、重试不覆盖、usage 求和、代次守卫", () => {
  const store = memoryStore();
  const cfg = testConfig();
  routeInbound(store, cfg, inbound());

  // 第一次尝试（租约 1ms，便于制造过期重试）
  const t0 = Date.now();
  const c1 = store.claimNextRun("w1", 1, t0)!;
  assert.equal(
    store.recordSessionLog({
      runId: c1.run.id,
      attemptId: c1.attemptId,
      generation: c1.generation,
      path: "/tmp/a1.jsonl",
      lastSeq: 3,
      inputTokens: 10,
      outputTokens: 5,
      cacheTokens: 0,
      totalTokens: 15,
    }),
    true,
  );

  // 租约过期 → 重试 → 第二次尝试（generation 递增）
  const t1 = t0 + 1_000;
  assert.equal(store.recoverExpiredLeases(t1), 1);
  const c2 = store.claimNextRun("w2", 60_000, t1)!;
  assert.notEqual(c2.attemptId, c1.attemptId);
  assert.equal(
    store.recordSessionLog({
      runId: c2.run.id,
      attemptId: c2.attemptId,
      generation: c2.generation,
      path: "/tmp/a2.jsonl",
      lastSeq: 4,
      inputTokens: 20,
      outputTokens: 10,
      cacheTokens: 0,
      totalTokens: 30,
    }),
    true,
  );

  // 两次尝试各自的指针都在，互不覆盖
  const attempts = store.listAttemptsByRun(c1.run.id);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].session_file, "/tmp/a1.jsonl");
  assert.equal(attempts[1].session_file, "/tmp/a2.jsonl");

  // run 级指针指向最新一次；usage 汇总为全部尝试之和（旧实现只留最后一次 = 漏记成本）
  const run = store.getRun(c1.run.id)!;
  assert.equal(run.session_file, "/tmp/a2.jsonl");
  assert.equal(run.usage_input_tokens, 30);
  assert.equal(run.usage_total_tokens, 45);

  // 过期代次的执行者不能再改 run 级指针（僵尸守卫）
  assert.equal(
    store.recordSessionLog({
      runId: c1.run.id,
      attemptId: c1.attemptId,
      generation: 1,
      path: "/tmp/stale.jsonl",
      lastSeq: 99,
      inputTokens: 999,
      outputTokens: 999,
      cacheTokens: 999,
      totalTokens: 999,
    }),
    false,
  );
  assert.equal(store.getRun(c1.run.id)!.session_file, "/tmp/a2.jsonl");
  assert.equal(store.getRun(c1.run.id)!.usage_total_tokens, 45);
});
