// 评测 v2 数据协议（docs 方案 §6）：公开 case 描述 / 私有逐轮标准 / trace / manifest / 分数。
//
// 纯类型 + 少量枚举常量，不依赖存储/网络。三个 schema：
//   prediagnosis-case-v2   公开 case 描述（控制器消费；不得整份进 prompt）
//   prediagnosis-truth-v2  私有逐轮标准（制作侧；Agent 结构性不可读）
//   prediagnosis-score-v2  逐 trial 评分结果（§9.2 指标，全带分母/缺测）
//
// 命名对齐方案：familyId / split / sourceTier / admission / allowedClaimDepth /
// requirementId / supportsAnyOf。不可判字段一律 null，不用 0/1 冒充。

// ---------- 枚举 ----------

export type CaseSplit = "development" | "holdout" | "engineering";
export type SourceTier = "synthetic_engineering" | "reproduced_history" | "verified_snapshot" | "from_issue_only";
export type Admission = "candidate" | "qualified" | "admitted" | "deferred";
export type ClaimDepth = "symptom" | "direct" | "root";
// blocked：预期内的“读取前阻断”（版本/隔离预检），与真实 error 区分（M3，2026-10-05）。
export type RoundOutcomeKind = "report" | "clarify" | "chat" | "error" | "blocked";
/** 三阶段输出（方案 §9.1.6）：模型原始草稿 / 程序校验后报告 / 实际回写文本。 */
export type OutputStage = "raw" | "validated" | "writeback";
/** 可见性观测等级（方案 §8）：A 只对日志源记录；C2 无请求观测时恒 null。 */
export type ObservationLevel = "full-abcd" | "b-c1-d" | "none";

// ---------- 公开 case 描述 ----------

export interface RepoRefV2 {
  repoId: string;
  /** 故障版本完整 SHA（40 hex）。资格验证通过前允许缺省（候选期）。 */
  expectedSha?: string;
  /** 仓库本地目录（相对项目根）。目录内容 hash 进 manifest。 */
  dir: string;
}

export interface CaseRoundV2 {
  roundId: string;
  /** 用户消息文本文件（相对 case 公开目录）。文件内容原样作为入站消息正文。 */
  messageRef: string;
  /** 模拟平台事实：上报时间（ISO）。 */
  receivedAt: string;
  /** 故障发生时间（ISO）；未知用 null，不互相替代。 */
  occurredAt: string | null;
  /** 本轮可用材料视图目录名（相对 case 公开目录）。 */
  materialView: string;
  services: string[];
  environment?: string;
  repos: RepoRefV2[];
  /** 本轮允许的最大调查轮预算（工具/时间沿用全局 config）。 */
}

export interface CaseDescriptorV2 {
  schemaVersion: "prediagnosis-case-v2";
  caseId: string;
  familyId: string;
  split: CaseSplit;
  sourceTier: SourceTier;
  publicBenchmark: boolean;
  admission: Admission;
  maxRounds: number;
  rounds: CaseRoundV2[];
  /** 工程自测用的脚本引擎行为；真实模型 case 不得携带。 */
  scriptedEngine?: boolean;
  /**
   * 工程自测用的脚本审计行为（A1）：私有目录 audit.json 提供确定性审计步骤。
   * 审计开启时 scripted/fake 引擎强制走确定性审计器，不得回落真实模型。
   */
  scriptedAudit?: boolean;
  /**
   * 诊断形态（C1）：known-service=已知服务诊断（召回按定位深度评）；
   * unknown-service=未知服务定位（先评"定位到哪个服务"，再评证据级）。
   * 缺省按 known-service 处理（记录口径，不猜）。
   */
  diagnosisKind?: "known-service" | "unknown-service";
  /** 材料与标准来源（C1）：题面/标签/污染风险显式入账。 */
  provenance?: {
    /** 题面来源（如 RCAEval fault_description / 合成工单）。 */
    questionSource: string;
    /** gold/标签来源（如 RCAEval root_cause_service / 人工复核）。 */
    labelSource: string;
    /** 训练污染风险：public-dataset（公开数据集，可能入过模型训练语料）等。 */
    contaminationRisk: "public-dataset" | "synthetic" | "internal";
  };
}

// ---------- 私有逐轮标准 ----------

/**
 * 源级证据定位（方案 §6.4）：代码定位含完整 SHA 与关键内容锚点；
 * 日志定位以关键内容为主，级别/子串只作辅助。
 */
export interface LogLocatorV2 {
  kind: "log";
  locatorId: string;
  /** 关键内容：必须出现在证据 excerpt（B 层）与工具返回文本（C1 层）中才算命中。 */
  keyContent: string;
  /** 辅助：期望日志级别。 */
  level?: string;
  /** 辅助：来源日志文件名（<service>.log）。 */
  fileName?: string;
}

