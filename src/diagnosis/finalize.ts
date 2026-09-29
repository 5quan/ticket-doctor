// 一轮诊断的提交边界：把引擎结果（报告 / 回复）落库并发布事件。
//
// 生产内联执行（orchestrator）与独立 Runner 执行（host/runner-executor）共用这一条路径，
// 保证"Host 校验后才接受写入"的语义只有一份实现。
import type { AppConfig } from "../config/index.ts";
import { renderReportText } from "../domain/report.ts";
import { onFailure } from "../domain/run-state.ts";
import type { DiagnosisReport, MaterialScope, RunErrorCode } from "../domain/types.ts";
import type { EventStore } from "../host/event-store.ts";
import type { EngineResult } from "../agent/types.ts";
import type { ClaimedRun, InvestigationRow, MessageRow, Store } from "../storage/store.ts";
import { StoreEvidenceResolver } from "../evidence/store-resolver.ts";
import { validateDraft } from "./validate.ts";

export interface FinalizeDeps {
  store: Store;
  config: AppConfig;
  eventStore?: EventStore;
}

/** 只有 IM 来源的轮次才回平台；Web 来源只进 EventStore/SSE。 */
export function isImProvider(provider: string): boolean {
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

export function classifyRunError(err: unknown): RunErrorCode {
  const message = err instanceof Error ? err.message : String(err);
  if (/abort|cancel|取消/i.test(message)) return "interrupted";
  if (/auth|401|403|credential|api key/i.test(message)) return "auth";
  if (/rate.?limit|429/i.test(message)) return "rate_limited";
  return "runtime_error";
}

const EMPTY_SCOPE: MaterialScope = { services: [], repos: [] };

export interface FinalizeArgs {
  investigation: InvestigationRow;
  message: MessageRow;
  result: EngineResult;
  scope?: MaterialScope;
  missingMaterial?: string[];
  toolCalls: number;
  question: string;
}

/**
 * 提交一轮引擎结果：reply 只落回复；report 走校验 + 报告 + 证据 + 终态 + 投递（同事务）。
 * 代次守卫失败返回 ok=false，调用方记录 commit_rejected。
 */
export function finalizeEngineResult(
  deps: FinalizeDeps,
  claimed: ClaimedRun,
  args: FinalizeArgs,
): { ok: boolean; kind: "report" | "reply"; delivered: boolean } {
  const { store, config } = deps;
  const emit = (type: string, payload?: unknown) => {
    try {
      deps.eventStore?.publish(args.investigation.id, type, payload);
    } catch {
      // 事件推送失败不影响提交
    }
  };
  const round = claimed.run.round || args.investigation.total_rounds + 1;
  const deliverToIm = isImProvider(args.message.provider);

  if (args.result.kind === "reply") {
    const replied = store.finalizeReply({
      runId: claimed.run.id,
      generation: claimed.generation,
      investigationId: args.investigation.id,
      round,
      text: args.result.text,
      targetMessageId: args.message.external_message_id,
      contextSummary: buildReplyContextSummary(args.result.reason, args.result.text),
      deliver: deliverToIm,
    });
    if (!replied.ok) return { ok: false, kind: "reply", delivered: false };
    store.appendRunEvent(claimed.run.id, claimed.attemptId, "reply_saved", { reason: args.result.reason });
    emit("reply", {
      runId: claimed.run.id,
      reason: args.result.reason,
      text: args.result.text,
      delivered: deliverToIm,
    });
    return { ok: true, kind: "reply", delivered: deliverToIm };
  }

  const draft = {
    ...args.result.draft,
    missingMaterial: [...args.result.draft.missingMaterial, ...(args.missingMaterial ?? [])],
  };
  const scope = args.scope ?? EMPTY_SCOPE;
  // 证据已在工具 commit 时入库（D8）；校验按调查内已持久化证据解析（§9），跨调查结构性不可达。
  const resolver = new StoreEvidenceResolver(store, args.investigation.id, claimed.run.id);
  const { report } = validateDraft(draft, {
    resolver,
    scope,
    investigationId: args.investigation.id,
    executionLimits: [
      `工具调用 ${args.toolCalls}/${config.diagnosis.maxToolCalls}`,
      `时间预算 ${config.diagnosis.timeoutMs}ms`,
    ],
  });

  // v2 报告的 evidenceIds 已统一为 uid；展示层用 uid → 短号映射还原成 [E#]（§9.2.4）
  const evidenceLabels = new Map(
    resolver.listByInvestigation(args.investigation.id).map((r) => [r.evidenceUid, r.evidenceId]),
  );
  const content = renderReportText(
    report,
    {
      investigationId: args.investigation.id,
      sessionCode: args.investigation.session_code,
      round,
      title: args.investigation.title ?? undefined,
      question: args.question,
    },
    evidenceLabels,
  );

  const finalized = store.finalizeSuccess({
    runId: claimed.run.id,
    generation: claimed.generation,
    attemptId: claimed.attemptId,
    investigationId: args.investigation.id,
    round,
    completeness: report.completeness,
    reportContent: report,
    // D8：证据已在工具 commit 时落库；finalize 只写报告 + 终态 + 投递
    evidence: [],
    // D7：新报告引用格式为 v2（evidenceIds = evidence_uid）
    referenceFormatVersion: 2,
    delivery: deliverToIm
      ? {
          kind: "report",
          targetMessageId: args.message.external_message_id,
          content,
          idempotencyKey: `report:${claimed.run.id}`,
        }
      : undefined,
    contextSummary: buildContextSummary(report),
  });

  if (!finalized.ok) return { ok: false, kind: "report", delivered: false };
  store.appendRunEvent(claimed.run.id, claimed.attemptId, "report_saved", {
    reportId: finalized.reportId,
    completeness: report.completeness,
  });
  emit("report", {
    runId: claimed.run.id,
    reportId: finalized.reportId,
    completeness: report.completeness,
    report,
    delivered: deliverToIm,
  });
  return { ok: true, kind: "report", delivered: deliverToIm };
}

/** 失败/中断落点：按状态机重排或判失败；失败通知遵守来源路由。 */
export async function failRun(
  deps: FinalizeDeps,
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
  try {
    deps.eventStore?.publish(claimed.run.investigation_id, "run_error", {
      runId: claimed.run.id,
      code,
      message,
      status: transition.status,
    });
  } catch {
    // ignore
  }
}
