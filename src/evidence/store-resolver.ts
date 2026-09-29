// Store 侧 EvidenceResolver：按 uid（v2）或 (runId, evidenceId)（v1）解析已持久化证据。
// 校验与展示共用；resolver 绑定调查，跨调查引用在结构上解析不到（§9）。
import type { EvidenceRef, EvidenceResolver } from "./types.ts";
import { evidenceRowToRef, type EvidenceRow, type Store } from "../storage/store.ts";

export class StoreEvidenceResolver implements EvidenceResolver {
  private readonly store: Store;
  private readonly investigationId: string;
  private readonly runId: string;

  constructor(store: Store, investigationId: string, currentRunId: string) {
    this.store = store;
    this.investigationId = investigationId;
    this.runId = currentRunId;
  }

  get currentRunId(): string {
    return this.runId;
  }

  byUid(investigationId: string, uid: string): EvidenceRef | undefined {
    if (!uid) return undefined;
    const row = this.store.getEvidenceByUid(investigationId, uid);
    return row ? evidenceRowToRef(row) : undefined;
  }

  byRunShortId(runId: string, evidenceId: string): EvidenceRef | undefined {
    const row = this.store.getEvidenceByRunAndId(runId, evidenceId);
    return row ? evidenceRowToRef(row) : undefined;
  }

  listByInvestigation(investigationId: string): EvidenceRef[] {
    return (this.store.listEvidenceByInvestigation(investigationId) as EvidenceRow[]).map(evidenceRowToRef);
  }
}
