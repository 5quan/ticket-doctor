// 实验级 OTel 基础设施：SDK runExperiment 和业务 recorder 共用一个 provider/processor。
// startActiveObservation 依赖全局 AsyncLocalStorage context manager，把 item 根 observation
// 及实验属性沿 task → runCase → executeRun 的 async 链传递；仅注册 provider 不够。
// 全局 provider 用于 SDK isOtelRegistered 检查，isolated provider 决定 Langfuse span 的实际导出。
// 资源属于整个实验，案例及 recorder 只借用，实验结束才统一 flush/shutdown。
import { context, createContextKey, ProxyTracerProvider, ROOT_CONTEXT, trace, type TracerProvider } from "@opentelemetry/api";
import { BasicTracerProvider, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { getLangfuseTracerProvider, setLangfuseTracerProvider } from "@langfuse/tracing";
import type { LfClientConfig } from "./client.ts";

export interface EvalOtel {
  /** 实验拥有；业务 recorder 借用，不得自行关闭。 */
  provider: BasicTracerProvider;
  /** 实验边界调用；并发或重复调用只 flush/shutdown 一次。 */
  shutdown(): Promise<void>;
}

function registeredProvider(): TracerProvider {
  const provider = trace.getTracerProvider();
  return provider instanceof ProxyTracerProvider ? provider.getDelegate() : provider;
}

export function setupEvalOtel(
  cfg: LfClientConfig,
  environment = "eval",
  /** 离线测试替换 exporter，不产生网络请求。 */
  processorOverride?: SpanProcessor,
): EvalOtel {
  const processor = processorOverride ?? new LangfuseSpanProcessor({
    publicKey: cfg.publicKey,
    secretKey: cfg.secretKey,
    baseUrl: cfg.baseUrl,
    environment,
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const previousGlobalProvider = trace.getTracerProvider();
  const previousLangfuseProvider = getLangfuseTracerProvider();
  const manager = new AsyncLocalStorageContextManager().enable();
  // OTel 重复注册返回 false，不抛错：保留已有基础设施，并立即释放未注册的 manager。
  const ownsContextManager = context.setGlobalContextManager(manager);
  if (!ownsContextManager) manager.disable();
  const ownsGlobalProvider = trace.setGlobalTracerProvider(provider);
  setLangfuseTracerProvider(provider);
  let shutdownPromise: Promise<void> | undefined;
  return {
    provider,
    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        try {
          await provider.forceFlush().catch(() => {});
          await provider.shutdown().catch(() => {});
        } finally {
          // 若其他组件已接管 isolated/global provider，不覆盖或关闭它的资源。
          if (getLangfuseTracerProvider() === provider) {
            setLangfuseTracerProvider(previousLangfuseProvider === previousGlobalProvider ? null : previousLangfuseProvider);
          }
          if (ownsGlobalProvider && registeredProvider() === provider) trace.disable();
          if (ownsContextManager) {
            // public context.with + manager.active 检查当前全局 manager 仍是本实例。
            const probe = ROOT_CONTEXT.setValue(createContextKey("ticket-doctor.eval-otel-owner"), true);
            if (context.with(probe, () => manager.active() === probe)) context.disable();
            else manager.disable();
          }
        }
      })();
      return shutdownPromise;
    },
  };
}
