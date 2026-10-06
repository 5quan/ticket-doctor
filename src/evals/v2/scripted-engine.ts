// 脚本引擎：engineering case 的确定性被测对象（方案 §7.1 "默认 fake/scripted"）。
//
// 每轮消费一个 step；step 先经真实 toolbox 取证（证据照常两阶段入库、签发 E#），再产出 reply 或
// report。与 pi 引擎同构：每次工具调用经 SessionSink 记录 tool_executions 并把带 [E#] 的返回文本
// 补记为 toolResult 会话条目——C1 层（模型实际可见文本）因此与真实引擎同一来源。
// draft 中未显式给 evidenceIds 的假设自动填上本轮取证返回的编号。
// 仅允许 engineering 拆分使用（schema 已约束）。
//
// ScriptedAuditor（A1）：确定性脚本审计器。审计开启时 scripted/fake 引擎只允许确定性审计——
// 严禁按环境配置回落到真实模型审计器（费用边界：确定性评测不得产生 API 调用）。
import { randomUUID } from "node:crypto";
import type { ReportDraft } from "../../domain/types.ts";
import type { DiagnosisEngine, EngineResult, SessionSink, Toolbox } from "../../agent/types.ts";
import type { LogQueryArgs, CodeSearchArgs, CodeReadArgs } from "../../agent/types.ts";
import type { AttemptObservationScope } from "../../observability/types.ts";
import { type AuditInput, type AuditOutcome, type AuditResult, type ClaimVerdict, type EvidenceAuditor, type MissingEvidence, type StopAdvice } from "../../agent/audit-types.ts";

export type ScriptToolCall =
  | { tool: "queryLogs"; args: LogQueryArgs }
  | { tool: "searchCode"; args: CodeSearchArgs }
  | { tool: "readCode"; args: CodeReadArgs }
  | { tool: "listFiles"; args: { glob?: string; repoId?: string } };

export type ScriptStep =
  | { kind: "reply"; reason: "clarify" | "chat"; text: string; tools?: ScriptToolCall[] }
  | { kind: "report"; draft: ReportDraft; tools?: ScriptToolCall[] };

function extractEvidenceIds(text: string): string[] {
  return [...text.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]);
}

export class ScriptedDiagnosisEngine implements DiagnosisEngine {
  readonly name = "scripted";
  private readonly steps: ScriptStep[];

  constructor(steps: ScriptStep[]) {
    this.steps = [...steps];
  }

