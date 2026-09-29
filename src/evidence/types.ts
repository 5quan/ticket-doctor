// 证据持久化的共享类型（docs/evidence-uid-design.md §4）。
//
// 身份与展示解耦：evidenceUid 是全局唯一的身份（报告 v2 引用它）；
// evidenceId 是调查内短号 E{n}（Host 分配，模型/报告/展示继续用它）。

export interface EvidenceItem {
  kind: "log" | "code";
  /** 未给则由 codeRef 生成（repoId@sha path#Lx-Ly）。 */
  source?: string;
  excerpt: string;
  time?: number;
  level?: string;
  codeRef?: { repoId: string; sha: string; path: string; startLine: number; endLine: number };
  /** excerpt 是否被截断（工具侧按单条上限截断后置位；随材料一起入库）。 */
  truncated?: boolean;
}

export interface EvidenceRef extends EvidenceItem {
  evidenceUid: string;
  evidenceId: string;
  truncated: boolean;
}

export interface EvidenceCommitRequest {
  batchId: string;
  tool: string;
  toolCallId: string;
  /** sha256(canonicalJson(items))；Host 会重算比对。 */
  payloadHash: string;
  items: EvidenceItem[];
  /** 结构化工具结果（pre-ID），随批次入库供恢复重建。 */
  result: unknown;
}

export interface EvidenceCommitResult {
  /** 与 items 同序。 */
  refs: EvidenceRef[];
}

export interface EvidenceSink {
  /** 保存并等待确认；失败抛错（由工具让本轮失败，fail-closed）。 */
  commit(req: EvidenceCommitRequest): Promise<EvidenceCommitResult>;
}

/** 校验/展示用：按 uid（v2）或 (runId, evidenceId)（v1）解析。 */
export interface EvidenceResolver {
  byUid(investigationId: string, uid: string): EvidenceRef | undefined;
  byRunShortId(runId: string, evidenceId: string): EvidenceRef | undefined;
  listByInvestigation(investigationId: string): EvidenceRef[];
  readonly currentRunId: string;
}
