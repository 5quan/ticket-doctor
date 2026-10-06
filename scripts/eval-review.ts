#!/usr/bin/env node
// 人工复核 CLI（E4）：无 --case 时打印复核清单；带 --case 时把结论写回 <scenario>/reviews.json。
// 用法：
//   npm run eval:review -- --scenario demo-checkout
//   npm run eval:review -- --scenario demo-checkout --case demo-001 --correct --note "根因正确"
//   npm run eval:review -- --scenario demo-checkout --case demo-001 --wrong --note "只答现象"
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl } from "../src/eval/report.ts";
import { formatReviewSheet, mergeReview } from "../src/eval/review.ts";
import type { CaseReview } from "../src/eval/scorer.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : "") : undefined;
}
const scenarioArg = arg("scenario");
if (!scenarioArg) {
  console.error("用法：npm run eval:review -- --scenario <name> [--case <id> --correct|--wrong --note <text>]");
  process.exit(2);
}
const scenarioName = scenarioArg.includes("/") ? scenarioArg.split("/").pop()! : scenarioArg;
const scenarioDir = isAbsolute(scenarioArg) ? scenarioArg : resolve(ROOT, "fixtures", "evals", scenarioName);
const jsonlPath = resolve(ROOT, "data", "evals", `${scenarioName}.jsonl`);
const records = readJsonl(jsonlPath);
if (records.length === 0) {
  console.error(`没有可复核的记录：${jsonlPath}（先跑 npm run eval）`);
  process.exit(1);
}

const caseId = arg("case");
if (!caseId) {
  console.log(formatReviewSheet(records));
  console.log(`\n写回复核：npm run eval:review -- --scenario ${scenarioName} --case <id> --correct|--wrong --note "..."`);
  process.exit(0);
}

const correct = process.argv.includes("--correct");
const wrong = process.argv.includes("--wrong");
if (correct === wrong) {
  console.error("必须且只能指定 --correct 或 --wrong");
  process.exit(2);
}
if (!records.some((r) => r.caseId === caseId)) {
  console.error(`case 不存在：${caseId}`);
  process.exit(2);
}

const reviewsPath = join(scenarioDir, "reviews.json");
let existing: Record<string, CaseReview> = {};
try {
  existing = JSON.parse(readFileSync(reviewsPath, "utf8")) as Record<string, CaseReview>;
} catch {
  existing = {};
}
const note = arg("note");
const merged = mergeReview(existing, caseId, correct, note || undefined);
writeFileSync(reviewsPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`已写回 ${reviewsPath}：${caseId} = ${correct ? "correct" : "wrong"}${note ? `（${note}）` : ""}`);
