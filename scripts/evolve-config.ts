#!/usr/bin/env node
// 自改进交付：冻结搜索配置 CLI（docs/self-improvement-implementation-plan.md §8 第 4 步）。
//   show    打印冻结配置
//   verify  与当前状态比对（准入清单、基线/评分器/rubric 指纹、split 隔离）；不一致即失败

import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SEARCH_CONFIG_REL, currentSearchState, loadSearchConfig, verifySearchConfig } from "../src/evolve/config.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : fallback;
}
function evalRoot(): string {
  const raw = arg("eval-root") ?? process.env.TD_EVAL_ROOT ?? join(ROOT, "data", "eval-v2");
  return isAbsolute(raw) ? raw : resolve(ROOT, raw);
}

function cmdShow(): number {
  const config = loadSearchConfig(ROOT);
  console.log(JSON.stringify(config, null, 2));
  return 0;
}

function cmdVerify(): number {
  const config = loadSearchConfig(ROOT);
  const state = currentSearchState(ROOT, evalRoot());
  const issues = verifySearchConfig(config, state);
  console.log(`[evolve:config] ${SEARCH_CONFIG_REL}（${config.configId}，冻结于 ${config.frozenAt}）`);
  console.log(`  训练：${config.splits.train.join(", ")}`);
  console.log(`  验证：${config.splits.validation.join(", ")}`);
  console.log(`  保留（不参与搜索）：${config.splits.holdout.join(", ")}`);
  console.log(`  预算：maxTokens=${config.budget.maxTokens} maxTrials=${config.budget.maxTrials}；GEPA：候选≤${config.gepa.maxCandidates}、metricCalls≤${config.gepa.maxMetricCalls}`);
  if (issues.length > 0) {
    console.log(`[evolve:config] 失败：${issues.length} 处不一致`);
    for (const i of issues) console.log(`  - ${i}`);
    return 1;
  }
  console.log("[evolve:config] 通过：配置与当前准入/指纹/split 一致");
  return 0;
}

function usage(): void {
  console.log(`用法：
  npm run evolve:config:show
  npm run evolve:config:verify [--eval-root <dir>]`);
}

const cmd = process.argv[2];
try {
  let code: number;
  switch (cmd) {
    case "show": code = cmdShow(); break;
    case "verify": code = cmdVerify(); break;
    default: usage(); code = 2; break;
  }
  process.exit(code);
} catch (err) {
  console.error(`[evolve:config] 错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
