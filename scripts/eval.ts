#!/usr/bin/env node
// 离线评测 CLI（MVP）：复用正式链路，逐 case 跑 N 次，保存三层结果 + 打分 + 版本指纹。
//
// 用法：
//   npm run eval -- --scenario demo-checkout [--runs 3] [--engine fake|pi] [--audit on|off]
// 输出：data/evals/<scenario>.jsonl（追加；每次运行带 header 指纹）
//
// 范围：只测诊断核心（见 src/eval/runner.ts 文件头）；不代表生产持久化/投递链路已验证。
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/index.ts";
import { buildSystemPrompt } from "../src/agent/pi-engine.ts";
import { loadBenchmark, resolveMaterialDirs } from "../src/eval/benchmark.ts";
import { buildFingerprint } from "../src/eval/fingerprint.ts";
import { runCase } from "../src/eval/runner.ts";
import { scoreCase } from "../src/eval/scorer.ts";
import { appendJsonl, buildRecord, loadReviews, summarize, writeRunHeader, type EvalRecord } from "../src/eval/report.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const scenarioArg = arg("scenario");
if (!scenarioArg) {
  console.error("用法：npm run eval -- --scenario <name|path> [--runs N] [--engine fake|pi] [--audit on|off]");
  process.exit(2);
}
const scenarioDir = isAbsolute(scenarioArg) ? scenarioArg : resolve(ROOT, scenarioArg.includes("/") ? scenarioArg : join("fixtures", "evals", scenarioArg));
const runs = Math.max(1, Number(arg("runs", "1")));
const benchmark = loadBenchmark(scenarioDir);
const engineName = (arg("engine", benchmark.engine ?? "fake") as "fake" | "pi") ?? "fake";
const auditEnabled = arg("audit", "off") === "on";
const { logsDir, repoDir } = resolveMaterialDirs(benchmark, scenarioDir, ROOT);
const repoId = benchmark.repoId ?? "app";

const rulesText = benchmark.rulesFile ? readFileSync(join(scenarioDir, benchmark.rulesFile), "utf8") : null;
const systemPrompt = buildSystemPrompt(rulesText ?? undefined);

const config = loadConfig();
config.diagnosis.engine = engineName;
config.diagnosis.audit.enabled = auditEnabled;
config.sources.logDir = logsDir;
config.sources.repos = [{ repoId, dir: repoDir, rev: benchmark.repoRev ?? "HEAD" }];
config.sources.allowedRepos = [repoId];

const fingerprint = buildFingerprint({
  projectRoot: ROOT,
  scenario: benchmark.scenario,
  engine: engineName,
  provider: config.diagnosis.provider,
  model: engineName === "pi" ? config.diagnosis.modelId : "fake",
  systemPrompt,
  rulesText,
  logsDir,
  repoDir,
  config,
  auditEnabled,
});

const reviews = loadReviews(scenarioDir);
const records: EvalRecord[] = [];

console.log(`[eval] scenario=${benchmark.scenario} engine=${engineName} audit=${auditEnabled ? "on" : "off"} runs=${runs}`);
console.log(`[eval] git=${fingerprint.gitRev}${fingerprint.gitDirty ? "+dirty" : ""} model=${fingerprint.model} prompt=${fingerprint.systemPromptHash} rules=${fingerprint.rulesHash ?? "-"} material=${fingerprint.materialHash} scorer=${fingerprint.scorerVersion}`);

for (let runIndex = 0; runIndex < runs; runIndex++) {
  for (const c of benchmark.cases) {
    const result = await runCase({ config, engineName, systemPrompt, c, runIndex });
    const score = result.report
      ? scoreCase(c, {
          report: result.report,
          evidence: result.evidence,
          scope: result.scope,
          validationIssues: result.validationIssues,
          review: reviews.get(c.id),
        })
      : null;
    const record = buildRecord(fingerprint, result, score ?? {
      scorerVersion: fingerprint.scorerVersion,
      gradeMode: "material-only",
      calibrated: false,
      evidenceRecall: null,
      evidencePrecision: null,
      goldTotal: c.gold.evidence.length,
      goldMatched: 0,
      citedTotal: 0,
      citedDistractor: 0,
      semanticCorrect: "unscored",
      reviewStatus: "unreviewed",
      citationInvalid: 0,
      note: result.error ?? "未产出报告",
    });
    records.push(record);
    const tag = result.ok ? (result.kind ?? "?") : `FAIL(${result.error})`;
    const r = score?.evidenceRecall;
    const p = score?.evidencePrecision;
    console.log(
      `  ${c.id} #${runIndex} ${tag} recall=${r === null || r === undefined ? "-" : r.toFixed(2)} precision=${p === null || p === undefined ? "-" : p.toFixed(2)} tools=${result.metrics.toolCalls} turns=${result.metrics.modelTurns} audits=${result.metrics.auditRounds} tokens=${result.metrics.totalTokens} ${result.metrics.durationMs}ms`,
    );
  }
}

const outPath = join(ROOT, "data", "evals", `${benchmark.scenario}.jsonl`);
writeRunHeader(outPath, fingerprint);
appendJsonl(outPath, records);
const summary = summarize(records);
console.log(`[eval] 汇总：runs=${summary.runs} ok=${summary.ok} failed=${summary.failed} meanRecall=${summary.meanRecall ?? "unscored"} meanPrecision=${summary.meanPrecision ?? "unscored"}`);
console.log(`[eval] 结果写入 ${outPath}（追加；不同 scorerVersion / 变量禁止同表比较）`);
