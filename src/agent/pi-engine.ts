// 真实诊断引擎：把 pi SDK 关在这一个文件里。
//
// 与假引擎产出同一种 ReportDraft，走同一条校验路径。上层业务类型不出现任何 SDK 类型。
// 工具只有四个只读/提交动作：query_logs / search_code / read_code / submit_report。
// 显式关闭内置工具（noTools: builtin）与文件发现（自定义 ResourceLoader），
// 避免意外加载 shell、写文件或全局扩展。
import { mkdirSync, rmSync } from "node:fs";
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
import type { DiagnosisEngine, EngineResult, SessionSink, Toolbox } from "./types.ts";
import { reconcileSession } from "./session-recovery.ts";
import { renderDiagnosisInput } from "./input-text.ts";
import { writeSeedFile } from "./seed-file.ts";

const SYSTEM_PROMPT = `你是飞书群里的 Bug 预检助手，像一名耐心、务实的同事一样和用户交流。

先判断用户意图：
- 如果只是打招呼、闲聊，或看不出明确的排查/查询需求：直接用自然语言友好回复，不要调用任何工具，
  也不要提交报告。
- 如果用户提出了报错、问题或查询需求：优先检索取证，再给结论。

排查规则：
1. 先取证，后结论：在拿到足够日志/源码证据前，必须先调用 query_logs / search_code / read_code；
   不确定文件在哪时先用 list_files 缩小范围（路径 → 定位 → 内容）。
   禁止不取证就直接下结论。证据足够就停，不要为了凑数继续查询。
2. 只读：没有 shell、没有写操作，不要尝试执行命令或修改任何东西。
3. 证据引用是硬规则：submit_report 中每条假设只能用 evidenceIds 引用工具返回的 [E#] 编号，
   禁止编造。没有证据的猜测把 status 设为 candidate、confidence 设为 low。
4. 材料不完整（查询失败、服务/版本拿不到）时 completeness 必须是 partial，并逐条写 missingMaterial。
5. 必要时（例如无法确定可读取的源码仓库/版本，或缺少服务名/现象等关键信息）调用 request_info
   向用户追问缺失信息，不要臆测；追问后本次运行即结束，等用户补充后继续，无需再提交报告。
6. 排查完成时调用 submit_report 提交结构化报告，不要用普通文本代替。

只有排查/查询场景才调用工具；闲聊请直接回复文字。`;

/**
 * 组装系统提示词。
 * 传入场景记忆规则（rules.md）时追加到末尾，作为该场景“什么该记 / 什么不该记”的显式约束。
 * 生产默认不传，行为与以前完全一致；评测用它注入 rules.md。
 */
export function buildSystemPrompt(rules?: string): string {
  const extra = rules?.trim();
  if (!extra) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}\n\n## 场景记忆规则（仅本场景生效）\n${extra}`;
}

const queryLogsSchema = Type.Object({
  service: Type.String({ description: "服务名，决定查询哪个日志源" }),
  from: Type.String({ description: "起始时间，ISO8601" }),
  to: Type.String({ description: "结束时间，ISO8601" }),
  keywords: Type.Array(Type.String(), { description: "关键词，任一命中即保留；可为空数组" }),
});

