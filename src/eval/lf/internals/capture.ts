// 捕获发送端：实现 DeliverySender，记录实际发送的文本（回写层验证，方案 §7.1）。
//
// 只验证内部保存/渲染/排队/发送语义；不接真实平台、不发真实消息。
import type { DeliverySender, SendResult } from "../../../delivery/delivery.ts";
import type { CapturedSend } from "./types.ts";

export class CaptureSender implements DeliverySender {
  readonly sent: CapturedSend[] = [];
  /** runner 在排水投递前设置当前轮次，便于把发送归属到轮。 */
  currentRoundId = "";

  async send(input: { chatId: string; targetMessageId?: string; text: string }): Promise<SendResult> {
    this.sent.push({
      roundId: this.currentRoundId,
      kind: "delivery",
      targetMessageId: input.targetMessageId,
      text: input.text,
      at: Date.now(),
    });
    return { providerMessageId: `om_captured_${this.sent.length}` };
  }
}
