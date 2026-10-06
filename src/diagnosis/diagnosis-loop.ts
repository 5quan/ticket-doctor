// 有界补证循环（OQ-30）的程序控制器：诊断 → 审计 → （审计建议 continue 且预算足够）补证 → 修订 → 再审计。
//
// 两条执行路径（内联 orchestrator / 进程 runner）共用这一条循环，避免某种模式绕过审计或补证。
// 预算：引擎、审计、补证共享同一个 Toolbox（工具额度）与 AbortSignal（总超时）；循环次数由 maxRounds 封顶。
// 模型只出判定与草稿；是否继续、补什么，由这里按确定性规则决定（模型不得直接改终态）。
import { randomUUID } from "node:crypto";
import type { AuditConfig } from "../config/index.ts";
import type { DiagnosisInput, MaterialScope } from "../domain/types.ts";
import { envelope, observeText, type AttemptObservationScope } from "../observability/types.ts";
import type { DiagnosisEngine, EngineResult, SessionSink, Toolbox } from "../agent/types.ts";
import { AUDIT_POLICY_VERSION, type AuditResult, type EvidenceAuditor } from "../agent/audit-types.ts";
import type { EvidenceRef } from "../evidence/types.ts";
import { buildAuditInput, runAuditPhase, type AuditPhaseOutcome } from "./audit.ts";

export interface DiagnosisLoopDeps {
  engine: DiagnosisEngine;
  auditor: EvidenceAuditor | undefined;
  auditConfig: AuditConfig;
  /** 补证循环上限（0=单次审计）。 */
  maxRounds: number;
  signal: AbortSignal;
  input: DiagnosisInput;
  scope: MaterialScope;
  toolbox: Toolbox;
  /** 需要能追加用户消息（补证指令写回同一会话）；两个执行路径的 session 都实现了。 */
  session: SessionSink & { appendUserMessage(text: string): void };
  obs?: AttemptObservationScope;
  /** 每轮重建审计证据快照（补证后证据会变）。 */
  evidence: () => EvidenceRef[];
  /** 每轮执行限制（工具/时间预算口径）。 */
  executionLimits: () => string[];
  /** 每轮审计完成回调（进程路径发 progress、内联路径记 run_event）。 */
  onAudit?: (round: number, outcome: AuditPhaseOutcome) => void;
}

export interface DiagnosisLoopResult {
  result: EngineResult;
  audit?: AuditResult;
  auditFailure?: string;
  modelTurns: number;
  /** 实际补证轮数（0=只做了一次审计）。 */
  auditRounds: number;
}

/** 补证指令：把审计的缺证项转成给主诊断会话的追问（同一会话，保留调查历史）。 */
export function renderSupplementPrompt(audit: AuditResult, round: number): string {
  const lines = [`（第 ${round} 轮补证）独立审计认为材料尚不足。请针对以下缺口继续取证，然后重新调用 submit_report：`];
  for (const item of audit.missingEvidence) {
    const target = item.hypothesisIndex >= 0 ? `结论 ${item.hypothesisIndex + 1}` : "整体";
    const tool = item.suggestedTool ? `；建议工具 ${item.suggestedTool}` : "";
    lines.push(`- ${target}：${item.what}${tool}`);
  }
  if (audit.stopAdvice.action === "continue") lines.push(`审计理由：${audit.stopAdvice.reason}`);
  lines.push("若确实无法获取，请在报告中如实写入 missingMaterial，并把相关结论标为 candidate。");
  return lines.join("\n");
}

/** 程序收敛判定：只有「审计建议 continue + 有补证项 + 未到轮次/工具预算上限」才继续。 */
export function shouldSupplement(
  audit: AuditResult | undefined,
  ctx: { rounds: number; maxRounds: number; toolCalls: number; maxToolCalls: number },
): boolean {
  if (!audit) return false;
  if (ctx.rounds >= ctx.maxRounds) return false;
  if (ctx.toolCalls >= ctx.maxToolCalls) return false;
  if (audit.stopAdvice.action !== "continue") return false;
  return audit.missingEvidence.length > 0;
}

