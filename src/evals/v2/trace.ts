// trace（方案 §11.1）：统一 envelope 的 JSONL 事件流。
//
// 事件来源分两类，不混用：
//   * 实时事件：runner 在调查轨迹推进时直接记录（trial_started / round_input / engine_result_raw /
//     output_persisted / delivery_captured / round_finished / trial_finished / run_error）。
//   * 持久化导出：每轮结束后从 session_entries / tool_executions / evidence_batches / attempts
//     导出（tool_returned / evidence_committed / usage），标记 derived=true——是从持久化事实导出的
//     观测，不是重放执行，恢复/重试不冒充新取证。
//
// 禁止把 API key / Authorization / 凭据写入 trace。
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TraceEvent } from "./types.ts";

export const TRACE_SCHEMA_VERSION = "prediagnosis-trace-v2";

export interface TraceContext {
  suiteRunId: string;
  caseId: string;
  familyId: string;
  trialId: string;
}

export class TraceRecorder {
  private seq = 0;
  private readonly startedAt: number;
  private readonly filePath?: string;
  private readonly ctx: TraceContext;
  readonly events: TraceEvent[] = [];

  constructor(ctx: TraceContext, outPath?: string) {
    this.ctx = ctx;
    this.startedAt = Date.now();
    if (outPath) {
      mkdirSync(dirname(outPath), { recursive: true });
      this.filePath = outPath;
    }
  }

  emit(eventType: string, payload?: unknown, ids?: { roundId?: string; runId?: string; attemptId?: string }): TraceEvent {
    this.seq += 1;
    const event: TraceEvent = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      suiteRunId: this.ctx.suiteRunId,
      caseId: this.ctx.caseId,
      familyId: this.ctx.familyId,
      trialId: this.ctx.trialId,
      roundId: ids?.roundId,
      runId: ids?.runId,
      attemptId: ids?.attemptId,
      seq: this.seq,
      eventType,
      wallTime: Date.now(),
      elapsedMs: Date.now() - this.startedAt,
      ...(payload === undefined ? {} : { payload }),
    };
    this.events.push(event);
    if (this.filePath) {
      appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    }
    return event;
  }

  /** 持久化导出事件：显式标记 derived=true，与实时事件区分。 */
  emitDerived(eventType: string, payload: unknown, ids?: { roundId?: string; runId?: string; attemptId?: string }): TraceEvent {
    return this.emit(eventType, { derived: true, ...(payload as Record<string, unknown>) }, ids);
  }
}

// ---------- 持久化导出 ----------

export interface ExportSqlite {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
}

