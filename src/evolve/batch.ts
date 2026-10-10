// 自改进方案交付 B：TS 批量评测桥梁（§6.1）。
//
// 协议：stdin 收一个 BatchRequest JSON，stdout 只输出一个结果 JSON（日志走 stderr）。
// 职责：编译候选 → 逐 case×repeat 执行 → 确定性评分 → 逐 trial 终态 + 逐 case 汇总。
// 不拼 shell、不远程拉取；只接受控制器批准的 caseId 与路径（由调用方注入白名单）。
//
// repeat 不改变 case 数：一个 case = 一个均值分数，全部原始 trial 保留在 items 里（§6.2）。

import { compileBaseline, compileCandidate, type CompiledCandidate } from "./compile.ts";
import { gradeCase } from "./grade.ts";
import { BudgetLedger, type BudgetLimits, type BudgetSnapshot, type UsageRecord } from "./budget.ts";
import type { CaseRunResult } from "../eval/lf/run-case.ts";
import type { TruthFileV2 } from "../eval/lf/internals/types.ts";

export const MAX_REPEAT = 5;

export class BatchProtocolError extends Error {}
export class SystematicBatchError extends Error {}

export interface BatchRequest {
  runId: string;
  candidateId: string;
  rulesText: string;
  /** true = 基线：不加外部规则，直接用当前生产内置提示词（rulesText 忽略）。 */
  baseline?: boolean;
  caseIds: string[];
  split: "train" | "validation" | "holdout";
  repeat: number;
  captureTraces: boolean;
  budget?: BudgetLimits;
  budgetMode?: "monitor" | "enforce";
}

export interface BatchItemResult {
  caseId: string;
  trialId: string;
  status: "scored" | "task_error" | "unscored";
  score: number | null;
  metrics: Record<string, number | null>;
  hardFailures: string[];
  output: unknown;
  feedback: string;
  traceRef?: string;
  error?: string;
}

export interface BatchCaseResult {
  caseId: string;
  trials: number;
  scored: number;
  meanScore: number | null;
  scores: Array<number | null>;
  statuses: string[];
  hardFailures: string[];
}

export interface BatchOutcome {
  runId: string;
  candidateId: string;
  rulesText: string;
  baseline: boolean;
  rulesHash: string;
  basePromptHash: string;
  compiledPromptHash: string;
  split: string;
  repeat: number;
  items: BatchItemResult[];
  cases: BatchCaseResult[];
  budget: BudgetSnapshot;
  stoppedByBudget: boolean;
}

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function finiteOrUndef(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new BatchProtocolError(`${name} 必须是非负有限数：${String(v)}`);
  return v;
}

/** 解析并校验 BatchRequest；未知 status、重复 caseId、非有限数等一律拒绝。 */
export function parseBatchRequest(raw: unknown, opts: { allowedCaseIds: ReadonlySet<string>; maxRepeat?: number }): BatchRequest {
  if (!raw || typeof raw !== "object") throw new BatchProtocolError("BatchRequest 必须是对象");
  const r = raw as Record<string, unknown>;
  if (!isStr(r.runId)) throw new BatchProtocolError("runId 缺失");
  if (!isStr(r.candidateId)) throw new BatchProtocolError("candidateId 缺失");
  if (r.baseline !== undefined && typeof r.baseline !== "boolean") throw new BatchProtocolError("baseline 必须是 boolean");
  const baseline = r.baseline === true;
  if (!baseline && typeof r.rulesText !== "string") throw new BatchProtocolError("rulesText 必须是字符串（baseline=true 时可省略）");
  if (!["train", "validation", "holdout"].includes(String(r.split))) throw new BatchProtocolError(`split 非法：${String(r.split)}`);
  if (!Array.isArray(r.caseIds) || r.caseIds.length === 0) throw new BatchProtocolError("caseIds 必须是非空数组");
  const caseIds = r.caseIds.map((c) => (isStr(c) ? c : ""));
  if (caseIds.some((c) => !c)) throw new BatchProtocolError("caseIds 含空值");
  const seen = new Set<string>();
  for (const id of caseIds) {
    if (seen.has(id)) throw new BatchProtocolError(`caseId 重复：${id}`);
    seen.add(id);
    if (!opts.allowedCaseIds.has(id)) throw new BatchProtocolError(`caseId 未被批准（不在该 split 的可运行清单）：${id}`);
  }
  const repeat = r.repeat === undefined ? 1 : r.repeat;
  const maxRepeat = opts.maxRepeat ?? MAX_REPEAT;
  if (!Number.isInteger(repeat) || (repeat as number) < 1 || (repeat as number) > maxRepeat) {
    throw new BatchProtocolError(`repeat 必须是 1~${maxRepeat} 的整数：${String(r.repeat)}`);
  }
  if (r.captureTraces !== undefined && typeof r.captureTraces !== "boolean") throw new BatchProtocolError("captureTraces 必须是 boolean");
  if (r.budgetMode !== undefined && !["monitor", "enforce"].includes(String(r.budgetMode))) throw new BatchProtocolError(`budgetMode 非法：${String(r.budgetMode)}`);
  const rawBudget = (r.budget ?? {}) as Record<string, unknown>;
  const budget: BudgetLimits = {
    maxTokens: finiteOrUndef(rawBudget.maxTokens, "budget.maxTokens"),
    maxUsd: finiteOrUndef(rawBudget.maxUsd, "budget.maxUsd"),
    maxWallMs: finiteOrUndef(rawBudget.maxWallMs, "budget.maxWallMs"),
    maxTrials: finiteOrUndef(rawBudget.maxTrials, "budget.maxTrials"),
  };
  return {
    runId: r.runId,
    candidateId: r.candidateId,
    rulesText: typeof r.rulesText === "string" ? r.rulesText : "",
    baseline,
    caseIds,
    split: r.split as BatchRequest["split"],
    repeat: repeat as number,
    captureTraces: r.captureTraces === true,
    budget,
    ...(r.budgetMode ? { budgetMode: r.budgetMode as "monitor" | "enforce" } : {}),
  };
}

