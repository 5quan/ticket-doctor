// 实验基础设施的资源所有权与异步上下文；内存 processor，不访问服务或真实模型。
import assert from "node:assert/strict";
import { test } from "node:test";
import { context, createContextKey, ProxyTracerProvider, ROOT_CONTEXT, trace, type Span } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { getLangfuseTracerProvider, setLangfuseTracerProvider, startActiveObservation, startObservation } from "@langfuse/tracing";
import { setupEvalOtel } from "../../src/eval/lf/otel.ts";
import { createLangfuseRecorder } from "../../src/observability/langfuse.ts";

const CONFIG = { baseUrl: "http://lf.invalid", publicKey: "pk-test", secretKey: "sk-test" };

function spyProcessor() {
  const ended: ReadableSpan[] = [];
  const calls = { flush: 0, shutdown: 0 };
  const processor: SpanProcessor = {
    onStart(_span: Span) {},
    onEnd(span: ReadableSpan) { ended.push(span); },
    async forceFlush() { calls.flush++; },
    async shutdown() { calls.shutdown++; },
  };
  return { processor, ended, calls };
}

function resetGlobals(): void {
  setLangfuseTracerProvider(null);
  context.disable();
  trace.disable();
}

function globalProvider() {
  const provider = trace.getTracerProvider();
  return provider instanceof ProxyTracerProvider ? provider.getDelegate() : provider;
}

test("eval OTel：ALS 跨 await 隔离并发 item，实验 provider 只关闭一次", async () => {
  resetGlobals();
  const spy = spyProcessor();
  const runtime = setupEvalOtel(CONFIG, "test", spy.processor);
  try {
    assert.equal(getLangfuseTracerProvider(), runtime.provider);
    assert.equal(globalProvider(), runtime.provider);
    await Promise.all(["item-a", "item-b"].map((name) => startActiveObservation(name, async (parent) => {
      await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(trace.getSpan(context.active())?.spanContext().spanId, parent.id);
      const child = startObservation(`${name}-business`);
      child.end();
    })));
    for (const name of ["item-a", "item-b"]) {
      const parent = spy.ended.find((span) => span.name === name)!;
      const child = spy.ended.find((span) => span.name === `${name}-business`)!;
      assert.equal(child.parentSpanContext?.spanId, parent.spanContext().spanId);
      assert.equal(child.spanContext().traceId, parent.spanContext().traceId);
    }
    assert.notEqual(spy.ended.find((span) => span.name === "item-a")!.spanContext().traceId, spy.ended.find((span) => span.name === "item-b")!.spanContext().traceId);
    const first = runtime.shutdown();
    assert.equal(first, runtime.shutdown(), "重复关闭共享同一 promise");
    await first;
    await runtime.shutdown();
    assert.deepEqual(spy.calls, { flush: 1, shutdown: 1 });
    assert.notEqual(globalProvider(), runtime.provider);
    assert.equal(getLangfuseTracerProvider(), trace.getTracerProvider());
    const key = createContextKey("closed-experiment-manager");
    context.with(ROOT_CONTEXT.setValue(key, true), () => {
      assert.equal(context.active().getValue(key), undefined, "自有全局 context manager 已释放");
    });
  } finally {
    await runtime.shutdown();
    resetGlobals();
  }
});

test("eval OTel：借用已有全局 manager/provider，恢复原 isolated provider", async () => {
  resetGlobals();
  const externalSpy = spyProcessor();
  const externalProvider = new BasicTracerProvider({ spanProcessors: [externalSpy.processor] });
  const isolatedSpy = spyProcessor();
  const externalIsolated = new BasicTracerProvider({ spanProcessors: [isolatedSpy.processor] });
  const manager = new AsyncLocalStorageContextManager().enable();
  let managerClosed = 0;
  const disable = manager.disable.bind(manager);
  manager.disable = () => { managerClosed++; return disable(); };
  assert.equal(context.setGlobalContextManager(manager), true);
  assert.equal(trace.setGlobalTracerProvider(externalProvider), true);
  setLangfuseTracerProvider(externalIsolated);
  const spy = spyProcessor();
  const runtime = setupEvalOtel(CONFIG, "test", spy.processor);
  try {
    startObservation("experiment-owned").end();
    await runtime.shutdown();
    assert.deepEqual(spy.calls, { flush: 1, shutdown: 1 });
    assert.deepEqual(externalSpy.calls, { flush: 0, shutdown: 0 });
    assert.deepEqual(isolatedSpy.calls, { flush: 0, shutdown: 0 });
    assert.equal(managerClosed, 0);
    assert.equal(globalProvider(), externalProvider);
    assert.equal(getLangfuseTracerProvider(), externalIsolated);
    const key = createContextKey("external-owner");
    await context.with(ROOT_CONTEXT.setValue(key, "present"), async () => {
      await Promise.resolve();
      assert.equal(context.active().getValue(key), "present");
    });
  } finally {
    await runtime.shutdown();
    resetGlobals();
    await externalProvider.shutdown();
    await externalIsolated.shutdown();
  }
});

