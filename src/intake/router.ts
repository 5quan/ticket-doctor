// 接入路由：把"一条入站消息"决定成"新调查 / 续接某调查 / 无法关联 / 重复"。
//
// 路由优先级（每一步都不猜）：
//   1. 正文里的会话标号 [TD-xxxx]        → 精确续接（用户回复机器人消息时最可靠）
//   2. 平台线程字段 root_id / thread_id   → 续接该线程的调查
//   3. parent_id 映射到历史消息           → 回复机器人消息时归入原调查
//   4. 群里被 @ 且无归属                  → 新建调查
//   5. 其余                               → 无法关联，提示从根消息发起
// 不同群聊的调查不自动合并：所有查找都带 chat_id。
//
// 路由规则（纯读判断）与落库（去重/建消息/建轮次）分离：
// 计划由 planRoute 算出，由 Store.acceptInbound 在**同一事务**里执行，保证原子入队。
import type { AppConfig } from "../config/index.ts";
import { extractSessionCode, newSessionCode, stripSessionMarker } from "../domain/session.ts";
import type { InboundMessage, IntakeDecision } from "../domain/types.ts";
import { HELP_TEXT } from "./help.ts";
import type { InboundPlan, InboundRejection, Store } from "../storage/store.ts";

export interface IntakeResult {
  decision: IntakeDecision;
  investigationId?: string;
  runId?: string;
  messageId?: string;
  /** Host 分配的调查内轮次号。 */
  round?: number;
  /** 新建调查时生成的标号，供回执使用。 */
  sessionCode?: string;
  /** decision 为 mechanical 时的固定文案（Host 出文案，适配器发送）。 */
  mechanicalText?: string;
}

export interface PlanRouteOptions {
  forcedInvestigationId?: string;
  /** 群聊新会话是否必须 @ 机器人（门控权威在 Host；默认 true = fail-closed）。 */
  requireMention?: boolean;
}

function titleOf(text: string): string {
  const first = stripSessionMarker(text).split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first.slice(0, 120) || "Bug 预检";
}

/**
 * 从正文粗提服务名：支持“服务: xxx”标注，或形如 xxx-service 的命名。
 *
 * 关键：标注捕获必须是**含字母**的标识符——否则 "checkout-service 服务: 2026-09-06 10:01 ..."
 * 会把日期 `2026-09-06` 当成服务名，使材料范围（scope.services）被污染，进而被 query_logs 范围约束拒绝。
 * 标注不合格时回退到 xxx-service 命名匹配。
 */
export function extractService(text: string): string | undefined {
  const labelled = text.match(/(?:服务(?:名)?|service)\s*[：:=]\s*([A-Za-z0-9][A-Za-z0-9._-]{1,99})/i);
  if (labelled && /[A-Za-z]/.test(labelled[1]!)) return labelled[1];
  const named = text.match(/\b([A-Za-z0-9][A-Za-z0-9._-]{1,99}-(?:service|server|api))\b/i);
  return named ? named[1] : undefined;
}

/** 纯路由判断：不写库，只返回"该建新调查 / 该续接谁 / 机械回复 / 该拒绝"。
 *
 * 判定顺序（feishu-trigger-design §2.3，与旧 gateway 语义一致）：
 *   1. 显式指定 / 标号 / 线程字段 / parent 命中调查 → 算出"续接"（免 @）；
 *   2. 未命中时应用 @ 门控（群聊新会话必须 @，fail-closed）；
 *   3. 门控通过后 `-help`（非 web 来源）→ 机械回复，不建调查不跑模型；
 *   4. 命中 → 续接；未命中 → 新建。
 */
export function planRoute(
  store: Store,
  msg: InboundMessage,
  opts: PlanRouteOptions = {},
): InboundPlan | InboundRejection {
  const requireMention = opts.requireMention ?? true;

  // 显式指定的调查优先（Web 按 investigationId 续接）。
  if (opts.forcedInvestigationId) {
    const forced = store.getInvestigation(opts.forcedInvestigationId);
    if (forced) {
      return {
        decision: "continue_investigation",
        investigationId: forced.id,
        servicePatch: extractService(msg.text),
      };
    }
  }

  const code = extractSessionCode(msg.text);
  let investigationId: string | undefined;

  if (code) {
    const found = store.findInvestigationByCode(code);
    // 标号必须属于同一个群聊，避免跨群串消息
    if (found && found.chat_id === msg.chatId) investigationId = found.id;
    else if (found) return { reject: "unroutable", reason: "会话标号不属于当前群聊" };
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

  // @ 门控只针对"未命中任何调查"的群聊新会话（线程回复/带标号续接免 @）；
  // Web 来源与 p2p 私聊无需 @。门控权威在 Host，适配器只归一化转发。
  if (
    !investigationId &&
    msg.provider !== "web" &&
    msg.chatType === "group" &&
    requireMention &&
    !msg.mentionedBot
  ) {
    return { reject: "unroutable", reason: "请从根消息 @机器人 发起新的调查" };
  }

  // 机械命令：只有 -help，不走模型、不建调查（门控通过后才生效；web 来源走正常链路）。
  if (msg.provider !== "web" && msg.text.trim().toLowerCase() === "-help") {
    return { decision: "mechanical", text: HELP_TEXT };
  }

  if (investigationId) {
    return {
      decision: "continue_investigation",
      investigationId,
      servicePatch: extractService(msg.text),
    };
  }

  return {
    decision: "new_investigation",
    newInvestigation: {
      sessionCode: newSessionCode(),
      provider: msg.provider,
      accountId: msg.accountId,
      chatId: msg.chatId,
      rootMessageId: msg.externalMessageId,
      threadId: msg.threadId,
      title: titleOf(msg.text),
      service: extractService(msg.text),
      createdBy: msg.senderId,
    },
  };
}

/** 统一入口：所有来源（飞书 / Web / 未来平台）都走这一条原子入队。 */
export function routeInbound(
  store: Store,
  config: AppConfig,
  msg: InboundMessage,
  opts: { forcedInvestigationId?: string } = {},
): IntakeResult {
  const accepted = store.acceptInbound(msg, {
    maxAttempts: config.scheduler.maxAttempts,
    plan: (m) =>
      planRoute(store, m, {
        forcedInvestigationId: opts.forcedInvestigationId,
        requireMention: config.feishu.requireMention,
      }),
  });
  return {
    decision: accepted.decision,
    investigationId: accepted.investigationId,
    runId: accepted.runId,
    messageId: accepted.messageId,
    round: accepted.round,
    sessionCode: accepted.sessionCode,
    mechanicalText: accepted.mechanicalText,
  };
}
