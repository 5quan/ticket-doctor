// 投递模块：报告/通知的可靠发送，与诊断执行完全解耦。
//
// 核心约束（对应方案第 9 节）：
//   * 发送成功记录平台消息 ID；
//   * 明确的临时失败退避重试；
//   * 明确不可恢复的错误进入 failed；
//   * 发送结果不确定（网络中断、超时）记为 uncertain，禁止当作未发送无限重试；
//   * 诊断失败不会因为发送失败而重跑模型——这里只重试投递。
import type { AppConfig } from "../config/index.ts";
import type { Store } from "../storage/store.ts";

export interface SendResult {
  providerMessageId?: string;
}
export interface DeliverySender {
  send(input: { chatId: string; targetMessageId?: string; text: string }): Promise<SendResult>;
}

/** 结果未知：可能已送达。 */
export class SendUncertainError extends Error {}
/** 明确临时失败：未送达，可退避重试。 */
export class SendRetryableError extends Error {}
/** 明确不可恢复：未送达，不重试。 */
export class SendFatalError extends Error {}

export async function processDeliveriesOnce(
  store: Store,
  config: AppConfig,
  sender: DeliverySender,
  now = Date.now(),
): Promise<number> {
  store.recoverExpiredDeliveries(now);
  const delivery = store.claimNextDelivery(config.scheduler.leaseMs, now);
  if (!delivery) return 0;

  const investigation = store.getInvestigation(delivery.investigation_id);
  if (!investigation) {
    store.markDeliveryFailed(delivery.id, "找不到对应调查，无法确定发送目标");
    return 1;
  }

  try {
    const result = await sender.send({
      chatId: investigation.chat_id,
      targetMessageId: delivery.target_message_id ?? undefined,
      text: delivery.content,
    });
    store.markDeliverySent(delivery.id, result.providerMessageId, now);
  } catch (err) {
    if (err instanceof SendUncertainError) {
      store.markDeliveryUncertain(delivery.id, err.message, now);
    } else if (err instanceof SendRetryableError && delivery.attempt < config.delivery.maxAttempts) {
      const backoff = config.delivery.baseBackoffMs * delivery.attempt;
      store.markDeliveryRetry(delivery.id, now + backoff, err.message, now);
    } else {
      store.markDeliveryFailed(delivery.id, err instanceof Error ? err.message : String(err), now);
    }
  }
  return 1;
}
