#!/usr/bin/env node
// 自改进交付 A CLI：rubric 人工复核与准入（docs/self-improvement-implementation-plan.md §3.3/§7.2）。
//   list    列出首批案例的 split/admission/rubric 指纹/复核状态
//   record  记录人工复核结论；approved 且指纹一致才置 admitted（--revise 覆盖旧记录）
//   verify  校验所有 admitted 案例都有匹配的批准记录（标准漂移防护）
//
// 本工具只记录人类审阅结论，不代替人工判断；未复核前案例保持 qualified。

import { existsSync, readdirSync, readFileSync } from "node:fs";
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

function cmdPacket(): number {
  const caseId = arg("case");
  if (!caseId) throw new Error("--case 必填");
  const spec = bootstrapSpec(caseId);
  if (!spec) throw new Error(`${caseId} 不是首批案例`);
  const root = evalRoot();
  const taskPath = join(ROOT, "fixtures/research/rsi-bootstrap/tasks", `${caseId}.json`);
  const oraclePath = join(ROOT, "fixtures/research/rsi-bootstrap/private", caseId, "ground_truth.json");
  const task = JSON.parse(readFileSync(taskPath, "utf8")) as { question: string; receivedAt: string };
  const truth = readTruth(root, caseId);
  const oracle = existsSync(oraclePath) ? (JSON.parse(readFileSync(oraclePath, "utf8")) as Record<string, unknown>) : {};
  const viewDir = join(root, "public", caseId, "round-1");
  const logs = existsSync(viewDir) ? readdirSync(viewDir).filter((f) => f.endsWith(".log")).sort() : [];
  const logText = new Map(logs.map((f) => [f, readFileSync(join(viewDir, f), "utf8")]));
  const countAll = (needle: string): number => [...logText.values()].reduce((a, t) => a + t.split("\n").filter((l) => l.includes(needle)).length, 0);

  console.log(`\n===== 复核包 ${caseId} [${spec.split}] family=${spec.familyId} =====`);
  console.log(`rubric 指纹：${rubricHash(truth)}`);
  console.log(`公开服务：${spec.services.join(", ")}；公开日志：${logs.join(", ")}`);
  console.log(`\n--- 工单（Agent 实际看到的首轮问题）---\n${task.question}`);
  console.log(`\n--- 待复核 rubric（provisional）---`);
  for (const r of truth.rounds) {
    console.log(`允许产出：${r.allowedOutcomes.join(", ")}；允许判断深度：${r.allowedClaimDepth}`);
    console.log("必需事实（每条必须在报告字段中出现）：");
    for (const f of r.requiredFacts) {
      const hits = f.concepts.flat().map((c) => `${c}:${countAll(c)}`).join(" ");
      console.log(`  · ${f.factId} 字段=${f.where.join("/")} 概念组=${JSON.stringify(f.concepts)} 日志命中 ${hits}`);
    }
    console.log("禁用断言（出现即硬失败，须确认这是真诱饵）：");
    if (r.forbiddenRules.length === 0) console.log("  （无）");
    for (const rule of r.forbiddenRules) console.log(`  · ${rule.ruleId} 概念组=${JSON.stringify(rule.assertAnyOf)}`);
    console.log("证据需求（四层可见性 B∧C1∧D）：");
    for (const req of r.evidenceRequirements) console.log(`  · ${req.requirementId} 需要 locator: ${req.supportsAnyOf.flatMap((g) => g.allOf).join(",")}`);
  }
  console.log("\n证据定位（在公开日志中的可见次数）：");
  for (const loc of truth.locators) {
    if (loc.kind === "log") console.log(`  · ${loc.locatorId} “${loc.keyContent}” → 命中 ${countAll(loc.keyContent)} 行（${loc.fileName ?? "任意"}）`);
  }
  console.log("\n--- oracle（制作侧，仅复核人可见，绝不进 Agent 输入）---");
  console.log(JSON.stringify(oracle, null, 2));
  console.log(`\n--- 复核建议 ---`);
  console.log("1) 逐条确认必需事实能否从上面日志推出，且不超出 allowedClaimDepth；");
  console.log("2) 逐条确认禁用断言是公开材料里的真实诱饵，且不会误伤正确表述；");
  console.log("3) 确认每条证据定位在公开日志中确实可见（命中 0 需说明原因）；");
  console.log("4) 确认题面不含 oracle/答案信息；");
  console.log(`记录：npm run evolve:review:record -- --case ${caseId} --reviewer <你的名字> --decision approved|changes_requested [--notes \"...\"]`);
  return 0;
}

function usage(): void {
  console.log(`用法：
  npm run evolve:review                                   # 列出复核状态
  npm run evolve:review:record -- --case rcb-001 --reviewer <name> --decision approved|changes_requested [--notes "..."] [--revise]
  npm run evolve:review:verify
  npm run evolve:review:packet -- --case rcb-001   # 打印复核包（工单+日志+rubric+oracle）`);
}

const cmd = process.argv[2];
let code: number;
try {
  switch (cmd) {
    case "list": code = cmdList(); break;
    case "record": code = cmdRecord(); break;
    case "packet": code = cmdPacket(); break;
    case "verify": code = cmdVerify(); break;
    default: usage(); code = 2; break;
  }
} catch (err) {
  console.error(`[evolve:review] 错误：${err instanceof Error ? err.message : String(err)}`);
  code = 1;
}
process.exit(code);
