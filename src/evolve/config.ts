// 自改进方案 §8 第 4 步：冻结搜索配置（GEPA 参数 / 预算 / 候选范围 / 数据划分）。
//
// 配置入库（evolve/config/search-v1.json）。任何影响评分的坐标（基线 prompt hash、
// 评分器 hash、rubric 源 hash、准入清单）变化都会让 verify 失败——必须重新冻结，
// 防止用旧配置跑新代码、或把 holdout 混进搜索。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt } from "../agent/pi-engine.ts";
import { sha256Bytes, sha256File } from "../eval/lf/internals/hash.ts";
import { loadCatalog, loadCase } from "../eval/lf/internals/load.ts";
import { MAX_RULES_LEN } from "./compile.ts";

export const SEARCH_CONFIG_REL = "evolve/config/search-v1.json";

export interface SearchConfig {
  schemaVersion: "rsi-search-config/v0";
  configId: string;
  frozenAt: string;
  datasetName: string;
  basePromptHash: string;
  scorerHash: string;
  rubricsSourceHash: string;
  splits: { train: string[]; validation: string[]; holdout: string[] };
  repeat: number;
  model: { provider: string; model: string };
  candidate: { component: "diagnosis_rules"; maxChars: number; forbidden: string[] };
  budget: { maxTokens: number; maxUsd: number | null; maxWallMs: number; maxTrials: number };
  gepa: { maxCandidates: number; maxMetricCalls: number; concurrency: number; maxNoImprovement: number; timeLimitMin: number };
  selection: { disallowNewHardFailures: boolean; disallowRegressionOnBaselinePassing: boolean; minMeanGain: number; holdoutReserved: boolean };
}

export interface SearchState {
  basePromptHash: string;
  scorerHash: string;
  rubricsSourceHash: string;
  admittedTrain: string[];
  admittedValidation: string[];
  holdoutCaseIds: string[];
}

export class SearchConfigError extends Error {}

export function loadSearchConfig(projectRoot: string, rel = SEARCH_CONFIG_REL): SearchConfig {
  const path = join(projectRoot, rel);
  if (!existsSync(path)) throw new SearchConfigError(`缺少冻结搜索配置：${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as SearchConfig;
}

/** 从当前仓库/材料计算坐标（供 verify 比对）。 */
export function currentSearchState(projectRoot: string, evalRoot: string): SearchState {
  const catalog = loadCatalog(evalRoot);
  const admittedTrain: string[] = [];
  const admittedValidation: string[] = [];
  const holdoutCaseIds: string[] = [];
  for (const entry of catalog.cases) {
    if (!entry.caseId.startsWith("rcb-")) continue;
    const desc = loadCase(evalRoot, entry, projectRoot, { requireAdmitted: false });
    if (desc.split === "holdout") holdoutCaseIds.push(desc.caseId);
    if (desc.admission !== "admitted") continue;
    if (desc.split === "train") admittedTrain.push(desc.caseId);
    if (desc.split === "validation") admittedValidation.push(desc.caseId);
  }
  return {
    basePromptHash: sha256Bytes(buildSystemPrompt()),
    scorerHash: sha256File(join(projectRoot, "src/evolve/grade.ts")),
    rubricsSourceHash: sha256File(join(projectRoot, "src/evolve/materials/rubrics.ts")),
    admittedTrain: admittedTrain.sort(),
    admittedValidation: admittedValidation.sort(),
    holdoutCaseIds: holdoutCaseIds.sort(),
  };
}

/** 校验配置与当前状态一致；返回问题列表（空=通过）。 */
export function verifySearchConfig(config: SearchConfig, state: SearchState): string[] {
  const issues: string[] = [];
  if (config.schemaVersion !== "rsi-search-config/v0") issues.push(`schemaVersion 非法：${String(config.schemaVersion)}`);

  const all = [...config.splits.train, ...config.splits.validation, ...config.splits.holdout];
  const dupes = all.filter((c, i) => all.indexOf(c) !== i);
  if (dupes.length > 0) issues.push(`案例跨 split 重复：${[...new Set(dupes)].join(",")}`);

  for (const c of config.splits.train) if (!state.admittedTrain.includes(c)) issues.push(`train 案例未准入或失踪：${c}`);
  for (const c of config.splits.validation) if (!state.admittedValidation.includes(c)) issues.push(`validation 案例未准入或失踪：${c}`);
  for (const c of config.splits.holdout) {
    if (state.admittedTrain.includes(c) || state.admittedValidation.includes(c)) issues.push(`holdout 案例被准入/混入搜索：${c}`);
    if (!state.holdoutCaseIds.includes(c)) issues.push(`holdout 案例不存在：${c}`);
  }
  for (const c of state.admittedTrain) if (!config.splits.train.includes(c)) issues.push(`已准入 train 案例未纳入配置：${c}`);
  for (const c of state.admittedValidation) if (!config.splits.validation.includes(c)) issues.push(`已准入 validation 案例未纳入配置：${c}`);

  if (config.basePromptHash !== state.basePromptHash) issues.push(`basePromptHash 过期：config=${config.basePromptHash.slice(0, 12)}… 当前=${state.basePromptHash.slice(0, 12)}…`);
  if (config.scorerHash !== state.scorerHash) issues.push(`scorerHash 过期：config=${config.scorerHash.slice(0, 12)}… 当前=${state.scorerHash.slice(0, 12)}…`);
  if (config.rubricsSourceHash !== state.rubricsSourceHash) issues.push(`rubricsSourceHash 过期：config=${config.rubricsSourceHash.slice(0, 12)}… 当前=${state.rubricsSourceHash.slice(0, 12)}…`);

  if (config.candidate.component !== "diagnosis_rules") issues.push(`candidate.component 必须是 diagnosis_rules：${config.candidate.component}`);
  if (!Number.isInteger(config.candidate.maxChars) || config.candidate.maxChars < 1 || config.candidate.maxChars > MAX_RULES_LEN) {
    issues.push(`candidate.maxChars 必须在 1~${MAX_RULES_LEN}`);
  }
  if (!Number.isInteger(config.repeat) || config.repeat < 1 || config.repeat > 5) issues.push(`repeat 必须在 1~5：${config.repeat}`);
  for (const [k, v] of Object.entries(config.budget)) {
    if (v !== null && (!Number.isFinite(v) || (v as number) < 0)) issues.push(`budget.${k} 非法：${String(v)}`);
  }
  for (const [k, v] of Object.entries(config.gepa)) {
    if (!Number.isFinite(v) || (v as number) < 0) issues.push(`gepa.${k} 非法：${String(v)}`);
  }
  return issues;
}
