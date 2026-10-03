// Pi streamFunction 包装（pi-observer）单元测试（观测方案 §5.1/§11）：
// 不修改请求、不多消费流、保留原 onPayload 的返回/替换值、同步/异步失败与 abort 均有收尾、
// 一次模型请求只计一次、settlePending 后晚到采集被丢弃。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import { attachPiObserver } from "../../src/observability/pi-observer.ts";
import { noopObservationSink } from "../../src/observability/noop.ts";
import type { ObservationEvent, ObservationSink } from "../../src/observability/types.ts";

const MODEL = { id: "deepseek-v4-flash", provider: "deepseek" } as unknown as Model<"openai-completions">;

function okMessage(usage?: Partial<AssistantMessage["usage"]>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...usage,
    },
    stopReason: "stop",
    timestamp: 0,
  } as unknown as AssistantMessage;
}

/** 最小事件流替身：观察者只用 result()；迭代器若被观察者消费即测试失败。 */
function fakeStream(
  final: AssistantMessage | Promise<AssistantMessage>,
  opts: { iteratorForbidden?: boolean; resultReject?: boolean } = {},
): AssistantMessageEventStream {
  return {
    result: () => (opts.resultReject ? Promise.reject(new Error("stream broken")) : Promise.resolve(final)),
    [Symbol.asyncIterator]() {
      if (opts.iteratorForbidden) throw new Error("观察者不得消费流迭代器");
      throw new Error("测试未预期消费迭代器");
    },
  } as unknown as AssistantMessageEventStream;
}

interface Harness {
  events: ObservationEvent[];
  sink: ObservationSink;
  makeSession(original: (model: Model<"openai-completions">, context: Context, options?: { onPayload?: unknown }) => AssistantMessageEventStream, onPayload?: unknown): {
    session: { agent: { streamFunction: unknown; onPayload?: unknown } };
    agent: { streamFunction: unknown; onPayload?: unknown };
  };
}

function makeHarness(): Harness {
  const events: ObservationEvent[] = [];
  const sink: ObservationSink = {
    record(event) {
      events.push(event);
    },
  };
  return {
    events,
    sink,
    makeSession(original, onPayload) {
      const agent: { streamFunction: unknown; onPayload?: unknown } = { streamFunction: original, onPayload };
      return { session: { agent }, agent };
    },
  };
}

const SCOPE = "attempt-scope";
const MAX_BYTES = 524_288;

test("包装一次请求：计数 +1，model_start/end 成对，父节点为 scope，返回原流引用", async () => {
  const h = makeHarness();
  const stream = fakeStream(okMessage());
  const originalCalls: unknown[] = [];
  const { session } = h.makeSession((_m, ctx) => {
    originalCalls.push(ctx);
    return stream;
  });
  const controller = attachPiObserver({ session: session as never, sink: h.sink, scopeId: SCOPE, maxEventBytes: MAX_BYTES });

  const context = { systemPrompt: "sys", messages: [], tools: [] } as unknown as Context;
  const returned = (session.agent.streamFunction as (m: unknown, c: Context, o?: unknown) => AssistantMessageEventStream)(
    MODEL,
    context,
  );
  assert.equal(returned, stream, "同步路径必须原样返回原流供 pi 消费");
  assert.equal(originalCalls.length, 1);
  assert.equal(originalCalls[0], context, "不得替换或复制 context 引用");
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(controller.modelCalls, 1);
  const starts = h.events.filter((e) => e.kind === "model_start");
  const ends = h.events.filter((e) => e.kind === "model_end");
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(starts[0].logicalObservationId, ends[0].logicalObservationId);
  assert.equal(starts[0].parentLogicalId, SCOPE);
  assert.equal(ends[0].status, "ok");
  const end = ends[0] as Extract<ObservationEvent, { kind: "model_end" }>;
  assert.equal(end.usage?.inputTokens, 10);
  assert.equal(end.usage?.totalTokens, 15);
});

test("多次请求累加计数；compaction 以 system prompt 标记识别 callPurpose", async () => {
  const h = makeHarness();
  const { session } = h.makeSession(() => fakeStream(okMessage()));
  const controller = attachPiObserver({ session: session as never, sink: h.sink, scopeId: SCOPE, maxEventBytes: MAX_BYTES });
  const call = (session.agent.streamFunction as (m: unknown, c: Context) => AssistantMessageEventStream);
  call(MODEL, { messages: [] } as unknown as Context);
  call(MODEL, { systemPrompt: "You are a context summarization assistant. ...", messages: [] } as unknown as Context);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(controller.modelCalls, 2);
  const purposes = h.events.filter((e) => e.kind === "model_start").map((e) => (e as { callPurpose: string }).callPurpose);
  assert.deepEqual(purposes, ["diagnosis", "compaction"]);
});

