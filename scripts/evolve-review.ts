#!/usr/bin/env node
// 自改进交付 A CLI：rubric 人工复核与准入（docs/self-improvement-implementation-plan.md §3.3/§7.2）。
//   list    列出首批案例的 split/admission/rubric 指纹/复核状态
//   record  记录人工复核结论；approved 且指纹一致才置 admitted（--revise 覆盖旧记录）
//   verify  校验所有 admitted 案例都有匹配的批准记录（标准漂移防护）
//
// 本工具只记录人类审阅结论，不代替人工判断；未复核前案例保持 qualified。

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapSpec, BOOTSTRAP_SPECS } from "../src/evolve/materials/rubrics.ts";
import { buildBootstrapCases } from "../src/evolve/materials/build-cases.ts";
import { assertAdmissionIntegrity, loadReview, rubricHash, writeReview, type RubricReview } from "../src/evolve/materials/review.ts";
import type { TruthFileV2 } from "../src/eval/lf/internals/types.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function evalRoot(): string {
  const raw = arg("eval-root") ?? process.env.TD_EVAL_ROOT ?? join(ROOT, "data", "eval-v2");
  return isAbsolute(raw) ? raw : resolve(ROOT, raw);
}
function truthPath(root: string, caseId: string): string {
  return join(root, "private", caseId, "truth.private.json");
}
function readTruth(root: string, caseId: string): TruthFileV2 {
  const p = truthPath(root, caseId);
  if (!existsSync(p)) throw new Error(`缺少已装配的 truth：${p}（先运行 npm run evolve:materials:build）`);
  return JSON.parse(readFileSync(p, "utf8")) as TruthFileV2;
}

function cmdList(): number {
  const root = evalRoot();
  console.log(`[evolve:review] 首批 ${BOOTSTRAP_SPECS.length} 案例（evalRoot=${root}）`);
  for (const spec of BOOTSTRAP_SPECS) {
    let admission = "(未装配)";
    let rHash = "";
    if (existsSync(truthPath(root, spec.caseId))) {
      const truth = readTruth(root, spec.caseId);
      rHash = rubricHash(truth);
      const caseJson = join(root, "public", spec.caseId, "case.json");
      if (existsSync(caseJson)) admission = (JSON.parse(readFileSync(caseJson, "utf8")) as { admission?: string }).admission ?? "?";
    }
    const review = loadReview(ROOT, spec.caseId);
    const status = !review ? "未复核" : review.decision === "approved" ? (review.rubricHash === rHash ? "已批准" : "批准失效（rubric 变更）") : "要求修改";
    console.log(`  ${spec.caseId} [${spec.split}] admission=${admission} rubric=${rHash.slice(0, 12)}… review=${status}${review ? ` by ${review.reviewer}` : ""}`);
  }
  return 0;
}

function cmdRecord(): number {
  const caseId = arg("case");
  if (!caseId) throw new Error("--case 必填");
  if (!bootstrapSpec(caseId)) throw new Error(`${caseId} 不是首批案例，不支持准入复核`);
  const reviewer = arg("reviewer");
  if (!reviewer) throw new Error("--reviewer 必填（真实审阅人标识，工具不代替人工判断）");
  const decision = arg("decision");
  if (decision !== "approved" && decision !== "changes_requested") throw new Error("--decision 必须是 approved|changes_requested");
  const existing = loadReview(ROOT, caseId);
  if (existing && !flag("revise")) throw new Error(`${caseId} 已有复核记录（${existing.decision}）；如需修改加 --revise`);
  const root = evalRoot();
  const truth = readTruth(root, caseId);
  const review: RubricReview = {
    schemaVersion: "rsi-rubric-review/v0",
    caseId,
    rubricHash: rubricHash(truth),
    reviewer,
    reviewedAt: new Date().toISOString(),
    decision,
    ...(arg("notes") ? { notes: arg("notes")! } : {}),
  };
  writeReview(ROOT, review);
  const { built } = buildBootstrapCases(ROOT, root);
  const b = built.find((x) => x.caseId === caseId)!;
  console.log(`[evolve:review] ${caseId} 记录复核：${decision}（reviewer=${reviewer}）→ admission=${b.admission}`);
  if (decision === "approved") console.log("[evolve:review] 提示：批准记录在 evolve/reviews/，请提交入库；材料重建会按指纹自动重新应用准入。");
  return 0;
}

function cmdVerify(): number {
  const root = evalRoot();
  let bad = 0;
  for (const spec of BOOTSTRAP_SPECS) {
    if (!existsSync(truthPath(root, spec.caseId))) continue;
    const truth = readTruth(root, spec.caseId);
    const caseJson = join(root, "public", spec.caseId, "case.json");
    const admission = existsSync(caseJson) ? (JSON.parse(readFileSync(caseJson, "utf8")) as { admission?: string }).admission : "?";
    if (admission !== "admitted") {
      console.log(`  ${spec.caseId} admission=${admission}（未准入，跳过）`);
      continue;
    }
    try {
      assertAdmissionIntegrity(ROOT, truth);
      console.log(`  ${spec.caseId} ✅ admitted 且有匹配批准记录`);
    } catch (err) {
      bad++;
      console.log(`  ${spec.caseId} ❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (bad > 0) {
    console.log(`[evolve:review] 失败：${bad} 个 admitted 案例缺少有效批准记录`);
    return 1;
  }
  console.log("[evolve:review] 通过：所有 admitted 案例都有匹配批准记录");
  return 0;
}

function usage(): void {
  console.log(`用法：
  npm run evolve:review                                   # 列出复核状态
  npm run evolve:review:record -- --case rcb-001 --reviewer <name> --decision approved|changes_requested [--notes "..."] [--revise]
  npm run evolve:review:verify`);
}

const cmd = process.argv[2];
let code: number;
try {
  switch (cmd) {
    case "list": code = cmdList(); break;
    case "record": code = cmdRecord(); break;
    case "verify": code = cmdVerify(); break;
    default: usage(); code = 2; break;
  }
} catch (err) {
  console.error(`[evolve:review] 错误：${err instanceof Error ? err.message : String(err)}`);
  code = 1;
}
process.exit(code);
