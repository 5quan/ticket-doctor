// Langfuse tracing SDK 适配（观测方案 §6/§8）：Host 侧 SDK 初始化、显式 observation registry、导出与关闭。
//
// 设计约束：
//   * 用官方 SDK observation 显式建父子节点，保留 provider/processor 基础设施；
//     跨 IPC/回调不依赖 AsyncLocalStorage 自动延续（观测方案 §6）；
//   * 不加载 Node 自动埋点（@opentelemetry/auto-instrumentations 等），避免 HTTP/DB 噪声 span；
//   * 未启用/缺配置 → 不创建 exporter、不连云端；启用但缺配置打印不含秘密的错误并降级 noop；
//   * best-effort：采集异常自捕获、告警节流，绝不穿透到业务协议路径；
//   * 关闭有界：shutdown 与 TD_OBSERVABILITY_SHUTDOWN_MS 竞速，不阻塞进程退出。
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { ROOT_CONTEXT, SpanStatusCode, context, trace, type Context, type TracerProvider } from "@opentelemetry/api";
import {
  getLangfuseTracerProvider,
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseObservationAttributes,
  type LangfuseAgent,
  type LangfuseGeneration,
  type LangfuseSpan,
  type LangfuseTool,
  type ObservationLevel,
} from "@langfuse/tracing";
// plan §2：枚举在 5.13 归属 @langfuse/core，显式从此导入（tracing 仅为向后兼容的再导出）。
import { LangfuseOtelSpanAttributes as LF, propagateAttributes } from "@langfuse/core";
import type { ObservabilityConfig } from "../config/index.ts";
import type { DiagnosisReport } from "../domain/types.ts";
import type { ObservationEvent, ObservationStatus } from "./types.ts";

/** Host 注入的运行身份（Runner 事件不携带身份，映射由 Host 持有）。 */
export interface ObservationRunIdentity {
  investigationId: string;
  runId: string;
  attemptId: string;
  generation: number;
}

export interface AttemptBeginMeta {
  /** 本轮原始用户问题（trace 根 input）。 */
  question: string;
  service?: string;
  environment?: string;
  engine: string;
}

export interface AttemptOutcome {
  status: ObservationStatus;
  /** report / reply(chat|clarify) / 终态错误码等稳定结果类型。 */
  kind?: string;
  summary?: string;
  error?: string;
}

const levelOf = (status: ObservationStatus): ObservationLevel =>
  status === "ok" ? "DEFAULT" : "ERROR";

function jsonAttr(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return '"[unserializable]"';
  }
}

type BusinessObservation = LangfuseSpan | LangfuseAgent | LangfuseGeneration | LangfuseTool;

interface NodeRecord {
  observation: BusinessObservation;
  type: "generation" | "tool" | "agent" | "span";
  metadata: Record<string, unknown>;
  parentLogicalId?: string;
  toolCallId?: string;
  ended: boolean;
  endedAt?: number;
}

interface AttemptRecord {
  root: NodeRecord;
  agent: NodeRecord;
  /** 保留已结束节点作 tombstone，重复 start/end 不会重开或覆盖在飞节点。 */
  children: Map<string, NodeRecord>;
  auditAgents: Map<string, NodeRecord>;
  agentStarted: boolean;
  /** 有界缓存先于 start/父节点到达的事件；attempt 终态时释放。 */
  pending: ObservationEvent[];
  /** 普通模式从 ROOT_CONTEXT 开始；评测模式保存实验 item 的完整传播上下文。 */
  base: Context;
}

export interface ObservationRecorder {
  /** attempt 开始：建 trace 根与 diagnosis-attempt agent 节点；返回 scopeId（失败返回 undefined）。 */
  beginAttempt(identity: ObservationRunIdentity, meta: AttemptBeginMeta): string | undefined;
  /** 记录 Runner 转发或本进程产生的中立事件；异常自捕获。 */
  record(event: ObservationEvent, identity: ObservationRunIdentity): void;
  /** report-validation span：草稿 → 校验后报告与程序修正。 */
  recordReportValidation(
    identity: ObservationRunIdentity,
    data: { draft: unknown; report: DiagnosisReport; startedAt: number },
  ): void;
  /** audit-apply span：独立审计判定 → 程序应用后的报告（OQ-30）。 */
  recordAuditApplication(
    identity: ObservationRunIdentity,
    data: {
      policyVersion: string;
      audit?: unknown;
      failure?: string;
      auditRounds?: number;
      report: DiagnosisReport;
      startedAt: number;
    },
  ): void;
  /** attempt 终态：关 agent（若未关）与 trace 根，清理 registry。幂等。 */
  endAttempt(identity: ObservationRunIdentity, outcome: AttemptOutcome): void;
  /** 有界关闭：flush 导出；超过 config.shutdownMs 不阻塞退出。 */
  shutdown(): Promise<void>;
}

