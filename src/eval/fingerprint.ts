// 评测版本指纹：固定"同一次评测"的可比条件，并记录**本次改变的变量**。
//
// 修正要点（评审）：优化前后当然要比较，禁止比较的是「不同口径」；因此指纹要覆盖
// 代码、材料、提示词、规则、模型与预算，而不只是 gitRev。打分器/审计策略版本单独记录。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/index.ts";
import { AUDIT_POLICY_VERSION } from "../agent/audit-types.ts";
import { EVAL_SCORER_VERSION } from "./benchmark.ts";

export interface EvalFingerprint {
  gitRev: string;
  gitDirty: boolean;
  scenario: string;
  engine: string;
  provider?: string;
  model?: string;
  systemPromptHash: string;
  rulesHash: string | null;
  materialHash: string;
  repoHead: string | null;
  budget: {
    maxToolCalls: number;
    maxModelTurns: number;
    timeoutMs: number;
    maxToolResultChars: number;
    maxResultChars: number;
  };
  scorerVersion: string;
  auditEnabled: boolean;
  auditPolicyVersion: string;
  auditMaxRounds: number;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/** 材料指纹：日志文件内容 + 仓库 HEAD + 仓库工作树内容（fixture 静态，二者都应稳定）。 */
export function hashMaterials(logsDir: string, repoDir: string): { materialHash: string; repoHead: string | null } {
  const h = createHash("sha256");
  const files = walkFiles(logsDir).sort();
  for (const f of files) {
    h.update(f.replace(logsDir, ""));
    h.update(readFileSync(f));
  }
  let repoHead: string | null = null;
  try {
    repoHead = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    h.update(`repo:${repoHead}`);
  } catch {
    h.update("repo:no-git");
  }
  for (const f of walkFiles(repoDir).sort()) {
    if (f.includes(`${join(repoDir, ".git")}`)) continue;
    h.update(f.replace(repoDir, ""));
    h.update(readFileSync(f));
  }
  return { materialHash: h.digest("hex").slice(0, 16), repoHead };
}

function gitRev(projectRoot: string): { rev: string; dirty: boolean } {
  try {
    const rev = execFileSync("git", ["-C", projectRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", projectRoot, "status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    return { rev, dirty };
  } catch {
    return { rev: "unknown", dirty: false };
  }
}

export function buildFingerprint(opts: {
  projectRoot: string;
  scenario: string;
  engine: string;
  provider?: string;
  model?: string;
  systemPrompt: string;
  rulesText: string | null;
  logsDir: string;
  repoDir: string;
  config: AppConfig;
  auditEnabled: boolean;
}): EvalFingerprint {
  const { rev, dirty } = gitRev(opts.projectRoot);
  const { materialHash, repoHead } = hashMaterials(opts.logsDir, opts.repoDir);
  return {
    gitRev: rev,
    gitDirty: dirty,
    scenario: opts.scenario,
    engine: opts.engine,
    provider: opts.provider,
    model: opts.model,
    systemPromptHash: hashText(opts.systemPrompt),
    rulesHash: opts.rulesText === null ? null : hashText(opts.rulesText),
    materialHash,
    repoHead,
    budget: {
      maxToolCalls: opts.config.diagnosis.maxToolCalls,
      maxModelTurns: opts.config.diagnosis.maxModelTurns,
      timeoutMs: opts.config.diagnosis.timeoutMs,
      maxToolResultChars: opts.config.diagnosis.maxToolResultChars,
      maxResultChars: opts.config.diagnosis.maxResultChars,
    },
    scorerVersion: EVAL_SCORER_VERSION,
    auditEnabled: opts.auditEnabled,
    auditPolicyVersion: AUDIT_POLICY_VERSION,
    auditMaxRounds: opts.config.diagnosis.audit.maxRounds,
  };
}