const listFilesSchema = Type.Object({
  glob: Type.Optional(Type.String({ description: "按路径子串过滤，如 /order/ 或 .java" })),
  repoId: Type.Optional(Type.String({ description: "多仓时指定仓库" })),
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

const requestInfoSchema = Type.Object({
  question: Type.String({ description: "要向用户追问的问题，尽量具体（缺哪个仓库/版本/服务名/现象）" }),
});

export interface PiEngineOptions {
  provider: string;
  modelId: string;
  apiKey?: string;
  maxToolCalls: number;
  maxModelTurns: number;
  /** 上下文压缩兜底：接近上下文窗口时自动总结旧内容（TD_COMPACTION_ENABLED）。 */
  compactionEnabled: boolean;
  systemPrompt?: string;
}

type SessionMessages = AgentSession["messages"];

/** 取最后一条 assistant 文本，用于闲聊场景的自然回复。 */
function lastAssistantText(messages: SessionMessages): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    const text = message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

/** 恢复时的提示：上一条 assistant 已结束但未提交报告（例如崩溃在 submit_report 之前）。 */
const RECOVERY_NUDGE =
  "（恢复）上一轮回复已结束但没有提交报告。请基于当前会话继续：若材料已足够就调用 submit_report，否则继续取证。";

/** 包一次工具执行：记录耗时/成败/结果规模（T3 可观测）。callId 用 pi 的 toolCallId，便于关联。 */
async function timedTool<T extends { content: Array<{ type: string; text?: string }> }>(
  sink: SessionSink | undefined,
  name: string,
  callId: string,
  input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const out = await fn();
    const chars = out.content.reduce((n, c) => n + (c.text?.length ?? 0), 0);
    sink?.recordTool({ callId, tool: name, input, ok: true, durationMs: Date.now() - started, outputChars: chars });
    return out;
  } catch (err) {
    sink?.recordTool({
      callId,
      tool: name,
      input,
      ok: false,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export class PiDiagnosisEngine implements DiagnosisEngine {
  readonly name = "pi";
  private readonly opts: PiEngineOptions;

  constructor(opts: PiEngineOptions) {
    this.opts = opts;
  }

  async run(
    input: DiagnosisInput,
    toolbox: Toolbox,
    signal: AbortSignal,
    sink?: SessionSink,
  ): Promise<EngineResult> {
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
      compaction: { enabled: this.opts.compactionEnabled },
      retry: { enabled: true, maxRetries: 2 },
    });

    let submitted: ReportDraft | undefined;
    let requested: string | undefined;
    let turns = 0;

    const queryLogsTool = defineTool({
      name: "query_logs",
      label: "query_logs",
      description: "查询服务在时间窗内的日志，返回带 [E#] 证据编号的原文。",
      parameters: queryLogsSchema,
      execute: (id, params: Static<typeof queryLogsSchema>) =>
        timedTool(sink, "query_logs", id, params, async () => {
          const from = Date.parse(params.from);
          const to = Date.parse(params.to);
          if (Number.isNaN(from) || Number.isNaN(to)) throw new Error("from/to 必须是 ISO8601 时间");
          const text = await toolbox.queryLogs({ service: params.service, from, to, keywords: params.keywords });
          return { content: [{ type: "text" as const, text }], details: {} };
        }),
    });

    const listFilesTool = defineTool({
      name: "list_files",
      label: "list_files",
      description: "列出本次运行的代码版本里的文件路径（路径层）。不确定文件在哪时先用它缩小范围，再 search_code / read_code。返回带 [E#] 的路径清单。",
      parameters: listFilesSchema,
      execute: (id, params: Static<typeof listFilesSchema>) =>
        timedTool(sink, "list_files", id, params, async () => {
          const text = await toolbox.listFiles({ glob: params.glob, repoId: params.repoId });
          return { content: [{ type: "text" as const, text }], details: {} };
        }),
    });

    const searchCodeTool = defineTool({
      name: "search_code",
      label: "search_code",
      description: "在本次运行的代码版本里按子串搜索，返回带 [E#] 的 文件:行号:内容。",
      parameters: searchCodeSchema,
      execute: (id, params: Static<typeof searchCodeSchema>) =>
        timedTool(sink, "search_code", id, params, async () => {
          const text = await toolbox.searchCode({ pattern: params.pattern, glob: params.glob, repoId: params.repoId });
          return { content: [{ type: "text" as const, text }], details: {} };
        }),
    });

    const readCodeTool = defineTool({
      name: "read_code",
      label: "read_code",
      description: "读取指定版本文件的一段内容，返回带 [E#] 的原文。",
      parameters: readCodeSchema,
      execute: (id, params: Static<typeof readCodeSchema>) =>
        timedTool(sink, "read_code", id, params, async () => {
          const text = await toolbox.readCode({
            path: params.path,
            startLine: params.startLine,
            endLine: params.endLine,
            repoId: params.repoId,
          });
          return { content: [{ type: "text" as const, text }], details: {} };
        }),
    });

    const submitReportTool = defineTool({
      name: "submit_report",
      label: "submit_report",
      description: "提交最终结构化报告并结束本次运行。假设用 evidenceIds 引用 [E#]；随后程序会做确定性校验。",
      parameters: reportSchema,
      execute: (id, params: Static<typeof reportSchema>) =>
        timedTool(sink, "submit_report", id, params, async () => {
          submitted = params as ReportDraft;
          return {
            content: [{ type: "text" as const, text: "报告已收到。" }],
            details: {},
            terminate: true,
          };
        }),
    });

    const requestInfoTool = defineTool({
      name: "request_info",
      label: "request_info",
      description:
        "必要时向用户追问缺失信息（例如：无法确定要读取的源码仓库/版本，或缺少服务名、现象、复现步骤等关键信息）。" +
        "不要用它做普通寒暄。调用后本次运行结束，等待用户补充后继续。",
      parameters: requestInfoSchema,
      execute: (id, params: Static<typeof requestInfoSchema>) =>
        timedTool(sink, "request_info", id, params, async () => {
          requested = params.question;
          return {
            content: [{ type: "text" as const, text: "已向用户追问，本次运行结束。" }],
            details: {},
            terminate: true,
          };
        }),
    });

    // request_info 常驻，是否调用交给模型判断（描述里写了必要条件）。
    const customTools = toolbox.hasCode
      ? [queryLogsTool, listFilesTool, searchCodeTool, readCodeTool, requestInfoTool, submitReportTool]
      : [queryLogsTool, requestInfoTool, submitReportTool];

    // 恢复：把已落库条目读回，补齐未决工具结果，再决定 prompt / continue。
    const reconciled = reconcileSession(sink?.priorEntries ?? []);
    for (const entry of reconciled.added) sink?.appendEntry(entry);

    let mode: "prompt" | "continue" | "nudge";
    if (reconciled.entries.length === 0) {
      mode = "prompt";
    } else {
      const last = reconciled.entries.at(-1);
      const lastIsAssistant =
        last?.type === "message" && (last.message as { role?: string }).role === "assistant";
      mode = lastIsAssistant ? "nudge" : "continue";
    }

    const seedFile = reconciled.entries.length > 0 ? writeSeedFile(agentDir, reconciled.entries) : undefined;
    const manager = seedFile ? SessionManager.open(seedFile) : SessionManager.inMemory(process.cwd());

    const created = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      model,
      modelRuntime,
      resourceLoader,
      settingsManager,
      noTools: "builtin",
      customTools,
      sessionManager: manager,
    });
    const session: AgentSession = created.session;
    // create 期间可能追加元数据条目（model_change / thinking_level_change）；一并落库，按 entry_id 去重。
    for (const entry of manager.getEntries()) sink?.appendEntry(entry);
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") turns += 1;
      if (event.type === "entry_appended") sink?.appendEntry(event.entry);
    });
    const onAbort = () => void session.abort();
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (mode === "continue") await session.agent.continue();
      else if (mode === "nudge") await session.prompt(RECOVERY_NUDGE);
      else await session.prompt(renderDiagnosisInput(input));
      if (signal.aborted) throw new Error("诊断被取消");

      // 反问：向用户要缺失信息，本次运行结束，等用户补充后进入下一轮。
      if (requested) {
        return {
          kind: "reply",
          reason: "clarify",
          text: requested,
          toolCalls: toolbox.toolCalls,
          modelTurns: turns,
          model: this.opts.modelId,
        };
      }

      if (!submitted) {
        // 没有调用任何工具、也没有提交报告：视为闲聊，直接返回自然语言回复。
        const text = lastAssistantText(session.messages);
        if (toolbox.toolCalls === 0 && text) {
          return { kind: "reply", reason: "chat", text, toolCalls: 0, modelTurns: turns, model: this.opts.modelId };
        }
        const draft: ReportDraft = {
          completeness: "partial",
          summary: input.question.slice(0, 200),
          confirmedFacts: [],
          hypotheses: [],
          uncertainties: [],
          nextSteps: [],
          missingMaterial: ["模型未在预算内提交结构化报告"],
        };
        return { kind: "report", draft, toolCalls: toolbox.toolCalls, modelTurns: turns, model: this.opts.modelId };
      }
      return { kind: "report", draft: submitted, toolCalls: toolbox.toolCalls, modelTurns: turns, model: this.opts.modelId };
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      session.dispose();
      if (seedFile) rmSync(seedFile, { force: true });
    }
  }
}
