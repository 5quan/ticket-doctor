// 每轮终态自动评分（交付四 D）：线上运行的程序代理分。
//
// 边界：
//   * 线上没有 gold：正确率/召回率/语义支持**缺测**（不造数）；只评可验证的结构、引用、
//     运行指标——引用可解析性、证据规模、产出类型、耗时、工具次数。
//   * 幂等：按 (run_id, attempt_id, round_id, scorer_version) 唯一索引去重，重复触发
//     （重试/重启）不重复计分；评分失败不阻塞报告投递（调用方 fire-and-forget + 本函数兜底捕获）。
//   * needs_review=1 即候选案例池信号：引用不可解析/提交失败/无产出——经材料冻结与
//     标准审核后回流为正式案例（与固定案例回归共用同一套评分定义）。
//   * 与评测线共用 Langfuse 权威源约定：线上分单列（scorer_version=online-*），不得与
//     评测分同表比较。
import { SCORER_VERSION } from "./scorer.ts";
import type { Store } from "../../storage/store.ts";
import { StoreEvidenceResolver } from "../../evidence/store-resolver.ts";

/** 线上评分口径独立于评测 scorer（指标集合不同；改判定语义时 bump 此版本）。 */
export const ONLINE_SCORER_VERSION = `online-1.0.0+eval-${SCORER_VERSION}`;

export interface OnlineRoundMetrics {
  scorerVersion: string;
  investigationId: string;
  runId: string;
  attemptId: string | null;
  roundId: string;
  outcome: "report" | "reply" | "error";
  /** 引用有效性：可解析引用 / 报告引用总数（无引用记 null=不适用）。 */
  citationValidRatio: number | null;
  citationTotal: number;
  evidenceCount: number;
  toolCalls: number;
  durationMs: number | null;
  needsReview: boolean;
  needsReviewReason: string | null;
}

export interface OnlineScoreRecord extends OnlineRoundMetrics {
  createdAt: number;
}

/** 评分一轮终态：只读持久化事实（报告/证据/工具执行），不做任何模型调用。 */
export function scoreOnlineRound(args: {
  store: Store;
  investigationId: string;
  runId: string;
  attemptId: string | null;
  roundId: string;
}): OnlineRoundMetrics {
  const { store, investigationId, runId, attemptId, roundId } = args;
  const reportRow = store.getReportByRun(runId);
  const report = reportRow ? (JSON.parse(reportRow.content) as { hypotheses?: Array<{ evidenceIds?: string[] }> } | undefined) : undefined;
  const runRowForStatus = store.getRun(runId);
  const replyText = reportRow || runRowForStatus?.status !== "succeeded" ? null : "reply";

  // 引用可解析性（uid 优先，兼容 E# 短号）。
  const resolver = new StoreEvidenceResolver(store, investigationId, runId);
  const citedIds = (report?.hypotheses ?? []).flatMap((h) => h.evidenceIds ?? []);
  let valid = 0;
  if (citedIds.length > 0) {
    for (const id of citedIds) {
      if (resolver.byUid(investigationId, id) ?? resolver.byRunShortId(runId, id)) valid += 1;
    }
  }

  const evidenceCount = store.listEvidenceByInvestigation ? store.listEvidenceByInvestigation(investigationId).length : 0;
  const toolRow = store.db
    ? (store.db.prepare("SELECT COUNT(*) AS n FROM tool_executions WHERE run_id = ?").get(runId) as { n: number | bigint })
    : { n: 0 };
  // 耗时取 attempts 真实起止（无 attempt 或未结束记 null，不猜）。
  const attemptTiming = store.db
    ? (store.db
        .prepare("SELECT MIN(started_at) AS s, MAX(finished_at) AS f FROM attempts WHERE run_id = ? AND finished_at IS NOT NULL")
        .get(runId) as { s: number | null; f: number | null })
    : { s: null, f: null };
  const durationMs = attemptTiming.s !== null && attemptTiming.f !== null ? Math.max(0, attemptTiming.f - attemptTiming.s) : null;

  const outcome: OnlineRoundMetrics["outcome"] = report ? "report" : replyText ? "reply" : "error";
  const citationInvalid = citedIds.length > 0 && valid < citedIds.length;
  let needsReview = false;
  let needsReviewReason: string | null = null;
  if (outcome === "error") {
    needsReview = true;
    needsReviewReason = "本轮无正式报告且无回复（提交失败）";
  } else if (citationInvalid) {
    needsReview = true;
    needsReviewReason = `存在不可解析引用（${citedIds.length - valid}/${citedIds.length}）`;
  }

  return {
    scorerVersion: ONLINE_SCORER_VERSION,
    investigationId,
    runId,
    attemptId,
    roundId,
    outcome,
    citationValidRatio: citedIds.length > 0 ? valid / citedIds.length : null,
    citationTotal: citedIds.length,
    evidenceCount,
    toolCalls: Number(toolRow.n),
    durationMs,
    needsReview,
    needsReviewReason,
  };
}

/** 持久化线上评分（幂等；失败抛出由调用方决定是否吞掉——默认不阻塞主链路）。 */
export function persistOnlineScore(store: Store, m: OnlineRoundMetrics): number | undefined {
  const duplicate = store.db
    .prepare(
      "SELECT id FROM eval_scores WHERE run_id = ? AND attempt_id IS ? AND round_id = ? AND scorer_version = ?",
    )
    .get(m.runId, m.attemptId, m.roundId, m.scorerVersion) as { id: number } | undefined;
  if (duplicate) return duplicate.id; // 已计分：去重（幂等）
  const result = store.db
    .prepare(
      "INSERT INTO eval_scores (run_id, attempt_id, round_id, investigation_id, scorer_version, outcome, metrics, needs_review, needs_review_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      m.runId,
      m.attemptId,
      m.roundId,
      m.investigationId,
      m.scorerVersion,
      m.outcome,
      JSON.stringify(m),
      m.needsReview ? 1 : 0,
      m.needsReviewReason,
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

/** 候选案例池：needs_review 的轮次（按时间倒序），供案例回流审核。 */
export function listNeedsReview(store: Store, limit = 50): Array<{ id: number; runId: string; roundId: string; reason: string | null; createdAt: number }> {
  const rows = store.db
    .prepare(
      "SELECT id, run_id, round_id, needs_review_reason, created_at FROM eval_scores WHERE needs_review = 1 ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as Array<{ id: number; run_id: string; round_id: string; needs_review_reason: string | null; created_at: number }>;
  return rows.map((r) => ({ id: r.id, runId: r.run_id, roundId: r.round_id, reason: r.needs_review_reason, createdAt: r.created_at }));
}