export interface CodeLocatorV2 {
  kind: "code";
  locatorId: string;
  repoId: string;
  /** 期望的故障版本完整 SHA；缺省 = 不做版本核对（候选期）。 */
  sha?: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  /** 关键内容锚点：行区间必须包含该内容，相邻行/注释不自动命中。 */
  keyContent: string;
}

export type LocatorV2 = LogLocatorV2 | CodeLocatorV2;

/** 一个重要判断所需的最小充分证据组合（§6.4）：组合间 OR，组合内 AND。 */
export interface EvidenceRequirementV2 {
  requirementId: string;
  /** 该需求支持到什么粒度；不允许越到更深层。 */
  depth: ClaimDepth;
  supportsAnyOf: Array<{ allOf: string[] }>;
  /** 仅未来轮可取得的证据不要求首轮召回（§9.2：首轮应评有效补证）。 */
  notRequiredBeforeRound?: string;
}

/**
 * 断言规则（确定性可判的子集）。方案 §6.3 的自然语言 forbiddenAssertions 保留在
 * notes 字段供人工复核；机器判分只用结构化规则，避免关键词刷分。
 */
export interface AssertionRuleV2 {
  ruleId: string;
  /** 规则适用的报告字段。 */
  where: Array<"summary" | "confirmedFacts" | "hypotheses" | "nextSteps">;
  /**
   * 断言概念组（any-of 组的序列，组间 AND）：全部组都被"断言"（含否定窗口豁免）
   * 即视为踩中该规则。
   */
  assertAnyOf: string[][];
  /** 前置条件：全部日志查询为空时才生效（"空日志推健康"反例）。 */
  onlyWhenAllLogQueriesEmpty?: boolean;
  /** 前置条件：仅当该假设无有效引用时才生效。 */
  onlyWhenHypothesisUncited?: boolean;
  /** 前置条件：仅当假设状态为该值时才生效（如 supported 越界到更深层）。 */
  onlyWhenStatus?: "supported" | "candidate" | "refuted";
}

export interface MaterialNeedV2 {
  needId: string;
  description: string;
  /** 补问文本需命中的概念组（any-of）；命中任一组即认为补问指向了该需求。 */
  clarifyConcepts: string[][];
}

export interface RoundTruthV2 {
  roundId: string;
  /** 本轮允许的产出类型；不在列表内的产出按越界处理。 */
  allowedOutcomes: Array<"report" | "clarify" | "blocked">;
  /** 本轮允许判断到什么粒度。 */
  allowedClaimDepth: ClaimDepth;
  requiredFacts: Array<{
    factId: string;
    concepts: string[][];
    where: Array<"summary" | "confirmedFacts" | "hypotheses">;
  }>;
  /** 机器可判的越界/禁用断言规则。 */
  forbiddenRules: AssertionRuleV2[];
  /** 人工复核用的自然语言禁用断言（确定性打分不消费）。 */
  forbiddenAssertions?: string[];
  acceptableClaims?: string[];
  materialNeeds: MaterialNeedV2[];
  evidenceRequirements: EvidenceRequirementV2[];
  /** 本轮证据已推翻的旧判断：被反证命中的概念不允许再以 supported 断言。 */
  contradictedClaims: Array<{
    claimId: string;
    concepts: string[][];
    /** 撤回/降级即可（candidate），不允许 supported。 */
    allowCandidate: boolean;
  }>;
  /** 回写不能丢失的关键信息（概念组，any-of 命中一组即可）。 */
  writebackRequirements: Array<{ reqId: string; concepts: string[][] }>;
}

export interface TruthFileV2 {
  schemaVersion: "prediagnosis-truth-v2";
  caseId: string;
  /** 制作侧根因文档（相对私有目录）；不参与确定性打分。 */
  rootCauseRef?: string;
  locators: LocatorV2[];
  rounds: RoundTruthV2[];
  /** 标准复核记录；provisional = 只有同一 AI 审阅，未宣称人工校准完成。 */
  review: {
    author: string;
    reviewer: string;
    provisional: boolean;
    rubricHash?: string;
    notes?: string;
  };
}

// ---------- trace ----------

export interface TraceEvent {
  schemaVersion: "prediagnosis-trace-v2";
  suiteRunId: string;
  caseId: string;
  familyId: string;
  trialId: string;
  roundId?: string;
  runId?: string;
  attemptId?: string;
  seq: number;
  eventType: string;
  wallTime: number;
  elapsedMs: number;
  payload?: unknown;
}

// ---------- 材料清单 ----------

export interface MaterialFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface MaterialManifestV2 {
  materialView: string;
  files: MaterialFileEntry[];
  totalBytes: number;
  /** 目录整体 hash：对「排序后的 path + sha256」规范化拼接再取 sha256。 */
  viewHash: string;
}

// ---------- 运行产物 ----------