interface PiEntryLike {
  type: string;
  message?: {
    role?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
}

function toolResultText(entry: PiEntryLike): string {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/** 导出一轮的工具调用与实际返回文本：tool_executions（入参/成败/耗时）+ session_entries（模型可见文本）。 */
export function exportToolEvents(recorder: TraceRecorder, sqlite: ExportSqlite, ids: { roundId: string; runId: string }): void {
  const execs = sqlite
    .prepare(
      "SELECT call_id, tool, input, ok, duration_ms, output_chars, error FROM tool_executions WHERE run_id = ? ORDER BY created_at ASC",
    )
    .all(ids.runId) as Array<Record<string, unknown>>;

  const resultTexts = new Map<string, { text: string; isError: boolean }>();
  const entries = sqlite
    .prepare("SELECT data FROM session_entries WHERE run_id = ? ORDER BY seq ASC")
    .all(ids.runId) as Array<{ data: string }>;
  for (const row of entries) {
    try {
      const entry = JSON.parse(row.data) as PiEntryLike;
      if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId) {
        resultTexts.set(entry.message.toolCallId, { text: toolResultText(entry), isError: entry.message.isError === true });
      }
    } catch {
      // 损坏行跳过
    }
  }

  for (const exec of execs) {
    const callId = String(exec.call_id);
    const returned = resultTexts.get(callId);
    recorder.emitDerived(
      "tool_returned",
      {
        callId,
        tool: String(exec.tool),
        input: exec.input === null ? null : JSON.parse(String(exec.input)),
        ok: Number(exec.ok) === 1,
        durationMs: Number(exec.duration_ms),
        outputChars: exec.output_chars === null || exec.output_chars === undefined ? null : Number(exec.output_chars),
        error: exec.error ?? null,
        ...(returned ? { returnedText: returned.text, returnedIsError: returned.isError } : { returnedText: null, returnedIsError: null }),
      },
      ids,
    );
  }
}

/** 导出一轮的证据批次（B 层事实）。 */
export function exportEvidenceEvents(recorder: TraceRecorder, sqlite: ExportSqlite, ids: { roundId: string; runId: string }): void {
  const batches = sqlite
    .prepare("SELECT batch_id, tool, tool_call_id, payload_hash FROM evidence_batches WHERE run_id = ? ORDER BY created_at ASC")
    .all(ids.runId) as Array<Record<string, unknown>>;
  for (const batch of batches) {
    const evidence = sqlite
      .prepare(
        "SELECT evidence_id, evidence_uid, kind, excerpt, truncated, level, repo_id, sha, path, start_line, end_line FROM evidence WHERE batch_id = ? ORDER BY item_index ASC",
      )
      .all(String(batch.batch_id)) as Array<Record<string, unknown>>;
    recorder.emitDerived("evidence_committed", { batch, evidence }, ids);
  }
}

/** 导出一轮 usage（attempts 表；字段缺失记 null，不猜测）。 */
export function exportUsageEvent(recorder: TraceRecorder, sqlite: ExportSqlite, ids: { roundId: string; attemptId?: string }): void {
  if (!ids.attemptId) {
    recorder.emitDerived("usage", { totalTokens: null, reason: "attempt 缺失" }, ids);
    return;
  }
  const row = sqlite
    .prepare("SELECT usage_input_tokens, usage_output_tokens, usage_cache_tokens, usage_total_tokens FROM attempts WHERE id = ?")
    .get(ids.attemptId) as Record<string, unknown> | undefined;
  recorder.emitDerived(
    "usage",
    row
      ? {
          inputTokens: row.usage_input_tokens === null ? null : Number(row.usage_input_tokens),
          outputTokens: row.usage_output_tokens === null ? null : Number(row.usage_output_tokens),
          cacheTokens: row.usage_cache_tokens === null ? null : Number(row.usage_cache_tokens),
          totalTokens: row.usage_total_tokens === null ? null : Number(row.usage_total_tokens),
        }
      : { totalTokens: null, reason: "attempt 行不存在" },
    ids,
  );
}

/**
 * 导出一轮的完整审计事件（交付 1.1 #7）：run_events 里的 audit_round（决定）/audit_failed
 * （失败）/audit_applied（最终应用）连同**真实发生时间**（created_at）导出为 derived 事件。
 * 审计决定此前只落在 per-trial 内存库、trial 结束即丢——B1 联调前必须在 trace 可回放。
 */
export function exportAuditEvents(recorder: TraceRecorder, sqlite: ExportSqlite, ids: { roundId: string; runId: string }): void {
  const rows = sqlite
    .prepare(
      "SELECT type, payload, created_at FROM run_events WHERE run_id = ? AND type IN ('audit_round','audit_failed','audit_applied') ORDER BY created_at ASC, sequence ASC",
    )
    .all(ids.runId) as Array<Record<string, unknown>>;
  for (const row of rows) {
    let payload: unknown = null;
    try {
      payload = row.payload === null || row.payload === undefined ? null : JSON.parse(String(row.payload));
    } catch {
      payload = String(row.payload);
    }
    recorder.emitDerived(
      "audit_event",
      { auditType: String(row.type), occurredAt: row.created_at === null || row.created_at === undefined ? null : Number(row.created_at), payload },
      ids,
    );
  }
}

export const traceFileOf = (runDir: string, caseId: string, trialId: string): string => join(runDir, caseId, trialId, "trace.jsonl");
