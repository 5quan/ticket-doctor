// 评测 v2 CLI：run / replay / summary / rescore / push（方案 §12 T6；A2/A3 契约）。
//
//   npm run eval:v2 -- run --suite local-1 --engine scripted [--repeat 3] [--cases a,b] [--audit on] [--gate on]
//   npm run eval:v2 -- replay --suite local-1
//   npm run eval:v2 -- summary --suite local-1
//   npm run eval:v2 -- rescore --suite local-1 --case eng-clarify --trial t1 --review review.json
//   npm run eval:v2 -- push --suite local-1
//
// 默认引擎 scripted（确定性工程自测）；pi 必须显式选择且凭据预检通过（§7.1），
// CLI 自身不设置任何 key。旧 `npm run eval` 入口保持不变，结果目录互不影响。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../config/index.ts";
import { materializeEngineeringCases } from "./engcases.ts";
import { aggregateMetrics, runSuite } from "./runner.ts";
import { SCORER_VERSION, scoreTrial, listJudgableClaims, type ScorerInput } from "./scorer.ts";
import { applyReview, judgedOutputsHash, validateReview } from "./review.ts";
import { createEvalLangfuse, type TrialMetric } from "./langfuse.ts";
import type { CaseDescriptorV2, CaseScoreV2, MetricValue, SuiteSummaryV2 } from "./types.ts";

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function usage(): never {
  console.log("用法：cli.ts run|replay|summary|rescore|push ...（见文件头注释）");
  process.exit(2);
}

