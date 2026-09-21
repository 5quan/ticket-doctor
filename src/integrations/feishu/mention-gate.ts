// 飞书群聊 mention 门控（纯函数，可单测）。
//
// 语义（比 miniclaw 简化，但保留其关键教训）：
//   * p2p 直接放行。
//   * group：已有活跃会话（线程回复/带会话标号/回复机器人消息）→ 允许免 @；
//     否则必须 @ 机器人。
//   * botOpenId 未知时 fail-closed：不能因为配置缺失就默认放行（miniclaw 踩过的坑）。
//   * 只输出决定，不做日志/副作用，便于把语义锁进单测。

export interface MentionGateInput {
  chatType: "p2p" | "group";
  mentionedBot: boolean;
  requireMention: boolean;
  /** 该群是否已有可关联的活跃会话（由调用方查库判定）。 */
  conversationActive: boolean;
  /** 机器人的 open_id；空串/undefined 表示未知。 */
  botOpenId?: string;
}

export type MentionGateRejectReason =
  | "mention_required"
  | "bot_open_id_missing"
  | "active_conversation_requires_bot_id";

export type MentionGateDecision = { allow: true } | { allow: false; reason: MentionGateRejectReason };

export function evaluateMentionGate(input: MentionGateInput): MentionGateDecision {
  if (input.chatType === "p2p") return { allow: true };
  if (!input.requireMention) return { allow: true };
  // 已有活跃会话：线程内回复/带会话标号，允许免 @
  if (input.conversationActive) return { allow: true };
  if (input.mentionedBot) return { allow: true };

  // 需要 @ 且未命中：先确认 botOpenId 已知，否则 fail-closed（不默认放行）
  if (!input.botOpenId) return { allow: false, reason: "bot_open_id_missing" };
  return { allow: false, reason: "mention_required" };
}
