// 内存证据 Sink/Resolver：**仅单测与评测过渡用途**（docs/evidence-uid-design.md §4/D13）。
//
// 不做去重（D6）：每次 commit 顺序分配 E1..En，立即返回；
// 同时提供 EvidenceResolver 视图（按 uid / 短号解析本 sink 签发的证据）。
import { randomUUID } from "node:crypto";
import type { EvidenceCommitRequest, EvidenceCommitResult, EvidenceRef, EvidenceResolver, EvidenceSink } from "./types.ts";

export class MemoryEvidenceSink implements EvidenceSink, EvidenceResolver {
  private counter = 0;
  private readonly issuedRefs: EvidenceRef[] = [];
  private readonly runId: string;

  constructor(runId = "") {
    this.runId = runId;
  }

  async commit(req: EvidenceCommitRequest): Promise<EvidenceCommitResult> {
    const refs = req.items.map((item) => {
      this.counter += 1;
      const ref: EvidenceRef = {
        ...item,
        evidenceUid: randomUUID(),
        evidenceId: `E${this.counter}`,
        truncated: item.truncated ?? false,
      };
      this.issuedRefs.push(ref);
      return ref;
    });
    return { refs };
  }

  /** 本 sink 已签发的全部证据（单测断言 / 打分用）。 */
  all(): EvidenceRef[] {
    return [...this.issuedRefs];
  }

  // ---------- EvidenceResolver 视图 ----------

  get currentRunId(): string {
    return this.runId;
  }

  byUid(_investigationId: string, uid: string): EvidenceRef | undefined {
    return this.issuedRefs.find((r) => r.evidenceUid === uid);
  }

  byRunShortId(_runId: string, evidenceId: string): EvidenceRef | undefined {
    return this.issuedRefs.find((r) => r.evidenceId === evidenceId);
  }

  listByInvestigation(_investigationId: string): EvidenceRef[] {
    return this.all();
  }
}