  async run(input: unknown, toolbox: Toolbox, signal: AbortSignal, session?: SessionSink): Promise<EngineResult> {
    signal.throwIfAborted();
    void input;
    const step = this.steps.shift();
    if (!step) {
      return {
        kind: "report",
        draft: {
          completeness: "partial",
          summary: "脚本已耗尽",
          confirmedFacts: [],
          hypotheses: [],
          uncertainties: [],
          nextSteps: [],
          missingMaterial: ["脚本引擎步骤耗尽"],
        },
        toolCalls: toolbox.toolCalls,
        modelTurns: 1,
        model: "scripted",
      };
    }

    // 与 pi-engine.timedTool 同构：记录耗时/成败，返回文本进会话（C1 的来源）。
    const evidenceIds: string[] = [];
    for (const call of step.tools ?? []) {
      const callId = randomUUID();
      const started = Date.now();
      try {
        const text =
          call.tool === "queryLogs"
            ? await toolbox.queryLogs(call.args, callId)
            : call.tool === "searchCode"
              ? await toolbox.searchCode(call.args, callId)
              : call.tool === "readCode"
                ? await toolbox.readCode(call.args, callId)
                : await toolbox.listFiles(call.args, callId);
        session?.recordTool({
          callId,
          tool: call.tool,
          input: call.args,
          ok: true,
          durationMs: Date.now() - started,
          outputChars: text.length,
        });
        session?.appendEntry({
          type: "message",
          id: randomUUID(),
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "toolResult",
            toolCallId: callId,
            toolName: call.tool,
            content: [{ type: "text", text }],
            isError: false,
            timestamp: Date.now(),
          },
        } as never);
        evidenceIds.push(...extractEvidenceIds(text));
      } catch (err) {
        session?.recordTool({
          callId,
          tool: call.tool,
          input: call.args,
          ok: false,
          durationMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    if (step.kind === "reply") {
      return { kind: "reply", reason: step.reason, text: step.text, toolCalls: toolbox.toolCalls, modelTurns: 1, model: "scripted" };
    }
    const draft: ReportDraft = {
      ...step.draft,
      hypotheses: step.draft.hypotheses.map((h) => ({
        ...h,
        evidenceIds: h.evidenceIds ?? [...new Set(evidenceIds)],
      })),
    };
    return { kind: "report", draft, toolCalls: toolbox.toolCalls, modelTurns: 1, model: "scripted" };
  }
}

/** 引擎装饰器：深拷贝捕获每次 run 的原始结果（三阶段中的 raw；方案 §7.3）。 */
export class CapturingEngine implements DiagnosisEngine {
  readonly name: string;
  readonly captured: EngineResult[] = [];
  private readonly inner: DiagnosisEngine;

  constructor(inner: DiagnosisEngine) {
    this.inner = inner;
    this.name = inner.name;
  }

  async run(
    input: Parameters<DiagnosisEngine["run"]>[0],
    toolbox: Toolbox,
    signal: AbortSignal,
    session?: Parameters<DiagnosisEngine["run"]>[3],
    obs?: AttemptObservationScope,
  ): Promise<EngineResult> {
    // obs 必须透传（A1）：生产引擎的观测范围在捕获装饰下不得丢失。
    const result = await this.inner.run(input, toolbox, signal, session, obs);
    this.captured.push(structuredClone(result));
    return result;
  }
}

// ---------- 确定性脚本审计器（A1） ----------

export interface ScriptedAuditStep {
  /** 逐结论判定；缺省 = 全部 supported（不降级）。 */
  verdicts?: Array<{ hypothesisIndex: number; verdict: ClaimVerdict; reason: string; evidenceUids?: string[] }>;
  /** 补证项：stopAdvice=continue 且非空时诊断循环才会补证。 */
  missingEvidence?: MissingEvidence[];
  stopAdvice?: StopAdvice;
  /** 置位时本次审计调用抛错（确定性注入审计失败路径；failBlocks 决定阻断或降级）。 */
  failure?: string;
}

const SCRIPT_AUDIT_EXHAUSTED = "脚本审计步骤耗尽";

/**
 * 按 audit.json 步骤顺序消费的确定性审计器：一次审计调用消费一个 step。
 * 脚本耗尽后返回"全部支持 + 停止"（不降级、不补证），并保留显式记录供 trace 核对。
 */
export class ScriptedAuditor implements EvidenceAuditor {
  readonly name = "scripted-audit";
  readonly stepsConsumed: ScriptedAuditStep[] = [];
  private readonly steps: ScriptedAuditStep[];

  constructor(steps: ScriptedAuditStep[]) {
    this.steps = [...steps];
  }

  async audit(input: AuditInput, signal: AbortSignal, _obs?: AttemptObservationScope): Promise<AuditOutcome> {
    signal.throwIfAborted();
    const step = this.steps.shift();
    if (step) this.stepsConsumed.push(step);
    if (step?.failure) throw new Error(step.failure);
    const claimVerdicts =
      step?.verdicts ??
      input.draft.hypotheses.map((h, i) => ({ hypothesisIndex: i, verdict: "supported" as const, reason: SCRIPT_AUDIT_EXHAUSTED }));
    const result: AuditResult = {
      claimVerdicts,
      missingEvidence: step?.missingEvidence ?? [],
      stopAdvice: step?.stopAdvice ?? { action: "stop", reason: SCRIPT_AUDIT_EXHAUSTED },
    };
    return { result, modelTurns: 1 };
  }
}