export interface CapturedSend {
  roundId: string;
  kind: string;
  targetMessageId?: string;
  text: string;
  providerMessageId?: string;
  at: number;
}

/** 一次诊断引擎调用的完整记录（A1）：一次用户轮可产生多次调用（审计补证循环）。 */
export interface EngineCallRecord {
  /** 本轮内的调用序号（0-based）。 */
  index: number;
  /** initial=首轮草稿；supplement=审计补证后的再诊断。 */
  phase: "initial" | "supplement";
  kind: "report" | "reply";
  /** report 调用的草稿（深拷贝，未经校验/审计）。 */
  draft?: unknown;
  /** reply 调用的文本。 */
  replyText?: string;
  reason?: "clarify" | "chat";
  modelTurns: number;
  model?: string;
  wallTime: number;
}

export interface RoundArtifacts {
  roundId: string;
  runId?: string;
  status?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  outcome: RoundOutcomeKind;
  /** 模型原始草稿（本轮**首次**引擎调用，深拷贝，未经校验；初稿错误不因审计纠正而抹去）。 */
  rawDraft?: unknown;
  /** 本轮全部引擎调用（初始草稿 + 补证再诊断 + 补证后转回复），按序完整保存（A1）。 */
  engineCalls: EngineCallRecord[];
  /** 校验（+审计应用）后的最终报告（reports 表持久化内容）。 */
  report?: unknown;
  /** clarify/chat 回复文本（取本轮**最后一次**调用；与生产实际产出一致）。 */
  replyText?: string;
  /** 实际回写（捕获发送端记录的文本）。 */
  writebackText?: string;
  /** 校验器程序修正（报告 corrections 字段）。 */
  corrections?: string[];
  toolCalls: number;
  /** 全部日志查询是否为空结果（"空日志推健康"反例依据）。 */
  allLogQueriesEmpty: boolean;
  /** 报告轮持久化的材料范围（scope）；reply 轮无报告时为 null 并在 trace 记原因。 */
  scopeResolved?: unknown;
  error?: string;
}

export interface TrialArtifacts {
  suiteRunId: string;
  caseId: string;
  familyId: string;
  trialId: string;
  engine: string;
  /** 本 trial 实际使用的审计器名（未启用审计为 null；交付 1.1 #7）。 */
  auditEngine: string | null;
  /** 脚本审计的步数账目：提供/消费/耗尽调用次数（仅 scripted-audit；交付 1.1 #7）。 */
  auditScript?: { provided: number; consumed: number; exhaustedCalls: number };
  rounds: RoundArtifacts[];
  /** A 层日志源记录（recording source 产出）。 */
  sourceReturned: Array<{ roundId: string; tool: string; args: unknown; entries: number; excerptHead: string[] }>;
  usage?: { totalTokens: number };
  wall: { startedAt: number; finishedAt: number };
  error?: string;
}

// ---------- 可见性 ----------

export interface LayerHit {
  locatorId: string;
  hit: boolean;
  /** 不可判原因：截断未展示、A 层未观测等。 */
  reason?: string;
}

export interface RequirementSatisfaction {
  requirementId: string;
  depth: ClaimDepth;
  applicable: boolean;
  notApplicableReason?: string;
  /** 组合内逐定位在各层的命中明细。 */
  locators: Array<{ locatorId: string; layers: { A: boolean | null; B: boolean; C1: boolean; C2: boolean | null; D: boolean } }>;
  /** 该需求是否被某一 OR 组合完整满足（AND 成员全命中）。 */
  satisfied: { A: boolean | null; B: boolean; C1: boolean; C2: boolean | null; D: boolean };
  partial: boolean;
}

export interface VisibilityResult {
  observationLevel: ObservationLevel;
  /** C2 恒为 null 的原因（未接请求观测）。 */
  c2Reason: string;
  requirements: RequirementSatisfaction[];
}

// ---------- 评分 ----------

export interface MetricValue {
  numerator: number;
  denominator: number;
  /** 不适用数（分母剔除并单独报告）。 */
  notApplicable: number;
  /** 缺测数（gold/观测不足，null 处理，不算 0 也不算 1）。 */
  unscored: number;
  value: number | null;
}

export interface HardFailure {
  code:
    | "citation_unresolvable"
    | "wrong_sha"
    | "cross_investigation_citation"
    | "forbidden_assertion"
    | "outcome_out_of_policy"
    | "contradiction_ignored"
    | "empty_log_health_claim"
    | "trace_incomplete"
    | "execution_error"
    | "audit_script_exhausted";
  message: string;
  roundId?: string;
  stage?: OutputStage;
}

export interface StageFinding {
  stage: OutputStage;
  hardFailures: HardFailure[];
}

