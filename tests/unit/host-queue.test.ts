import assert from "node:assert/strict";
import { test } from "node:test";
import type { InboundMessage } from "../../src/domain/types.ts";
import { routeInbound } from "../../src/intake/router.ts";
import { memoryStore, testConfig } from "../helpers.ts";

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    provider: "feishu",
    accountId: "default",
    externalMessageId: `om_${Math.random().toString(36).slice(2)}`,
    chatId: "oc_1",
    chatType: "group",
    mentionedBot: true,
    text: "checkout-service 下单报错",
    receivedAt: Date.now(),
    ...over,
  };
}

test("入队原子且分配调查内单调轮次号", () => {
  const store = memoryStore();
  const config = testConfig();
  const first = routeInbound(store, config, inbound());
  const second = routeInbound(store, config, inbound({ text: `补充 [TD-${first.sessionCode}]` }));
  assert.equal(first.round, 1);
  assert.equal(second.round, 2);
  assert.equal(second.investigationId, first.investigationId);
  // 轮次来源逐轮保存
  assert.equal(store.getRun(first.runId!)!.source, "feishu");
  assert.equal(store.listMessages(first.investigationId!).length, 2);
});

test("Web 来源可新建调查（无需 @）且 source=web", () => {
  const store = memoryStore();
  const result = routeInbound(
    store,
    testConfig(),
    inbound({ provider: "web", mentionedBot: false, externalMessageId: "web:1", text: "checkout-service 超时" }),
  );
  assert.equal(result.decision.kind, "new_investigation");
  assert.equal(store.getRun(result.runId!)!.source, "web");
});

test("严格轮次顺序：前一轮未终态时后一轮不可领取", () => {
  const store = memoryStore();
  const inv = store.createInvestigation({
    sessionCode: "code-order",
    provider: "feishu",
    accountId: "default",
    chatId: "oc_1",
  });
  const m1 = store.insertMessage({
    investigationId: inv.id,
    provider: "feishu",
    accountId: "default",
    externalMessageId: "om_1",
    text: "轮1",
    receivedAt: 1,
  });
  const m2 = store.insertMessage({
    investigationId: inv.id,
    provider: "feishu",
    accountId: "default",
    externalMessageId: "om_2",
    text: "轮2",
    receivedAt: 2,
  });
  const r1 = store.createRun({ investigationId: inv.id, messageId: m1.id, maxAttempts: 3 });
  const r2 = store.createRun({ investigationId: inv.id, messageId: m2.id, maxAttempts: 3 });
  assert.equal(r1.round, 1);
  assert.equal(r2.round, 2);

  const claimed1 = store.claimNextRun("w1", 60_000);
  assert.equal(claimed1!.run.id, r1.id);
  // 轮1 运行中，轮2 不能越过
  assert.equal(store.claimNextRun("w2", 60_000), undefined);

  // 轮1 成功后才能领轮2
  store.finishSuccess(r1.id, claimed1!.generation, "report-1");
  const claimed2 = store.claimNextRun("w2", 60_000);
  assert.equal(claimed2!.run.id, r2.id);
});

test("待重试的轮次不越过：轮1 回 queued 时轮2 仍等待", () => {
  const store = memoryStore();
  const inv = store.createInvestigation({
    sessionCode: "code-retry",
    provider: "feishu",
    accountId: "default",
    chatId: "oc_1",
  });
  const mk = (n: number) =>
    store.createRun({
      investigationId: inv.id,
      messageId: store.insertMessage({
        investigationId: inv.id,
        provider: "feishu",
        accountId: "default",
        externalMessageId: `om_r${n}`,
        text: `轮${n}`,
        receivedAt: n,
      }).id,
      maxAttempts: 3,
    });
  const r1 = mk(1);
  const r2 = mk(2);
  const claimed = store.claimNextRun("w1", 60_000)!;
  // 模拟中断回 queued（可重试）
  store.finishFailure(r1.id, claimed.generation, "queued", "timeout", "超时", Date.now() - 1);
  assert.equal(store.getRun(r1.id)!.status, "queued");
  // 待重试的是轮1：可以再领（重试轮1），但绝不会越过它去领轮2。
  const retried = store.claimNextRun("w2", 60_000);
  assert.equal(retried!.run.id, r1.id);
  assert.equal(retried!.run.round, 1);
  assert.equal(store.getRun(r2.id)!.status, "queued");
});