export async function runDiagnosisLoop(deps: DiagnosisLoopDeps): Promise<DiagnosisLoopResult> {
  let result = await deps.engine.run(deps.input, deps.toolbox, deps.signal, deps.session, deps.obs);
  let modelTurns = result.modelTurns;
  let audit: AuditResult | undefined;
  let auditFailure: string | undefined;
  let rounds = 0;

  if (result.kind !== "report") return { result, modelTurns, auditRounds: 0 };
  // 审计未启用/未构建：不调用审计、也不发 onAudit（避免“审计未开却记审计事件”）。
  if (!deps.auditor || !deps.auditConfig.enabled) return { result, modelTurns, auditRounds: 0 };

  for (;;) {
    // 每轮审计一个独立观测范围：trace 根下建 audit#n 兄弟节点，其 generation 挂在该节点下。
    const auditScope = deps.obs ? { scopeId: randomUUID(), sink: deps.obs.sink } : undefined;
    if (auditScope) {
      auditScope.sink.record({
        ...envelope(1),
        kind: "phase_start",
        phase: "audit",
        logicalObservationId: auditScope.scopeId,
        input: observeText(
          { round: rounds + 1, question: deps.input.question, draftSummary: result.draft.summary },
          4_096,
        ),
        metadata: { round: rounds, policyVersion: AUDIT_POLICY_VERSION },
      });
    }
    let outcome: AuditPhaseOutcome;
    try {
      outcome = await runAuditPhase({
        auditor: deps.auditor,
        config: deps.auditConfig,
        input: buildAuditInput({
          question: deps.input.question,
          service: deps.input.service,
          environment: deps.input.environment,
          scope: deps.scope,
          draft: result.draft,
          evidence: deps.evidence(),
          executionLimits: deps.executionLimits(),
        }),
        signal: deps.signal,
        obs: auditScope,
      });
    } catch (err) {
      if (auditScope) {
        auditScope.sink.record({
          ...envelope(2),
          kind: "phase_end",
          phase: "audit",
          logicalObservationId: auditScope.scopeId,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          metadata: { round: rounds },
        });
      }
      throw err;
    }
    if (auditScope) {
      auditScope.sink.record({
        ...envelope(2),
        kind: "phase_end",
        phase: "audit",
        logicalObservationId: auditScope.scopeId,
        status: outcome.failure ? "error" : "ok",
        output: observeText(
          {
            verdicts: outcome.audit?.claimVerdicts ?? [],
            missingEvidence: outcome.audit?.missingEvidence ?? [],
            stopAdvice: outcome.audit?.stopAdvice ?? null,
            failure: outcome.failure ?? null,
          },
          4_096,
        ),
        error: outcome.failure,
        metadata: {
          round: rounds,
          policyVersion: outcome.policyVersion,
          verdicts: outcome.audit?.claimVerdicts.length ?? 0,
          stopAdvice: outcome.audit?.stopAdvice?.action ?? null,
        },
      });
    }
    modelTurns += outcome.modelTurns;
    audit = outcome.audit;
    auditFailure = outcome.failure;
    deps.onAudit?.(rounds, outcome);

    if (
      !shouldSupplement(outcome.audit, {
        rounds,
        maxRounds: deps.maxRounds,
        toolCalls: deps.toolbox.toolCalls,
        maxToolCalls: deps.toolbox.maxToolCalls,
      })
    ) {
      break;
    }

    rounds += 1;
    deps.session.appendUserMessage(renderSupplementPrompt(outcome.audit!, rounds));
    const next = await deps.engine.run(deps.input, deps.toolbox, deps.signal, deps.session, deps.obs);
    modelTurns += next.modelTurns;
    if (next.kind !== "report") {
      // 补证轮变成闲聊/反问：以该结果为准，保留已得的审计判定（供 Host 记录）
      return { result: next, audit, auditFailure, modelTurns, auditRounds: rounds };
    }
    result = next;
  }

  return { result, audit, auditFailure, modelTurns, auditRounds: rounds };
}
