// 领域层：纯业务类型与规则，不依赖任何 SDK / 数据库 / 网络。
//
// 分层依赖方向：domain ← storage / intake / scheduling / delivery / agent / sources
//   domain 只回答"一个合法的调查/轮次/报告是什么"，其余层都依赖它，它不依赖任何人。

// ---------- 状态 ----------

/** 一个 Bug 调查的生命周期。 */
export type InvestigationStatus = "open" | "closed";

/**
 * 一轮诊断的执行状态。
 * queued → running → succeeded | failed | interrupted
 * interrupted → queued（有限重试）
 */
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "interrupted";

/** 报告材料完整性，与"执行是否成功"正交。 */
export type ReportCompleteness = "complete" | "partial";

/** 待发送记录的投递状态。uncertain 表示"发送结果未知"，禁止当作未发送无限重试。 */
export type DeliveryStatus = "pending" | "sending" | "sent" | "uncertain" | "failed";

/** 一次诊断尝试的终止原因（可重试 / 不可重试在 run-state.ts 里判定）。 */
export type RunErrorCode =
  | "interrupted" // 租约过期 / 进程退出，可重试
  | "timeout" // 时间预算耗尽，可重试
  | "provider_unavailable" // 模型/数据源临时不可用，可重试
  | "rate_limited" // 限流，可重试
  | "budget_iterations" // 迭代预算耗尽，不可重试
  | "budget_tools" // 工具调用预算耗尽，不可重试
  | "invalid_input" // 输入/权限/配置错误，不可重试
  | "auth" // 凭证错误，不可重试
  | "runtime_error"; // 未分类

// ---------- 输入侧 ----------

/** 平台无关的入站消息（飞书事件归一化后的结果）。 */
export interface InboundMessage {
  provider: "feishu";
  accountId: string;
  /** 平台消息 ID，用于事件去重与消息映射。 */
  externalMessageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  /** 平台线程/根消息标识，用于把回复归入原调查。 */
  rootId?: string;
  threadId?: string;
  parentId?: string;
  /** 群聊里机器人是否被 @。 */
  mentionedBot: boolean;
  senderId?: string;
  senderName?: string;
  text: string;
  /** 平台消息时间（epoch ms）。 */
  receivedAt: number;
}

/** 消息的关联判定结果。 */
export type IntakeDecision =
  | { kind: "new_investigation"; sessionCode: string }
  | { kind: "continue_investigation"; investigationId: string }
  | { kind: "duplicate"; investigationId?: string }
  | { kind: "unroutable"; reason: string }
  | { kind: "ignored"; reason: string };

// ---------- 诊断输入与材料范围 ----------

export interface RepositoryRef {
  repoId: string;
  /** 显式引用（commit / 分支）。优先级最高。 */
  rev?: string;
  /** 发生时间：未给 rev 时，按此时间解析仓库当时的提交。 */
  at?: number;
}

export interface DiagnosisInput {
  investigationId: string;
  runId: string;
  /** 本轮要回答的问题（当前轮用户输入）。 */
  question: string;
  /** 此前轮次的有效上下文摘要，供多轮追问使用。 */
  contextSummary?: string;
  service?: string;
  environment?: string;
  /** 上报时间（平台事实，一定存在）。 */
  receivedAt: number;
  /** 故障发生时间（从输入提取，提取不到则 undefined——宁可未知也不猜测）。 */
  occurredAt?: number;
  /** 发生时间的解析来源，供报告如实标注。 */
  occurredSource?: string;
  repositories?: RepositoryRef[];
  /** 权限范围内的服务/仓库白名单。 */
  allowedServices?: string[];
  allowedRepos?: string[];
}

/** 本次运行实际使用的材料范围，写进报告供人核对。 */
export interface MaterialScope {
  services: string[];
  environment?: string;
  /** 上报时间（平台事实）。 */
  reportedAt?: number;
  /** 故障发生时间（提取到时）；未提取到则 undefined。 */
  occurredAt?: number;
  /** 时间窗依据：按发生时间（occurred）或按上报时间回溯（reported）。 */
  timeWindowBasis?: "occurred" | "reported";
  timeWindow?: { from: number; to: number };
  repos: Array<{
    repoId: string;
    rev: string;
    sha?: string;
    resolved: boolean;
    /** 版本钉死依据：显式 / 按发生时间 / 当前 HEAD / 未解析。 */
    pinnedBy?: "explicit" | "time" | "head" | "unresolved";
  }>;
}

// ---------- 证据 ----------

export type EvidenceKind = "log" | "code";

export interface CodeLocator {
  repoId: string;
  sha: string;
  path: string;
  startLine: number;
  endLine: number;
}

/** 程序签发证据：模型只引用 evidenceId，不负责复述来源与位置。 */
export interface EvidenceRecord {
  evidenceId: string;
  runId: string;
  kind: EvidenceKind;
  source: string;
  excerpt: string;
  truncated: boolean;
  time?: number;
  level?: string;
  codeRef?: CodeLocator;
}

// ---------- 报告 ----------

export interface LogEntry {
  time: number;
  level: string;
  message: string;
}

export interface CodeSnippet {
  path: string;
  line: number;
  text: string;
}

export type Confidence = "high" | "medium" | "low";
export type HypothesisStatus = "supported" | "candidate" | "refuted";

export interface RootCauseHypothesis {
  cause: string;
  confidence: Confidence;
  status: HypothesisStatus;
  evidenceIds: string[];
}

/** 模型提交的草稿：程序校验后才会变成 DiagnosisReport。 */
export interface ReportDraft {
  completeness: ReportCompleteness;
  summary: string;
  confirmedFacts: string[];
  hypotheses: Array<{
    cause: string;
    confidence: Confidence;
    status?: HypothesisStatus;
    evidenceIds?: string[];
  }>;
  uncertainties: string[];
  nextSteps: string[];
  missingMaterial: string[];
}

/** 校验后的正式报告。status=partial 表示材料缺失，不代表根因已确认。 */
export interface DiagnosisReport {
  completeness: ReportCompleteness;
  summary: string;
  scope: MaterialScope;
  confirmedFacts: string[];
  hypotheses: RootCauseHypothesis[];
  uncertainties: string[];
  nextSteps: string[];
  missingMaterial: string[];
  /** 程序施加的强制修正（模型说了不算的部分），供审计。 */
  corrections: string[];
  executionLimits: string[];
}

// ---------- 执行预算 ----------

export interface RunBudget {
  /** 墙钟时间预算（ms）。 */
  timeMs: number;
  /** 最大工具调用次数。 */
  maxToolCalls: number;
  /** 单次工具结果最大字符数。 */
  maxResultChars: number;
  /** 最大模型轮次。 */
  maxModelTurns: number;
}