const identityKey = (id: ObservationRunIdentity): string =>
  `${id.investigationId}:${id.runId}:${id.attemptId}:${id.generation}`;

export function createLangfuseRecorder(
  config: ObservabilityConfig,
  /** 测试注入：内存 processor，不发网络请求。 */
  processorOverride?: SpanProcessor,
  /** 评测只借用进程拥有的 provider，不负责 flush/shutdown 它。 */
  opts?: {
    joinActiveContext?: boolean;
    prompt?: { name: string; version: number };
    tracerProvider?: TracerProvider;
  },
): ObservationRecorder | undefined {
  if (!config.enabled) return undefined;
  const missing = [
    !config.baseUrl && "LANGFUSE_BASE_URL",
    !config.publicKey && "LANGFUSE_PUBLIC_KEY",
    !config.secretKey && "LANGFUSE_SECRET_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(
      `[ticket-doctor] 观测已启用但缺少配置：${missing.join("、")}。降级为不采集（业务不受影响）；请检查运行环境变量。`,
    );
    return undefined;
  }

  let warnCount = 0;
  const warnThrottled = (message: string, err: unknown): void => {
    if (warnCount >= 3) return;
    warnCount += 1;
    console.warn(`[ticket-doctor] 观测采集异常（已忽略，不影响业务）：${message}`, err instanceof Error ? err.message : err);
  };
  let ownedProvider: BasicTracerProvider | undefined;
  let provider: TracerProvider;
  try {
    if (opts?.tracerProvider) {
      provider = opts.tracerProvider;
    } else {
      const processor = processorOverride ?? new LangfuseSpanProcessor({
        publicKey: config.publicKey!,
        secretKey: config.secretKey!,
        baseUrl: config.baseUrl!,
        environment: config.environment,
        ...(config.release ? { release: config.release } : {}),
      });
      ownedProvider = new BasicTracerProvider({ spanProcessors: [processor] });
      provider = ownedProvider;
    }
  } catch (err) {
    warnThrottled("initialize", err);
    return undefined;
  }

  const registry = new Map<string, AttemptRecord>();
  // 长驻 Host 的 identity tombstone 有界；在飞 attempt 内所有逻辑节点保留至终态。
  const completedAttempts = new Set<string>();
  const maxPendingEvents = 256;
  const maxCompletedAttempts = 1024;
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  /** SDK provider 是进程 singleton；仅同步创建期间切换，finally 恢复，不能跨 await。 */
  const withRecorderProvider = <T>(fn: () => T): T => {
    const previousGlobal = trace.getTracerProvider();
    const previous = getLangfuseTracerProvider();
    setLangfuseTracerProvider(provider);
    try {
      return fn();
    } finally {
      // 默认 global 回退应恢复为 null，不能把当前 Proxy 固定成 isolated provider。
      setLangfuseTracerProvider(previous === previousGlobal ? null : previous);
    }
  };

  const eventDate = (timestamp: string | number | undefined): Date | undefined => {
    const millis = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
    return millis !== undefined && Number.isFinite(millis) ? new Date(millis) : undefined;
  };

  const activeBase = (): Context => {
    if (!opts?.joinActiveContext) return ROOT_CONTEXT;
    const active = context.active();
    return trace.getSpan(active) ? active : ROOT_CONTEXT;
  };

  const createNode = (
    name: string,
    type: NodeRecord["type"],
    attrs: LangfuseObservationAttributes,
    base: Context,
    parent?: NodeRecord,
    timestamp?: string | number,
    parentLogicalId?: string,
  ): NodeRecord => {
    const startTime = eventDate(timestamp);
    const attributes = { environment: config.environment, ...attrs };
    const observation = withRecorderProvider(() => context.with(base, () => {
      // 5.13.1 的父 observation.startObservation 不接受 startTime。
      // 有事件时间时用顶层 SDK API + 显式 parentSpanContext，保留 IPC 原始时间。
      if (parent && !startTime) {
        switch (type) {
          case "generation": return parent.observation.startObservation(name, attributes, { asType: "generation" });
          case "tool": return parent.observation.startObservation(name, attributes, { asType: "tool" });
          case "agent": return parent.observation.startObservation(name, attributes, { asType: "agent" });
          case "span": return parent.observation.startObservation(name, attributes);
        }
      }
      const options = {
        ...(startTime ? { startTime } : {}),
        ...(parent ? { parentSpanContext: parent.observation.otelSpan.spanContext() } : {}),
      };
      switch (type) {
        case "generation": return startObservation(name, attributes, { ...options, asType: "generation" });
        case "tool": return startObservation(name, attributes, { ...options, asType: "tool" });
        case "agent": return startObservation(name, attributes, { ...options, asType: "agent" });
        case "span": return startObservation(name, attributes, options);
      }
    }));
    return { observation, type, metadata: attrs.metadata ?? {}, parentLogicalId, ended: false };
  };

  const updateNode = (node: NodeRecord, attrs: LangfuseObservationAttributes): void => {
    if (node.ended) return;
    if (attrs.metadata) node.metadata = { ...node.metadata, ...attrs.metadata };
    node.observation.update({ ...attrs, ...(attrs.metadata ? { metadata: node.metadata } : {}) });
  };

  const finishNode = (
    node: NodeRecord,
    status: ObservationStatus,
    message?: string,
    timestamp?: string | number,
  ): void => {
    if (node.ended) return;
    const endTime = eventDate(timestamp);
    try {
      updateNode(node, { level: levelOf(status), ...(message ? { statusMessage: message } : {}) });
      // SDK level/statusMessage 没有 OTel status.code 的等价项；保留错误状态兼容。
      node.observation.otelSpan.setStatus(
        status === "ok"
          ? { code: SpanStatusCode.OK }
          : { code: SpanStatusCode.ERROR, message: message ?? status },
      );
    } catch (err) {
      warnThrottled("finishObservation", err);
    } finally {
      node.ended = true;
      node.endedAt = endTime?.getTime() ?? Date.now();
      try {
        node.observation.end(endTime);
      } catch (err) {
        warnThrottled("endObservation", err);
      }
    }
  };

  const closeAttempt = (k: string, rec: AttemptRecord, outcome: AttemptOutcome): void => {
    registry.delete(k);
    completedAttempts.add(k);
    if (completedAttempts.size > maxCompletedAttempts) completedAttempts.delete(completedAttempts.values().next().value!);
    for (const node of rec.children.values()) finishNode(node, "error", "attempt_terminal");
    for (const node of rec.auditAgents.values()) finishNode(node, "error", "attempt_terminal");
    finishNode(rec.agent, outcome.status, outcome.error);
    try {
      updateNode(rec.root, { output: outcome });
      // 保留旧平台/evaluator 的 trace IO；实验 trace 的根 IO 由 runExperiment 拥有。
      if (!opts?.joinActiveContext) rec.root.observation.setTraceIO({ output: outcome });
    } catch (err) {
      warnThrottled("attemptOutput", err);
    } finally {
      finishNode(rec.root, outcome.status, outcome.error);
      rec.children.clear();
      rec.auditAgents.clear();
      rec.pending.length = 0;
    }
  };

  const resolveParent = (rec: AttemptRecord, k: string, parentLogicalId: string | undefined): NodeRecord | undefined =>
    parentLogicalId === k ? rec.agent : parentLogicalId ? rec.auditAgents.get(parentLogicalId) : undefined;

  const matchesEnd = (node: NodeRecord, event: ObservationEvent, type: NodeRecord["type"]): boolean =>
    node.type === type && (event.parentLogicalId === undefined || event.parentLogicalId === node.parentLogicalId);

  /** true=已处理或应丢弃，false=依赖尚未到达，加入有界 pending。 */
  const processEvent = (rec: AttemptRecord, k: string, event: ObservationEvent): boolean => {
    switch (event.kind) {
      case "phase_start": {
        if (event.phase === "audit") {
          if (event.logicalObservationId === k || rec.auditAgents.has(event.logicalObservationId) || rec.children.has(event.logicalObservationId)) return true;
          if (event.parentLogicalId !== undefined && event.parentLogicalId !== k) return true;
          const round = typeof event.metadata?.round === "number" ? event.metadata.round : undefined;
          const node = createNode(
            round !== undefined ? `audit#${round + 1}` : "audit",
            "agent",
            { input: event.input ?? null, metadata: event.metadata },
            rec.base,
            rec.root,
            event.timestamp,
            k,
          );
          rec.auditAgents.set(event.logicalObservationId, node);
          return true;
        }
        if (event.logicalObservationId !== k || rec.agentStarted || rec.agent.ended) return true;
        rec.agentStarted = true;
        updateNode(rec.agent, { input: event.input ?? null, metadata: event.metadata });
        return true;
      }
      case "phase_end": {
        const node = event.phase === "audit" ? rec.auditAgents.get(event.logicalObservationId) : rec.agent;
        if (event.phase === "attempt" && event.logicalObservationId !== k) return true;
        if (!node) return !rec.children.has(event.logicalObservationId) && event.logicalObservationId !== k ? false : true;
        if (!matchesEnd(node, event, "agent") || node.ended) return true;
        try {
          updateNode(node, { output: event.output ?? null, metadata: event.metadata });
        } finally {
          finishNode(node, event.status, event.error, event.timestamp);
        }
        return true;
      }
      case "model_start":
      case "tool_start": {
        if (event.logicalObservationId === k || rec.children.has(event.logicalObservationId) || rec.auditAgents.has(event.logicalObservationId)) return true;
        if (!event.parentLogicalId || event.parentLogicalId === event.logicalObservationId) return true;
        const parent = resolveParent(rec, k, event.parentLogicalId);
        if (!parent) return rec.children.has(event.parentLogicalId);
        // 接受先结束父节点、后到达的历史子事件；不接受父节点结束后的新调用。
        const startedAt = eventDate(event.timestamp)?.getTime();
        if (parent.ended && startedAt !== undefined && startedAt > parent.endedAt!) return true;
        let node: NodeRecord;
        if (event.kind === "model_start") {
          node = createNode("model-request", "generation", {
            input: event.input ?? null,
            model: event.model,
            modelParameters: {},
            // prompt 原生关联只属于主诊断 generation，审计/压缩不关联。
            ...(opts?.prompt && parent === rec.agent && event.callPurpose === "diagnosis"
              ? { prompt: { ...opts.prompt, isFallback: false } }
              : {}),
            metadata: {
              callPurpose: event.callPurpose,
              captureLevel: event.captureLevel,
              provider: event.provider ?? null,
              ...(event.metadata ?? {}),
            },
            // 没有真实首个输出时刻，不伪造 completionStartTime（OQ-42）。
          }, rec.base, parent, event.timestamp, event.parentLogicalId);
        } else {
          node = createNode(event.tool, "tool", {
            input: event.input ?? null,
            metadata: { toolCallId: event.toolCallId, ...(event.metadata ?? {}) },
          }, rec.base, parent, event.timestamp, event.parentLogicalId);
          node.toolCallId = event.toolCallId;
        }
        rec.children.set(event.logicalObservationId, node);
        return true;
      }
      case "model_end":
      case "tool_end": {
        const node = rec.children.get(event.logicalObservationId);
        if (!node) return rec.auditAgents.has(event.logicalObservationId) || event.logicalObservationId === k;
        const type = event.kind === "model_end" ? "generation" : "tool";
        if (!matchesEnd(node, event, type) || node.ended) return true;
        if (event.kind === "tool_end" && node.toolCallId !== event.toolCallId) return true;
        try {
          if (event.kind === "model_end") {
            updateNode(node, {
              output: event.output ?? null,
              metadata: {
                stopReason: event.stopReason ?? null,
                errorMessage: event.errorMessage ?? null,
                usageAvailable: event.usage !== undefined,
                ...(event.metadata ?? {}),
              },
              ...(event.usage ? {
                usageDetails: {
                  input: event.usage.inputTokens,
                  output: event.usage.outputTokens,
                  cache_read: event.usage.cacheReadTokens,
                  cache_write: event.usage.cacheWriteTokens,
                  total: event.usage.totalTokens,
                },
              } : {}),
            });
          } else {
            updateNode(node, {
              output: event.output ?? null,
              metadata: {
                toolCallId: event.toolCallId,
                outputChars: event.outputChars ?? null,
                durationMs: event.durationMs,
                ...(event.metadata ?? {}),
              },
            });
          }
        } finally {
          finishNode(node, event.status, event.kind === "model_end" ? event.errorMessage : event.error, event.timestamp);
        }
        return true;
      }
    }
  };

  const drainPending = (rec: AttemptRecord, k: string): void => {
    let progressed: boolean;
    do {
      progressed = false;
      const events = rec.pending;
      rec.pending = [];
      for (const event of events) {
        if (processEvent(rec, k, event)) progressed = true;
        else rec.pending.push(event);
      }
    } while (progressed && rec.pending.length > 0);
  };

  return {
    beginAttempt(identity, meta) {
      let root: NodeRecord | undefined;
      let agent: NodeRecord | undefined;
      try {
        const k = identityKey(identity);
        if (closed || registry.has(k) || completedAttempts.has(k)) return undefined;
        let base = activeBase();
        const rootScope = {
          runId: identity.runId,
          attemptId: identity.attemptId,
          generation: identity.generation,
          service: meta.service ?? null,
          environment: meta.environment ?? null,
        };
        root = createNode("diagnose-turn", "span", { input: meta.question, metadata: rootScope }, base);
        // SDK observation attrs 尚无 release 字段，保留原有 release 标识。
        if (config.release) root.observation.otelSpan.setAttribute(LF.RELEASE, config.release);
        if (!opts?.joinActiveContext) {
          root.observation.setTraceIO({ input: meta.question });
          const rootSpan = root.observation.otelSpan;
          base = context.with(trace.setSpan(base, rootSpan), () => propagateAttributes({
            traceName: "diagnose-turn",
            sessionId: identity.investigationId,
          }, () => {
            // 生产显式 IPC 链不安装全局 ALS。5.13.1 propagation 需要 active context；
            // 无 context manager 时只回退 SDK 无法等价设置的 name/session。
            if (trace.getSpan(context.active()) !== rootSpan) {
              rootSpan.setAttribute(LF.TRACE_NAME, "diagnose-turn");
              rootSpan.setAttribute(LF.TRACE_SESSION_ID, identity.investigationId);
            }
            return context.active();
          }));
          // propagateAttributes.metadata 只支持短字符串，原有 number/null trace metadata 保留。
          rootSpan.setAttribute(LF.TRACE_METADATA, jsonAttr(rootScope));
        }
        // 评测 base 不被改写，保留 experiment/item attrs；业务节点只更新自己的 observation IO。
        agent = createNode("diagnosis-attempt", "agent", {
          metadata: { attemptId: identity.attemptId, generation: identity.generation, engine: meta.engine, service: meta.service ?? null },
        }, base, root, undefined, k);
        registry.set(k, {
          root, agent, children: new Map(), auditAgents: new Map(), agentStarted: false, pending: [], base,
        });
        return k;
      } catch (err) {
        if (agent) finishNode(agent, "error", "observation_initialization_failed");
        if (root) finishNode(root, "error", "observation_initialization_failed");
        warnThrottled("beginAttempt", err);
        return undefined;
      }
    },

    record(event, identity) {
      try {
        const k = identityKey(identity);
        const rec = registry.get(k);
        if (!rec || closed) return;
        if (!processEvent(rec, k, event)) {
          if (rec.pending.length < maxPendingEvents) rec.pending.push(event);
          else warnThrottled("pendingEvents", "乱序事件缓存已满，忽略无法关联的事件");
        }
        drainPending(rec, k);
      } catch (err) {
        warnThrottled(`record(${event.kind})`, err);
      }
    },

    recordAuditApplication(identity, data) {
      let node: NodeRecord | undefined;
      try {
        const rec = registry.get(identityKey(identity));
        if (!rec || closed) return;
        node = createNode("audit-apply", "span", {
          input: data.audit ?? { failure: data.failure ?? null },
          output: { corrections: data.report.corrections, completeness: data.report.completeness },
          metadata: { policyVersion: data.policyVersion, auditRounds: data.auditRounds ?? 0 },
        }, rec.base, rec.root, data.startedAt);
      } catch (err) {
        warnThrottled("recordAuditApplication", err);
      } finally {
        if (node) finishNode(node, "ok");
      }
    },

    recordReportValidation(identity, data) {
      let node: NodeRecord | undefined;
      try {
        const rec = registry.get(identityKey(identity));
        if (!rec || closed) return;
        node = createNode("report-validation", "span", {
          input: data.draft ?? null,
          output: { issues: data.report.corrections, report: data.report },
          metadata: { durationMs: Date.now() - data.startedAt },
        }, rec.base, rec.root, data.startedAt);
      } catch (err) {
        warnThrottled("recordReportValidation", err);
      } finally {
        if (node) finishNode(node, "ok");
      }
    },

    endAttempt(identity, outcome) {
      try {
        const k = identityKey(identity);
        const rec = registry.get(k);
        if (rec) closeAttempt(k, rec, outcome);
      } catch (err) {
        warnThrottled("endAttempt", err);
      }
    },

    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      for (const [k, rec] of registry) {
        closeAttempt(k, rec, { status: "aborted", kind: "observability_shutdown", error: "observability_shutdown" });
      }
      // 共享实验 provider 的队列与关闭由进程拥有者处理；recorder 只结束自己的节点。
      if (!ownedProvider) return shutdownPromise = Promise.resolve();
      const owner = ownedProvider;
      shutdownPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            owner.forceFlush()
              .catch((err: unknown) => warnThrottled("forceFlush", err))
              .then(() => owner.shutdown())
              .catch((err: unknown) => warnThrottled("shutdown", err)),
            new Promise<void>((resolve) => { timer = setTimeout(resolve, config.shutdownMs); }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      })();
      return shutdownPromise;
    },
  };
}
