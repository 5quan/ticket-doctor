// Langfuse Experiment 封装（交付二 B1/B2）。
//
// B1（实验）：
//   * 一个 experiment item = 一次完整 case trial；每个用户轮 = 独立子观测（报告全文/回写/
//     工具返回/审计过程，保留原始发生时间）。
//   * task 输入白名单：input 只含公开题面；**私有标准（truth/locator/forbiddenRules）结构性
//     不进入任何上报字段**——expectedOutput 侧由 Langfuse Dataset 承载（B1 阶段以 metadata
//     记录 caseHash/truthHash 引用，不传内容）。
//   * C2 未接请求观测继续为 null，不用重放文本冒充。
//
// B2（可靠同步）：
//   * traceId / score id 全部**确定性派生**：同一 trial 重复同步得到同一 trace、同一 score id
//     （平台侧按 id 幂等），不产生重复实验/trace/分数。
//   * 同步状态机：confirmed（平台 2xx 确认受理）/ failed（原因留档），跳过已确认、续传失败，
//     同步失败不改变本地诊断产物。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseScoreV2, SuiteSummaryV2, TrialArtifacts } from "./types.ts";
import type { TraceEvent } from "./types.ts";
import type { TrialMetric } from "./langfuse.ts";
import { SCORER_VERSION } from "./scorer.ts";

export interface RoundObservation {
  roundId: string;
  runId: string | null;
  outcome: string;
  status: string | null;
  /** 正式报告（校验+审计应用后）全文 JSON。 */
  report: unknown;
  /** 实际回写/投递文本（最终渲染产物）。 */
  writebackText: string | null;
  /** 初稿摘要（与终稿对照；A1 归属语义）。 */
  rawDraftSummary: string | null;
  replyText: string | null;
  corrections: string[] | null;
  /** 审计决定/失败/应用事件（真实发生时间；交付 1.1 #7 的 trace 导出复用）。 */
  auditEvents: Array<{ auditType: string; occurredAt: number | null; payload: unknown }>;
  /** 工具调用与返回（C1 层事实；只含调用摘要与返回头部，控制上报体积）。 */
  toolCalls: Array<{ callId: string; tool: string; ok: boolean; durationMs: number; returnedHead: string }>;
  metrics: {
    /** 只带 code：message 可能内嵌 truth 侧 ruleId，不上报（评价标准属 Dataset/expectedOutput 侧）。 */
    hardFailureCodes: string[];
    clarificationSuccess: boolean | null;
    contradictionUpdate: boolean | null;
    /** 满足的需求数（requirementId 是 truth 侧评价标准标识，不进上报）。 */
    newC1SatisfiedCount: number;
  };
}

export interface TrialExperimentPayload {
  key: string;
  /** 确定性 traceId（32 hex）：重复同步幂等的根基（B2）。 */
  traceId: string;
  name: string;
  experimentId: string;
  sessionId: string;
  input: string;
  /** 实际投递全文（末轮回写）；reply 轮为回复文本。 */
  output: string;
  metadata: Record<string, unknown>;
  rounds: RoundObservation[];
  scores: TrialMetric[];
}

/** 确定性 id：同一路径重复同步得到同一 id（B2 幂等）。 */
export function deterministicId(kind: string, ...parts: string[]): string {
  const h = createHash("sha256").update(`${kind}\u0000${parts.join("\u0000")}`).digest("hex");
  // 32 hex（traceId 16 bytes）；score id 同型。
  return h.slice(0, 32);
}

/** 从 trace.jsonl 提取审计事件与工具返回（读取失败按空处理，不猜测）。 */
function readTraceEvents(tracePath: string): TraceEvent[] {
  if (!existsSync(tracePath)) return [];
  const out: TraceEvent[] = [];
  for (const line of readFileSync(tracePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TraceEvent);
    } catch {
      // 损坏行跳过（与 exportToolEvents 同口径）
    }
  }
  return out;
}