test("stopReason=error：status=error 且省略 usage（零初始化不伪造为真实消费）", async () => {
  const h = makeHarness();
  const message = { ...okMessage(), stopReason: "error", errorMessage: "rate limited", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } as unknown as AssistantMessage;
  const { session } = h.makeSession(() => fakeStream(message));
  attachPiObserver({ session: session as never, sink: h.sink, scopeId: SCOPE, maxEventBytes: MAX_BYTES });
  (session.agent.streamFunction as (m: unknown, c: Context) => AssistantMessageEventStream)(MODEL, { messages: [] } as unknown as Context);
  await new Promise((r) => setTimeout(r, 0));
  const end = h.events.find((e) => e.kind === "model_end") as Extract<ObservationEvent, { kind: "model_end" }>;
  assert.equal(end.status, "error");
  assert.equal(end.usage, undefined);
  assert.equal(end.errorMessage, "rate limited");
});

test("onPayload 链式：快照 payload、原回调收到原 payload、返回值（替换语义）原样保留", async () => {
  const h = makeHarness();
  const replacement = { replaced: true };
  const seen: unknown[] = [];
  let capturedByObserver: unknown;
  const payload = { body: "request" };
  const { session } = h.makeSession(
    (_m, _c, options) => {
      const cb = options?.onPayload as ((p: unknown) => unknown) | undefined;
      capturedByObserver = cb?.(payload);
      return fakeStream(okMessage());
    },
    (p: unknown) => {
      seen.push(p);
      return replacement;
    },
  );
  attachPiObserver({ session: session as never, sink: h.sink, scopeId: SCOPE, maxEventBytes: MAX_BYTES });
  (session.agent.streamFunction as (m: unknown, c: Context, o: { onPayload?: unknown }) => AssistantMessageEventStream)(
    MODEL,
    { messages: [] } as unknown as Context,
    { onPayload: session.agent.onPayload },
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen, [payload], "原回调必须收到原始 payload");
  assert.equal(capturedByObserver, replacement, "替换语义的返回值必须原样传递");
  const end = h.events.find((e) => e.kind === "model_end") as Extract<ObservationEvent, { kind: "model_end" }>;
  assert.deepEqual(end.metadata?.captureLevels, ["effective_context", "provider_payload"]);
  assert.ok((end.metadata?.providerPayload as { text: string }).text.includes("request"));
});

test("settlePending：在飞 generation 结算为 aborted；晚到 result 不再产生事件；原 streamFunction 恢复", async () => {
  const h = makeHarness();
  let resolveResult: (m: AssistantMessage) => void = () => {};
  const deferredStream = fakeStream(new Promise<AssistantMessage>((resolve) => (resolveResult = resolve)));
  const original = () => deferredStream;
  const { session } = h.makeSession(original);
  const controller = attachPiObserver({ session: session as never, sink: h.sink, scopeId: SCOPE, maxEventBytes: MAX_BYTES });
  const wrapped = session.agent.streamFunction as (m: unknown, c: Context) => AssistantMessageEventStream;
  wrapped(MODEL, { messages: [] } as unknown as Context);
  controller.settlePending();
  const endsAfterSettle = h.events.filter((e) => e.kind === "model_end").length;
  assert.equal(endsAfterSettle, 1, "在飞请求应被结算为 aborted");
  assert.equal((h.events.at(-1) as { status: string }).status, "aborted");
  assert.equal(session.agent.streamFunction, original, "settle 后必须恢复原函数");
  // 晚到的 result()：不得再产生事件
  resolveResult(okMessage());
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.events.filter((e) => e.kind === "model_end").length, 1);
});

test("noop sink 下计数仍正确（关闭观测不改变 modelTurns 口径）", async () => {
  const { session } = makeHarness().makeSession(() => fakeStream(okMessage()));
  const controller = attachPiObserver({ session: session as never, sink: noopObservationSink, scopeId: SCOPE, maxEventBytes: MAX_BYTES });
  (session.agent.streamFunction as (m: unknown, c: Context) => AssistantMessageEventStream)(MODEL, { messages: [] } as unknown as Context);
  (session.agent.streamFunction as (m: unknown, c: Context) => AssistantMessageEventStream)(MODEL, { messages: [] } as unknown as Context);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(controller.modelCalls, 2);
});

test("超预算输入按字节截断并标记 originalBytes", async () => {
  const h = makeHarness();
  const { session } = h.makeSession(() => fakeStream(okMessage()));
  attachPiObserver({ session: session as never, sink: h.sink, scopeId: SCOPE, maxEventBytes: 64 });
  const longText = "x".repeat(1_000);
  (session.agent.streamFunction as (m: unknown, c: Context) => AssistantMessageEventStream)(MODEL, {
    systemPrompt: longText,
    messages: [],
  } as unknown as Context);
  await new Promise((r) => setTimeout(r, 0));
  const start = h.events.find((e) => e.kind === "model_start") as Extract<ObservationEvent, { kind: "model_start" }>;
  assert.equal(start.input?.truncated, true);
  assert.equal(start.input?.originalBytes > 64, true);
  assert.ok(Buffer.byteLength(start.input?.text ?? "", "utf8") <= 64);
});