test("eval OTel：后续组件接管全局和 isolated 资源，旧实验关闭不覆盖新组件", async () => {
  resetGlobals();
  const spy = spyProcessor();
  const runtime = setupEvalOtel(CONFIG, "test", spy.processor);
  const externalSpy = spyProcessor();
  const externalProvider = new BasicTracerProvider({ spanProcessors: [externalSpy.processor] });
  const replacementManager = new AsyncLocalStorageContextManager().enable();
  let managerClosed = 0;
  const disable = replacementManager.disable.bind(replacementManager);
  replacementManager.disable = () => { managerClosed++; return disable(); };
  context.disable();
  trace.disable();
  context.setGlobalContextManager(replacementManager);
  trace.setGlobalTracerProvider(externalProvider);
  setLangfuseTracerProvider(externalProvider);
  try {
    await runtime.shutdown();
    assert.deepEqual(spy.calls, { flush: 1, shutdown: 1 });
    assert.deepEqual(externalSpy.calls, { flush: 0, shutdown: 0 });
    assert.equal(managerClosed, 0);
    assert.equal(globalProvider(), externalProvider);
    assert.equal(getLangfuseTracerProvider(), externalProvider);
    await startActiveObservation("replacement-owner", async (parent) => {
      await Promise.resolve();
      assert.equal(trace.getSpan(context.active())?.spanContext().spanId, parent.id);
    });
  } finally {
    await runtime.shutdown();
    resetGlobals();
    await externalProvider.shutdown();
  }
});

test("eval OTel：flush/shutdown 故障仍释放自有全局资源", async () => {
  resetGlobals();
  const spy = spyProcessor();
  spy.processor.forceFlush = async () => { spy.calls.flush++; throw new Error("flush failed"); };
  spy.processor.shutdown = async () => { spy.calls.shutdown++; throw new Error("shutdown failed"); };
  const runtime = setupEvalOtel(CONFIG, "test", spy.processor);
  try {
    await runtime.shutdown();
    assert.deepEqual(spy.calls, { flush: 1, shutdown: 1 });
    assert.notEqual(globalProvider(), runtime.provider);
    assert.equal(getLangfuseTracerProvider(), trace.getTracerProvider());
  } finally {
    resetGlobals();
  }
});

test("eval OTel：业务 recorder 借用 provider，结束节点但不关闭实验导出资源", async () => {
  resetGlobals();
  const spy = spyProcessor();
  const runtime = setupEvalOtel(CONFIG, "test", spy.processor);
  const recorder = createLangfuseRecorder({
    ...CONFIG,
    enabled: true,
    environment: "test",
    maxEventBytes: 524_288,
    shutdownMs: 100,
  }, undefined, { joinActiveContext: true, tracerProvider: runtime.provider })!;
  try {
    const identity = { investigationId: "inv", runId: "run", attemptId: "attempt", generation: 1 };
    await startActiveObservation("dataset-item", async () => {
      await Promise.resolve();
      recorder.beginAttempt(identity, { question: "question", engine: "fake" });
      // 模拟执行异常，没有 endAttempt；关闭 recorder 必须清理在飞业务节点。
    });
    await recorder.shutdown();
    assert.equal(spy.calls.shutdown, 0, "借用者不得关闭 provider");
    assert.ok(spy.ended.some((span) => span.name === "diagnose-turn"), "异常残留业务节点在关闭时结束");
    const root = spy.ended.find((span) => span.name === "dataset-item")!;
    const business = spy.ended.find((span) => span.name === "diagnose-turn")!;
    assert.equal(business.parentSpanContext?.spanId, root.spanContext().spanId);
    assert.equal(business.spanContext().traceId, root.spanContext().traceId);
    await runtime.shutdown();
    assert.equal(spy.calls.shutdown, 1);
  } finally {
    await recorder.shutdown();
    await runtime.shutdown();
    resetGlobals();
  }
});
