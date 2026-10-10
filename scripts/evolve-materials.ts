#!/usr/bin/env node
// 自改进交付 A · 材料 CLI（docs/self-improvement-implementation-plan.md §4）：
//   verify    核对冻结案例包 hash 与 split 卫生（只读，不改资料）
//   convert   把首批/全部案例转换成 Agent 可见的日志材料视图（写入 data/evolve/rsi-bootstrap）
//
// 材料在 Agent 运行前完成并冻结；本命令不做任何模型调用。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "../src/eval/lf/internals/hash.ts";
import {
  FIRST_BATCH_CASE_IDS,
  checkSplitHygiene,
  loadRsiBootstrapManifest,
  selectFirstBatch,
  verifyRsiBootstrapHashes,
} from "../src/evolve/materials/catalog.ts";
import { EVOLVE_MATERIALS_ROOT, materializeCases } from "../src/evolve/materials/materialize.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function outRoot(): string {
  const raw = arg("out") ?? process.env.TD_EVOLVE_MATERIALS_ROOT ?? EVOLVE_MATERIALS_ROOT;
  return isAbsolute(raw) ? raw : resolve(ROOT, raw);
}
function converterSource(): string {
  return ["convert.ts", "catalog.ts", "materialize.ts"]
    .map((f) => readFileSync(join(ROOT, "src", "evolve", "materials", f), "utf8"))
    .join("\n\u0000\n");
}
function gitRev(): string {
  try {
    return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function cmdVerify(): number {
  const manifest = loadRsiBootstrapManifest(ROOT);
  const check = verifyRsiBootstrapHashes(ROOT, manifest);
  const hygiene = checkSplitHygiene(manifest.cases);
  console.log(`[evolve:materials] 冻结包：${manifest.cases.length} 案例，${check.checked} 文件，来源 ${manifest.sourceCommit.slice(0, 12)}`);
  console.log(`[evolve:materials] hash 核对：${check.checked - check.mismatches.length - check.missing.length}/${check.checked} 通过`);
  if (check.missing.length) console.log(`[evolve:materials] 缺失：${check.missing.join(", ")}`);
  for (const m of check.mismatches) console.log(`[evolve:materials] hash 不符：${m.path}（期望 ${m.expected.slice(0, 12)}… 实际 ${m.actual.slice(0, 12)}…）`);
  if (hygiene.length) for (const v of hygiene) console.log(`[evolve:materials] split 违规：${v}`);
  const splits = manifest.cases.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.split]: (acc[c.split] ?? 0) + 1 }), {});
  console.log(`[evolve:materials] split 分布：${JSON.stringify(splits)}；首批=${FIRST_BATCH_CASE_IDS.join(", ")}`);
  const failed = check.mismatches.length > 0 || check.missing.length > 0 || hygiene.length > 0;
  if (failed) console.log("[evolve:materials] 结果：失败（材料不可重复，拒绝继续）");
  return failed ? 1 : 0;
}

function cmdConvert(): number {
  const manifest = loadRsiBootstrapManifest(ROOT);
  const check = verifyRsiBootstrapHashes(ROOT, manifest);
  if (check.mismatches.length || check.missing.length) {
    console.log("[evolve:materials] 冻结包 hash 不符，拒绝转换（先修来源，不得改资料迁就代码）");
    return 1;
  }
  const caseId = arg("case");
  const cases = flag("all") ? manifest.cases : caseId ? manifest.cases.filter((c) => c.caseId === caseId) : selectFirstBatch(manifest);
  if (cases.length === 0) {
    console.log(`[evolve:materials] 未找到案例：${caseId ?? "(默认首批)"}`);
    return 1;
  }
  const root = outRoot();
  const aggregate = materializeCases(ROOT, root, cases, { converterSource: converterSource(), sourceCommit: manifest.sourceCommit });
  console.log(`[evolve:materials] 转换 ${cases.length} 案例 → ${root}`);
  console.log(`[evolve:materials] converterHash=${aggregate.converterHash.slice(0, 12)}… sourceCommit=${manifest.sourceCommit.slice(0, 12)} git=${gitRev()}`);
  for (const c of aggregate.cases) {
    console.log(`  ${c.caseId} [${c.split}] source=${c.sourceSha256.slice(0, 12)}… logView=${c.logViewHash.slice(0, 12)}…`);
  }
  console.log("[evolve:materials] 归档附件（diff/deploy/flags/metrics/traces/patterns）只登记 hash，不进日志视图，不可读。");
  return 0;
}

function usage(): void {
  console.log(`用法：
  npm run evolve:materials:verify
  npm run evolve:materials:convert [--case rcb-001 | --all] [--out <dir>]`);
}

const cmd = process.argv[2];
let code: number;
switch (cmd) {
  case "verify": code = cmdVerify(); break;
  case "convert": code = cmdConvert(); break;
  default: usage(); code = 2; break;
}
process.exit(code);
