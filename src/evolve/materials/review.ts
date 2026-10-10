// 自改进方案交付 A：rubric 人工复核与准入（§3.3 / §7.2 / §12）。
//
// 规则：
//   * 复核记录写入**仓库内** `evolve/reviews/<caseId>.json`（不在 data/ 下），重建材料不丢批准。
//   * 只有 decision=approved 且 rubricHash 与当前 truth 完全一致时，才把 case.json 置 admitted。
//   * rubric 任何改动都会改变 rubricHash → 旧批准自动失效，必须重新复核（标准漂移防护）。
//   * reviewer 为真实人类标识；本工具只记录，不代替人工判断。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes } from "../../eval/lf/internals/hash.ts";
import type { TruthFileV2 } from "../../eval/lf/internals/types.ts";

export const REVIEW_STORE_REL = "evolve/reviews";

export interface RubricReview {
  schemaVersion: "rsi-rubric-review/v0";
  caseId: string;
  /** 复核时的 rubric 指纹；与当前 truth 不一致即失效。 */
  rubricHash: string;
  reviewer: string;
  reviewedAt: string;
  decision: "approved" | "changes_requested";
  notes?: string;
}

/** rubric 指纹：只覆盖可复核内容（locators + rounds），不含 review 自身，避免循环。 */
export function rubricHash(truth: TruthFileV2): string {
  return sha256Bytes(JSON.stringify({ locators: truth.locators, rounds: truth.rounds }));
}

/** 复核记录位置可选覆盖（测试/隔离用）；缺省挂在仓库内 evolve/reviews。 */
export interface ReviewOpts {
  reviewRoot?: string;
}

export function reviewStoreRoot(projectRoot: string, opts?: ReviewOpts): string {
  return opts?.reviewRoot ?? join(projectRoot, REVIEW_STORE_REL);
}

export function reviewPath(projectRoot: string, caseId: string, opts?: ReviewOpts): string {
  return join(reviewStoreRoot(projectRoot, opts), `${caseId}.json`);
}

export function loadReview(projectRoot: string, caseId: string, opts?: ReviewOpts): RubricReview | undefined {
  const path = reviewPath(projectRoot, caseId, opts);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as RubricReview;
}

export function writeReview(projectRoot: string, review: RubricReview, opts?: ReviewOpts): void {
  mkdirSync(reviewStoreRoot(projectRoot, opts), { recursive: true });
  writeFileSync(reviewPath(projectRoot, review.caseId, opts), JSON.stringify(review, null, 2), "utf8");
}

export class ReviewError extends Error {}

/**
 * 是否可准入：存在 approved 记录且 rubricHash 与当前 truth 一致。
 * 返回原因供 CLI 显示。
 */
export function admissionVerdict(
  projectRoot: string,
  caseId: string,
  truth: TruthFileV2,
  opts?: ReviewOpts,
): { admissible: boolean; reason: string; review?: RubricReview } {
  const review = loadReview(projectRoot, caseId, opts);
  if (!review) return { admissible: false, reason: "无复核记录" };
  if (review.decision !== "approved") return { admissible: false, reason: `复核结论=${review.decision}`, review };
  const current = rubricHash(truth);
  if (review.rubricHash !== current) {
    return { admissible: false, reason: `rubric 已变更（review=${review.rubricHash.slice(0, 12)}… 当前=${current.slice(0, 12)}…），需重新复核`, review };
  }
  return { admissible: true, reason: `复核通过（reviewer=${review.reviewer}）`, review };
}

/**
 * 依据复核记录决定写入的准入状态与 truth.review。
 * 未通过/缺失时保持 qualified 与 provisional。
 */
export function applyAdmission(
  projectRoot: string,
  truth: TruthFileV2,
  opts?: ReviewOpts,
): { admission: "admitted" | "qualified"; review: TruthFileV2["review"] } {
  const verdict = admissionVerdict(projectRoot, truth.caseId, truth, opts);
  if (verdict.admissible && verdict.review) {
    return {
      admission: "admitted",
      review: {
        author: truth.review.author,
        reviewer: verdict.review.reviewer,
        provisional: false,
        rubricHash: verdict.review.rubricHash,
        ...(verdict.review.notes ? { notes: verdict.review.notes } : {}),
      },
    };
  }
  return { admission: "qualified", review: truth.review };
}

/** 已准入案例必须有匹配的批准记录；用于数据集 builder 前的完整性检查。 */
export function assertAdmissionIntegrity(projectRoot: string, truth: TruthFileV2, opts?: ReviewOpts): void {
  const review = loadReview(projectRoot, truth.caseId, opts);
  if (!review) throw new ReviewError(`case ${truth.caseId} 标为 admitted 但无复核记录`);
  if (review.decision !== "approved") throw new ReviewError(`case ${truth.caseId} 标为 admitted 但复核结论=${review.decision}`);
  const current = rubricHash(truth);
  if (review.rubricHash !== current) {
    throw new ReviewError(`case ${truth.caseId} 标为 admitted 但 rubric 已变更（review=${review.rubricHash.slice(0, 12)}… 当前=${current.slice(0, 12)}…）`);
  }
}
