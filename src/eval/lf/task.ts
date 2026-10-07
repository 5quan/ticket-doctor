// 官方 SDK task（plan §3/§6）：一个 Dataset Item = 一次完整调查。
// task 由 dataset.runExperiment 逐 item 调用；本模块把 item 路由到本地冻结材料 +
// runCase 执行核心，并把结果整理为可读回的 output 载荷。
// 全程固定同一提示词版本；过程捕获由 recorder（joinActiveContext）挂到实验 trace 下。
import { context as otelContext } from "@opentelemetry/api";
import { join } from "node:path";
import type { AppConfig } from "../../config/index.ts";
import type { ObservationRecorder } from "../../observability/langfuse.ts";
import { loadCatalog, loadCase, type CatalogEntry } from "./internals/load.ts";
import { loadSmokeTruth, casePublicHash, SMOKE_PROTOCOL } from "./seed.ts";
import { runCase, type CaseRunResult, type EvalEngine } from "./run-case.ts";
import type { PromptVersion } from "./prompt.ts";

export interface CaseTaskOutput {
  protocolVersion: string;
  caseId: string;
  scenario: string;
  prompt: {
    name: string;
    version: number;
    hash: string;
    /** 引擎自报系统提示词与目标一致（执行前配置）。 */
    injectedVerified: boolean;
    injectedMatches: boolean | null;
    /** 从实际模型请求（effective context）捕获的系统提示词是否与目标一致（plan §5 实证）。 */
    effectiveVerified: boolean;
    effectiveMatches: boolean | null;
    effectiveTruncated: boolean;
  };
  engine: string;
  auditEngine: string | null;
  rounds: Array<{
    roundId: string;
    outcome: string;
    status: string;
    blocked: boolean;
    error?: string;
    engineCalls: number;
    report: unknown;
    replyText: string | null;
    writebackText: string | null;
    toolCalls: number;
    usage: { inputTokens: number | null; outputTokens: number | null; cacheTokens: number | null; totalTokens: number | null };
    citations: Array<{ stage: string; rawId: string; resolved: boolean; wrongSha: boolean }>;
    scopeChecks: CaseRunResult["rounds"][number]["scopeChecks"];
    visibility: CaseRunResult["rounds"][number]["visibility"];
    allLogQueriesEmpty: boolean;
  }>;
  wallMs: number;
  /** plan §9：任务级失败（材料 hash 不匹配/隔离失败/执行异常）也返回结构化结果，不让 SDK 丢弃该案例。 */
  failure?: string;
}

export interface EvalTaskOptions {
  projectRoot: string;
  evalRoot: string;
  baseConfig: AppConfig;
  engine: EvalEngine;
  /** 实验全程固定的提示词版本（plan §5）。 */
  prompt: PromptVersion;
  /** 本地落盘目录（trace.jsonl/artifacts.json，仅调试与导出）。 */
  outDir: string;
  /** 过程捕获记录器（整个实验共享一个实例，单案例不关闭）。 */
  recorder?: ObservationRecorder;
}

export function makeTicketDoctorTask(opts: EvalTaskOptions): (item: { input: unknown; metadata?: unknown }) => Promise<CaseTaskOutput> {
  const catalog: CatalogEntry[] = loadCatalog(opts.evalRoot).cases;
  const baseOutput = (caseId: string, scenario: string): CaseTaskOutput => ({
    protocolVersion: SMOKE_PROTOCOL,
    caseId,
    scenario,
    prompt: { name: opts.prompt.name, version: opts.prompt.version, hash: opts.prompt.hash, injectedVerified: false, injectedMatches: null, effectiveVerified: false, effectiveMatches: null, effectiveTruncated: false },
    engine: opts.engine,
    auditEngine: null,
    rounds: [],
    wallMs: 0,
  });
  return async (item) => {
    const meta = (item.metadata ?? {}) as { caseId?: string; scenario?: string; caseHash?: string };
    const caseId = meta.caseId ?? (item.input as { caseId?: string } | null)?.caseId ?? "unknown-case";
    const scenario = meta.scenario ?? "";
    // plan §4：input 是数据集的**权威首轮问题**（在 Langfuse 修改会实际改变 Agent 收到的问题）。
    const firstRoundQuestion = (item.input as { question?: string } | null)?.question;
    try {
      const entry = catalog.find((c) => c.caseId === caseId);
      if (!entry) throw new Error(`dataset item 引用的案例不在本地冻结材料中：${caseId}（先 eval:lf:seed）`);
      // plan §4：Dataset 版本不冻结服务器文件——运行时必须核对材料 hash，不一致即失败（不静默降级）。
      if (meta.caseHash) {
        const actualHash = casePublicHash(opts.evalRoot, loadCase(opts.evalRoot, entry, opts.projectRoot));
        if (actualHash !== meta.caseHash) {
          throw new Error(`案例 ${caseId} 材料 hash 与 dataset 记录不一致：dataset=${meta.caseHash} 本地=${actualHash}`);
        }
      }
      // 控制器可读私有标准（评分参照）；Agent 只见当前轮允许材料（runCase 内部逐轮构造）。
      loadSmokeTruth(opts.evalRoot, caseId);
      const result = await runCase({
        projectRoot: opts.projectRoot,
        evalRoot: opts.evalRoot,
        entry,
        engine: opts.engine,
        baseConfig: opts.baseConfig,
        systemPrompt: opts.prompt.compiled,
        ...(firstRoundQuestion ? { firstRoundQuestion } : {}),
        outDir: join(opts.outDir, caseId),
        // plan §6：接入 SDK task 的父 context——executeRun 在 task 的 async 链内同步调用
        // beginAttempt，active context 即实验 item 根 span 的 context。
        recorder: opts.recorder,
        otelParentContext: otelContext.active(),
      });
      return {
        protocolVersion: SMOKE_PROTOCOL,
        caseId: result.caseId,
        scenario,
        prompt: { name: opts.prompt.name, version: opts.prompt.version, hash: opts.prompt.hash, injectedVerified: result.injectedPrompt.verified, injectedMatches: result.injectedPrompt.matches, effectiveVerified: result.injectedPrompt.effectiveVerified, effectiveMatches: result.injectedPrompt.effectiveMatches, effectiveTruncated: result.injectedPrompt.effectiveTruncated },
        engine: result.engine,
        auditEngine: result.auditEngine,
        rounds: result.rounds.map((r) => ({
          roundId: r.roundId,
          outcome: r.outcome,
          status: r.status,
          blocked: r.blocked,
          ...(r.error ? { error: r.error } : {}),
          engineCalls: r.engineCalls,
          report: r.report,
          replyText: r.replyText,
          writebackText: r.writebackText,
          toolCalls: r.toolCalls,
          usage: r.usage,
          citations: r.citations,
          scopeChecks: r.scopeChecks,
          visibility: r.visibility,
          allLogQueriesEmpty: r.allLogQueriesEmpty,
        })),
        wallMs: result.wall.ms,
      };
    } catch (err) {
      // 结构化失败：SDK 会当成正常 item 记录并跑 evaluator（run_integrity=0），不丢弃该案例。
      return { ...baseOutput(caseId, scenario), failure: err instanceof Error ? err.message : String(err) };
    }
  };
}
