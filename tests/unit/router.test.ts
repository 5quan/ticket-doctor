import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSessionCode } from "../../src/domain/session.ts";
import type { InboundMessage } from "../../src/domain/types.ts";
import { routeInbound } from "../../src/intake/router.ts";
import { memoryStore, testConfig } from "../helpers.ts";

let counter = 0;
function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  counter += 1;
  return {
    provider: "feishu",
    accountId: "default",
    externalMessageId: `om_${counter}`,
    chatId: "oc_1",
    chatType: "group",
    mentionedBot: true,
    text: "checkout-service 下单报错",
    receivedAt: Date.now(),
    ...over,
  };
}

test("被 @ 的群消息创建新调查并生成会话标号", () => {
  const store = memoryStore();
  const result = routeInbound(store, testConfig(), msg());
  assert.equal(result.decision.kind, "new_investigation");
  assert.ok(result.runId);
  assert.equal(extractSessionCode(`报告 [TD-${result.sessionCode}]`), result.sessionCode);
});

test("同一平台消息 ID 只处理一次", () => {
  const store = memoryStore();
  const config = testConfig();
  const first = msg({ externalMessageId: "om_dup" });
  routeInbound(store, config, first);
  const second = routeInbound(store, config, { ...first, text: "重复投递" });
  assert.equal(second.decision.kind, "duplicate");
});

test("带会话标号的回复归入原调查", () => {
  const store = memoryStore();
  const config = testConfig();
  const first = routeInbound(store, config, msg());
  const code = first.sessionCode!;
  const follow = routeInbound(store, config, msg({ mentionedBot: false, text: `补充材料 [TD-${code}]` }));
  assert.equal(follow.decision.kind, "continue_investigation");
  assert.equal(follow.investigationId, first.investigationId);
});

test("回复机器人消息（parent_id 映射）归入原调查", () => {
  const store = memoryStore();
  const config = testConfig();
  const first = routeInbound(store, config, msg({ externalMessageId: "om_root" }));
  const follow = routeInbound(store, config, msg({ mentionedBot: false, parentId: "om_root", text: "再补充一点" }));
  assert.equal(follow.decision.kind, "continue_investigation");
  assert.equal(follow.investigationId, first.investigationId);
});

test("p2p 私聊无需 @ 也能新建调查（与 mention-gate 一致）", () => {
  const store = memoryStore();
  const result = routeInbound(store, testConfig(), msg({ chatType: "p2p", mentionedBot: false, text: "下单报错" }));
  assert.equal(result.decision.kind, "new_investigation");
  assert.ok(result.investigationId);
});

test("无法关联且未 @ 的消息不猜归属", () => {
  const store = memoryStore();
  const result = routeInbound(store, testConfig(), msg({ mentionedBot: false, text: "随便聊聊" }));
  assert.equal(result.decision.kind, "unroutable");
});

test("不同群聊的相同标号不会串消息", () => {
  const store = memoryStore();
  const config = testConfig();
  const first = routeInbound(store, config, msg({ chatId: "oc_a" }));
  const code = first.sessionCode!;
  const cross = routeInbound(store, config, msg({ chatId: "oc_b", mentionedBot: false, text: `[TD-${code}] 你好` }));
  assert.equal(cross.decision.kind, "unroutable");
});

// ---------- 门控单点化 + -help 机械回复（feishu-trigger-design §5） ----------

test("群聊线程回复（root_id 命中）未 @ → 续接（P0 修复锁）", () => {
  const store = memoryStore();
  const config = testConfig();
  const first = routeInbound(store, config, msg({ externalMessageId: "om_root", threadId: "ot_1" }));
  assert.equal(first.decision.kind, "new_investigation");
  const follow = routeInbound(
    store,
    config,
    msg({ mentionedBot: false, rootId: "om_root", text: "线程内补充现象" }),
  );
  assert.equal(follow.decision.kind, "continue_investigation");
  assert.equal(follow.investigationId, first.investigationId);
});

test("-help 群聊被 @ → 机械回复，不建调查不建轮次", () => {
  const store = memoryStore();
  const result = routeInbound(store, testConfig(), msg({ text: "-help" }));
  assert.equal(result.decision.kind, "mechanical");
  assert.ok(result.mechanicalText?.includes("ticket-doctor 使用说明"));
  assert.equal(result.runId, undefined);
  assert.equal(result.investigationId, undefined);
});

test("-help 群聊新会话未 @ → 门控优先，拒绝且不回机械文案", () => {
  const store = memoryStore();
  const result = routeInbound(store, testConfig(), msg({ mentionedBot: false, text: "-help" }));
  assert.equal(result.decision.kind, "unroutable");
  assert.equal(result.mechanicalText, undefined);
});

test("-help 在活跃会话（线程命中）未 @ → 机械回复", () => {
  const store = memoryStore();
  const config = testConfig();
  routeInbound(store, config, msg({ externalMessageId: "om_root2", threadId: "ot_2" }));
  const result = routeInbound(store, config, msg({ mentionedBot: false, rootId: "om_root2", text: "-help" }));
  assert.equal(result.decision.kind, "mechanical");
  assert.ok(result.mechanicalText);
});

test("requireMention=false + 群聊未 @ → 新建调查", () => {
  const store = memoryStore();
  const config = testConfig({ feishu: { botOpenId: "ou_bot", requireMention: false } });
  const result = routeInbound(store, config, msg({ mentionedBot: false, text: "随便报个错" }));
  assert.equal(result.decision.kind, "new_investigation");
  assert.ok(result.runId);
});

test("web 来源的 -help 不走机械回复（建调查）", () => {
  const store = memoryStore();
  const result = routeInbound(
    store,
    testConfig(),
    msg({ provider: "web", mentionedBot: false, text: "-help" }),
  );
  assert.equal(result.decision.kind, "new_investigation");
});
