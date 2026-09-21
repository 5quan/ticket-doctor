// 飞书网关逻辑：事件归一化 → mention 门控 → 接入路由。
// 与 SDK 解耦（只接收归一化前的事件），便于用测试直接喂事件。
import type { AppConfig } from "../../config/index.ts";
import { extractSessionCode } from "../../domain/session.ts";
import type { InboundMessage } from "../../domain/types.ts";
import { routeInbound, type IntakeResult } from "../../intake/router.ts";
import type { Store } from "../../storage/store.ts";
import type { DeliverySender } from "../../delivery/delivery.ts";
import { evaluateMentionGate } from "./mention-gate.ts";
import { normalizeFeishuEvent, type FeishuReceiveEvent } from "./normalize.ts";

export interface GatewayDeps {
  store: Store;
  config: AppConfig;
  sender: DeliverySender;
  accountId?: string;
  logger?: (message: string) => void;
}

export type GatewayOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "hint_sent"; text: string }
  | { kind: "routed"; result: IntakeResult };

function conversationActive(store: Store, msg: InboundMessage): boolean {
  const code = extractSessionCode(msg.text);
  if (code) {
    const found = store.findInvestigationByCode(code);
    if (found && found.chat_id === msg.chatId) return true;
  }
  if (store.findInvestigationByRoute(msg.provider, msg.accountId, msg.chatId, msg.rootId, msg.threadId)) {
    return true;
  }
  if (msg.parentId) {
    const parent = store.findMessageByExternalId(msg.provider, msg.accountId, msg.parentId);
    if (parent) return true;
  }
  return false;
}

export function createFeishuGateway(deps: GatewayDeps) {
  const { store, config, sender } = deps;
  const accountId = deps.accountId ?? "default";
  const logger = deps.logger ?? ((m: string) => console.log(m));

  async function handleEvent(event: FeishuReceiveEvent): Promise<GatewayOutcome> {
    const normalized = normalizeFeishuEvent(event, accountId, config.feishu.botOpenId);
    if (!normalized.ok) return { kind: "ignored", reason: normalized.reason };
    const msg = normalized.message;

    const gate = evaluateMentionGate({
      chatType: msg.chatType,
      mentionedBot: msg.mentionedBot,
      requireMention: config.feishu.requireMention,
      conversationActive: conversationActive(store, msg),
      botOpenId: config.feishu.botOpenId,
    });
    if (!gate.allow) {
      if (gate.reason === "bot_open_id_missing") {
        logger("[feishu] botOpenId 未知，群聊消息按 fail-closed 忽略");
      }
      return { kind: "ignored", reason: gate.reason };
    }

    const result = routeInbound(store, config, msg);
    if (result.decision.kind === "unroutable") {
      // 只在“确实是在回复机器人但关联不上”时提示，避免对普通群聊刷屏
      if (msg.parentId) {
        const text = `无法把这条消息关联到已有调查：${result.decision.reason}`;
        try {
          await sender.send({ chatId: msg.chatId, targetMessageId: msg.externalMessageId, text });
          return { kind: "hint_sent", text };
        } catch (err) {
          logger(`[feishu] 提示发送失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { kind: "ignored", reason: result.decision.reason };
    }
    return { kind: "routed", result };
  }

  return { handleEvent, conversationActive };
}
