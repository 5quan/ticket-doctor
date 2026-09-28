// 一轮诊断的编排：领取后在这里完成"建材料范围 → 跑引擎 → 校验 → 落库 → 排投递"。
//
// 边界：
//   * 所有外部 IO（模型、日志、源码）都在数据库事务之外。
//   * 终态提交带代次守卫：租约过期后写不进任何东西。
//   * 报告、终态、待发送记录、上下文指针在同一事务里落库。
import type { AppConfig } from "../config/index.ts";
import { renderReportText } from "../domain/report.ts";
import { onFailure } from "../domain/run-state.ts";
import type { DiagnosisReport, RunErrorCode } from "../domain/types.ts";
import type { FileLogSource } from "../sources/logs.ts";
import type { Store, ClaimedRun } from "../storage/store.ts";
import type { EventStore } from "../host/event-store.ts";
import { ToolBudgetExceeded } from "../agent/toolbox.ts";
import type { DiagnosisEngine, EngineResult } from "../agent/types.ts";
import { prepareDiagnosis } from "./prepare.ts";
import { RunSession } from "./run-session.ts";
import { renderDiagnosisInput } from "../agent/input-text.ts";
import { validateDraft } from "./validate.ts";

export interface OrchestratorDeps {
  store: Store;
  config: AppConfig;
  engine: DiagnosisEngine;
  /** 让测试注入假日志源。缺省用配置文件日志源。 */
  logSource?: FileLogSource;
  /** Host EventStore（SSE）：提供时把生命周期事件持久化并推送。 */
  eventStore?: EventStore;
}

/** 只有 IM 来源的轮次才回平台；Web 来源只进 EventStore/SSE。 */
function isImProvider(provider: string): boolean {
  return provider !== "web";
}

function buildContextSummary(report: DiagnosisReport): string {
  const hypothesis = report.hypotheses[0]?.cause ?? "无明确假设";
  const missing = report.missingMaterial.length > 0 ? `；缺失：${report.missingMaterial.join("、")}` : "";
  return `材料${report.completeness === "complete" ? "完整" : "不完整"}；首要假设：${hypothesis}${missing}`;
}

function buildReplyContextSummary(reason: "chat" | "clarify", text: string): string {
  const label = reason === "clarify" ? "已向用户追问" : "助手已回复";
  return `${label}：${text.replace(/\s+/g, " ").slice(0, 200)}`;
}