function usageOf(result: CaseRunResult): UsageRecord {
  const total = result.rounds.reduce((a, r) => a + (r.usage.totalTokens ?? 0), 0);
  const has = result.rounds.some((r) => r.usage.totalTokens !== null);
  return { totalTokens: has ? total : null };
}

/** 汇总逐 trial → 逐 case（均值；GEPA 一个输入 case 对应一个均值分）。 */
export function aggregateCases(items: BatchItemResult[]): BatchCaseResult[] {
  const byCase = new Map<string, BatchItemResult[]>();
  for (const it of items) {
    const arr = byCase.get(it.caseId) ?? [];
    arr.push(it);
    byCase.set(it.caseId, arr);
  }
  return [...byCase.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([caseId, its]) => {
      const scores = its.map((i) => i.score);
      const numeric = scores.filter((s): s is number => s !== null);
      return {
        caseId,
        trials: its.length,
        scored: its.filter((i) => i.status === "scored").length,
        meanScore: numeric.length > 0 ? numeric.reduce((a, b) => a + b, 0) / numeric.length : null,
        scores,
        statuses: its.map((i) => i.status),
        hardFailures: [...new Set(its.flatMap((i) => i.hardFailures))],
      };
    });
}

export interface BatchDeps {
  runTrial: (args: {
    caseId: string;
    trialId: string;
    compiledPrompt: string;
    captureTraces: boolean;
  }) => Promise<{ result: CaseRunResult; truth: TruthFileV2; traceRef?: string }>;
}

/**
 * 执行一个 batch。
 * 系统性失败（材料 hash/隔离/评分器失配，由 runner 抛 SystematicBatchError）终止整轮；
 * 个别模型/工具失败产出 task_error 记录与失败分，不终止（§6.1.3）。
 */
export async function runBatch(request: BatchRequest, deps: BatchDeps): Promise<BatchOutcome> {
  const compiled: CompiledCandidate = request.baseline ? compileBaseline() : compileCandidate(request.rulesText);
  const budget = new BudgetLedger(request.budget ?? {}, request.budgetMode ?? "monitor");
  const items: BatchItemResult[] = [];
  let stoppedByBudget = false;

  outer: for (const caseId of request.caseIds) {
    for (let t = 1; t <= request.repeat; t++) {
      if (!budget.canStartTrial()) {
        stoppedByBudget = true;
        break outer;
      }
      const trialId = `${caseId}-t${t}`;
      try {
        const { result, truth, traceRef } = await deps.runTrial({
          caseId,
          trialId,
          compiledPrompt: compiled.compiledPrompt,
          captureTraces: request.captureTraces,
        });
        budget.record(usageOf(result));
        const g = gradeCase(result, truth);
        items.push({
          caseId,
          trialId,
          status: g.status,
          score: g.score,
          metrics: g.metrics,
          hardFailures: g.hardFailures,
          output: result.rounds.map((r) => r.report ?? r.replyText),
          feedback: g.feedback,
          ...(traceRef ? { traceRef } : {}),
        });
      } catch (err) {
        if (err instanceof SystematicBatchError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        budget.record({ totalTokens: null });
        items.push({
          caseId,
          trialId,
          status: "task_error",
          score: 0,
          metrics: {},
          hardFailures: [`task_error:${caseId}`],
          output: null,
          feedback: `个别执行失败（保留记录，不计为通过）：${message}`,
          error: message,
        });
      }
    }
  }

  return {
    runId: request.runId,
    candidateId: request.candidateId,
    rulesText: compiled.rulesText,
    baseline: request.baseline === true,
    rulesHash: compiled.rulesHash,
    basePromptHash: compiled.basePromptHash,
    compiledPromptHash: compiled.compiledPromptHash,
    split: request.split,
    repeat: request.repeat,
    items,
    cases: aggregateCases(items),
    budget: budget.snapshot(),
    stoppedByBudget,
  };
}
