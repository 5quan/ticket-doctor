// Langfuse Dataset 同步（eval/langfuse 分支）：案例集 → Langfuse Dataset items。
//
// B1 白名单纪律在这里收口：
//   * input  = 公开题面（各轮消息文本，与 push 的 loadRoundMessages 同一来源）；
//   * expectedOutput 恒 null —— truth 内容（标准/定位/禁用断言）结构性不进 Langfuse；
//   * metadata 只放公开描述字段与指纹引用（caseHash/truthHash），评价标准靠引用对回本地。
// 幂等：itemId 由 caseId 确定性派生；同 id 重复 upsert 得到同一条 item，内容变化时
// Langfuse 侧自动生成新的 dataset 版本（时间戳快照），可按版本复跑。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deterministicId } from "./experiment.ts";
import type { CaseDescriptorV2 } from "./types.ts";

export const LF_DATASET_SCHEMA = "prediagnosis-lf-dataset-sync-v1";

/** 确定性 item id：同一 case 在任何机器、任何时间同步都得到同一 item（幂等 upsert 的根基）。 */
export function datasetItemId(caseId: string): string {
  return deterministicId("dataset-item", caseId);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v === undefined ? null : v));
}

/** 公开材料指纹：case.json + 各轮消息文本（消息缺失按占位计入，装载错误直接抛出）。 */
export function hashCasePublic(evalRoot: string, caseDesc: CaseDescriptorV2): string {
  const caseDir = join(evalRoot, "public", caseDesc.caseId);
  const caseJson = readFileSync(join(caseDir, "case.json"), "utf8");
  const messages = caseDesc.rounds.map((r) => {
    const f = join(caseDir, r.messageRef);
    return existsSync(f) ? readFileSync(f, "utf8") : `[missing:${r.roundId}]`;
  });
  return createHash("sha256").update(canonical({ caseJson, messages })).digest("hex");
}

/** truth 指纹：只回传哈希引用，不上传内容；无私有目录（工程条目允许）记 "absent"。 */
export function hashTruth(evalRoot: string, entry: { privateDir?: string }): string {
  if (!entry.privateDir) return "absent";
  const f = join(evalRoot, entry.privateDir, "truth.private.json");
  if (!existsSync(f)) return "absent";
  return createHash("sha256").update(readFileSync(f, "utf8")).digest("hex");
}

export interface LfDatasetItemPayload {
  datasetName: string;
  id: string;
  input: string;
  expectedOutput: null;
  metadata: {
    caseId: string;
    familyId: string;
    split: string;
    sourceTier: string;
    admission: string;
    diagnosisKind: string;
    maxRounds: number;
    caseHash: string;
    truthHash: string;
    truthNote: string;
  };
}

/**
 * 组装一个 case 的 dataset item（纯函数，无网络）。
 * truthNote 固定指向本地私有标准路径约定——Langfuse 侧永远拿不到内容本身。
 */
export function buildDatasetItemPayload(args: {
  datasetName: string;
  evalRoot: string;
  caseDesc: CaseDescriptorV2;
  truthHash: string;
}): LfDatasetItemPayload {
  const { datasetName, evalRoot, caseDesc } = args;
  const caseDir = join(evalRoot, "public", caseDesc.caseId);
  const input = caseDesc.rounds
    .map((r) => {
      const f = join(caseDir, r.messageRef);
      return existsSync(f) ? readFileSync(f, "utf8").trim() : `[${r.roundId}]`;
    })
    .join("\n---\n");
  return {
    datasetName,
    id: datasetItemId(caseDesc.caseId),
    input,
    expectedOutput: null,
    metadata: {
      caseId: caseDesc.caseId,
      familyId: caseDesc.familyId,
      split: caseDesc.split,
      sourceTier: caseDesc.sourceTier,
      admission: caseDesc.admission,
      diagnosisKind: caseDesc.diagnosisKind ?? "known-service",
      maxRounds: caseDesc.maxRounds,
      caseHash: hashCasePublic(evalRoot, caseDesc),
      truthHash: args.truthHash,
      truthNote: "private/truth.private.json 仅存本地；本条目只含指纹引用（B1 白名单纪律）",
    },
  };
}

// ---------- 同步状态机（纯函数，可确定性测试；与 experiment.ts 的 LfSyncState 同风格） ----------

export interface LfDatasetItemRecord {
  itemId: string;
  caseHash: string;
  truthHash: string;
}

export interface LfDatasetSyncState {
  schemaVersion: string;
  datasetName: string;
  /** 首次 sync 时由服务端返回并固化；之后 push/verify 都用它。 */
  datasetId: string;
  items: Record<string, LfDatasetItemRecord>;
  syncedAt: number;
}

export function emptyDatasetSyncState(datasetName: string, datasetId: string): LfDatasetSyncState {
  return { schemaVersion: LF_DATASET_SCHEMA, datasetName, datasetId, items: {}, syncedAt: 0 };
}

/** 记录/刷新一个 case 的同步结果（同 caseHash+truthHash 重复同步幂等）。 */
export function applyDatasetSync(
  state: LfDatasetSyncState,
  caseId: string,
  record: LfDatasetItemRecord,
): { changed: boolean } {
  const prev = state.items[caseId];
  const changed =
    !prev || prev.caseHash !== record.caseHash || prev.truthHash !== record.truthHash;
  state.items[caseId] = record;
  state.syncedAt = Date.now();
  return { changed };
}
