// 确定性假引擎：零模型成本，用于离线 demo、测试与框架自检。
// 它产出与真实引擎同形的 ReportDraft，走完全相同的工具箱与校验路径——
// 保证"框架正确"可以在没有模型/网络的情况下被验证。
import type { DiagnosisInput, ReportDraft } from "../domain/types.ts";
import type { DiagnosisEngine, EngineResult, Toolbox } from "./types.ts";

export interface FakeEngineOptions {
  defaultService?: string;
  /** 时间窗半宽，默认 6 小时。 */
  windowMs?: number;
}

function guessService(question: string, fallback: string): string {
  const labelled = question.match(/(?:服务(?:名)?|service)\s*[：:=]\s*([A-Za-z0-9._-]{2,100})/i);
  if (labelled) return labelled[1];
  const named = question.match(/\b([a-zA-Z0-9][a-zA-Z0-9._-]{1,99}-(?:service|server|api))\b/i);
  return named ? named[1] : fallback;
}

function guessKeywords(question: string): string[] {
  const tokens = question.match(/[A-Za-z_][A-Za-z0-9_.]{3,}/g) ?? [];
  const filtered = tokens.filter((t) => !/^(https?|the|and|with|that|this)$/i.test(t));
  const merged = [...filtered.slice(0, 4), "ERROR", "Exception", "timeout", "失败"];
  return [...new Set(merged)].slice(0, 6);
}

function extractEvidenceIds(text: string): string[] {
  return [...text.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]);
}

function identifiersIn(text: string): string[] {
  const at = [...text.matchAll(/\bat\s+[A-Za-z_][\w.$]*?\.([A-Z][A-Za-z0-9_]{3,})/g)].map((m) => m[1]);
  const exception = [...text.matchAll(/\b([A-Z][A-Za-z0-9_]{3,}(?:Exception|Error))\b/g)].map((m) => m[1]);
  const pascal = [...text.matchAll(/\b([A-Z][A-Za-z0-9_]{3,})\b/g)].map((m) => m[1]);
  return [...new Set([...exception, ...at, ...pascal])];
}

export class FakeDiagnosisEngine implements DiagnosisEngine {
  readonly name = "fake";
  private readonly defaultService: string;
  private readonly windowMs: number;

  constructor(opts: FakeEngineOptions = {}) {
    this.defaultService = opts.defaultService ?? "checkout-service";
    this.windowMs = opts.windowMs ?? 6 * 60 * 60 * 1000;
  }

  async run(input: DiagnosisInput, toolbox: Toolbox, signal: AbortSignal): Promise<EngineResult> {
    signal.throwIfAborted();
    const service = input.service ?? guessService(input.question, this.defaultService);
    const occurred = input.occurredAt ?? Date.now();
    const from = occurred - this.windowMs;
    const to = occurred + 60 * 60 * 1000;

    const missingMaterial: string[] = [];
    const confirmedFacts: string[] = [];
    const hypotheses: ReportDraft["hypotheses"] = [];
    const nextSteps: string[] = [];

    const logText = await toolbox.queryLogs({ service, from, to, keywords: guessKeywords(input.question) });
    const logIds = extractEvidenceIds(logText);
    if (logIds.length > 0) {
      confirmedFacts.push(`服务 ${service} 在 [${new Date(from).toISOString()} ~ ${new Date(to).toISOString()}] 命中 ${logIds.length} 条相关日志`);
      const firstErrorLine = logText.split("\n").find((l) => /ERROR|Exception|timeout|失败/i.test(l)) ?? logText.split("\n")[0];
      hypotheses.push({
        cause: `日志显示：${firstErrorLine.replace(/^\[E\d+\]\s*/, "").slice(0, 200)}`,
        confidence: "medium",
        status: "supported",
        evidenceIds: logIds.slice(0, 3),
      });
      nextSteps.push("结合日志 traceId 在链路追踪系统核对上下游调用");
    } else {
      missingMaterial.push(`服务 ${service} 在给定时间窗内没有检索到相关日志（确认服务名/时间窗是否正确）`);
    }

    if (toolbox.hasCode) {
      const candidates = identifiersIn(logText).slice(0, 3);
      for (const codeToken of candidates) {
        try {
          const codeText = await toolbox.searchCode({ pattern: codeToken });
          const codeIds = extractEvidenceIds(codeText);
          if (codeIds.length > 0) {
            confirmedFacts.push(`在源码中检索到与 ${codeToken} 相关的 ${codeIds.length} 处代码`);
            const target = hypotheses[0];
            if (target) {
              target.evidenceIds = [...(target.evidenceIds ?? []), ...codeIds.slice(0, 2)];
              target.confidence = "high";
            }
            break;
          }
        } catch (err) {
          missingMaterial.push(`源码检索失败：${err instanceof Error ? err.message : String(err)}`);
          break;
        }
      }
    } else if ((input.repositories?.length ?? 0) > 0) {
      missingMaterial.push("工单指定了源码仓库，但本次运行无法解析到对应版本");
    }

    const completeness: ReportDraft["completeness"] = missingMaterial.length === 0 ? "complete" : "partial";
    const draft: ReportDraft = {
      completeness,
      summary: input.question.slice(0, 200),
      confirmedFacts,
      hypotheses,
      uncertainties: hypotheses.length > 0 ? ["预检只做材料与假设，根因需开发确认"] : [],
      nextSteps,
      missingMaterial,
    };
    return { kind: "report", draft, toolCalls: toolbox.toolCalls, modelTurns: 1, model: "fake" };
  }
}
