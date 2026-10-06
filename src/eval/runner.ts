// 离线评测运行器：复用正式链路（prepare → 引擎+审计循环 → 校验 → 审计应用），只在内存里跑。
//
// 范围（评审修正）：本运行器测**诊断核心**（工具/证据/引擎/审计/校验）。
// 持久化、调查隔离、正式回写（Host finalize/投递/代次守卫）不在其内，须另行验证，不得笼统宣称覆盖完整生产链路。
import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config/index.ts";
import type { AuditResult } from "../agent/audit-types.ts";
import type { SessionSink, ToolExecutionRecord } from "../agent/types.ts";
import type { DiagnosisReport, MaterialScope, ReportDraft } from "../domain/types.ts";
import type { EvidenceRef } from "../evidence/types.ts";
import { MemoryEvidenceSink } from "../evidence/memory-sink.ts";
import { buildAuditor, buildEngine } from "../agent/factory.ts";
import { prepareDiagnosis } from "../diagnosis/prepare.ts";
import { usageOf } from "../diagnosis/run-session.ts";
import { runDiagnosisLoop } from "../diagnosis/diagnosis-loop.ts";
import { validateDraft, type ValidationIssue } from "../diagnosis/validate.ts";
import { applyAudit, applyAuditFailure } from "../diagnosis/audit.ts";
import type { EvalCase } from "./benchmark.ts";

/** 内存会话槽：评测单次运行用，不落库（覆盖范围见文件头）。 */
class MemorySessionSink implements SessionSink {
  readonly priorEntries: SessionEntry[] = [];
  readonly resumed = false;
  readonly usage = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0 };
  appendEntry(entry: SessionEntry): void {
    this.priorEntries.push(entry);
    const u = usageOf(entry);
    if (!u) return;
    this.usage.inputTokens += u.inputTokens;
    this.usage.outputTokens += u.outputTokens;
    this.usage.cacheTokens += u.cacheTokens;
    this.usage.totalTokens += u.totalTokens;
  }
  recordTool(_record: ToolExecutionRecord): void {}
  appendUserMessage(text: string): void {
    const entry = {
      type: "message",
      id: randomUUID(),
      parentId: this.priorEntries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: text, timestamp: Date.now() },
    } as unknown as SessionEntry;
    this.priorEntries.push(entry);
  }
}

export interface CaseRunMetrics {
  toolCalls: number;
  modelTurns: number;
  auditRounds: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CaseRunResult {
  caseId: string;
  runIndex: number;
  ok: boolean;
  error?: string;
  kind?: "report" | "reply";
  replyText?: string;
  /** 模型原输出（未校验）。 */
  draft?: ReportDraft;
  /** 程序校验后、未经审计的报告。 */
  validated?: DiagnosisReport;
  /** 审计应用后的最终报告。 */
  report?: DiagnosisReport;
  audit?: AuditResult;
  auditFailure?: string;
  /** 校验问题（引用不存在/版本不符等），供打分区分“材料命中”与“引用有效性”。 */
  validationIssues?: ValidationIssue[];
  evidence: EvidenceRef[];
  scope?: MaterialScope;
  metrics: CaseRunMetrics;
}

export async function runCase(opts: {
  config: AppConfig;
  engineName: "fake" | "pi";
  systemPrompt: string;
  c: EvalCase;
  runIndex: number;
}): Promise<CaseRunResult> {
  const { config, c, runIndex } = opts;
  const startedAt = Date.now();
  const investigationId = `eval-${c.id}`;
  const runId = `eval-${c.id}-${runIndex}-${randomUUID().slice(0, 8)}`;
  const sink = new MemoryEvidenceSink(runId);
  const controller = new AbortController();
  const base = { caseId: c.id, runIndex, evidence: [] as EvidenceRef[] };

  try {
    const receivedAt = c.occurredAt ? Date.parse(c.occurredAt) : Date.now();
    const missingFromCase: string[] = [];
    if (c.logOnly) missingFromCase.push("本案例仅提供日志，没有可绑定的源码版本（只评日志定位，不评代码根因）");

    const prepared = await prepareDiagnosis(config, {
      investigationId,
      runId,
      text: c.question,
      receivedAt,
      service: c.service,
      environment: c.environment,
      signal: controller.signal,
      sink,
    });

    const engine = buildEngine(config, opts.systemPrompt);
    const auditor = config.diagnosis.audit.enabled ? buildAuditor(config) : undefined;
    const session = new MemorySessionSink();
    const executionLimits = [
      `工具调用 ${config.diagnosis.maxToolCalls}`,
      `时间预算 ${config.diagnosis.timeoutMs}ms`,
    ];

    const loop = await runDiagnosisLoop({
      engine,
      auditor,
      auditConfig: config.diagnosis.audit,
      maxRounds: config.diagnosis.audit.maxRounds,
      signal: controller.signal,
      input: prepared.input,
      scope: prepared.scope,
      toolbox: prepared.toolbox,
      session,
      evidence: () => sink.all(),
      executionLimits: () => executionLimits,
    });

    const usage = session.usage;
    const metrics: CaseRunMetrics = {
      toolCalls: prepared.toolbox.toolCalls,
      modelTurns: loop.modelTurns,
      auditRounds: loop.auditRounds,
      durationMs: Date.now() - startedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    };

    if (loop.result.kind === "reply") {
      return { ...base, ok: true, kind: "reply", replyText: loop.result.text, evidence: sink.all(), scope: prepared.scope, metrics };
    }

    const draft: ReportDraft = {
      ...loop.result.draft,
      missingMaterial: [...loop.result.draft.missingMaterial, ...prepared.missingMaterial, ...missingFromCase],
    };
    const validation = validateDraft(draft, {
      resolver: sink,
      scope: prepared.scope,
      investigationId,
      executionLimits,
    });
    const validated = validation.report;
    let report = validated;
    if (loop.audit) report = applyAudit(report, loop.audit);
    if (loop.auditFailure) report = applyAuditFailure(report, loop.auditFailure);

    return {
      ...base,
      ok: true,
      kind: "report",
      draft,
      validated,
      report,
      audit: loop.audit,
      auditFailure: loop.auditFailure,
      validationIssues: validation.issues,
      evidence: sink.all(),
      scope: prepared.scope,
      metrics,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      metrics: { toolCalls: 0, modelTurns: 0, auditRounds: 0, durationMs: Date.now() - startedAt, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}
