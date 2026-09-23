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
  | { kind: "mechanical_reply_sent"; text: string }
  | { kind: "routed"; result: IntakeResult };

/** 机械回复（不建调查、不走模型）。目前只有 `-help` 命令使用。 */
const HELP_TEXT = [
  "【ticket-doctor 使用说明】",
  "• 提交 Bug：在群里 @我，尽量带上「服务名、发生时间、现象/报错」。",
  "• 继续追问：回复我的报告，保留末尾的 [TD-xxxxxxxx] 标号即可续接。",
  "• 我只做只读预检（查日志 + 读源码），不会修改任何东西。",
].join("\n");

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

  /** 机械回复：不创建调查、不调用模型，直接回一条固定文本（通知/帮助）。 */
  async function sendMechanical(
    chatId: string,
    targetMessageId: string | undefined,
    text: string,
  ): Promise<GatewayOutcome> {
    try {
      await sender.send({ chatId, targetMessageId, text });
      return { kind: "mechanical_reply_sent", text };
    } catch (err) {
      logger(`[feishu] 机械回复发送失败：${err instanceof Error ? err.message : String(err)}`);
      return { kind: "ignored", reason: "mechanical_reply_failed" };
    }
  }

  async function handleEvent(event: FeishuReceiveEvent): Promise<GatewayOutcome> {
    // 机械命令：只有 -help，不走模型、不建调查。
    // （先归一化再判命令，保证只有真实消息能触发。）
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

    // 机械回复命令：-help 展示使用方法。
    if (msg.text.trim().toLowerCase() === "-help") {
      return sendMechanical(msg.chatId, msg.externalMessageId, HELP_TEXT);
    }

    const result = routeInbound(store, config, msg);
    if (result.decision.kind === "unroutable") {
      // 只在“确实是在回复机器人但关联不上”时提示，避免对普通群聊刷屏
      if (msg.parentId) {
        return sendMechanical(
          msg.chatId,
          msg.externalMessageId,
          `无法把这条消息关联到已有调查：${result.decision.reason}`,
        );
      }
      return { kind: "ignored", reason: result.decision.reason };
    }
    return { kind: "routed", result };
  }

  return { handleEvent, conversationActive };
}