export async function executeRun(deps: OrchestratorDeps, claimed: ClaimedRun): Promise<void> {
  const { store, config, engine } = deps;
  const run = claimed.run;
  const message = store.getMessageById(run.message_id);
  const investigation = store.getInvestigation(run.investigation_id);
  if (!message || !investigation) {
    store.finishFailure(run.id, claimed.generation, "failed", "runtime_error", "运行缺少消息或调查记录", Date.now());
    return;
  }

  // 心跳独立于模型循环：模型卡住也必须能续租 / 失租即中止
  const controller = new AbortController();
  let leaseLost = false;
  let timedOut = false;
  let cancelRequested = false;
  const emit = (type: string, payload?: unknown) => {
    try {
      deps.eventStore?.publish(investigation.id, type, payload);
    } catch {
      // 事件推送失败不影响诊断主链路
    }
  };
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

    let result: EngineResult;
    try {
      // 首次执行 prompt；恢复（本轮已有条目）则由引擎 continue，不重复追加用户消息。
      result = await engine.run(input, toolbox, controller.signal, runSession);
    } catch (err) {
      // 无论成败都把本轮 usage 汇总落库；条目由引擎逐个带守卫写入。
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
      priorEntries: runSession.priorEntries.length,
    });

    const round = run.round || investigation.total_rounds + 1;
    const deliverToIm = isImProvider(message.provider);

    // 非诊断回复（闲聊 / 追问）：不产生报告，只回一条消息。
    if (result.kind === "reply") {
      const replied = store.finalizeReply({
        runId: run.id,
        generation: claimed.generation,
        investigationId: investigation.id,
        round,
        text: result.text,
        targetMessageId: message.external_message_id,
        contextSummary: buildReplyContextSummary(result.reason, result.text),
        deliver: deliverToIm,
      });
      if (!replied.ok) {
        store.appendRunEvent(run.id, claimed.attemptId, "commit_rejected", { reason: "lease_lost" });
        return;
      }
      store.appendRunEvent(run.id, claimed.attemptId, "reply_saved", { reason: result.reason });
      emit("reply", { runId: run.id, reason: result.reason, text: result.text, delivered: deliverToIm });
      return;
    }

    const draft = result.draft;
    for (const item of missingMaterial) draft.missingMaterial.push(item);
    const { report } = validateDraft(draft, {
      registry,
      scope,
      executionLimits: [
        `工具调用 ${toolbox.toolCalls}/${config.diagnosis.maxToolCalls}`,
        `时间预算 ${config.diagnosis.timeoutMs}ms`,
      ],
    });

    const content = renderReportText(report, {
      investigationId: investigation.id,
      sessionCode: investigation.session_code,
      round,
      title: investigation.title ?? undefined,
      question,
    });

    const finalized = store.finalizeSuccess({
      runId: run.id,
      generation: claimed.generation,
      attemptId: claimed.attemptId,
      investigationId: investigation.id,
      round,
      completeness: report.completeness,
      reportContent: report,
      evidence: registry.all().map((e) => ({
        evidenceId: e.evidenceId,
        kind: e.kind,
        source: e.source,
        excerpt: e.excerpt,
        truncated: e.truncated,
        time: e.time,
        level: e.level,
        codeRef: e.codeRef,
      })),
      delivery: deliverToIm
        ? {
            kind: "report",
            targetMessageId: message.external_message_id,
            content,
            idempotencyKey: `report:${run.id}`,
          }
        : undefined,
      contextSummary: buildContextSummary(report),
    });

    if (!finalized.ok) {
      store.appendRunEvent(run.id, claimed.attemptId, "commit_rejected", { reason: "lease_lost" });
      return;
    }
    store.appendRunEvent(run.id, claimed.attemptId, "report_saved", {
      reportId: finalized.reportId,
      completeness: report.completeness,
    });
    emit("report", {
      runId: run.id,
      reportId: finalized.reportId,
      completeness: report.completeness,
      report,
      delivered: deliverToIm,
    });
  } catch (err) {
    if (cancelRequested) {
      store.finishCancelled(run.id, claimed.generation, "用户取消", Date.now());
      store.appendRunEvent(run.id, claimed.attemptId, "run_cancelled", null);
      emit("cancelled", { runId: run.id });
      return;
    }
    const code: RunErrorCode = leaseLost ? "interrupted" : timedOut ? "timeout" : classify(err);
    await failRun(deps, claimed, code, err instanceof Error ? err.message : String(err), emit);
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
}

function classify(err: unknown): RunErrorCode {
  const message = err instanceof Error ? err.message : String(err);
  if (/abort|cancel|取消/i.test(message)) return "interrupted";
  if (/auth|401|403|credential|api key/i.test(message)) return "auth";
  if (/rate.?limit|429/i.test(message)) return "rate_limited";
  return "runtime_error";
}

async function failRun(
  deps: OrchestratorDeps,
  claimed: ClaimedRun,
  code: RunErrorCode,
  message: string,
  emit: (type: string, payload?: unknown) => void = () => {},
): Promise<void> {
  const { store, config } = deps;
  store.appendRunEvent(claimed.run.id, claimed.attemptId, "run_error", { code, message });
  const transition = onFailure(code, claimed.run.attempt_count, claimed.run.max_attempts);
  store.finishFailure(
    claimed.run.id,
    claimed.generation,
    transition.status,
    code,
    message,
    Date.now() + config.scheduler.retryDelayMs,
  );
  if (transition.status === "failed") {
    // 失败通知也遵守来源路由：Web 轮次不回 IM。
    const failingMessage = store.getMessageById(claimed.run.message_id);
    if (failingMessage && isImProvider(failingMessage.provider)) {
      store.enqueueDelivery({
        investigationId: claimed.run.investigation_id,
        runId: claimed.run.id,
        kind: "notice",
        targetMessageId: undefined,
        content: `【预检失败】本轮诊断未能完成：${message}`,
        idempotencyKey: `failure-notice:${claimed.run.id}`,
      });
    }
  }
  emit("run_error", {
    runId: claimed.run.id,
    code,
    message,
    status: transition.status,
  });
}