function sha256Text(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** 把 MetricValue 映射为 Langfuse 分数（null/unscored 跳过，不冒充 0）。 */
function metricOf(name: string, m: MetricValue | null | undefined): TrialMetric | undefined {
  if (!m || m.value === null || m.value === undefined) return undefined;
  return { name, value: m.value, comment: `${m.numerator}/${m.denominator}（na=${m.notApplicable},unscored=${m.unscored}）` };
}

function buildMetrics(s: CaseScoreV2): TrialMetric[] {
  const out: TrialMetric[] = [{ name: "executionSuccess", value: s.executionSuccess }];
  const add = (name: string, m: MetricValue | null | undefined): void => {
    const v = metricOf(name, m);
    if (v) out.push(v);
  };
  add("recall.A", s.recall.A);
  add("recall.B", s.recall.B);
  add("recall.C1", s.recall.C1);
  add("recall.C2", s.recall.C2);
  add("recall.D", s.recall.D);
  add("citationValidity", s.citationValidity);
  add("claimSupport", s.claimSupport);
  add("requiredFactCoverage", s.requiredFactCoverage);
  add("unsupportedAssertionRate", s.unsupportedAssertionRate);
  add("clarificationSuccess", s.clarificationSuccess);
  add("contradictionUpdateSuccess", s.contradictionUpdateSuccess);
  add("writebackSuccess", s.writebackSuccess);
  out.push({ name: "hardFailureCount", value: s.hardFailures.length, comment: s.hardFailures.map((f) => f.code).join(",") });
  return out;
}

/** 读回本轮题面（公开材料），作为 Langfuse trace 的 input。 */
function loadRoundMessages(evalRoot: string, caseId: string, caseDesc: CaseDescriptorV2): string {
  const dir = join(evalRoot, "public", caseId);
  return caseDesc.rounds
    .map((r) => {
      const f = join(dir, r.messageRef);
      return existsSync(f) ? readFileSync(f, "utf8").trim() : `[${r.roundId}]`;
    })
    .join("\n---\n");
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
    const engineRaw = arg("--engine", "scripted") ?? "scripted";
    // 非法参数显式失败（A3）：不允许静默回退默认引擎。
    if (!["fake", "scripted", "pi"].includes(engineRaw)) {
      console.error(`[eval:v2] 非法 --engine：${engineRaw}（只允许 fake|scripted|pi）`);
      process.exit(2);
    }
    const engine = engineRaw as "fake" | "scripted" | "pi";
    const repeat = Number(arg("--repeat", "1"));
    if (!Number.isInteger(repeat) || repeat < 1) {
      console.error(`[eval:v2] 非法 --repeat：${arg("--repeat")}（必须 ≥1 的整数）`);
      process.exit(2);
    }
    const caseIds = arg("--cases")?.split(",").map((s) => s.trim()).filter(Boolean);
    // 审计开关（OQ-30）：显式控制本轮口径；缺省 off（与 TD_AUDIT_ENABLED 解耦，保证可复现）。
    // audit on + scripted/fake → 确定性审计器（A1）；audit on + pi → 真实审计器（花费 API）。
    const auditOn = arg("--audit", "off") === "on";
    config.diagnosis.audit.enabled = auditOn;
    materializeEngineeringCases(PROJECT_ROOT, evalRoot);
    const summary = await runSuite({
      projectRoot: PROJECT_ROOT,
      evalV2Root: evalRoot,
      suiteRunId: suite,
      engine,
      repeat,
      baseConfig: config,
      ...(caseIds && caseIds.length > 0 ? { caseIds } : {}),
    });
    // CI 门禁（M10/A3）：硬失败 + **完整性**——遗漏 case / 缺 trial 的 suite 不得以零失败通过；
    // 预期阻断（blocked ∈ allowedOutcomes）与准入拒绝（admission_rejected）单独计数，不算失败。
    if (arg("--gate", "off") === "on") {
      const maxHard = Number(arg("--max-hard-failures", "0"));
      const trials = summary.cases.flatMap((c) => c.trials);
      const hard = trials.reduce((n, t) => n + t.hardFailures.length, 0);
      const omissions = summary.caseStatuses.filter((s) => s.phase !== "scored" && s.phase !== "admission_rejected");
      const accountedTrials = summary.caseStatuses.filter((s) => s.phase === "scored" || s.phase === "run_error").reduce((n, s) => n + s.trials, 0);
      console.log(
        `[eval:v2][gate] planned=${summary.planned.trials} trials=${accountedTrials}/${summary.planned.cases} case ` +
          `hardFailures=${hard}（上限 ${maxHard}）blockedExpected=${summary.counts.blockedExpectedTrials} ` +
          `admissionRejected=${summary.counts.admissionRejected} omissions=${omissions.length}`,
      );
      let gateError: string | null = null;
      if (omissions.length > 0 || accountedTrials !== summary.planned.trials) {
        gateError = `存在遗漏：${omissions.map((s) => `${s.caseId}(${s.phase})`).join(", ") || "trial 数不足"}——全部可评案例必须出分或显式预期阻断`;
      } else if (hard > maxHard) {
        gateError = `硬失败 ${hard} > 上限 ${maxHard}`;
      }
      if (gateError) {
        console.error(`[eval:v2][gate] ${gateError}，失败退出`);
        process.exit(1);
      }
    }
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
    // replay 必须能对账口径（A3）：manifest 缺失 = 产物不完整，直接失败。
    if (!existsSync(join(runDir, "manifest.json")) || !existsSync(join(runDir, "summary.json"))) {
      console.error(`[eval:v2] 缺少 manifest.json / summary.json（产物不完整，拒绝重放）：${runDir}`);
      process.exit(1);
    }
    const results: Array<{ trial: string; consistent: boolean; detail?: string }> = [];
    for (const caseId of readdirSync(runDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      const caseDir = join(runDir, caseId);
      for (const trialId of readdirSync(caseDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
        const trialDir = join(caseDir, trialId);
        // 缺任何必要产物必须失败（A3）：静默跳过会让"重放全绿"掩盖产物丢失。
        const missing = ["outputs.json", "score.json", "trace.jsonl"].filter((f) => !existsSync(join(trialDir, f)));
        if (missing.length > 0) {
          results.push({ trial: `${caseId}/${trialId}`, consistent: false, detail: `缺少必要产物：${missing.join(", ")}` });
          continue;
        }
        const { scorerInput } = JSON.parse(readFileSync(join(trialDir, "outputs.json"), "utf8")) as { scorerInput: ScorerInput };
        const rescored = scoreTrial(scorerInput);
        const saved = JSON.parse(readFileSync(join(trialDir, "score.json"), "utf8")) as CaseScoreV2;
        const same = stableStringify(rescored) === stableStringify(saved);
        const versionNote =
          saved.scorerVersion !== SCORER_VERSION ? `（保存 ${saved.scorerVersion} vs 当前 ${SCORER_VERSION}，口径变更须另建 suite）` : "";
        results.push({
          trial: `${caseId}/${trialId}`,
          consistent: same,
          ...(same ? {} : { detail: `离线重评分与保存结果不一致（评分器或数据被改动）${versionNote}` }),
        });
      }
    }
    const replayPath = join(runDir, "replay.json");
    writeFileSync(replayPath, JSON.stringify({ suite, scorerVersion: SCORER_VERSION, results, allConsistent: results.every((r) => r.consistent) }, null, 2), "utf8");
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
    // A2 绑定：suite / case / trial / 输出内容指纹 / 实际判断清单（claimId 基准）。
    const bind = {
      suiteRunId: suite,
      outputsHash: judgedOutputsHash(scorerInput),
      claims: listJudgableClaims(scorerInput.rounds),
    };
    const checked = validateReview(reviewRaw, scorerInput.caseDesc, scorerInput.truth, bind);
    if (!checked.ok) {
      console.error("[eval:v2] review 工件校验失败：");
      for (const e of checked.errors) console.error(`  ${e.path}: ${e.message}`);
      process.exit(1);
    }
    if (checked.value.trialId !== trialId || checked.value.caseId !== caseId) {
      console.error("[eval:v2] review 绑定与 --case/--trial 不一致");
      process.exit(1);
    }
    // 追加产物（A3）：基础评分不可变；review 工件按内容哈希归档，同一工件拒绝重复计分。
    const reviewHash = sha256Text(stableStringify(checked.value));
    const reviewsDir = join(trialDir, "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    const artifactPath = join(reviewsDir, `${reviewHash.slice(0, 16)}.review.json`);
    if (existsSync(artifactPath)) {
      console.error(`[eval:v2] 该 review 已导入过（${artifactPath}），拒绝重复计分。如需覆盖请修改工件（将生成新归档）。`);
      process.exit(1);
    }
    writeFileSync(artifactPath, JSON.stringify(checked.value, null, 2), "utf8");
    const reviewed = applyReview(scorerInput, saved, checked.value);
    const outPath = join(trialDir, "score.reviewed.json");
    writeFileSync(outPath, JSON.stringify(reviewed, null, 2), "utf8");
    console.log(`[eval:v2] 重评分完成：${outPath}（review 归档：${artifactPath}）`);
    console.log(`  claimSupport=${fmt(reviewed.claimSupport)}  覆盖率=${reviewed.semanticReview.coverage?.reviewed ?? 0}/${reviewed.semanticReview.coverage?.total ?? 0}`);
    console.log(`  来源=${reviewed.semanticReview.reviewerType}/${reviewed.semanticReview.reviewer}  semanticReview=${JSON.stringify({ imported: reviewed.semanticReview.imported, provisional: reviewed.semanticReview.provisional })}`);
    console.log(`  硬失败不变：${reviewed.hardFailures.length === saved.hardFailures.length ? "是" : "否（异常：review 不得覆盖确定性失败）"}`);
    return;
  }

  if (command === "push") {
    const suite = arg("--suite");
    if (!suite) usage();
    const runDir = join(evalRoot, "runs", suite);
    if (!existsSync(runDir)) {
      console.error(`[eval:v2] 找不到 suite 运行目录：${runDir}`);
      process.exit(1);
    }
    const obs = config.observability;
    const lf = createEvalLangfuse(
      obs.baseUrl && obs.publicKey && obs.secretKey
        ? {
            baseUrl: obs.baseUrl,
            publicKey: obs.publicKey,
            secretKey: obs.secretKey,
            environment: "eval",
            ...(obs.release ? { release: obs.release } : {}),
          }
        : undefined,
    );
    if (!lf) {
      console.error("[eval:v2] 缺少 LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY");
      process.exit(2);
    }
    const pushed: Record<string, string> = {};
    for (const caseId of readdirSync(runDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      const caseDir = join(runDir, caseId);
      for (const trialId of readdirSync(caseDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
        const dir = join(caseDir, trialId);
        const scorePath = join(dir, "score.json");
        const outputsPath = join(dir, "outputs.json");
        if (!existsSync(scorePath) || !existsSync(outputsPath)) continue;
        // A2：复核后的有效评分优先于基础程序分进入推送；来源显式入 metadata。
        const reviewedPath = join(dir, "score.reviewed.json");
        const usingReviewed = existsSync(reviewedPath);
        const scorePathUsed = usingReviewed ? reviewedPath : scorePath;
        const score = JSON.parse(readFileSync(scorePathUsed, "utf8")) as CaseScoreV2;
        const { scorerInput } = JSON.parse(readFileSync(outputsPath, "utf8")) as { scorerInput: ScorerInput };
        const metrics = buildMetrics(score);
        const traceId = await lf.pushTrial({
          suite,
          caseId,
          trialId,
          engine: score.engine,
          scorerVersion: score.scorerVersion,
          input: loadRoundMessages(evalRoot, caseId, scorerInput.caseDesc),
          output: (score.roundScores ?? []).map((r) => `${r.roundId}:${r.outcome}`).join(", "),
          metadata: {
            familyId: score.familyId,
            split: score.split,
            sourceTier: score.sourceTier,
            executionSuccess: score.executionSuccess,
            hardFailures: score.hardFailures.length,
            scoreSource: usingReviewed
              ? `review:${score.semanticReview.reviewerType ?? "unknown"}/${score.semanticReview.reviewer ?? "unknown"}`
              : "program",
          },
          metrics,
        });
        if (traceId) pushed[`${caseId}/${trialId}`] = traceId;
        console.log(`  ${caseId}/${trialId} → trace ${traceId?.slice(0, 12) ?? "?"}（${metrics.length} 分，${usingReviewed ? "复核分" : "程序分"}）`);
      }
    }
    writeFileSync(join(runDir, "langfuse.json"), JSON.stringify(pushed, null, 2), "utf8");
    await lf.shutdown();
    console.log(`[eval:v2] 已推送 ${Object.keys(pushed).length} 个 trial 到 Langfuse（${obs.baseUrl}）；映射：${join(runDir, "langfuse.json")}`);
    return;
  }

  if (command === "summary") {
    const suite = arg("--suite");
    if (!suite) usage();
    const runDir = join(evalRoot, "runs", suite);
    const summaryPath = join(runDir, "summary.json");
    if (!existsSync(summaryPath)) {
      console.error(`[eval:v2] 找不到 ${summaryPath}`);
      process.exit(1);
    }
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as SuiteSummaryV2;
    // A2：复核结果进入汇总——score.reviewed.json 存在的 trial 以复核分重算聚合。
    let anyReviewed = false;
    const reviewedCases = summary.cases.map((c) => ({
      ...c,
      trials: c.trials.map((t) => {
        const p = join(runDir, c.caseId, t.trialId, "score.reviewed.json");
        if (!existsSync(p)) return t;
        anyReviewed = true;
        return JSON.parse(readFileSync(p, "utf8")) as CaseScoreV2;
      }),
    }));
    printSummary(summary);
    if (anyReviewed) {
      const reviewedSummary: SuiteSummaryV2 = { ...summary, cases: reviewedCases, aggregate: aggregateMetrics(reviewedCases) };
      console.log(`[eval:v2] —— 含人工/模型复核的聚合（基础程序分保持不变，见上）——`);
      for (const [key, m] of Object.entries(reviewedSummary.aggregate)) {
        const val = m.value === null ? `null(${m.unscored} 缺测)` : `${(m.value * 100).toFixed(1)}%`;
        console.log(`  ${key.padEnd(30)} ${m.numerator}/${m.denominator}${m.notApplicable ? ` (NA ${m.notApplicable})` : ""} → ${val}`);
      }
      const reviewedPath = join(runDir, "summary.reviewed.json");
      writeFileSync(reviewedPath, JSON.stringify(reviewedSummary, null, 2), "utf8");
      console.log(`[eval:v2] 复核聚合已写入：${reviewedPath}`);
    }
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
