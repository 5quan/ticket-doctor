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
import { isAbsolute, join } from "node:path";
import { loadConfig } from "../../config/index.ts";
import { materializeEngineeringCases } from "./engcases.ts";
import { evaluateGate } from "./gate.ts";
import { aggregateMetrics, runSuite } from "./runner.ts";
import { SCORER_VERSION, scoreTrial, listJudgableClaims, type ScorerInput } from "./scorer.ts";
import { applyReview, judgedOutputsHash, reviewedBindingValid, validateReview } from "./review.ts";
import { createEvalLangfuse, type TrialMetric } from "./langfuse.ts";
import type { CaseDescriptorV2, CaseScoreV2, MetricValue, SuiteSummaryV2 } from "./types.ts";
import type { SuiteManifestV2 } from "./manifest.ts";

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

const runDirOf = (evalRoot: string, suite: string): string => join(evalRoot, "runs", suite);

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
  // --eval-root 支持绝对路径（测试/跨目录使用）；相对路径按项目根解析。
  const evalRootArg = arg("--eval-root", "data/eval-v2")!;
  const evalRoot = isAbsolute(evalRootArg) ? evalRootArg : join(PROJECT_ROOT, evalRootArg);
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
    // 门禁阈值在运行前校验（交付 1.1 #3）：NaN/负数会让 `hard > NaN` 恒 false 静默放行。
    const maxHardRaw = arg("--max-hard-failures", "0")!;
    const maxHard = Number(maxHardRaw);
    if (!Number.isInteger(maxHard) || maxHard < 0) {
      console.error(`[eval:v2] 非法 --max-hard-failures：${maxHardRaw}（必须 ≥0 的整数）`);
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
    // CI 门禁（M10/A3/交付 1.1）：硬失败 + **完整性**（遗漏 case / 缺 trial）+ **冻结完整性**
    // （材料/项目身份漂移、git unknown）。判定逻辑在 gate.ts（纯函数，可反例测试）。
    if (arg("--gate", "off") === "on") {
      const manifestPath = join(runDirOf(evalRoot, suite), "manifest.json");
      const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as SuiteManifestV2) : null;
      const verdict = evaluateGate({ summary, manifest, maxHard });
      console.log(verdict.line);
      if (!verdict.ok) {
        console.error(`[eval:v2][gate] ${verdict.error}，失败退出`);
        process.exit(1);
      }
    }
    printSummary(summary);
    return;
  }

  if (command === "replay") {
    const suite = arg("--suite");
    if (!suite) usage();
    const runDir = runDirOf(evalRoot, suite);
    if (!existsSync(runDir)) {
      console.error(`[eval:v2] 找不到 suite 运行目录：${runDir}`);
      process.exit(1);
    }
    // replay 必须能对账口径（A3）：manifest/summary 缺失 = 产物不完整，直接失败。
    if (!existsSync(join(runDir, "manifest.json")) || !existsSync(join(runDir, "summary.json"))) {
      console.error(`[eval:v2] 缺少 manifest.json / summary.json（产物不完整，拒绝重放）：${runDir}`);
      process.exit(1);
    }
    // 交付 1.1 #2：按运行前冻结的 case/trial 身份清单对账——目录里有什么就对什么账的
    // 旧做法会让"缺 trial/缺 case/全部缺失"静默通过。
    const trialsManifestPath = join(runDir, "trials.json");
    if (!existsSync(trialsManifestPath)) {
      console.error(`[eval:v2] 缺少 trials.json（冻结身份清单，交付 1.1 起的运行才有）：${trialsManifestPath}——请用当前代码重跑该 suite`);
      process.exit(1);
    }
    const identities = JSON.parse(readFileSync(trialsManifestPath, "utf8")) as {
      schemaVersion: string;
      suiteRunId: string;
      identities: Array<{ caseId: string; trialId: string }>;
    };
    if (identities.schemaVersion !== "prediagnosis-trials-v1" || !Array.isArray(identities.identities)) {
      console.error(`[eval:v2] trials.json 格式非法：${trialsManifestPath}`);
      process.exit(1);
    }
    if (identities.suiteRunId !== suite) {
      console.error(`[eval:v2] trials.json 绑定不匹配：${identities.suiteRunId} ≠ --suite ${suite}`);
      process.exit(1);
    }
    const results: Array<{ trial: string; consistent: boolean; detail?: string }> = [];
    const seen = new Set<string>();
    for (const identity of identities.identities) {
      const { caseId, trialId } = identity;
      const key = `${caseId}/${trialId}`;
      seen.add(key);
      const trialDir = join(runDir, caseId, trialId);
      if (!existsSync(trialDir)) {
        results.push({ trial: key, consistent: false, detail: "冻结身份清单中的 trial 缺少产物目录" });
        continue;
      }
      // 缺任何必要产物必须失败（A3）：静默跳过会让"重放全绿"掩盖产物丢失。
      const missing = ["outputs.json", "score.json", "trace.jsonl"].filter((f) => !existsSync(join(trialDir, f)));
      if (missing.length > 0) {
        results.push({ trial: key, consistent: false, detail: `缺少必要产物：${missing.join(", ")}` });
        continue;
      }
      const { scorerInput } = JSON.parse(readFileSync(join(trialDir, "outputs.json"), "utf8")) as { scorerInput: ScorerInput };
      const rescored = scoreTrial(scorerInput);
      const saved = JSON.parse(readFileSync(join(trialDir, "score.json"), "utf8")) as CaseScoreV2;
      const same = stableStringify(rescored) === stableStringify(saved);
      const versionNote =
        saved.scorerVersion !== SCORER_VERSION ? `（保存 ${saved.scorerVersion} vs 当前 ${SCORER_VERSION}，口径变更须另建 suite）` : "";
      results.push({
        trial: key,
        consistent: same,
        ...(same ? {} : { detail: `离线重评分与保存结果不一致（评分器或数据被改动）${versionNote}` }),
      });
    }
    // 清单外产物目录：混入的旧/未知 trial 也不得放过。
    for (const caseId of readdirSync(runDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      for (const trialId of readdirSync(join(runDir, caseId), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
        if (!seen.has(`${caseId}/${trialId}`)) {
          results.push({ trial: `${caseId}/${trialId}`, consistent: false, detail: "产物目录不在冻结身份清单中（混入的旧运行或未知 trial）" });
        }
      }
    }
    const replayPath = join(runDir, "replay.json");
    writeFileSync(replayPath, JSON.stringify({ suite, scorerVersion: SCORER_VERSION, identitiesChecked: identities.identities.length, results, allConsistent: results.every((r) => r.consistent) }, null, 2), "utf8");
    for (const r of results) console.log(`${r.consistent ? "✅" : "❌"} ${r.trial}${r.detail ? `  ${r.detail}` : ""}`);
    console.log(`[eval:v2] 重放完成（对账 ${identities.identities.length} 个冻结身份）：${replayPath}`);
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
    // 交付 1.1 #6：拒绝混合评分版本——基础分必须出自当前评分器，且可用当前代码逐字段复算。
    if (saved.scorerVersion !== SCORER_VERSION) {
      console.error(`[eval:v2] score.json 版本 ${saved.scorerVersion} ≠ 当前评分器 ${SCORER_VERSION}：拒绝混合口径重评分。请用当前代码重跑 suite（口径变更须另建结果目录）。`);
      process.exit(1);
    }
    const recomputed = scoreTrial(scorerInput);
    if (stableStringify(recomputed) !== stableStringify(saved)) {
      console.error("[eval:v2] 基础评分无法用当前评分器逐字段复算（评分器或数据被改动）：拒绝在其上叠加复核分。");
      process.exit(1);
    }
    const reviewRaw = JSON.parse(readFileSync(reviewPath, "utf8")) as unknown;
    // A2 绑定：suite / case / trial / 输出内容指纹 / 实际判断清单（claimId 基准）/ 回写事实。
    const bind = {
      suiteRunId: suite,
      outputsHash: judgedOutputsHash(scorerInput),
      claims: listJudgableClaims(scorerInput.rounds),
      writebackPresentByRound: Object.fromEntries(scorerInput.rounds.map((r) => [r.roundId, !!r.writebackText])),
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
    // 交付 1.1 #6：复核分携带绑定元数据（outputsHash/reviewHash/评分版本），消费前可核验。
    reviewed.reviewMeta = {
      outputsHash: bind.outputsHash,
      reviewHash,
      reviewArtifact: artifactPath,
      baseScorerVersion: saved.scorerVersion,
      rescoredAt: Date.now(),
    };
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
        const { scorerInput } = JSON.parse(readFileSync(outputsPath, "utf8")) as { scorerInput: ScorerInput };
        // A2/#6：复核分优先于基础程序分进入推送，但必须通过绑定核验（outputsHash 一致）；
        // 失效则回退程序分并告警。来源显式入 metadata。
        const reviewedPath = join(dir, "score.reviewed.json");
        let score: CaseScoreV2 | null = null;
        let scoreSource = "program";
        if (existsSync(reviewedPath)) {
          const reviewed = JSON.parse(readFileSync(reviewedPath, "utf8")) as CaseScoreV2;
          if (reviewedBindingValid(reviewed, scorerInput)) {
            score = reviewed;
            scoreSource = `review:${reviewed.semanticReview.reviewerType ?? "unknown"}/${reviewed.semanticReview.reviewer ?? "unknown"}`;
          } else {
            console.warn(`[eval:v2] ${caseId}/${trialId} 复核分绑定失效（outputsHash 不符），回退程序分`);
          }
        }
        if (!score) score = JSON.parse(readFileSync(scorePath, "utf8")) as CaseScoreV2;
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
            scoreSource,
          },
          metrics,
        });
        if (traceId) pushed[`${caseId}/${trialId}`] = traceId;
        console.log(`  ${caseId}/${trialId} → trace ${traceId?.slice(0, 12) ?? "?"}（${metrics.length} 分，${scoreSource === "program" ? "程序分" : "复核分"}）`);
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
    // A2/#6：复核结果进入汇总——score.reviewed.json 存在**且绑定核验通过**时以复核分重算聚合；
    // 绑定失效（trial 重跑、outputsHash 不符）回退程序分并告警。
    let anyReviewed = false;
    const reviewedCases = summary.cases.map((c) => ({
      ...c,
      trials: c.trials.map((t) => {
        const p = join(runDir, c.caseId, t.trialId, "score.reviewed.json");
        if (!existsSync(p)) return t;
        const reviewed = JSON.parse(readFileSync(p, "utf8")) as CaseScoreV2;
        const outputsPath = join(runDir, c.caseId, t.trialId, "outputs.json");
        if (!existsSync(outputsPath)) return t;
        const { scorerInput } = JSON.parse(readFileSync(outputsPath, "utf8")) as { scorerInput: ScorerInput };
        if (!reviewedBindingValid(reviewed, scorerInput)) {
          console.warn(`[eval:v2] ${c.caseId}/${t.trialId} 复核分绑定失效（outputsHash 与当前输出不符），回退程序分`);
          return t;
        }
        anyReviewed = true;
        return reviewed;
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
