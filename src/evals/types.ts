// 评测领域类型：benchmark、证据定位、分数。纯类型，不依赖存储/网络。
//
// 关键：gold/干扰证据用「源级定位」表达，而不是运行内的 E#（E# 调查内续签，跨 case 无意义）。

export interface EvidenceLocatorLog {
  kind: "log";
  /** 期望日志级别（可选）。 */
  level?: string;
  /** 日志正文里唯一可辨识的子串（traceId / 关键短语）。 */
  substring: string;
}

export interface EvidenceLocatorCode {
  kind: "code";
  repoId: string;
  path: string;
  /** 命中区间（与证据 codeRef 的 [startLine,endLine] 重叠即算命中）。 */
  lineStart: number;
  lineEnd: number;
}

export type EvidenceLocator = EvidenceLocatorLog | EvidenceLocatorCode;

/** gold 注解（人工黄金标准，自动迭代不得改写——eval-design §12.1 禁区）。
 *
 * requiredConcepts 缺失 = 未校准（legacy）：correct 退回 v1 的"仅引证"口径，
 * 不得当作已校准结果报数（OQ-41）。
 */
export interface GoldSpec {
  answer: string;
  evidence: EvidenceLocator[];
  /** 每组 any-of；top.cause 必须每组命中至少一个同义词（确定性概念匹配）。 */
  requiredConcepts?: string[][];
  /** 断言即错（否定语境豁免，如"不是 Redis 而是库存"）。 */
  forbiddenConcepts?: string[][];
  /** 人类可读等价表述，供 judge 与人工核对（确定性打分不用）。 */
  acceptableCauses?: string[];
  /** 期望粒度：root=要根因，direct=直接原因即可。 */
  causeLevel?: "root" | "direct";
}

export interface BenchmarkCase {
  id: string;
  question: string;
  /** 故障发生时间（ISO）；同时应出现在 question 文本里，供 extractOccurredAt 解析。 */
  occurredAt: string;
  /** 上报时间（ISO），供提取发生时间做参考。 */
  receivedAt: string;
  service: string;
  repo?: string;
  /** diagnose=应给出根因；insufficient=材料不足，不得臆断。 */
  expect?: "diagnose" | "insufficient";
  gold: GoldSpec;
  distractors: EvidenceLocator[];
  labels?: string[];
}

export interface Benchmark {
  scenario: string;
  cases: BenchmarkCase[];
}

export interface CauseCheck {
  missingGroups: string[];
  forbiddenHit: string[];
}

export interface CaseScore {
  id: string;
  /** 证据召回率：gold 中被本次运行实际检索到的比例。 */
  recall: number;
  /** 引用精确率：报告引用（按身份去重后）中命中 gold 的比例。 */
  precision: number;
  /** 引用干扰率：去重后的引用中命中干扰证据的比例。 */
  distractorCitationRate: number;
  /** 决策正确率：该 case 是否答对（0/1）。 */
  correct: boolean;
  /** 根因概念匹配：null = 该 case 未注解（legacy，不参与校准口径）。 */
  causeMatched: boolean | null;
  /** 概念核对明细：缺了哪组概念、踩中哪组禁用概念。 */
  causeCheck: CauseCheck | null;
  /** top 假设是否引用了 ≥1 条 gold 证据。 */
  evidenceSupported: boolean;
  /** top 的引用是否全部非 gold（干扰/无关），无任何 gold。 */
  distractorOnly: boolean;
  /** correct 的判定依据：cause+evidence（校准）/ insufficient / evidence-only(legacy)。 */
  correctBasis: "cause+evidence" | "insufficient" | "evidence-only(legacy)";
  matchedGold: string[];
  missedGold: string[];
  citedDistractor: string[];
  /** 去重后的非 gold 引用（身份标识）。 */
  citedNonGold: string[];
  topCause?: string;
  note?: string;
}

export interface ScenarioScore {
  scenario: string;
  engine: string;
  cases: CaseScore[];
  recall: number;
  precision: number;
  accuracy: number;
  /** 打分器版本：改判定语义必须 bump，不同版本禁止同表对比（OQ-41）。 */
  scorerVersion: string;
  /** benchmark 内容 hash（sha256 前 12 位）：内容变更即换口径。 */
  benchmarkVersion: string;
  gradeMode: "deterministic" | "judge";
  /** 所有诊断类 case 均带 requiredConcepts 才为 true；false 时 accuracy 仅 legacy 兼容。 */
  calibrated: boolean;
  /** 用了 judge 才带（M2，需先过一致性门槛）。 */
  judge?: { model: string; agreement?: number };
  /** 打分时的 git 短 revision（取不到时缺省）。 */
  gitRev?: string;
  /** 证据口径：D6 取消跨调用去重后的证据条数口径。 */
  evidencePolicy: "d6_no_dedupe";
}
