// 真实诊断引擎：把 pi SDK 关在这一个文件里。
//
// 与假引擎产出同一种 ReportDraft，走同一条校验路径。上层业务类型不出现任何 SDK 类型。
// 工具只有四个只读/提交动作：query_logs / search_code / read_code / submit_report。
// 显式关闭内置工具（noTools: builtin）与文件发现（自定义 ResourceLoader），
// 避免意外加载 shell、写文件或全局扩展。
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { DiagnosisInput, ReportDraft } from "../domain/types.ts";
import type { DiagnosisEngine, EngineResult, Toolbox } from "./types.ts";

const SYSTEM_PROMPT = `你是 bug 工单的预检诊断员。目标：用尽可能少的查询，尽快给出可核验的初步结论。
规则：
1. 需要日志就调用 query_logs（服务名不确定时可先用工单里的服务名或常见服务名试一次）；
   需要代码就调用 search_code / read_code（仅当本次运行提供了源码）。
2. 只读：没有 shell，没有写操作，不要尝试执行命令或修改任何东西。
3. 证据引用是硬规则：submit_report 中每条假设只能用 evidenceIds 引用工具返回的 [E#] 编号；
   禁止编造编号。没有证据的猜测请把 status 设为 candidate、confidence 设为 low。
4. 材料不完整（查询失败、服务/版本拿不到）时 completeness 必须是 partial 并逐条写 missingMaterial。
5. 最后必须调用 submit_report 提交结构化报告，不要用普通文本代替。`;

const queryLogsSchema = Type.Object({
  service: Type.String({ description: "服务名，决定查询哪个日志源" }),
  from: Type.String({ description: "起始时间，ISO8601" }),
  to: Type.String({ description: "结束时间，ISO8601" }),
  keywords: Type.Array(Type.String(), { description: "关键词，任一命中即保留；可为空数组" }),
});

const searchCodeSchema = Type.Object({
  pattern: Type.String({ description: "大小写敏感的子串，用于定位类名/方法名/异常信息" }),
  glob: Type.Optional(Type.String({ description: "按路径子串过滤，如 .java" })),
  repoId: Type.Optional(Type.String({ description: "多仓时指定仓库" })),
});

const readCodeSchema = Type.Object({
  path: Type.String({ description: "相对仓库根目录的路径" }),
  startLine: Type.Optional(Type.Number({ description: "起始行，1-based" })),
  endLine: Type.Optional(Type.Number({ description: "结束行，含端点" })),
  repoId: Type.Optional(Type.String()),
});