export interface CaseScoreV2 {
  schemaVersion: "prediagnosis-score-v2";
  scorerVersion: string;
  suiteRunId: string;
  caseId: string;
  familyId: string;
  trialId: string;
  split: CaseSplit;
  sourceTier: SourceTier;
  /** 诊断形态（C1）：known-service | unknown-service（缺省 known-service）。 */
  diagnosisKind: string;
  engine: string;
  executionSuccess: boolean;
  traceCompletion: MetricValue;
  /** 各层召回：分母 = 本轮适用需求数（§9.2）。 */
  recall: { A: MetricValue | null; B: MetricValue; C1: MetricValue; C2: MetricValue | null; D: MetricValue };
  citationValidity: MetricValue;
  /**
   * 语义支持（人工 rubric）：review 导入前 value=null、denominator=0、unscored=重要判断数。
   * 不允许用关键词代理计数重新生成 value——代理计数单列在 requiredFactCoverage。
   */
  claimSupport: MetricValue;
  /** 确定性代理指标：必需事实的关键词覆盖（非语义评分，仅用于观察与复核排程）。 */
  requiredFactCoverage: MetricValue;
  unsupportedAssertionRate: MetricValue;
  clarificationSuccess: MetricValue;
  contradictionUpdateSuccess: MetricValue;
  writebackSuccess: MetricValue;
  hardFailures: HardFailure[];
  stageFindings: StageFinding[];
  /** 语义 rubric 结果导入前恒为 unscored（§9.3）；导入后携带来源身份与覆盖率（A2）。 */
  semanticReview: {
    imported: boolean;
    provisional: boolean;
    /** 导入复核的来源身份（A2）：reviewerType=human|model，模型裁判分不得伪装人工分。 */
    author?: string;
    reviewer?: string;
    reviewerType?: "human" | "model";
    /** claimSupport 复核覆盖率：已复核 / 实际可判判断总数。 */
    coverage?: { reviewed: number; total: number };
  };
  /**
   * 复核分绑定元数据（交付 1.1 #6）：消费方据此核验 outputsHash / 评分版本，
   * 绑定失效（trial 重跑、口径混用）时必须回退程序分，不得冒用。
   */
  reviewMeta?: {
    outputsHash: string;
    reviewHash: string;
    reviewArtifact: string;
    baseScorerVersion: string;
    rescoredAt: number;
  };
  /** 逐轮摘要：产出类型、该轮硬失败、补问/反证结论、本轮新增 C1 满足的需求。 */
  roundScores: Array<{
    roundId: string;
    outcome: string;
    hardFailures: HardFailure[];
    clarificationSuccess: boolean | null;
    contradictionUpdate: boolean | null;
    newC1Satisfied: string[];
  }>;
  /** 六层失败归因提示（§11.4），由确定性证据推导，不作唯一结论。 */
  attribution: Array<{ layer: "engineering" | "material" | "reasoning" | "clarification" | "contradiction" | "scoring"; hint: string }>;
}

export type CasePhase = "admission_rejected" | "isolation_blocked" | "load_error" | "validate_error" | "run_error" | "score_error" | "scored";

/** 单 case 的执行终态（A3）：计划内每个 case 必须落到其中一种，缺失即门禁失败。 */
export interface CaseStatus {
  caseId: string;
  phase: CasePhase;
  /** scored 的 case 此处为其 trial 数；未 scored 的 case 为 0。 */
  trials: number;
  reason?: string;
}

export interface SuiteSummaryV2 {
  schemaVersion: "prediagnosis-score-v2";
  suiteRunId: string;
  engine: string;
  repeat: number;
  /** 显式选题数（--cases 给出时为其长度；全量运行为 catalog 匹配数；交付 1.1 #3）。 */
  selected: number;
  /** 计划口径（A3）：计划 case 数与计划 trial 数（不含准入拒绝的 case）。 */
  planned: { cases: number; trials: number };
  /** 准入拒绝数（交付 1.1 #3）：selected − planned = excluded，分母缩小必须显式可见。 */
  counts: { scoredTrials: number; blockedExpectedTrials: number; admissionRejected: number; unscoredCases: number };
  caseStatuses: CaseStatus[];
  cases: Array<{ caseId: string; familyId: string; split: CaseSplit; admission: Admission; trials: CaseScoreV2[] }>;
  /** 聚合只作参考，硬失败单列；均值不得掩盖。 */
  aggregate: Record<string, MetricValue>;
  families: Array<{ familyId: string; trials: number; hardFailures: number }>;
  wall: { startedAt: number; finishedAt: number };
}

// ---------- 运行配置 ----------

export interface SuiteRunOptions {
  suiteRunId: string;
  /** 真实模型必须显式选择且配置预检通过（§7.1）。 */
  engine: "fake" | "scripted" | "pi";
  repeat: number;
  /** 覆盖默认轮内预算（工具数/超时沿用 config.diagnosis）。 */
  maxRounds?: number;
  outDir: string;
}
