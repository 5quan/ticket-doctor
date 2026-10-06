// 脚本引擎：engineering case 的确定性被测对象（方案 §7.1 "默认 fake/scripted"）。
//
// 每轮消费一个 step；step 先经真实 toolbox 取证（证据照常两阶段入库、签发 E#），再产出 reply 或
// report。与 pi 引擎同构：每次工具调用经 SessionSink 记录 tool_executions 并把带 [E#] 的返回文本
// 补记为 toolResult 会话条目——C1 层（模型实际可见文本）因此与真实引擎同一来源。
// draft 中未显式给 evidenceIds 的假设自动填上本轮取证返回的编号。
// 仅允许 engineering 拆分使用（schema 已约束）。
import { randomUUID } from "node:crypto";
import type { ReportDraft } from "../../domain/types.ts";
import type { DiagnosisEngine, EngineResult, SessionSink, Toolbox } from "../../agent/types.ts";
import type { LogQueryArgs, CodeSearchArgs, CodeReadArgs } from "../../agent/types.ts";

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

  async run(input: Parameters<DiagnosisEngine["run"]>[0], toolbox: Toolbox, signal: AbortSignal, session?: Parameters<DiagnosisEngine["run"]>[3]): Promise<EngineResult> {
    const result = await this.inner.run(input, toolbox, signal, session);
    this.captured.push(structuredClone(result));
    return result;
  }
}
