// Host 内联路径的证据 Sink：把工具批次提交到 Store 事务（docs/evidence-uid-design.md §5.3）。
//
// 身份字段（investigationId/runId/attemptId/generation）由实际派发任务的编排层注入，
// 不读消息字段（§5.2）；提交失败抛 EvidenceCommitError，由工具让本轮失败（D9）。
import type { Store } from "../storage/store.ts";
import { EvidenceCommitError } from "./errors.ts";
import type { EvidenceCommitRequest, EvidenceCommitResult, EvidenceSink } from "./types.ts";

export interface EvidenceRunContext {
  investigationId: string;
  runId: string;
  attemptId: string;
  generation: number;
}

export class StoreEvidenceSink implements EvidenceSink {
  private readonly store: Store;
  private readonly ctx: EvidenceRunContext;

  constructor(store: Store, ctx: EvidenceRunContext) {
    this.store = store;
    this.ctx = ctx;
  }

  async commit(req: EvidenceCommitRequest): Promise<EvidenceCommitResult> {
    const result = this.store.commitEvidenceBatch({ ...req, ...this.ctx });
    if (!result.ok) throw new EvidenceCommitError(result.code, result.message);
    return { refs: result.refs };
  }
}
