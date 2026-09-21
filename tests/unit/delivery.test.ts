import assert from "node:assert/strict";
import { test } from "node:test";
import {
  processDeliveriesOnce,
  SendFatalError,
  SendRetryableError,
  SendUncertainError,
  type DeliverySender,
} from "../../src/delivery/delivery.ts";
import { memoryStore, testConfig } from "../helpers.ts";

function seedDelivery(store: ReturnType<typeof memoryStore>, key: string): string {
  const investigation = store.createInvestigation({
    sessionCode: `code${key}0`,
    provider: "feishu",
    accountId: "default",
    chatId: "oc_1",
  });
  store.enqueueDelivery({
    investigationId: investigation.id,
    runId: `run_${key}`,
    kind: "report",
    content: "报告正文",
    idempotencyKey: `report:${key}`,
    targetMessageId: "om_root",
  });
  return investigation.id;
}

function rowOf(store: ReturnType<typeof memoryStore>, investigationId: string): { status: string } {
  return store.db
    .prepare("SELECT status FROM deliveries WHERE investigation_id = ?")
    .get(investigationId) as { status: string };
}

test("发送结果不确定记为 uncertain，不当作未发送重试", async () => {
  const store = memoryStore();
  const id = seedDelivery(store, "a");
  const sender: DeliverySender = { send: async () => { throw new SendUncertainError("网络中断"); } };
  await processDeliveriesOnce(store, testConfig(), sender);
  assert.equal(rowOf(store, id).status, "uncertain");
});

test("明确的临时失败退避重试", async () => {
  const store = memoryStore();
  const id = seedDelivery(store, "b");
  const sender: DeliverySender = { send: async () => { throw new SendRetryableError("限流"); } };
  await processDeliveriesOnce(store, testConfig(), sender);
  assert.equal(rowOf(store, id).status, "pending");
});

test("不可恢复错误直接 failed", async () => {
  const store = memoryStore();
  const id = seedDelivery(store, "c");
  const sender: DeliverySender = { send: async () => { throw new SendFatalError("权限不足"); } };
  await processDeliveriesOnce(store, testConfig(), sender);
  assert.equal(rowOf(store, id).status, "failed");
});

test("发送成功记录平台消息 ID", async () => {
  const store = memoryStore();
  const id = seedDelivery(store, "d");
  const sender: DeliverySender = { send: async () => ({ providerMessageId: "om_sent" }) };
  await processDeliveriesOnce(store, testConfig(), sender);
  const row = store.db
    .prepare("SELECT status, provider_message_id FROM deliveries WHERE investigation_id = ?")
    .get(id) as { status: string; provider_message_id: string };
  assert.equal(row.status, "sent");
  assert.equal(row.provider_message_id, "om_sent");
});
