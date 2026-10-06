#!/usr/bin/env node
// 评测对比 CLI：读取 data/evals/*.jsonl（多次运行的追加记录），按变量分组输出。
// 用法：
//   npm run eval:compare -- --scenario demo-checkout
//   npm run eval:compare -- --scenario demo-checkout,order-validation,payment-timeout
//   npm run eval:compare -- --all
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatComparison, groupVariants } from "../src/eval/compare.ts";
import { readJsonl, type EvalRecord } from "../src/eval/report.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EVAL_DIR = join(ROOT, "data", "evals");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let names: string[];
if (process.argv.includes("--all")) {
  // 只纳入有 fixture 的场景，避免扫到历史/异构 JSONL。
  names = readdirSync(EVAL_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""))
    .filter((name) => existsSync(join(ROOT, "fixtures", "evals", name, "benchmark.json")));
} else {
  const scenarioArg = arg("scenario");
  if (!scenarioArg) {
    console.error("用法：npm run eval:compare -- --scenario <a,b,c> | --all");
    process.exit(2);
  }
  names = scenarioArg
    .split(",")
    .map((s) => s.trim().replace(/\.jsonl$/, "").split("/").pop()!)
    .filter(Boolean);
}

const records: EvalRecord[] = [];
for (const name of names) {
  const rs = readJsonl(join(EVAL_DIR, `${name}.jsonl`));
  records.push(...rs);
}
if (records.length === 0) {
  console.error(`没有可对比的记录：${names.join(", ")}`);
  process.exit(1);
}
console.log(`[eval:compare] ${names.join(", ")}（${records.length} 条运行记录）`);
console.log(formatComparison(groupVariants(records)));
console.log("注意：不同 scorerVersion / 不同材料指纹 / 不同场景禁止列为同一口径比较；语义正确性未复核时为 unscored。");
