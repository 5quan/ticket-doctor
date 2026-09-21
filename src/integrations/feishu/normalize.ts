// 飞书原始事件 → 平台无关的 InboundMessage。
// 只做确定性转换，不做路由判断；忽略机器人自身与不支持的消息类型。
import type { InboundMessage } from "../../domain/types.ts";

export interface FeishuMention {
  key?: string;
  name?: string;
  id?: { open_id?: string };
}

export interface FeishuReceiveEvent {
  sender?: { sender_type?: string; sender_id?: { open_id?: string }; sender_name?: string };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    create_time?: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    mentions?: FeishuMention[];
  };
}

export type NormalizeResult =
  | { ok: true; message: InboundMessage }
  | { ok: false; reason: string };

function parseText(content: string | undefined): string | undefined {
  if (!content) return undefined;
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : undefined;
  } catch {
    return undefined;
  }
}

function removeMentionTokens(text: string, mentions: FeishuMention[] | undefined): string {
  let cleaned = text;
  for (const mention of mentions ?? []) {
    if (mention.key) cleaned = cleaned.replaceAll(mention.key, " ");
  }
  return cleaned.replace(/[ \t]{2,}/g, " ").replace(/ *\r?\n */g, "\n").trim();
}

export function isBotMentioned(mentions: FeishuMention[] | undefined, botOpenId?: string): boolean {
  if (!botOpenId) return (mentions?.length ?? 0) > 0;
  return mentions?.some((m) => m.id?.open_id === botOpenId) ?? false;
}

export function normalizeFeishuEvent(
  event: FeishuReceiveEvent,
  accountId: string,
  botOpenId?: string,
): NormalizeResult {
  const senderType = event.sender?.sender_type;
  if (senderType && senderType !== "user") return { ok: false, reason: "ignored_bot_sender" };

  const message = event.message;
  if (!message?.message_id || !message.chat_id) return { ok: false, reason: "missing_message_id" };
  if (message.message_type && message.message_type !== "text") {
    return { ok: false, reason: `unsupported_message_type:${message.message_type}` };
  }

  const rawText = parseText(message.content);
  if (!rawText) return { ok: false, reason: "empty_content" };
  const text = removeMentionTokens(rawText, message.mentions);
  if (!text) return { ok: false, reason: "empty_text" };

  const createTime = Number(message.create_time);
  return {
    ok: true,
    message: {
      provider: "feishu",
      accountId,
      externalMessageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type === "p2p" ? "p2p" : "group",
      rootId: message.root_id,
      threadId: message.thread_id,
      parentId: message.parent_id,
      mentionedBot: isBotMentioned(message.mentions, botOpenId),
      senderId: event.sender?.sender_id?.open_id,
      senderName: event.sender?.sender_name,
      text,
      receivedAt: Number.isFinite(createTime) && createTime > 0 ? createTime : Date.now(),
    },
  };
}
