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
import { ToolBudgetExceeded } from "../agent/toolbox.ts";
import type { DiagnosisEngine, EngineResult } from "../agent/types.ts";
import { prepareDiagnosis } from "./prepare.ts";
import { SessionLog } from "./session-log.ts";
import { validateDraft } from "./validate.ts";

export interface OrchestratorDeps {
  store: Store;
  config: AppConfig;
  engine: DiagnosisEngine;
  /** 让测试注入假日志源。缺省用配置文件日志源。 */
  logSource?: FileLogSource;
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
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.diagnosis.timeoutMs);
  const heartbeat = setInterval(() => {
    const ok = store.heartbeat(run.id, claimed.attemptId, claimed.generation, config.scheduler.leaseMs);
    if (!ok) {
      leaseLost = true;
      controller.abort();
    }
  }, config.scheduler.heartbeatMs);

  try {
    store.appendRunEvent(run.id, claimed.attemptId, "run_started", { worker: claimed.attemptId });

    // 会话日志：模型层逐条事件（消息/工具/用量/压缩）的 append-only 真相源。
    const sessionLog = SessionLog.open({
      dir: config.sessionDir,
      runId: run.id,
      attemptId: claimed.attemptId,
      investigationId: investigation.id,
      cwd: process.cwd(),
    });

    // 材料准备与生产同一路径：时间窗 → 钉版本 → 工具箱（含会话日志埋点）。
    const { input, scope, registry, toolbox, missingMaterial } = await prepareDiagnosis(config, {
      investigationId: investigation.id,
      runId: run.id,
      text: message.text,
      receivedAt: message.received_at,
      service: investigation.service ?? undefined,
      environment: investigation.environment ?? undefined,
      contextSummary: investigation.context_summary ?? undefined,
      signal: controller.signal,
      log: sessionLog,
      logSource: deps.logSource,
    });
    const question = input.question;
    sessionLog.append("message", { role: "user", content: question });

    let result: EngineResult;
    try {
      result = await engine.run(input, toolbox, controller.signal, sessionLog);
    } catch (err) {
      // 无论成败都先落会话日志指针，保证失败尝试也可回放。
      store.recordSessionLog(run.id, sessionLog.summary());
      if (err instanceof ToolBudgetExceeded) {
        await failRun(deps, claimed, "budget_tools", err.message);
        return;
      }
      throw err;
    }
    store.recordSessionLog(run.id, sessionLog.summary());
    store.appendRunEvent(run.id, claimed.attemptId, "engine_finished", {
      kind: result.kind,
      toolCalls: result.toolCalls,
      modelTurns: result.modelTurns,
      model: result.model,
      session: sessionLog.summary(),
    });

    const round = investigation.total_rounds + 1;

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
      });
      if (!replied.ok) {
        store.appendRunEvent(run.id, claimed.attemptId, "commit_rejected", { reason: "lease_lost" });
        return;
      }
      store.appendRunEvent(run.id, claimed.attemptId, "reply_saved", { reason: result.reason });
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
      delivery: {
        kind: "report",
        targetMessageId: message.external_message_id,
        content,
        idempotencyKey: `report:${run.id}`,
      },
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
  } catch (err) {
    const code: RunErrorCode = leaseLost ? "interrupted" : timedOut ? "timeout" : classify(err);
    await failRun(deps, claimed, code, err instanceof Error ? err.message : String(err));
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
    // 诊断失败与消息发送失败分开处理：这里只记录，不触发任何飞书发送重试
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