const reportSchema = Type.Object({
  completeness: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
  summary: Type.String({ description: "问题摘要" }),
  confirmedFacts: Type.Array(Type.String(), { description: "由证据支持的已确认事实" }),
  hypotheses: Type.Array(
    Type.Object({
      cause: Type.String(),
      confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
      status: Type.Optional(
        Type.Union([Type.Literal("supported"), Type.Literal("candidate"), Type.Literal("refuted")]),
      ),
      evidenceIds: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  uncertainties: Type.Array(Type.String()),
  nextSteps: Type.Array(Type.String()),
  missingMaterial: Type.Array(Type.String()),
});

export interface PiEngineOptions {
  provider: string;
  modelId: string;
  apiKey?: string;
  maxToolCalls: number;
  maxModelTurns: number;
  systemPrompt?: string;
}

function renderInput(input: DiagnosisInput): string {
  const lines = [`工单问题：${input.question}`];
  if (input.service) lines.push(`服务：${input.service}`);
  if (input.occurredAt) lines.push(`发生时间：${new Date(input.occurredAt).toISOString()}`);
  if (input.repositories?.length) {
    lines.push(`代码仓库：${input.repositories.map((r) => `${r.repoId}@${r.rev ?? "HEAD"}`).join("、")}`);
  }
  if (input.contextSummary) lines.push(`此前轮次上下文：${input.contextSummary}`);
  lines.push("请按系统提示完成预检，并用 submit_report 提交报告。");
  return lines.join("\n");
}

export class PiDiagnosisEngine implements DiagnosisEngine {
  readonly name = "pi";
  private readonly opts: PiEngineOptions;

  constructor(opts: PiEngineOptions) {
    this.opts = opts;
  }

  async run(input: DiagnosisInput, toolbox: Toolbox, signal: AbortSignal): Promise<EngineResult> {
    const agentDir = join(tmpdir(), "ticket-doctor-agent");
    mkdirSync(agentDir, { recursive: true });

    const modelRuntime = await ModelRuntime.create();
    if (this.opts.apiKey) await modelRuntime.setRuntimeApiKey(this.opts.provider, this.opts.apiKey);
    const model = getBuiltinModel(
      this.opts.provider as "deepseek",
      this.opts.modelId as "deepseek-v4-flash",
    );
    if (!model) throw new Error(`内置目录找不到模型：${this.opts.provider}/${this.opts.modelId}`);

    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => this.opts.systemPrompt ?? SYSTEM_PROMPT,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });

    let submitted: ReportDraft | undefined;
    let turns = 0;

    const queryLogsTool = defineTool({
      name: "query_logs",
      label: "query_logs",
      description: "查询服务在时间窗内的日志，返回带 [E#] 证据编号的原文。",
      parameters: queryLogsSchema,
      execute: async (_id, params: Static<typeof queryLogsSchema>) => {
        const from = Date.parse(params.from);
        const to = Date.parse(params.to);
        if (Number.isNaN(from) || Number.isNaN(to)) throw new Error("from/to 必须是 ISO8601 时间");
        const text = await toolbox.queryLogs({ service: params.service, from, to, keywords: params.keywords });
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    });

    const searchCodeTool = defineTool({
      name: "search_code",
      label: "search_code",
      description: "在本次运行的代码版本里按子串搜索，返回带 [E#] 的 文件:行号:内容。",
      parameters: searchCodeSchema,
      execute: async (_id, params: Static<typeof searchCodeSchema>) => {
        const text = await toolbox.searchCode({ pattern: params.pattern, glob: params.glob, repoId: params.repoId });
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    });

    const readCodeTool = defineTool({
      name: "read_code",
      label: "read_code",
      description: "读取指定版本文件的一段内容，返回带 [E#] 的原文。",
      parameters: readCodeSchema,
      execute: async (_id, params: Static<typeof readCodeSchema>) => {
        const text = await toolbox.readCode({
          path: params.path,
          startLine: params.startLine,
          endLine: params.endLine,
          repoId: params.repoId,
        });
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    });

    const submitReportTool = defineTool({
      name: "submit_report",
      label: "submit_report",
      description: "提交最终结构化报告。假设用 evidenceIds 引用 [E#]；随后程序会做确定性校验。",
      parameters: reportSchema,
      execute: async (_id, params: Static<typeof reportSchema>) => {
        submitted = params as ReportDraft;
        return { content: [{ type: "text" as const, text: "报告已收到。" }], details: {} };
      },
    });

    const customTools = toolbox.hasCode
      ? [queryLogsTool, searchCodeTool, readCodeTool, submitReportTool]
      : [queryLogsTool, submitReportTool];

    const created = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      model,
      modelRuntime,
      resourceLoader,
      settingsManager,
      noTools: "builtin",
      customTools,
      sessionManager: SessionManager.inMemory(process.cwd()),
    });
    const session: AgentSession = created.session;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") turns += 1;
    });
    const onAbort = () => void session.abort();
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await session.prompt(renderInput(input));
      if (signal.aborted) throw new Error("诊断被取消");
      if (!submitted) {
        const draft: ReportDraft = {
          completeness: "partial",
          summary: input.question.slice(0, 200),
          confirmedFacts: [],
          hypotheses: [],
          uncertainties: [],
          nextSteps: [],
          missingMaterial: ["模型未在预算内提交结构化报告"],
        };
        return { draft, toolCalls: toolbox.toolCalls, modelTurns: turns, model: this.opts.modelId };
      }
      return { draft: submitted, toolCalls: toolbox.toolCalls, modelTurns: turns, model: this.opts.modelId };
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      session.dispose();
    }
  }
}
