// 内存证据 Sink：**仅单测与过渡用途**（docs/evidence-uid-design.md §4）。
//
// 不做去重（D6）：每次 commit 顺序分配 E1..En，立即返回。
import { randomUUID } from "node:crypto";
import type { EvidenceCommitRequest, EvidenceCommitResult, EvidenceRef, EvidenceSink } from "./types.ts";

export class MemoryEvidenceSink implements EvidenceSink {
  private counter = 0;
  private readonly issuedRefs: EvidenceRef[] = [];

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

  /** 本 sink 已签发的全部证据（单测断言 / Runner 过渡期上报用）。 */
  all(): EvidenceRef[] {
    return [...this.issuedRefs];
  }
}
