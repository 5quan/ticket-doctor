// 飞书客户端：长连接接收事件 + 可靠回复。
//
// 采用官方 SDK 的 WSClient 长连接，无需公网回调地址。网关只依赖本文件暴露的
// start/stop/send 三个动作，业务逻辑不接触 SDK 类型。
import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuReceiveEvent } from "./normalize.ts";
import {
  SendFatalError,
  SendRetryableError,
  SendUncertainError,
  type DeliverySender,
  type SendResult,
} from "../../delivery/delivery.ts";

export interface FeishuClientOptions {
  appId: string;
  appSecret: string;
  botOpenId?: string;
}

// 明确的限流/频率错误码（未穷举，命中前缀即可）
const RETRYABLE_CODES = new Set([99991400, 99991663, 429]);

export class FeishuClient implements DeliverySender {
  private client: Lark.Client;
  private ws?: Lark.WSClient;
  private botOpenId: string | undefined;
  private readonly opts: FeishuClientOptions;

  constructor(opts: FeishuClientOptions) {
    this.opts = opts;
    this.client = new Lark.Client({ appId: opts.appId, appSecret: opts.appSecret });
    this.botOpenId = opts.botOpenId;
  }

  getBotOpenId(): string | undefined {
    return this.botOpenId;
  }

  /** 启动期拉取 bot open_id；失败不阻塞启动（门控会 fail-closed，直到补齐）。 */
  async refreshBotOpenId(): Promise<void> {
    if (this.botOpenId) return;
    try {
      const response = (await this.client.request({ method: "GET", url: "/open-apis/bot/v3/info/" })) as {
        bot?: { open_id?: string };
        data?: { bot?: { open_id?: string } };
      };
      this.botOpenId = response?.bot?.open_id ?? response?.data?.bot?.open_id;
    } catch {
      // 交给门控 fail-closed
    }
  }

  async start(onMessage: (event: FeishuReceiveEvent) => void | Promise<void>): Promise<void> {
    await this.refreshBotOpenId();
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        await onMessage(data as FeishuReceiveEvent);
      },
    });
    this.ws = new Lark.WSClient({ appId: this.opts.appId, appSecret: this.opts.appSecret });
    await this.ws.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  async send(input: { chatId: string; targetMessageId?: string; text: string }): Promise<SendResult> {
    const content = JSON.stringify({ text: input.text });
    try {
      if (input.targetMessageId) {
        const response = (await this.client.im.message.reply({
          path: { message_id: input.targetMessageId },
          data: { msg_type: "text", content },
        })) as { code?: number; msg?: string; data?: { message_id?: string } };
        this.assertSuccess("reply", response);
        return { providerMessageId: response.data?.message_id };
      }
      const response = (await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: input.chatId, msg_type: "text", content },
      })) as { code?: number; msg?: string; data?: { message_id?: string } };
      this.assertSuccess("create", response);
      return { providerMessageId: response.data?.message_id };
    } catch (err) {
      if (err instanceof SendFatalError || err instanceof SendRetryableError) throw err;
      // 网络中断/超时：无法判断是否已送达
      throw new SendUncertainError(err instanceof Error ? err.message : String(err));
    }
  }

  private assertSuccess(operation: string, response: { code?: number; msg?: string }): void {
    if (response?.code === undefined || response.code === 0) return;
    const message = `飞书 ${operation} 失败 code=${response.code} msg=${response.msg ?? "unknown"}`;
    if (RETRYABLE_CODES.has(response.code) || /frequency|rate|limit/i.test(response.msg ?? "")) {
      throw new SendRetryableError(message);
    }
    throw new SendFatalError(message);
  }
}
