#!/usr/bin/env node
// 评测对比 CLI：读取 data/evals/<scenario>.jsonl（多次运行的追加记录），按变量分组输出。
// 用法：npm run eval:compare -- --scenario demo-checkout
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatComparison, groupVariants } from "../src/eval/compare.ts";
import { readJsonl } from "../src/eval/report.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const i = process.argv.indexOf("--scenario");
const scenarioArg = i >= 0 ? process.argv[i + 1] : undefined;
if (!scenarioArg) {
  console.error("用法：npm run eval:compare -- --scenario <name>");
  process.exit(2);
}
const scenario = scenarioArg.includes("/") ? scenarioArg.split("/").pop()! : scenarioArg;
const outPath = isAbsolute(scenarioArg) ? scenarioArg : resolve(ROOT, "data", "evals", `${scenario}.jsonl`);
const records = readJsonl(outPath);
if (records.length === 0) {
  console.error(`没有可对比的记录：${outPath}`);
  process.exit(1);
}
console.log(`[eval:compare] ${outPath}（${records.length} 条运行记录）`);
console.log(formatComparison(groupVariants(records)));
console.log("注意：不同 scorerVersion / 不同材料指纹 / 不同场景禁止同表比较；语义正确性未复核时为 unscored。");