test("会话间公平：不同调查的队首按进入顺序轮转", () => {
  const store = memoryStore();
  const seed = (tag: string, n: number) => {
    const inv = store.createInvestigation({
      sessionCode: `code-${tag}`,
      provider: "feishu",
      accountId: "default",
      chatId: `oc_${tag}`,
    });
    return Array.from({ length: n }, (_, i) =>
      store.createRun({
        investigationId: inv.id,
        messageId: store.insertMessage({
          investigationId: inv.id,
          provider: "feishu",
          accountId: "default",
          externalMessageId: `om_${tag}_${i}`,
          text: `轮${i}`,
          receivedAt: Date.now() + i,
        }).id,
        maxAttempts: 3,
      }),
    );
  };
  const a = seed("a", 3);
  const b = seed("b", 3);
  // 两个调查的队首交替被领取（各自第二、第三轮受串行约束）
  const first = store.claimNextRun("w1", 60_000)!;
  const second = store.claimNextRun("w2", 60_000)!;
  assert.notEqual(first.run.investigation_id, second.run.investigation_id);
  // 完成后继续：先完成的调查不会连续领走多轮（轮次顺序约束）
  store.finishSuccess(first.run.id, first.generation, "rep-a");
  const third = store.claimNextRun("w3", 60_000)!;
  assert.equal(third.run.investigation_id, first.run.investigation_id);
  assert.equal(third.run.round, 2);
  void a;
  void b;
});

test("取消 queued 轮次：状态置 cancelled，后续轮次可继续", () => {
  const store = memoryStore();
  const inv = store.createInvestigation({
    sessionCode: "code-cancel",
    provider: "feishu",
    accountId: "default",
    chatId: "oc_1",
  });
  const mk = (n: number) =>
    store.createRun({
      investigationId: inv.id,
      messageId: store.insertMessage({
        investigationId: inv.id,
        provider: "feishu",
        accountId: "default",
        externalMessageId: `om_c${n}`,
        text: `轮${n}`,
        receivedAt: n,
      }).id,
      maxAttempts: 3,
    });
  const r1 = mk(1);
  const r2 = mk(2);
  // 模拟轮1 运行中，用户取消
  const claimed = store.claimNextRun("w1", 60_000)!;
  assert.equal(store.requestCancel(r1.id).status, "running");
  assert.equal(store.isCancelRequested(r1.id), true);
  assert.equal(store.finishCancelled(r1.id, claimed.generation, "用户取消"), true);
  assert.equal(store.getRun(r1.id)!.status, "cancelled");
  // 取消是终态，不阻塞轮2
  const claimed2 = store.claimNextRun("w2", 60_000);
  assert.equal(claimed2!.run.id, r2.id);
});

test("取消 queued 轮次直接终结并放行后续轮次", () => {
  const store = memoryStore();
  const inv = store.createInvestigation({
    sessionCode: "code-cancel-q",
    provider: "feishu",
    accountId: "default",
    chatId: "oc_1",
  });
  const mk = (n: number) =>
    store.createRun({
      investigationId: inv.id,
      messageId: store.insertMessage({
        investigationId: inv.id,
        provider: "feishu",
        accountId: "default",
        externalMessageId: `om_cq${n}`,
        text: `轮${n}`,
        receivedAt: n,
      }).id,
      maxAttempts: 3,
    });
  const r1 = mk(1);
  const r2 = mk(2);
  const result = store.requestCancel(r1.id);
  assert.equal(result.status, "cancelled");
  assert.equal(store.getRun(r1.id)!.status, "cancelled");
  const claimed2 = store.claimNextRun("w1", 60_000);
  assert.equal(claimed2!.run.id, r2.id);
});

test("人工重试失败轮次：回 queued 并可再次领取", () => {
  const store = memoryStore();
  const inv = store.createInvestigation({
    sessionCode: "code-manual-retry",
    provider: "feishu",
    accountId: "default",
    chatId: "oc_1",
  });
  const msg = store.insertMessage({
    investigationId: inv.id,
    provider: "feishu",
    accountId: "default",
    externalMessageId: "om_mr",
    text: "轮1",
    receivedAt: 1,
  });
  const run = store.createRun({ investigationId: inv.id, messageId: msg.id, maxAttempts: 1 });
  const claimed = store.claimNextRun("w1", 60_000)!;
  store.finishFailure(run.id, claimed.generation, "failed", "runtime_error", "崩了", Date.now());
  assert.equal(store.getRun(run.id)!.status, "failed");
  assert.equal(store.retryRun(run.id), true);
  assert.equal(store.getRun(run.id)!.status, "queued");
  assert.ok(store.claimNextRun("w2", 60_000));
});

test("Web 轮次不产生 IM 投递（delivery 省略）", () => {
  const store = memoryStore();
  const inv = store.createInvestigation({
    sessionCode: "code-web",
    provider: "web",
    accountId: "web",
    chatId: "web",
  });
  const msg = store.insertMessage({
    investigationId: inv.id,
    provider: "web",
    accountId: "web",
    externalMessageId: "web:1",
    text: "问题",
    receivedAt: 1,
  });
  const run = store.createRun({
    investigationId: inv.id,
    messageId: msg.id,
    maxAttempts: 3,
    source: "web",
  });
  const claimed = store.claimNextRun("w1", 60_000)!;
  const finalized = store.finalizeSuccess({
    runId: run.id,
    generation: claimed.generation,
    attemptId: claimed.attemptId,
    investigationId: inv.id,
    round: run.round,
    completeness: "complete",
    reportContent: { summary: "ok" },
    evidence: [],
    contextSummary: "材料完整",
  });
  assert.equal(finalized.ok, true);
  assert.equal(store.claimNextDelivery(60_000), undefined, "Web 轮次不应有 IM 投递");
});
