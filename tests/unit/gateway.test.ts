// 网关机械回复：-help 不建调查、不产生 run。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeishuGateway } from "../../src/integrations/feishu/gateway.ts";
import { FakeFeishuClient } from "../../src/integrations/feishu/fake-client.ts";
import type { FeishuReceiveEvent } from "../../src/integrations/feishu/normalize.ts";
import { memoryStore, testConfig } from "../helpers.ts";

function helpEvent(text = "-help", mentioned = true): FeishuReceiveEvent {
  return {
    sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
    message: {
      message_id: "om_help",
      chat_id: "oc_1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
      mentions: mentioned ? [{ key: "@_user_1", id: { open_id: "ou_bot" } }] : [],
    },
  };
}

function investigationCount(store: ReturnType<typeof memoryStore>): number {
  return Number((store.db.prepare("SELECT COUNT(*) AS n FROM investigations").get() as { n: number }).n);
}

test("-help 走机械回复：不建调查、不产生 run，直接回使用方法", async () => {
  const store = memoryStore();
  const cfg = testConfig();
  cfg.feishu.botOpenId = "ou_bot";
  const feishu = new FakeFeishuClient();
  const gateway = createFeishuGateway({ store, config: cfg, sender: feishu });

  const outcome = await gateway.handleEvent(helpEvent());
  assert.equal(outcome.kind, "mechanical_reply_sent");
  assert.equal(feishu.sent.length, 1);
  assert.match(feishu.sent[0].text, /使用说明/);
  assert.equal(investigationCount(store), 0);
});

test("-help 未 @机器人时按 fail-closed 忽略", async () => {
  const store = memoryStore();
  const cfg = testConfig();
  cfg.feishu.botOpenId = "ou_bot";
  const feishu = new FakeFeishuClient();
  const gateway = createFeishuGateway({ store, config: cfg, sender: feishu });

  const outcome = await gateway.handleEvent(helpEvent("-help", false));
  assert.equal(outcome.kind, "ignored");
  assert.equal(feishu.sent.length, 0);
});
