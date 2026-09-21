import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStore } from "../helpers.ts";

function seedInvestigation(store: ReturnType<typeof memoryStore>, tag: string) {
  const investigation = store.createInvestigation({
    sessionCode: `code${tag}0`,
    provider: "feishu",
    accountId: "default",
    chatId: "oc_1",
    title: tag,
  });
  const message = store.insertMessage({
    investigationId: investigation.id,
    provider: "feishu",
    accountId: "default",
    externalMessageId: `om_${tag}`,
    text: "问题",
    receivedAt: Date.now(),
  });
  const run = store.createRun({ investigationId: investigation.id, messageId: message.id, maxAttempts: 2 });
  return { investigation, run };
}

test("同一调查串行：已有运行中的轮次时不再领取", () => {
  const store = memoryStore();
  seedInvestigation(store, "a");
  const first = store.claimNextRun("w1", 60_000);
  assert.ok(first);
  const second = store.claimNextRun("w2", 60_000);
  assert.equal(second, undefined);
});

test("不同调查可并行领取", () => {
  const store = memoryStore();
  seedInvestigation(store, "a");
  seedInvestigation(store, "b");
  const a = store.claimNextRun("w1", 60_000);
  const b = store.claimNextRun("w2", 60_000);
  assert.ok(a && b);
  assert.notEqual(a!.run.investigation_id, b!.run.investigation_id);
});

test("过期代次不能续租或提交", () => {
  const store = memoryStore();
  const { run } = seedInvestigation(store, "a");
  const claimed = store.claimNextRun("w1", 60_000)!;
  assert.equal(store.heartbeat(run.id, claimed.attemptId, claimed.generation + 1, 60_000), false);
  assert.equal(store.finishSuccess(run.id, claimed.generation + 1, "report-x"), false);
  assert.equal(store.heartbeat(run.id, claimed.attemptId, claimed.generation, 60_000), true);
});

test("租约过期后被回收并按额度重排", () => {
  const store = memoryStore();
  const { run } = seedInvestigation(store, "a");
  store.claimNextRun("w1", -1_000); // 立即过期
  const recovered = store.recoverExpiredLeases(Date.now());
  assert.equal(recovered, 1);
  const after = store.getRun(run.id)!;
  assert.equal(after.status, "queued");
  assert.equal(after.attempt_count, 1);
});

test("成功提交在同一事务内写入报告与待发送记录", () => {
  const store = memoryStore();
  const { investigation, run } = seedInvestigation(store, "a");
  const claimed = store.claimNextRun("w1", 60_000)!;
  const result = store.finalizeSuccess({
    runId: run.id,
    generation: claimed.generation,
    attemptId: claimed.attemptId,
    investigationId: investigation.id,
    round: 1,
    completeness: "complete",
    reportContent: { completeness: "complete", summary: "ok" },
    evidence: [],
    delivery: { kind: "report", content: "报告", idempotencyKey: `report:${run.id}`, targetMessageId: "om_a" },
    contextSummary: "材料完整",
  });
  assert.equal(result.ok, true);
  assert.equal(store.getRun(run.id)!.status, "succeeded");
  assert.ok(store.getReportByRun(run.id));
  const delivery = store.claimNextDelivery(60_000);
  assert.ok(delivery);
  assert.equal(delivery!.content, "报告");
});
