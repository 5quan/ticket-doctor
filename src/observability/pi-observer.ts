// Pi 请求边界采集（观测方案 §5.1）：包装 session.agent.streamFunction。
//
// 依据 pi 0.84.2 的实际公开接口（不按旧教程猜）：
//   * Agent.streamFunction 是非可选属性，缺省即 Models.streamSimple —— 总可保存并替换；
//   * 压缩/总结（compaction）复用同一 streamFunction（agent-session 把 this.agent.streamFunction
//     传入 compact/generateSummary），因此包装点天然覆盖压缩调用，不漏计；
//   * 契约：stream 函数不得 throw、不得 reject —— 失败经流内协议事件以最终 AssistantMessage
//     （stopReason = "error"/"aborted" + errorMessage）传递；因此用同一流的 result() 观察最终
//     消息，绝不开第二个 async iterator 抢 token 事件；
//   * provider 真实请求体经 options.onPayload 链式捕获：完全保留原回调的异步返回值与
//     payload 替换语义，不因记录而改变请求体。
//
// 计数口径（观测方案 §5.2）：modelCalls = 逻辑模型调用次数，包含 pi 重新发起的请求与压缩调用；
// provider 内部 HTTP 重试发生在 onPayload 之后，一期不逐次捕获。该计数与 TD_OBSERVABILITY_ENABLED
// 无关（关闭观测时用 noop sink，仍保证计数正确）。
import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEventStream, SimpleStreamOptions, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { envelope, observeText, type ObservationSink, type ObservationStatus, type ObservationText, type ObservationUsage } from "./types.ts";

/** pi 压缩/总结请求固定使用的 system prompt 开头（core/compaction/utils.js）。 */
const SUMMARIZATION_PROMPT_PREFIX = "You are a context summarization assistant";

export interface PiObserverController {
  /** 已发生的逻辑模型调用数（含 compaction 与 pi 重新发起的请求）。 */
  readonly modelCalls: number;
  /** 终态前收尾：给仍在飞的 generation 补 aborted 结束事件，并恢复原 streamFunction。之后晚到的 result() 不再产生事件。 */
  settlePending(): void;
}

export interface AttachPiObserverOptions {
  session: AgentSession;
  sink: ObservationSink;
  /** 本次 attempt 的 scope 节点 ID：model 事件以它为父。 */
  scopeId: string;
  /** 单事件字节预算（TD_OBSERVABILITY_MAX_EVENT_BYTES）。 */
  maxEventBytes: number;
}

