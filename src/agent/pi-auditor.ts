// pi 审计器：在一个**独立、内存态、无检索工具**的会话里复核草稿。
//
// 与诊断引擎（pi-engine.ts）共享同一套 SDK 会话/隔离/中止方式，但：
//   * 新建 SessionManager.inMemory()，不读也不写主诊断的 session_entries（上下文彻底隔离）；
//   * noTools 全关，只提供一个 submit_audit 结构化提交工具（首版不允许主动检索）；
//   * 用 noopObservationSink 挂 observer 仅用于统计模型调用次数（并入本次 attempt 预算）。
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
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { attachPiObserver } from "../observability/pi-observer.ts";
import { noopObservationSink } from "../observability/noop.ts";
import { renderAuditInput, type AuditInput, type AuditOutcome, type AuditResult, type EvidenceAuditor } from "./audit-types.ts";

const AUDIT_SYSTEM_PROMPT = `你是独立的证据审计员（不是诊断者）。唯一职责：检查草稿里每条结论是否被给出的证据真正支持。

规则：
1. 只依据消息中给出的证据快照判定，不假设存在未提供的材料；你没有检索工具，不要尝试查询。
2. 逐条输出 claimVerdicts，verdict 取 supported / unsupported / contradicted / undecidable：
   - 证据与结论的语义关系要成立。例：HTTP 504 日志支持"请求超时"，不直接支持"数据库连接池耗尽"。
   - 材料不足或引用无法在快照中解析 → undecidable；存在反证 → contradicted；证据确实支撑 → supported。
   - 不要为了配合草稿而判 supported。
3. missingEvidence：缺什么材料、针对哪条结论（hypothesisIndex 用草稿里的序号，整体缺失用 -1）。
4. stopAdvice：stop（可提交）/ continue（有明显补证项）/ ask_user（需要用户补充信息，附 question）。
5. 最后必须调用 submit_audit 提交结构化判定，不要用普通文本。`;

const auditSchema = Type.Object({
  claimVerdicts: Type.Array(
    Type.Object({
      hypothesisIndex: Type.Number({ description: "草稿结论下标，0-based" }),
      verdict: Type.Union([
        Type.Literal("supported"),
        Type.Literal("unsupported"),
        Type.Literal("contradicted"),
        Type.Literal("undecidable"),
      ]),
      reason: Type.String({ description: "判定理由" }),
      evidenceUids: Type.Optional(Type.Array(Type.String(), { description: "支撑/反驳的证据 UID" })),
    }),
  ),
  missingEvidence: Type.Array(
    Type.Object({
      hypothesisIndex: Type.Number({ description: "针对的结论下标；-1 表示整体" }),
      what: Type.String({ description: "缺什么材料" }),
      suggestedTool: Type.Optional(
        Type.Union([
          Type.Literal("query_logs"),
          Type.Literal("list_files"),
          Type.Literal("search_code"),
          Type.Literal("read_code"),
        ]),
      ),
    }),
  ),
  stopAdvice: Type.Union([
    Type.Object({ action: Type.Literal("stop"), reason: Type.String() }),
    Type.Object({ action: Type.Literal("continue"), reason: Type.String() }),
    Type.Object({ action: Type.Literal("ask_user"), reason: Type.String(), question: Type.String() }),
  ]),
});

export interface PiAuditorOptions {
  provider: string;
  modelId: string;
  apiKey?: string;
  maxEventBytes?: number;
}

export class PiEvidenceAuditor implements EvidenceAuditor {
  readonly name = "pi-audit";
  private readonly opts: PiAuditorOptions;

  constructor(opts: PiAuditorOptions) {
    this.opts = opts;
  }

  async audit(input: AuditInput, signal: AbortSignal): Promise<AuditOutcome> {
    const agentDir = join(tmpdir(), "ticket-doctor-auditor");
    mkdirSync(agentDir, { recursive: true });

    const modelRuntime = await ModelRuntime.create();
    if (this.opts.apiKey) await modelRuntime.setRuntimeApiKey(this.opts.provider, this.opts.apiKey);
    const model = getBuiltinModel(
      this.opts.provider as "deepseek",
      this.opts.modelId as "deepseek-v4-flash",
    );
    if (!model) throw new Error(`内置目录找不到模型：${this.opts.provider}/${this.opts.modelId}`);

    let submitted: AuditResult | undefined;
    const submitAuditTool = defineTool({
      name: "submit_audit",
      label: "submit_audit",
      description: "提交结构化审计判定并结束审计会话。",
      parameters: auditSchema,
      execute: async (_id, params: Static<typeof auditSchema>) => {
        submitted = params as AuditResult;
        return { content: [{ type: "text" as const, text: "审计已收到。" }], details: {}, terminate: true };
      },
    });

    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => AUDIT_SYSTEM_PROMPT,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });
    const manager = SessionManager.inMemory(process.cwd());
    const created = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      model,
      modelRuntime,
      resourceLoader,
      settingsManager,
      noTools: "builtin",
      customTools: [submitAuditTool],
      sessionManager: manager,
    });
    const session = created.session;
    // 仅用于统计模型调用次数（noop sink 不发事件）；审计不占用检索工具额度。
    const observer = attachPiObserver({
      session,
      sink: noopObservationSink,
      scopeId: "audit",
      maxEventBytes: this.opts.maxEventBytes ?? 524_288,
    });
    const onAbort = () => void session.abort();
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await session.prompt(renderAuditInput(input));
      if (signal.aborted) throw new Error("审计被取消");
      if (!submitted) throw new Error("审计未在预算内提交结构化结论");
      return { result: submitted, modelTurns: observer.modelCalls };
    } finally {
      observer.settlePending();
      signal.removeEventListener("abort", onAbort);
      session.dispose();
    }
  }
}
