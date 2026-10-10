// 自改进方案交付 A：通用数据集 builder（§9）。
//
// 只把 **admission=admitted** 的案例纳入数据集；qualified/candidate/deferred 只登记跳过原因。
// Dataset Item 划分类似 smoke：input=首轮问题（不含后续轮/答案），expectedOutput=逐轮标准派生，
// metadata=split/来源/hash/服务；私有 truth 不进入 Agent 输入。
//
// 当前首批案例均为 qualified（待人工复核），因此 builder 产出 0 条，并显式列出跳过项——
// 这正是"未审定不得进入运行"的门禁。

import { join } from "node:path";
import type { LangfuseClient } from "@langfuse/client";
import { loadCatalog, loadCase, loadRoundMessage, loadTruth, type CatalogEntry } from "../../eval/lf/internals/load.ts";
import { casePublicHash } from "../../eval/lf/seed.ts";
import { sha256Bytes } from "../../eval/lf/internals/hash.ts";
import { assertAdmissionIntegrity } from "./review.ts";
import type { CaseDescriptorV2, TruthFileV2 } from "../../eval/lf/internals/types.ts";

export const BOOTSTRAP_DATASET = "ticket-doctor-rsi-bootstrap-v1";
export const BOOTSTRAP_PROTOCOL = "prediagnosis-bootstrap-v0";

export interface BootstrapLoadedCase {
  entry: CatalogEntry;
  caseDesc: CaseDescriptorV2;
  truth: TruthFileV2;
}

/** 读取 catalog 中 rcb-* 案例（草稿也读，admission 由 builder 过滤）。 */
export function listRsiCases(evalRoot: string, projectRoot: string): BootstrapLoadedCase[] {
  const catalog = loadCatalog(evalRoot);
  return catalog.cases
    .filter((e) => e.caseId.startsWith("rcb-"))
    .sort((a, b) => a.caseId.localeCompare(b.caseId))
    .map((entry) => ({
      entry,
      caseDesc: loadCase(evalRoot, entry, projectRoot, { requireAdmitted: false }),
      truth: loadTruth(evalRoot, entry),
    }));
}

export interface BootstrapDatasetItem {
  datasetName: string;
  input: { caseId: string; question: string };
  expectedOutput: { protocolVersion: string; rounds: Array<{ roundId: string; allowedOutcomes: string[]; allowedClaimDepth: string; requiredFacts: string[]; evidenceRequirements: number; forbiddenRules: number }> };
  metadata: {
    caseId: string;
    familyId: string;
    split: string;
    sourceType: string;
    services: string[];
    casePublicHash: string;
    protocolVersion: string;
    itemId: string;
  };
}

/** 确定性 item id：同 caseId 同 id（upsert 幂等）。 */
export function bootstrapItemId(caseId: string): string {
  return sha256Bytes(`rsi-bootstrap\u0000${caseId}`).slice(0, 32);
}

export interface BootstrapDatasetBuild {
  datasetName: string;
  items: BootstrapDatasetItem[];
  skipped: Array<{ caseId: string; admission: string; reason: string }>;
}

/** 只纳入 admitted；其余记跳过原因。对每条 admitted 案例的首轮生成 input/expectedOutput/metadata。 */
export function buildBootstrapDataset(evalRoot: string, projectRoot: string, opts?: { reviewRoot?: string }): BootstrapDatasetBuild {
  const items: BootstrapDatasetItem[] = [];
  const skipped: BootstrapDatasetBuild["skipped"] = [];
  for (const { entry, caseDesc, truth } of listRsiCases(evalRoot, projectRoot)) {
    if (caseDesc.admission !== "admitted") {
      skipped.push({ caseId: caseDesc.caseId, admission: caseDesc.admission, reason: "未通过准入门槛（需人工复核后置 admitted）" });
      continue;
    }
    // 已准入必须有匹配的批准记录，否则拒绝纳入（标准漂移防护）。
    assertAdmissionIntegrity(projectRoot, truth, { reviewRoot: opts?.reviewRoot });
    const firstRound = caseDesc.rounds[0]!;
    const roundTruth = truth.rounds.find((r) => r.roundId === firstRound.roundId);
    if (!roundTruth) throw new Error(`case ${caseDesc.caseId} 首轮缺少 truth`);
    const caseDir = join(evalRoot, entry.publicDir);
    items.push({
      datasetName: BOOTSTRAP_DATASET,
      input: { caseId: caseDesc.caseId, question: loadRoundMessage(caseDir, firstRound.messageRef) },
      expectedOutput: {
        protocolVersion: BOOTSTRAP_PROTOCOL,
        rounds: [
          {
            roundId: roundTruth.roundId,
            allowedOutcomes: roundTruth.allowedOutcomes,
            allowedClaimDepth: roundTruth.allowedClaimDepth,
            requiredFacts: roundTruth.requiredFacts.map((f) => f.factId),
            evidenceRequirements: roundTruth.evidenceRequirements.length,
            forbiddenRules: roundTruth.forbiddenRules.length,
          },
        ],
      },
      metadata: {
        caseId: caseDesc.caseId,
        familyId: caseDesc.familyId,
        split: caseDesc.split,
        sourceType: caseDesc.sourceTier,
        services: firstRound.services,
        casePublicHash: casePublicHash(evalRoot, caseDesc),
        protocolVersion: BOOTSTRAP_PROTOCOL,
        itemId: bootstrapItemId(caseDesc.caseId),
      },
    });
  }
  return { datasetName: BOOTSTRAP_DATASET, items, skipped };
}

export interface BootstrapSeedResult {
  datasetName: string;
  datasetId: string | null;
  synced: boolean;
  items: Array<{ caseId: string; itemId: string; ok: boolean; error?: string }>;
  skipped: BootstrapDatasetBuild["skipped"];
}

/**
 * 把已准入案例同步到 Langfuse Dataset（幂等 upsert）。默认 dry-run（sync=false）只组装不触网。
 * 注意：Dataset 版本只冻结 item 内容，不冻结服务器文件——运行时由 task 侧核材料 hash。
 */
export async function seedBootstrapDataset(
  lf: LangfuseClient,
  evalRoot: string,
  projectRoot: string,
  opts: { sync?: boolean; reviewRoot?: string } = {},
): Promise<BootstrapSeedResult> {
  const built = buildBootstrapDataset(evalRoot, projectRoot, { reviewRoot: opts.reviewRoot });
  const result: BootstrapSeedResult = { datasetName: BOOTSTRAP_DATASET, datasetId: null, synced: opts.sync === true, items: [], skipped: built.skipped };
  if (opts.sync) {
    const ds = (await lf.api.datasets.create({
      name: BOOTSTRAP_DATASET,
      description: "ticket-doctor 自改进启动集：RootCauseBench 公开模拟案例（train/validation），仅准入案例纳入",
    })) as { id?: string };
    result.datasetId = ds.id ?? null;
  }
  for (const item of built.items) {
    const itemId = item.metadata.itemId;
    try {
      if (opts.sync) {
        await lf.api.datasetItems.create({
          datasetName: BOOTSTRAP_DATASET,
          id: itemId,
          input: item.input as unknown,
          expectedOutput: item.expectedOutput as unknown,
          metadata: item.metadata as unknown,
        });
      }
      result.items.push({ caseId: item.metadata.caseId, itemId, ok: true });
    } catch (err) {
      result.items.push({ caseId: item.metadata.caseId, itemId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
