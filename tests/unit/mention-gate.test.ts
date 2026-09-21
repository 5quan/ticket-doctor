import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateMentionGate } from "../../src/integrations/feishu/mention-gate.ts";

test("p2p 一律放行", () => {
  assert.deepEqual(
    evaluateMentionGate({ chatType: "p2p", mentionedBot: false, requireMention: true, conversationActive: false }),
    { allow: true },
  );
});

test("群聊未 @ 且无活跃会话时拒绝，且 botOpenId 未知时 fail-closed", () => {
  assert.deepEqual(
    evaluateMentionGate({ chatType: "group", mentionedBot: false, requireMention: true, conversationActive: false, botOpenId: "" }),
    { allow: false, reason: "bot_open_id_missing" },
  );
  assert.deepEqual(
    evaluateMentionGate({ chatType: "group", mentionedBot: false, requireMention: true, conversationActive: false, botOpenId: "ou_bot" }),
    { allow: false, reason: "mention_required" },
  );
});

test("已有活跃会话时线程回复可免 @", () => {
  assert.deepEqual(
    evaluateMentionGate({ chatType: "group", mentionedBot: false, requireMention: true, conversationActive: true, botOpenId: "ou_bot" }),
    { allow: true },
  );
});

test("被 @ 时放行", () => {
  assert.deepEqual(
    evaluateMentionGate({ chatType: "group", mentionedBot: true, requireMention: true, conversationActive: false, botOpenId: "ou_bot" }),
    { allow: true },
  );
});
