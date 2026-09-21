// 接入路由：把"一条入站消息"决定成"新调查 / 续接某调查 / 无法关联 / 重复"。
//
// 路由优先级（每一步都不猜）：
//   1. 正文里的会话标号 [TD-xxxx]        → 精确续接（用户回复机器人消息时最可靠）
//   2. 平台线程字段 root_id / thread_id   → 续接该线程的调查
//   3. parent_id 映射到历史消息           → 回复机器人消息时归入原调查
//   4. 群里被 @ 且无归属                  → 新建调查
//   5. 其余                               → 无法关联，提示从根消息发起
// 不同群聊的调查不自动合并：所有查找都带 chat_id。
import type { AppConfig } from "../config/index.ts";
import { extractSessionCode, newSessionCode, stripSessionMarker } from "../domain/session.ts";
import type { InboundMessage, IntakeDecision } from "../domain/types.ts";
import type { Store } from "../storage/store.ts";

export interface IntakeResult {
  decision: IntakeDecision;
  investigationId?: string;
  runId?: string;
  /** 新建调查时生成的标号，供回执使用。 */
  sessionCode?: string;
}

function titleOf(text: string): string {
  const first = stripSessionMarker(text).split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first.slice(0, 120) || "Bug 预检";
}

/** 从正文粗提服务名：支持“服务: xxx”标注，或形如 xxx-service 的命名。 */
export function extractService(text: string): string | undefined {
  const labelled = text.match(/(?:服务(?:名)?|service)\s*[：:=]\s*([A-Za-z0-9._-]{2,100})/i);
  if (labelled) return labelled[1];
  const named = text.match(/\b([A-Za-z0-9][A-Za-z0-9._-]{1,99}-(?:service|server|api))\b/i);
  return named ? named[1] : undefined;
}

export function routeInbound(store: Store, config: AppConfig, msg: InboundMessage): IntakeResult {
  const inbound = store.recordInbound(msg);
  if (!inbound.created) {
    return { decision: { kind: "duplicate" } };
  }

  const code = extractSessionCode(msg.text);
  let investigationId: string | undefined;

  if (code) {
    const found = store.findInvestigationByCode(code);
    // 标号必须属于同一个群聊，避免跨群串消息
    if (found && found.chat_id === msg.chatId) investigationId = found.id;
    else if (found) {
      store.finishInbound(inbound.id, "ignored", "会话标号属于其他群聊");
      return { decision: { kind: "unroutable", reason: "会话标号不属于当前群聊" } };
    }
  }

  if (!investigationId) {
    const byRoute = store.findInvestigationByRoute(
      msg.provider,
      msg.accountId,
      msg.chatId,
      msg.rootId,
      msg.threadId,
    );
    if (byRoute) investigationId = byRoute.id;
  }

  if (!investigationId && msg.parentId) {
    const parent = store.findMessageByExternalId(msg.provider, msg.accountId, msg.parentId);
    if (parent) investigationId = parent.investigation_id;
  }

  // 新建
  if (!investigationId) {
    if (!msg.mentionedBot) {
      store.finishInbound(inbound.id, "ignored", "无法关联且未 @机器人");
      return { decision: { kind: "unroutable", reason: "请从根消息 @机器人 发起新的调查" } };
    }
    const investigation = store.createInvestigation({
      sessionCode: newSessionCode(),
      provider: msg.provider,
      accountId: msg.accountId,
      chatId: msg.chatId,
      rootMessageId: msg.externalMessageId,
      threadId: msg.threadId,
      title: titleOf(msg.text),
      service: extractService(msg.text),
      createdBy: msg.senderId,
    });
    investigationId = investigation.id;
    const runId = addRound(store, config, investigation.id, msg);
    store.finishInbound(inbound.id, "processed");
    return {
      decision: { kind: "new_investigation", sessionCode: investigation.session_code },
      investigationId,
      runId,
      sessionCode: investigation.session_code,
    };
  }

  const runId = addRound(store, config, investigationId, msg);
  const investigation = store.getInvestigation(investigationId);
  if (investigation && !investigation.service) {
    const service = extractService(msg.text);
    if (service) store.setInvestigationService(investigationId, service);
  }
  store.finishInbound(inbound.id, "processed");
  return { decision: { kind: "continue_investigation", investigationId }, investigationId, runId };
}

function addRound(store: Store, config: AppConfig, investigationId: string, msg: InboundMessage): string {
  const message = store.insertMessage({
    investigationId,
    provider: msg.provider,
    accountId: msg.accountId,
    externalMessageId: msg.externalMessageId,
    rootId: msg.rootId,
    threadId: msg.threadId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    text: msg.text,
    receivedAt: msg.receivedAt,
  });
  const run = store.createRun({
    investigationId,
    messageId: message.id,
    maxAttempts: config.scheduler.maxAttempts,
  });
  return run.id;
}
