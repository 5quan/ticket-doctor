// 评测 v2 CLI：run / replay / summary（方案 §12 T6）。
//
//   npm run eval:v2 -- run --suite local-1 --engine scripted [--repeat 3] [--cases a,b]
//   npm run eval:v2 -- replay --suite local-1
//   npm run eval:v2 -- summary --suite local-1
//   npm run eval:v2 -- rescore --suite local-1 --case eng-clarify --trial t1 --review review.json
//
// 默认引擎 scripted（确定性工程自测）；pi 必须显式选择且凭据预检通过（§7.1），
// CLI 自身不设置任何 key。旧 `npm run eval` 入口保持不变，结果目录互不影响。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../config/index.ts";
import { materializeEngineeringCases } from "./engcases.ts";
import { runSuite } from "./runner.ts";
import { scoreTrial, type ScorerInput } from "./scorer.ts";
import { applyReview, validateReview } from "./review.ts";
import type { CaseScoreV2, SuiteSummaryV2 } from "./types.ts";

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function usage(): never {
  console.log("用法：cli.ts run|replay|summary ...（见文件头注释）");
  process.exit(2);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v === undefined ? null : v), 2);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const evalRoot = join(PROJECT_ROOT, arg("--eval-root", "data/eval-v2")!);
  const config = loadConfig({ envFile: join(PROJECT_ROOT, ".env") });
  config.projectRoot = PROJECT_ROOT;

  if (command === "run") {
    const suite = arg("--suite", `local-${new Date().toISOString().slice(0, 10)}`)!;
    const engine = (arg("--engine", "scripted") ?? "scripted") as "fake" | "scripted" | "pi";
    const repeat = Number(arg("--repeat", "1"));
    const caseIds = arg("--cases")?.split(",").map((s) => s.trim()).filter(Boolean);
    materializeEngineeringCases(PROJECT_ROOT, evalRoot);
    const summary = await runSuite({
      projectRoot: PROJECT_ROOT,
      evalV2Root: evalRoot,
      suiteRunId: suite,
      engine,
      repeat: Number.isFinite(repeat) && repeat > 0 ? repeat : 1,
      baseConfig: config,
      ...(caseIds && caseIds.length > 0 ? { caseIds } : {}),
    });
    printSummary(summary);
    return;
  }

  if (command === "replay") {
    const suite = arg("--suite");
    if (!suite) usage();
    const runDir = join(evalRoot, "runs", suite);
    if (!existsSync(runDir)) {
      console.error(`[eval:v2] 找不到 suite 运行目录：${runDir}`);
      process.exit(1);
    }
    const results: Array<{ trial: string; consistent: boolean; detail?: string }> = [];
    for (const caseId of readdirSync(runDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      const caseDir = join(runDir, caseId);
      for (const trialId of readdirSync(caseDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
        const trialDir = join(caseDir, trialId);
        const outputsPath = join(trialDir, "outputs.json");
        const scorePath = join(trialDir, "score.json");
        if (!existsSync(outputsPath) || !existsSync(scorePath)) continue;
        const { scorerInput } = JSON.parse(readFileSync(outputsPath, "utf8")) as { scorerInput: ScorerInput };
        const rescored = scoreTrial(scorerInput);
        const saved = JSON.parse(readFileSync(scorePath, "utf8")) as CaseScoreV2;
        const same = stableStringify(rescored) === stableStringify(saved);
        results.push({ trial: `${caseId}/${trialId}`, consistent: same, ...(same ? {} : { detail: "离线重评分与保存结果不一致（评分器或数据被改动）" }) });
      }
    }
    const replayPath = join(runDir, "replay.json");
    const { writeFileSync: wf } = await import("node:fs");
    wf(replayPath, JSON.stringify({ suite, results, allConsistent: results.every((r) => r.consistent) }, null, 2), "utf8");
    for (const r of results) console.log(`${r.consistent ? "✅" : "❌"} ${r.trial}${r.detail ? `  ${r.detail}` : ""}`);
    console.log(`[eval:v2] 重放完成：${replayPath}`);
    if (!results.every((r) => r.consistent)) process.exit(1);
    return;
  }

  if (command === "rescore") {
    const suite = arg("--suite");
    const caseId = arg("--case");
    const trialId = arg("--trial");
    const reviewPath = arg("--review");
    if (!suite || !caseId || !trialId || !reviewPath) usage();
    const trialDir = join(evalRoot, "runs", suite, caseId, trialId);
    const outputsPath = join(trialDir, "outputs.json");
    const scorePath = join(trialDir, "score.json");
    if (!existsSync(outputsPath) || !existsSync(scorePath)) {
      console.error(`[eval:v2] 缺少产物：${outputsPath} / ${scorePath}`);
      process.exit(1);
    }
    const { scorerInput } = JSON.parse(readFileSync(outputsPath, "utf8")) as { scorerInput: ScorerInput };
    const saved = JSON.parse(readFileSync(scorePath, "utf8")) as import("./types.ts").CaseScoreV2;
    const reviewRaw = JSON.parse(readFileSync(reviewPath, "utf8")) as unknown;
    const checked = validateReview(reviewRaw, scorerInput.caseDesc);
    if (!checked.ok) {
      console.error("[eval:v2] review 工件校验失败：");
      for (const e of checked.errors) console.error(`  ${e.path}: ${e.message}`);
      process.exit(1);
    }
    if (checked.value.trialId !== trialId || checked.value.caseId !== caseId) {
      console.error("[eval:v2] review 绑定与 --case/--trial 不一致");
      process.exit(1);
    }
    const reviewed = applyReview(scorerInput, saved, checked.value);
    const outPath = join(trialDir, "score.reviewed.json");
    const { writeFileSync: wf } = await import("node:fs");
    wf(outPath, JSON.stringify(reviewed, null, 2), "utf8");
    console.log(`[eval:v2] 重评分完成：${outPath}`);
    console.log(`  claimSupport=${fmt(reviewed.claimSupport)}  semanticReview=${JSON.stringify(reviewed.semanticReview)}`);
    console.log(`  硬失败不变：${reviewed.hardFailures.length === saved.hardFailures.length ? "是" : "否（异常：review 不得覆盖确定性失败）"}`);
    return;
  }

  if (command === "summary") {
    const suite = arg("--suite");
    if (!suite) usage();
    const summaryPath = join(evalRoot, "runs", suite, "summary.json");
    if (!existsSync(summaryPath)) {
      console.error(`[eval:v2] 找不到 ${summaryPath}`);
      process.exit(1);
    }
    printSummary(JSON.parse(readFileSync(summaryPath, "utf8")) as SuiteSummaryV2);
    return;
  }

  usage();
}

function printSummary(summary: SuiteSummaryV2): void {
  console.log(`[eval:v2] suite=${summary.suiteRunId} engine=${summary.engine} repeat=${summary.repeat}`);
  for (const [key, m] of Object.entries(summary.aggregate)) {
    const val = m.value === null ? `null(${m.unscored} 缺测)` : `${(m.value * 100).toFixed(1)}%`;
    console.log(`  ${key.padEnd(30)} ${m.numerator}/${m.denominator}${m.notApplicable ? ` (NA ${m.notApplicable})` : ""} → ${val}`);
  }
  for (const c of summary.cases) {
    for (const t of c.trials) {
      const hard = t.hardFailures.map((f) => `${f.code}@${f.roundId ?? "-"}${f.stage ? `/${f.stage}` : ""}`);
      console.log(
        `${t.executionSuccess ? "✅" : "❌"} ${c.caseId}/${t.trialId} 召回C1=${fmt(t.recall.C1)} 引用有效=${fmt(t.citationValidity)} ` +
          `补问=${fmt(t.clarificationSuccess)} 反证=${fmt(t.contradictionUpdateSuccess)} 回写=${fmt(t.writebackSuccess)}` +
          (hard.length > 0 ? ` 硬失败=[${hard.join("; ")}]` : ""),
      );
    }
  }
  console.log(`[eval:v2] 产物：data/eval-v2/runs/${summary.suiteRunId}/（summary/manifest/逐 trial trace·outputs·score）`);
}

function fmt(m: { value: number | null; unscored: number } | null | undefined): string {
  if (!m) return "n/a";
  return m.value === null ? `null(${m.unscored})` : `${(m.value * 100).toFixed(0)}%`;
}

main().catch((err) => {
  console.error("[eval:v2] 运行失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
