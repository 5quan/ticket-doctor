// 评测领域类型：benchmark、证据定位、分数。纯类型，不依赖存储/网络。
//
// 关键：gold/干扰证据用「源级定位」表达，而不是运行内的 E#（E# 每轮从 E1 重开，跨 case 无意义）。

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
  gold: { answer: string; evidence: EvidenceLocator[] };
  distractors: EvidenceLocator[];
  labels?: string[];
}

export interface Benchmark {
  scenario: string;
  cases: BenchmarkCase[];
}

export interface CaseScore {
  id: string;
  /** 证据召回率：gold 中被本次运行实际检索到的比例。 */
  recall: number;
  /** 引用精确率：报告引用中命中 gold 的比例。 */
  precision: number;
  /** 决策正确率：该 case 是否答对（0/1）。 */
  correct: boolean;
  matchedGold: string[];
  missedGold: string[];
  citedDistractor: string[];
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
}