export function attachPiObserver(opts: AttachPiObserverOptions): PiObserverController {
  const { session, sink, scopeId, maxEventBytes } = opts;
  const agent = session.agent;
  const originalStreamFn = agent.streamFunction;

  let seq = 0;
  let modelCalls = 0;
  let settled = false;
  const inFlight = new Map<string, number>();

  const emitModelEnd = (
    id: string,
    startedAt: number,
    patch: {
      status: ObservationStatus;
      output?: ObservationText;
      stopReason?: string;
      errorMessage?: string;
      usage?: ObservationUsage;
      metadata?: Record<string, unknown>;
    },
  ): void => {
    // 终态收尾后晚到的异步采集直接丢弃（观测方案 §6.6：防异步采集晚于 terminal）。
    if (settled) return;
    inFlight.delete(id);
    sink.record({
      ...envelope(++seq),
      kind: "model_end",
      logicalObservationId: id,
      parentLogicalId: scopeId,
      metadata: { durationMs: Date.now() - startedAt, ...patch.metadata },
      status: patch.status,
      output: patch.output,
      stopReason: patch.stopReason,
      errorMessage: patch.errorMessage,
      usage: patch.usage,
    });
  };

  const observeStream = (
    stream: AssistantMessageEventStream,
    id: string,
    startedAt: number,
    capture: { providerPayload?: ObservationText },
  ): void => {
    // 只用 result() 观察最终 AssistantMessage；不消费流的迭代器，token 事件全部留给 pi。
    inFlight.set(id, startedAt);
    void stream
      .result()
      .then((message: AssistantMessage) => {
        const aborted = message.stopReason === "aborted";
        const errored = message.stopReason === "error" || Boolean(message.errorMessage);
        // generation output（观测方案 §4）：模型实际返回的文本、thinking/reasoning、tool calls。
        // 只记录 provider 已返回的数据，不生成"内部思考"。
        const parts = Array.isArray(message.content) ? message.content : [];
        const text = parts
          .filter((p): p is TextContent => p.type === "text")
          .map((p) => p.text)
          .join("\n")
          .trim();
        const thinking = parts
          .filter((p): p is ThinkingContent => p.type === "thinking")
          .map((p) => p.thinking)
          .join("\n")
          .trim();
        const toolCalls = parts
          .filter((p): p is ToolCall => p.type === "toolCall")
          .map((p) => ({ id: p.id, name: p.name, arguments: p.arguments }));
        const outputPayload: Record<string, unknown> = {};
        if (text) outputPayload.text = text;
        if (thinking) outputPayload.thinking = thinking;
        if (toolCalls.length > 0) outputPayload.toolCalls = toolCalls;
        const output =
          Object.keys(outputPayload).length > 0 ? observeText(outputPayload, maxEventBytes) : undefined;
        // error/aborted 或全零初始化 usage 都不可作为真实消费证据，省略而不伪造零。
        const usage = message.usage;
        const usageReliable =
          !errored && !aborted && Boolean(usage) && (usage.input > 0 || usage.output > 0 || usage.totalTokens > 0);
        emitModelEnd(id, startedAt, {
          status: aborted ? "aborted" : errored ? "error" : "ok",
          output,
          stopReason: message.stopReason,
          errorMessage: message.errorMessage,
          usage: usageReliable
            ? {
                inputTokens: usage.input,
                outputTokens: usage.output,
                cacheReadTokens: usage.cacheRead,
                cacheWriteTokens: usage.cacheWrite,
                totalTokens: usage.totalTokens,
              }
            : undefined,
          metadata: {
            // 采集层级如实标注：provider 未触发 onPayload 时只有 effective_context，不编造 payload。
            captureLevels: capture.providerPayload ? ["effective_context", "provider_payload"] : ["effective_context"],
            providerPayload: capture.providerPayload,
            ...(usageReliable ? {} : { usageAvailable: false }),
          },
        });
      })
      .catch((err: unknown) => {
        // 契约上 result() 不应 reject；防御性兜底，不影响 pi 消费原流。
        emitModelEnd(id, startedAt, {
          status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          metadata: { usageAvailable: false },
        });
      });
  };

  agent.streamFunction = (model, context, options?: SimpleStreamOptions) => {
    if (settled) {
      // 已收尾（settle 后立即 restore，正常不可达）。防御性直通，不再计数。
      return originalStreamFn.call(agent, model, context, options);
    }
    modelCalls += 1;
    const id = randomUUID();
    const startedAt = Date.now();
    const callPurpose: "diagnosis" | "compaction" = context.systemPrompt?.startsWith(SUMMARIZATION_PROMPT_PREFIX)
      ? "compaction"
      : "diagnosis";

    // onPayload 链式捕获：先快照 payload，再原样转发原回调；保留其异步返回值与替换语义。
    const originalOnPayload = options?.onPayload;
    const capture: { providerPayload?: ObservationText } = {};
    const wrappedOptions: SimpleStreamOptions | undefined =
      options === undefined
        ? options
        : {
            ...options,
            onPayload: (payload, m) => {
              capture.providerPayload = observeText(payload, maxEventBytes);
              return originalOnPayload?.(payload, m);
            },
          };

    sink.record({
      ...envelope(++seq),
      kind: "model_start",
      logicalObservationId: id,
      parentLogicalId: scopeId,
      model: model.id,
      provider: model.provider,
      callPurpose,
      captureLevel: "effective_context",
      input: observeText(
        { systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools },
        maxEventBytes,
      ),
    });

    let stream: AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
    try {
      stream = originalStreamFn.call(agent, model, context, wrappedOptions);
    } catch (err) {
      // 契约不允许 throw；防御性兜底：记录错误并继续向业务抛出原错误。
      emitModelEnd(id, startedAt, {
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        metadata: { usageAvailable: false },
      });
      throw err;
    }
    if (typeof (stream as { then?: unknown }).then === "function") {
      return (stream as Promise<AssistantMessageEventStream>).then(
        (s) => {
          observeStream(s, id, startedAt, capture);
          return s;
        },
        (err: unknown) => {
          emitModelEnd(id, startedAt, {
            status: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
            metadata: { usageAvailable: false },
          });
          throw err;
        },
      );
    }
    const eventStream = stream as AssistantMessageEventStream;
    observeStream(eventStream, id, startedAt, capture);
    return eventStream;
  };

  return {
    get modelCalls() {
      return modelCalls;
    },
    settlePending() {
      if (settled) return;
      settled = true;
      const now = Date.now();
      for (const [id, startedAt] of inFlight) {
        sink.record({
          ...envelope(++seq),
          kind: "model_end",
          logicalObservationId: id,
          parentLogicalId: scopeId,
          status: "aborted",
          metadata: {
            durationMs: now - startedAt,
            usageAvailable: false,
            note: "pending_settled_on_terminal",
          },
        });
      }
      inFlight.clear();
      agent.streamFunction = originalStreamFn;
    },
  };
}