function head(text: string | undefined | null, max = 600): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 构建一个 suite 的全部 trial 实验载荷（纯读本地产物，无网络）。
 * @param roundInputs 每轮公开题面文本（调用方用 loadRoundMessages 白名单构造）。
 */
export function buildTrialPayload(args: {
  suiteRunId: string;
  caseId: string;
  trialId: string;
  runDir: string;
  familyId: string;
  split: string;
  sourceTier: string;
  score: CaseScoreV2;
  reviewed: CaseScoreV2 | null;
  /** 公开题面（各轮消息文本，白名单内容）。 */
  input: string;
}): TrialExperimentPayload {
  const { suiteRunId, caseId, trialId, runDir, score } = args;
  const outputsPath = join(runDir, caseId, trialId, "outputs.json");
  const artifacts = (JSON.parse(readFileSync(outputsPath, "utf8")) as { artifacts: TrialArtifacts }).artifacts;
  const events = readTraceEvents(join(runDir, caseId, trialId, "trace.jsonl"));

  const auditByRound = new Map<string, Array<{ auditType: string; occurredAt: number | null; payload: unknown }>>();
  const toolsByRound = new Map<string, Array<{ callId: string; tool: string; ok: boolean; durationMs: number; returnedHead: string }>>();
  for (const e of events) {
    if (!e.roundId) continue;
    if (e.eventType === "audit_event") {
      const p = e.payload as { auditType: string; occurredAt: number | null; payload: unknown };
      const list = auditByRound.get(e.roundId) ?? [];
      list.push({ auditType: p.auditType, occurredAt: p.occurredAt ?? null, payload: p.payload });
      auditByRound.set(e.roundId, list);
    } else if (e.eventType === "tool_returned") {
      const p = e.payload as { callId: string; tool: string; ok: boolean; durationMs: number; returnedText?: string | null };
      const list = toolsByRound.get(e.roundId) ?? [];
      list.push({ callId: p.callId, tool: p.tool, ok: p.ok, durationMs: p.durationMs, returnedHead: head(p.returnedText ?? "") });
      toolsByRound.set(e.roundId, list);
    }
  }

  const rounds: RoundObservation[] = artifacts.rounds.map((r) => {
    const rs = score.roundScores.find((x) => x.roundId === r.roundId);
    const report = r.report ?? (r.replyText ? { kind: "reply", text: r.replyText } : null);
    return {
      roundId: r.roundId,
      runId: r.runId ?? null,
      outcome: r.outcome,
      status: r.status ?? null,
      report,
      writebackText: r.writebackText ?? null,
      rawDraftSummary: (r.rawDraft as { summary?: string } | undefined)?.summary ?? null,
      replyText: r.replyText ?? null,
      corrections: (r.report as { corrections?: string[] } | undefined)?.corrections ?? null,
      auditEvents: auditByRound.get(r.roundId) ?? [],
      toolCalls: toolsByRound.get(r.roundId) ?? [],
      metrics: {
        hardFailureCodes: (rs?.hardFailures ?? []).map((f) => f.code),
        clarificationSuccess: rs?.clarificationSuccess ?? null,
        contradictionUpdate: rs?.contradictionUpdate ?? null,
        newC1SatisfiedCount: (rs?.newC1Satisfied ?? []).length,
      },
    };
  });

  const lastRound = artifacts.rounds.at(-1);
  const output = lastRound?.writebackText ?? lastRound?.replyText ?? "(无最终产出)";

  const scores: TrialMetric[] = [...(args.score ? metricList(score, "") : [])];
  if (args.reviewed) {
    // 复核分单列（reviewerType/reviewer 入 comment），不与程序分混同。
    scores.push(...metricList(args.reviewed, ".reviewed"));
  }

  return {
    key: `${caseId}/${trialId}`,
    traceId: deterministicId("trial", suiteRunId, caseId, trialId),
    name: `eval/${caseId}`,
    experimentId: deterministicId("experiment", suiteRunId),
    sessionId: suiteRunId,
    input: args.input,
    output,
    metadata: {
      suite: suiteRunId,
      caseId,
      trialId,
      familyId: args.familyId,
      split: args.split,
      sourceTier: args.sourceTier,
      engine: score.engine,
      scorerVersion: score.scorerVersion,
      currentScorerVersion: SCORER_VERSION,
      executionSuccess: score.executionSuccess,
      hardFailureCount: score.hardFailures.length,
      observationLevel: "b-c1-d",
      c2: null,
      scoreSource: args.reviewed
        ? `review:${args.reviewed.semanticReview.reviewerType ?? "unknown"}/${args.reviewed.semanticReview.reviewer ?? "unknown"}`
        : "program",
      rounds: rounds.length,
    },
    rounds,
    scores,
  };
}

