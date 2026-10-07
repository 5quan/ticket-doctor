// 全局 OTel provider（plan §6）：SDK runExperiment 的 item 根 span 经全局 tracer 创建，
// 必须注册带 LangfuseSpanProcessor 的全局 provider 才会真正导出（isOtelRegistered 检查）。
//
// 关键（已踩坑）：`@langfuse/tracing` 的 startActiveObservation 依赖 OTel 的 **全局 context manager**
// 把 item 根 span 设为 active。仅注册 provider 不够——没有 AsyncLocalStorageContextManager 时
// `context.active()` 恒为 ROOT_CONTEXT，业务 recorder 会另起一条 trace（joinActiveContext 失效）。
// 因此这里同时注册 context manager + 全局 provider + Langfuse isolated provider。
//
// 资源所有权：本 provider 属于**整个实验**——只在实验结束 flush/shutdown 一次，
// 不随单案例关闭；案例内业务 span 由 src/observability 的 recorder 负责（各自 provider）。
import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import type { LfClientConfig } from "./client.ts";

export interface EvalOtel {
  /** 实验结束调用一次：flush 导出并关闭（plan §6「实验结束完成 SDK 分数 flush 和 OTel 导出」）。 */
  shutdown(): Promise<void>;
}

/** 全局 context manager 只能设置一次（进程级）；重复调用会告警，这里幂等处理。 */
function ensureContextManager(): void {
  try {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  } catch {
    // 已被其他 SDK 注册（如 NodeSDK）：沿用现有 manager，不覆盖。
  }
}

export function setupEvalOtel(cfg: LfClientConfig, environment = "eval"): EvalOtel {
  ensureContextManager();
  const processor = new LangfuseSpanProcessor({
    publicKey: cfg.publicKey,
    secretKey: cfg.secretKey,
    baseUrl: cfg.baseUrl,
    environment,
    // SDK 的实验根 span 使用官方 tracer 名；本进程内没有自动埋点噪声，全部放行。
    shouldExportSpan: () => true,
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  // 1) Langfuse SDK 走 isolated provider；2) 全局 provider 让 isOtelRegistered() 为真（否则 SDK 告警且不认为已接入）。
  setLangfuseTracerProvider(provider);
  try {
    trace.setGlobalTracerProvider(provider);
  } catch {
    // 全局 provider 已注册：isolated provider 仍生效，实验根 span 依旧导出。
  }
  return {
    async shutdown(): Promise<void> {
      await provider.forceFlush().catch(() => {});
      await provider.shutdown().catch(() => {});
    },
  };
}
