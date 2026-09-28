// 一轮诊断的编排：领取后在这里完成"建材料范围 → 跑引擎 → 校验 → 落库 → 排投递"。
//
// 边界：
//   * 所有外部 IO（模型、日志、源码）都在数据库事务之外。
//   * 终态提交带代次守卫：租约过期后写不进任何东西。
//   * 报告、终态、待发送记录、上下文指针在同一事务里落库（见 finalize.ts）。
//
// 这是"内联执行"路径（worker 与引擎同进程），用于本地/测试/评测；
// 生产 Host 可改用 host/runner-executor.ts 的独立子进程路径，二者共用 finalize.ts。
import type { AppConfig } from "../config/index.ts";
import type { RunErrorCode } from "../domain/types.ts";
import type { FileLogSource } from "../sources/logs.ts";
import type { Store, ClaimedRun } from "../storage/store.ts";
import type { EventStore } from "../host/event-store.ts";
import { ToolBudgetExceeded } from "../agent/toolbox.ts";
import type { DiagnosisEngine } from "../agent/types.ts";
import { prepareDiagnosis } from "./prepare.ts";
import { RunSession } from "./run-session.ts";
import { renderDiagnosisInput } from "../agent/input-text.ts";
import { classifyRunError, failRun, finalizeEngineResult } from "./finalize.ts";

export interface OrchestratorDeps {
  store: Store;
  config: AppConfig;
  engine: DiagnosisEngine;
  /** 让测试注入假日志源。缺省用配置文件日志源。 */
  logSource?: FileLogSource;
  /** Host EventStore（SSE）：提供时把生命周期事件持久化并推送。 */
  eventStore?: EventStore;
}

export async function executeRun(deps: OrchestratorDeps, claimed: ClaimedRun): Promise<void> {
  const { store, config, engine } = deps;
  const run = claimed.run;
  const message = store.getMessageById(run.message_id);
  const investigation = store.getInvestigation(run.investigation_id);
  if (!message || !investigation) {
    await failRun(deps, claimed, "runtime_error", "运行缺少消息或调查记录");
    return;
  }

  const emit = (type: string, payload?: unknown) => {
    try {
      deps.eventStore?.publish(investigation.id, type, payload);
    } catch {
      // 事件推送失败不影响诊断主链路
    }
  };

  // 心跳独立于模型循环：模型卡住也必须能续租 / 失租或收到取消即中止。
  const controller = new AbortController();
  let leaseLost = false;
  let timedOut = false;
  let cancelRequested = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.diagnosis.timeoutMs);
  const heartbeat = setInterval(() => {
    const ok = store.heartbeat(run.id, claimed.attemptId, claimed.generation, config.scheduler.leaseMs);
    if (store.isCancelRequested(run.id)) {
      cancelRequested = true;
      controller.abort();
    }
    if (!ok) {
      leaseLost = true;
      controller.abort();
    }
  }, config.scheduler.heartbeatMs);

  try {
    store.appendRunEvent(run.id, claimed.attemptId, "run_started", { worker: claimed.attemptId });
    emit("run_started", { runId: run.id, round: run.round, source: run.source });

    // 会话槽：模型会话条目直接落 SQLite（单存储）。先读回历史条目，pi 重建会话。
    const runSession = new RunSession(store, {
      investigationId: investigation.id,
      runId: run.id,
      attemptId: claimed.attemptId,
      generation: claimed.generation,
    });

    // 材料准备与生产同一路径：时间窗 → 钉版本 → 工具箱。
    const { input, scope, registry, toolbox, missingMaterial } = await prepareDiagnosis(config, {
      investigationId: investigation.id,
      runId: run.id,
      text: message.text,
      receivedAt: message.received_at,
      service: investigation.service ?? undefined,
      environment: investigation.environment ?? undefined,
      contextSummary: investigation.context_summary ?? undefined,
      signal: controller.signal,
      logSource: deps.logSource,
    });
    const question = input.question;
    // 首次执行：把本轮用户输入落成会话条目（恢复时不追加，避免重复）。
    if (!runSession.resumed) runSession.appendUserMessage(renderDiagnosisInput(input));

    let result: Awaited<ReturnType<DiagnosisEngine["run"]>>;
    try {
      result = await engine.run(input, toolbox, controller.signal, runSession);
    } catch (err) {
      runSession.finish();
      if (err instanceof ToolBudgetExceeded) {
        await failRun(deps, claimed, "budget_tools", err.message);
        return;
      }
      throw err;
    }
    runSession.finish();
    store.appendRunEvent(run.id, claimed.attemptId, "engine_finished", {
      kind: result.kind,
      toolCalls: result.toolCalls,
      modelTurns: result.modelTurns,
      model: result.model,
    });

    const finalized = finalizeEngineResult(deps, claimed, {
      investigation,
      message,
      result,
      evidence: registry.all(),
      scope,
      missingMaterial,
      toolCalls: toolbox.toolCalls,
      question,
    });
    if (!finalized.ok) {
      store.appendRunEvent(run.id, claimed.attemptId, "commit_rejected", { reason: "lease_lost" });
    }
  } catch (err) {
    if (cancelRequested) {
      store.finishCancelled(run.id, claimed.generation, "用户取消", Date.now());
      store.appendRunEvent(run.id, claimed.attemptId, "run_cancelled", null);
      emit("cancelled", { runId: run.id });
      return;
    }
    const code: RunErrorCode = leaseLost ? "interrupted" : timedOut ? "timeout" : classifyRunError(err);
    await failRun(deps, claimed, code, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
}