function metricList(s: CaseScoreV2, suffix: string): TrialMetric[] {
  const out: TrialMetric[] = [{ name: `executionSuccess${suffix}`, value: s.executionSuccess }];
  const add = (name: string, m: { value: number | null; numerator: number; denominator: number; notApplicable: number; unscored: number } | null | undefined): void => {
    if (!m || m.value === null || m.value === undefined) return;
    out.push({ name: `${name}${suffix}`, value: m.value, comment: `${m.numerator}/${m.denominator}（na=${m.notApplicable},unscored=${m.unscored}）` });
  };
  add("recall.A", s.recall.A);
  add("recall.B", s.recall.B);
  add("recall.C1", s.recall.C1);
  add("recall.C2", s.recall.C2);
  add("recall.D", s.recall.D);
  add("citationValidity", s.citationValidity);
  add("claimSupport", s.claimSupport);
  add("requiredFactCoverage", s.requiredFactCoverage);
  add("unsupportedAssertionRate", s.unsupportedAssertionRate);
  add("clarificationSuccess", s.clarificationSuccess);
  add("contradictionUpdateSuccess", s.contradictionUpdateSuccess);
  add("writebackSuccess", s.writebackSuccess);
  out.push({ name: `hardFailureCount${suffix}`, value: s.hardFailures.length, comment: s.hardFailures.map((f) => f.code).join(",") });
  return out;
}

// ---------- B2：同步状态机（纯函数，可确定性测试） ----------

export const LF_SYNC_SCHEMA = "prediagnosis-lf-sync-v1";

export interface TrialSyncRecord {
  traceId: string;
  /** confirmed = 平台已确认受理（ingestion 2xx 且无逐条错误）；failed = 失败原因留档。 */
  status: "confirmed" | "failed";
  scores: number;
  rounds: number;
  attempts: number;
  lastError: string | null;
  syncedAt: number;
}

export interface LfSyncState {
  schemaVersion: string;
  suiteRunId: string;
  /** 已确认且无需重推的 trial key 集合。 */
  trials: Record<string, TrialSyncRecord>;
}

export function emptySyncState(suiteRunId: string): LfSyncState {
  return { schemaVersion: LF_SYNC_SCHEMA, suiteRunId, trials: {} };
}

export function shouldSync(state: LfSyncState, key: string, force: boolean): boolean {
  if (force) return true;
  const rec = state.trials[key];
  return !rec || rec.status !== "confirmed";
}

export function applySyncResult(state: LfSyncState, key: string, result: { ok: boolean; traceId: string; scores: number; rounds: number; error?: string; previousAttempts?: number }): void {
  const prev = state.trials[key];
  state.trials[key] = {
    traceId: result.traceId,
    status: result.ok ? "confirmed" : "failed",
    scores: result.scores,
    rounds: result.rounds,
    attempts: (prev?.attempts ?? 0) + 1,
    lastError: result.ok ? null : (result.error ?? "unknown"),
    syncedAt: Date.now(),
  };
}
