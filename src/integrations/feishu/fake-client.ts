// 假飞书发送端：demo 与测试用，记录所有出站消息，可注入失败。
import type { DeliverySender, SendResult } from "../../delivery/delivery.ts";

export class FakeFeishuClient implements DeliverySender {
  readonly sent: Array<{ chatId: string; targetMessageId?: string; text: string }> = [];
  nextError?: Error;
  private counter = 0;

  async send(input: { chatId: string; targetMessageId?: string; text: string }): Promise<SendResult> {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = undefined;
      throw err;
    }
    this.sent.push(input);
    this.counter += 1;
    return { providerMessageId: `om_fake_${this.counter}` };
  }
}
