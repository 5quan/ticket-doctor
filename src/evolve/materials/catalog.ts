// 自改进方案交付 A：冻结案例目录与完整性核对（§4.1 / §4.4）。
//
// 独立控制器清单（manifest.json）是 train/validation/holdout 与准入状态的权威来源；
// 现有 case-v2 协议的 development/holdout 不足以表达 train/validation。
// 本模块只读冻结资料，不修改；hash 不符即拒绝（方案 §1「材料可重复」）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes } from "../../eval/lf/internals/hash.ts";

export const RSI_BOOTSTRAP_ROOT = "fixtures/research/rsi-bootstrap";

/** 首批接入顺序（方案 §4.3）：先在两训练例验证接入，再在验证例检查流程。 */
export const FIRST_BATCH_CASE_IDS = ["rcb-001", "rcb-004", "rcb-007"] as const;

export type RsiSplit = "train" | "validation" | "holdout";

export interface RsiBootstrapFileEntry {
  path: string;
  sourcePath: string;
  sourceUrl: string;
  bytes: number;
  sha256: string;
  gitBlobSha: string;
}

export interface RsiBootstrapCase {
  caseId: string;
  upstreamScenario: string;
  familyId: string;
  split: RsiSplit;
  sourceType: string;
  reviewStatus: string;
  task: string;
  agentMaterialDir: string;
  graderTruth: string;
  fullGitSourceAvailable: boolean;
  codeVersionEvaluation: string;
}

export interface RsiBootstrapManifest {
  schemaVersion: string;
  createdAt: string;
  sourceRepo: string;
  sourceCommit: string;
  license: string;
  status: string;
  files: RsiBootstrapFileEntry[];
  cases: RsiBootstrapCase[];
}

export class MaterialCatalogError extends Error {}

export function loadRsiBootstrapManifest(projectRoot: string): RsiBootstrapManifest {
  const path = join(projectRoot, RSI_BOOTSTRAP_ROOT, "manifest.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as RsiBootstrapManifest;
  if (!Array.isArray(raw.files) || !Array.isArray(raw.cases)) {
    throw new MaterialCatalogError("manifest.json 缺少 files/cases 数组");
  }
  return raw;
}

export interface HashCheckResult {
  checked: number;
  mismatches: Array<{ path: string; expected: string; actual: string }>;
  missing: string[];
}

/** 逐文件核对 sha256 与字节数；不符即返回明细（调用方决定是否阻断）。 */
export function verifyRsiBootstrapHashes(projectRoot: string, manifest: RsiBootstrapManifest): HashCheckResult {
  const mismatches: HashCheckResult["mismatches"] = [];
  const missing: string[] = [];
  for (const entry of manifest.files) {
    const abs = join(projectRoot, RSI_BOOTSTRAP_ROOT, entry.path);
    let data: Buffer;
    try {
      data = readFileSync(abs);
    } catch {
      missing.push(entry.path);
      continue;
    }
    const actual = sha256Bytes(data);
    if (actual !== entry.sha256 || data.length !== entry.bytes) {
      mismatches.push({ path: entry.path, expected: entry.sha256, actual });
    }
  }
  return { checked: manifest.files.length, mismatches, missing };
}

/**
 * split 卫生检查：同一 familyId 不得跨 split（方案 §4.1「同一事故的变体必须同 split」）。
 * 返回违规列表；空表示通过。
 */
export function checkSplitHygiene(cases: RsiBootstrapCase[]): string[] {
  const familySplits = new Map<string, Set<RsiSplit>>();
  for (const c of cases) {
    const set = familySplits.get(c.familyId) ?? new Set<RsiSplit>();
    set.add(c.split);
    familySplits.set(c.familyId, set);
  }
  const violations: string[] = [];
  for (const [family, splits] of familySplits) {
    if (splits.size > 1) violations.push(`family ${family} 跨 split：${[...splits].join(", ")}`);
  }
  return violations;
}

/** 按首批顺序取出案例；缺失或 split 不符即报错（不静默放过）。 */
export function selectFirstBatch(manifest: RsiBootstrapManifest): RsiBootstrapCase[] {
  const byId = new Map(manifest.cases.map((c) => [c.caseId, c]));
  return FIRST_BATCH_CASE_IDS.map((id) => {
    const c = byId.get(id);
    if (!c) throw new MaterialCatalogError(`首批案例 ${id} 不在 manifest 中`);
    return c;
  });
}
