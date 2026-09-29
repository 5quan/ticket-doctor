// 证据批次 → 恢复补记文本（docs/evidence-uid-design.md §8）。
//
// Host 为"已发起但无结果"的 tool_call 查找已持久化批次，用共享渲染器重建模型可见文本；
// 命中 → 补记 isError:false 的保存结果；未命中 → 维持 outcome unknown（由 reconcileSession 处理）。
// 进程路径（RunnerTask.savedToolResults）与内联路径（RunSession）共用。
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { pendingToolCallIds, type SavedToolResult } from "../agent/session-recovery.ts";
import { renderEvidenceResult } from "./render.ts";
import type { EvidenceRef } from "./types.ts";

/** buildSavedToolResults 依赖的 Store 子集（结构化类型，便于测试注入）。 */
export interface EvidenceBatchLookup {
  getBatchByToolCall(
    runId: string,
    toolCallId: string,
  ): { batch: { batch_id: string; tool: string }; evidence: unknown[] } | undefined;
  listEvidenceRefsByBatch(batchId: string): EvidenceRef[];
}

export function buildSavedToolResults(
  store: EvidenceBatchLookup,
  runId: string,
  entries: SessionEntry[],
  maxToolResultChars: number,
): Map<string, SavedToolResult> {
  const map = new Map<string, SavedToolResult>();
  for (const call of pendingToolCallIds(entries)) {
    const found = store.getBatchByToolCall(runId, call.id);
    if (!found) continue;
    const refs = store.listEvidenceRefsByBatch(found.batch.batch_id);
    map.set(call.id, {
      toolName: call.name || found.batch.tool,
      text: renderEvidenceResult(found.batch.tool, refs, refs, { maxResultChars: maxToolResultChars }),
      isError: false,
    });
  }
  return map;
}
