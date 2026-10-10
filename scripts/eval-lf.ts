#!/usr/bin/env node
// Langfuse 原生离线评测 CLI（plan §8）：
//   preflight  环境与部署能力检查（不发评测请求）
//   seed       预览/同步工程数据集；登记基线/候选提示词
//   run        在指定 Dataset 版本 + 提示词版本上运行一次原生实验
//   verify     从服务器读回实验、案例过程与分数
//
// 本地文件只用于材料、调试与导出；正式实验与分数以 Langfuse 为准。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/index.ts";
import { createLfClient, lfConfigOf, preflight, printPreflight, type LfClientConfig } from "../src/eval/lf/client.ts";
import { buildSmokePayloads, seedSmokeDataset, SMOKE_DATASET, SMOKE_PROTOCOL } from "../src/eval/lf/seed.ts";
import { DIAGNOSIS_PROMPT_NAME, ensureBaselinePrompt, getPromptVersion, registerCandidatePrompt } from "../src/eval/lf/prompt.ts";
import { makeTicketDoctorTask } from "../src/eval/lf/task.ts";
import { smokeEvaluators } from "../src/eval/lf/evaluators.ts";
import { setupEvalOtel } from "../src/eval/lf/otel.ts";
import { createLangfuseRecorder } from "../src/observability/langfuse.ts";
import { printVerify, verifyExperiment } from "../src/eval/lf/verify.ts";
import { addTracesToAnnotationQueue, ensureAnnotationSetup, recordQueueAnnotation } from "../src/eval/lf/review.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EVAL_ROOT_DEFAULT = join(ROOT, "data", "eval-v2");

function arg(name: string, fallback: string): string;
function arg(name: string): string | undefined;
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function numArg(name: string, fallback: number): number {
  const v = arg(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} 必须是数字：${v}`);
  return n;
}
function evalRoot(): string {
  const raw = arg("eval-root") ?? process.env.TD_EVAL_ROOT ?? EVAL_ROOT_DEFAULT;
  return isAbsolute(raw) ? raw : resolve(ROOT, raw);
}
function gitRev(projectRoot: string): string {
  try {
    const rev = execFileSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", projectRoot, "status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    return dirty ? `${rev}-dirty` : rev;
  } catch {
    return "unknown";
  }
}
function requireLf(config: ReturnType<typeof loadConfig>): LfClientConfig {
  const cfg = lfConfigOf(config.observability);
  if (!cfg) throw new Error("缺少 Langfuse 配置：需要 LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY（只记录存在状态，不打印值）");
  return cfg;
}
function manifestPath(name: string): string {
  const outDir = arg("out") ?? join(ROOT, "data", "lf-eval");
  mkdirSync(outDir, { recursive: true });
  return join(outDir, `${name.replace(/[^\w.-]+/g, "_")}.manifest.json`);
}
function usage(): void {
  console.log(`用法：
  eval:lf:preflight
  eval:lf:seed [--sync] [--json] [--eval-root <dir>] [--register-baseline] [--register-candidate <file>]
  eval:lf:run --prompt-version <n> [--dataset <name>] [--dataset-version <iso>] [--experiment <name>]
             [--run-name <name>] [--concurrency <n>] [--engine pi|fake|scripted] [--audit on|off]
             [--max-cases <n>] [--max-rounds <n>] [--budget <说明>] [--eval-root <dir>] [--out <dir>] [--dry-run]
  eval:lf:verify [--manifest <file>] [--dataset <name>] [--dataset-id <id>] [--run-name <name>] [--expect-trace <id>...]
  eval:lf:review [--manifest <file>] [--trace <id>...] [--queue <name>] [--score-config <name>]
                [--annotate-trace <id> --value 0|1|2 --comment <理由>]

  --engine pi（真实模型）必须显式提供 --budget（运行预算说明），否则拒绝发起真实调用。`);
}

async function cmdPreflight(): Promise<number> {
  const config = loadConfig();
  const cfg = lfConfigOf(config.observability);
  if (!cfg) {
    console.error("❌ 缺少 Langfuse 配置（LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY）");
    return 2;
  }
  const report = await preflight(cfg);
  printPreflight(report);
  return report.auth && report.datasetApi && report.scoresPost && report.observationsV2Read && report.experimentsRead ? 0 : 1;
}

async function cmdSeed(): Promise<number> {
  const config = loadConfig();
  const root = evalRoot();
  const sync = flag("sync");
  const asJson = flag("json");

  const payloads = buildSmokePayloads(config.projectRoot, root);
  if (asJson) {
    console.log(JSON.stringify(payloads.map((p) => ({
      caseId: p.metadata.caseId,
      scenario: p.metadata.scenario,
      input: p.input,
      rounds: p.expectedOutput.rounds.map((r) => r.roundId),
      materials: p.metadata.materials,
      caseHash: p.metadata.caseHash,
    })), null, 2));
  } else {
    console.log(`[eval:lf] 数据集 ${SMOKE_DATASET}（协议 ${SMOKE_PROTOCOL}）——${payloads.length} 条合成案例草稿`);
    for (const p of payloads) {
      console.log(`  · ${p.metadata.caseId} [${p.metadata.scenario}] 轮次=${p.expectedOutput.rounds.map((r) => r.roundId).join("/")} 材料=${p.metadata.materials.map((m) => `${m.repoId}@${m.expectedSha?.slice(0, 8) ?? "-"}`).join(",")} hash=${p.metadata.caseHash.slice(0, 12)}`);
      console.log(`      问：${String((p.input as { question?: string }).question ?? "").replace(/\n/g, " ").slice(0, 80)}`);
    }
    console.log("[eval:lf] 以上为 synthetic 草稿；加 --sync 才写入 Langfuse。结果不代表真实工单质量。");
  }

  const wantsPrompt = flag("register-baseline") || arg("register-candidate") !== undefined;
  const needsSync = sync || wantsPrompt;
  if (!needsSync) return 0;

  const lf = createLfClient(requireLf(config));
  if (sync) {
    const result = await seedSmokeDataset(lf, config.projectRoot, root, true);
    const failed = result.items.filter((i) => !i.ok);
    console.log(`[eval:lf] dataset=${result.datasetName} id=${result.datasetId ?? "?"} 写入 ${result.items.length - failed.length}/${result.items.length}`);
    for (const f of failed) console.error(`  ❌ ${f.caseId}: ${f.error}`);
    if (failed.length > 0) return 1;
  }
  if (flag("register-baseline")) {
    const v = await ensureBaselinePrompt(lf);
    console.log(`[eval:lf] 基线提示词 ${v.name} v${v.version} hash=${v.hash.slice(0, 12)}`);
  }
  const candidate = arg("register-candidate");
  if (candidate) {
    const file = isAbsolute(candidate) ? candidate : resolve(ROOT, candidate);
    const v = await registerCandidatePrompt(lf, file);
    console.log(`[eval:lf] 候选提示词 ${v.name} v${v.version} hash=${v.hash.slice(0, 12)}（来源 ${candidate}）`);
  }
  return 0;
}

async function cmdRun(): Promise<number> {
  const config = loadConfig();
  const root = evalRoot();
  const engine = (arg("engine", "pi") as "pi" | "fake" | "scripted");
  const datasetName = arg("dataset", SMOKE_DATASET)!;
  const datasetVersion = arg("dataset-version");
  const experimentName = arg("experiment", engine === "pi" ? "ticket-doctor-smoke" : `ticket-doctor-smoke-${engine}`);
  const runName = arg("run-name");
  const concurrency = Math.max(1, numArg("concurrency", 1));
  const maxCases = numArg("max-cases", 5);
  const maxRounds = numArg("max-rounds", 3);
  const budget = arg("budget");
  const casesArg = arg("cases");
  const auditEnabled = arg("audit", "off") === "on";
  const promptName = arg("prompt", DIAGNOSIS_PROMPT_NAME)!;
  const promptVersionArg = arg("prompt-version");
  const dryRun = flag("dry-run");

  // 预算闸门（plan §2）：真实模型调用前必须有明确预算，缺失即拒绝。
  if (engine === "pi" && !budget) {
    console.error("❌ --engine pi 必须提供 --budget（例如 --budget \"≤5 USD / 5 案例 / 1 并发\"）。预算缺失时先跑 --engine scripted/fake 完成代码与案例验证。");
    return 2;
  }
  if (engine === "pi" && !config.diagnosis.apiKey) {
    console.error("❌ pi 引擎缺少 provider API key（检查 .env 的 DEEPSEEK_API_KEY 等）。");
    return 2;
  }

  const lf = createLfClient(requireLf(config));
  const dataset = await lf.dataset.get(datasetName, datasetVersion ? { version: datasetVersion } : undefined);
  const allItems = dataset.items as Array<{ input?: unknown; metadata?: Record<string, unknown> }>;
  const selected = casesArg
    ? allItems.filter((i) => casesArg.split(",").map((s) => s.trim()).includes(String(i.metadata?.caseId)))
    : allItems;
  if (casesArg && selected.length === 0) {
    console.error(`❌ --cases ${casesArg} 未命中任何 item（可选：${allItems.map((i) => i.metadata?.caseId).join(", ")}）`);
    return 2;
  }
  const items = selected;
  console.log(`[eval:lf] dataset=${datasetName} version=${datasetVersion ?? dataset.version ?? "latest"} items=${items.length}${casesArg ? `（--cases ${casesArg}）` : ""} prompt=${promptName}@${promptVersionArg ?? "baseline"}`);

  // 成本守卫：数据集规模 / 单案例轮数不得超过预算假设（plan §8 默认并发 1、每案例 ≤3 轮）。
  if (items.length > maxCases) {
    console.error(`❌ 数据集有 ${items.length} 条 > --max-cases ${maxCases}；拒绝运行（请提高预算假设或缩小数据集）。`);
    return 2;
  }
  const overRounds = items.filter((i) => Number(i.metadata?.maxRounds ?? 0) > maxRounds);
  if (overRounds.length > 0) {
    console.error(`❌ 以下案例轮数 > --max-rounds ${maxRounds}：${overRounds.map((i) => i.metadata?.caseId).join(", ")}`);
    return 2;
  }
  if (dryRun) {
    console.log("[eval:lf] --dry-run：仅校验预算与材料，不发起实验。");
    return 0;
  }

  const prompt = promptVersionArg ? await getPromptVersion(lf, Number(promptVersionArg)) : await ensureBaselinePrompt(lf);
  if (prompt.name !== promptName) {
    console.error(`❌ 提示词名称不一致：--prompt ${promptName} vs 实际 ${prompt.name}`);
    return 2;
  }

  const baseConfig = {
    ...config,
    diagnosis: { ...config.diagnosis, audit: { ...config.diagnosis.audit, enabled: auditEnabled } },
  };
  const observability = { ...config.observability, enabled: true, environment: "eval" };
  const outDir = arg("out") ?? join(ROOT, "data", "lf-eval", "runs");
  const fingerprint = {
    protocolVersion: SMOKE_PROTOCOL,
    gitRev: gitRev(config.projectRoot),
    engine,
    provider: config.diagnosis.provider,
    model: config.diagnosis.modelId,
    audit: auditEnabled,
    maxToolCalls: config.diagnosis.maxToolCalls,
    maxModelTurns: config.diagnosis.maxModelTurns,
    concurrency,
    budget: budget ?? null,
    dataset: { name: datasetName, version: datasetVersion ?? dataset.version ?? "latest", items: items.length },
    prompt: { name: prompt.name, version: prompt.version, hash: prompt.hash },
    evalRoot: root,
  };
  const startedAt = new Date().toISOString();
  console.log(`[eval:lf] 实验 ${experimentName}${runName ? ` run=${runName}` : ""} engine=${engine} 并发=${concurrency} 审计=${auditEnabled ? "on" : "off"}`);

  const evalOtel = setupEvalOtel(requireLf(config), "eval");
  let recorder: ReturnType<typeof createLangfuseRecorder>;
  let result;
  try {
    // 业务 observation 借用实验 provider，避免创建第二套 processor/导出队列。
    recorder = createLangfuseRecorder(observability, undefined, {
      joinActiveContext: true,
      prompt: { name: prompt.name, version: prompt.version },
      tracerProvider: evalOtel.provider,
    });
    const task = makeTicketDoctorTask({
      projectRoot: config.projectRoot,
      evalRoot: root,
      baseConfig,
      engine,
      prompt,
      outDir,
      ...(recorder ? { recorder } : {}),
    });
    result = await dataset.runExperiment({
      name: experimentName,
      ...(runName ? { runName } : {}),
      description: "ticket-doctor 合成工程案例预诊断实验（synthetic；仅验证评测闭环，不代表真实工单质量）",
      task,
      evaluators: smokeEvaluators,
      maxConcurrency: concurrency,
      metadata: fingerprint,
      // --cases 预算控制：覆盖 runExperiment 内闭包的 items（仍为 DatasetItem，id 保留→照常关联 dataset run）。
      ...(casesArg ? { data: items } : {}),
    } as Parameters<typeof dataset.runExperiment>[0]);
  } finally {
    // runExperiment 成功时已 flush scores；异常也须处理客户端队列。
    // recorder 先结束残留节点，实验拥有者随后发送 traces 并释放自己的基础设施。
    try {
      await lf.shutdown().catch((err: unknown) => {
        console.warn(`[eval:lf] 分数队列关闭失败：${err instanceof Error ? err.message : String(err)}`);
      });
    } finally {
      try {
        await recorder?.shutdown();
      } finally {
        await evalOtel.shutdown();
      }
    }
  }

  const traceIds = result.itemResults.map((r) => r.traceId).filter((t): t is string => typeof t === "string");
  const manifest = {
    experimentName,
    runName: result.runName,
    datasetName,
    datasetId: (dataset as { id?: string }).id ?? null,
    datasetVersion: datasetVersion ?? dataset.version ?? null,
    resolveDatasetVersion: (dataset as { version?: string }).version ?? null,
    datasetRunId: result.datasetRunId ?? null,
    datasetRunUrl: result.datasetRunUrl ?? null,
    prompt: { name: prompt.name, version: prompt.version, hash: prompt.hash },
    engine,
    audit: auditEnabled,
    concurrency,
    budget: budget ?? null,
    fingerprint,
    startedAt,
    finishedAt: new Date().toISOString(),
    traceIds,
    items: result.itemResults.map((r) => ({
      caseId: (r.item.metadata as { caseId?: string } | undefined)?.caseId ?? null,
      traceId: r.traceId ?? null,
      prompt: (r.output as { prompt?: unknown } | undefined)?.prompt ?? null,
      evaluations: r.evaluations.map((e) => ({ name: e.name, value: e.value, comment: e.comment ?? null })),
    })),
  };
  const path = manifestPath(runName ?? experimentName);
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf8");

  console.log(await result.format());
  console.log(`[eval:lf] manifest → ${path}`);
  if (manifest.datasetRunUrl) console.log(`[eval:lf] 实验对比页 → ${manifest.datasetRunUrl}`);
  console.log(`[eval:lf] 读回：npm run eval:lf:verify -- --manifest ${path}`);
  return 0;
}

async function cmdVerify(): Promise<number> {
  const config = loadConfig();
  const cfg = requireLf(config);
  const manifestArg = arg("manifest");
  let datasetId = arg("dataset-id") ?? null;
  let runName = arg("run-name") ?? null;
  let expectTraces: string[] = [];
  let expectedPrompt: { name: string; version: number } | undefined;
  const manifestFile = manifestArg ? (isAbsolute(manifestArg) ? manifestArg : resolve(ROOT, manifestArg)) : manifestPath(arg("experiment", "ticket-doctor-smoke"));
  try {
    const m = JSON.parse(readFileSync(manifestFile, "utf8")) as { datasetId?: string | null; runName?: string; traceIds?: string[]; prompt?: { name?: string; version?: number } };
    datasetId = datasetId ?? m.datasetId ?? null;
    runName = runName ?? m.runName ?? null;
    expectTraces = m.traceIds ?? [];
    if (m.prompt?.name && typeof m.prompt.version === "number") expectedPrompt = { name: m.prompt.name, version: m.prompt.version };
  } catch (err) {
    if (manifestArg) {
      console.error(`❌ 无法读取 manifest ${manifestFile}：${err instanceof Error ? err.message : err}`);
      return 2;
    }
  }
  if (!datasetId && !runName) {
    console.error("需要 --dataset-id 与 --run-name（或 --manifest <file>）。");
    return 2;
  }
  const report = await verifyExperiment(cfg, { datasetId: datasetId ?? "", runName: runName ?? "", expectTraces, ...(expectedPrompt ? { expectedPrompt } : {}) });
  const ok = printVerify(report);
  return ok ? 0 : 1;
}

async function cmdReview(): Promise<number> {
  const config = loadConfig();
  const lf = createLfClient(requireLf(config));
  let traceIds: string[] = [];
  const manifestArg = arg("manifest");
  const manifestFile = manifestArg ? (isAbsolute(manifestArg) ? manifestArg : resolve(ROOT, manifestArg)) : manifestPath(arg("experiment", "ticket-doctor-smoke"));
  if (manifestArg) {
    try {
      const m = JSON.parse(readFileSync(manifestFile, "utf8")) as { traceIds?: string[] };
      traceIds = m.traceIds ?? [];
    } catch {
      console.error(`❌ 无法读取 manifest ${manifestFile}`);
      return 2;
    }
  }
  // --trace 可逗号分隔或重复传（这里取全部 --trace 值）。
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--trace" && process.argv[i + 1]) traceIds.push(...process.argv[i + 1]!.split(",").map((s) => s.trim()).filter(Boolean));
  }
  traceIds = [...new Set(traceIds)];
  if (traceIds.length === 0 && !arg("annotate-trace")) {
    console.error("需要 --manifest <file> 或 --trace <id>（没有可加入标注队列的 trace）。");
    return 2;
  }
  const setup = await ensureAnnotationSetup(lf, arg("score-config"), arg("queue"));

  // 标注模式：--annotate-trace <id> --value <0|1|2> --comment <理由>
  const annotateTrace = arg("annotate-trace");
  if (annotateTrace) {
    const value = Number(arg("value"));
    if (![0, 1, 2].includes(value)) {
      console.error("❌ --value 必须是 0/1/2（plan §7 人工评分档位）。");
      return 2;
    }
    const comment = arg("comment") ?? "";
    const recorded = await recordQueueAnnotation(lf, {
      queueId: setup.queueId,
      scoreConfigId: setup.scoreConfigId,
      traceId: annotateTrace,
      value,
      comment,
      ...(arg("score-config") ? { scoreConfigName: arg("score-config")! } : {}),
    });
    console.log(`[eval:lf] 标注已记录：scoreId=${recorded.scoreId} trace=${annotateTrace.slice(0, 12)} value=${value}`);
    console.log(`[eval:lf] 队列项 ${recorded.queueItemId ?? "?"} 标记完成：${recorded.queueCompleted ? "是" : "否（未在队列中找到该 trace）"}`);
    for (const r of recorded.readback) console.log(`[eval:lf] 读回：${r.name}=${r.value}（来源 ${r.source ?? "?"}；${r.comment ?? "无理由"}）`);
    if (recorded.readback.length === 0) console.log("[eval:lf] v1 scores 未返回，请用 eval:lf:verify 或 UI 核对（v3/scores 不含 comment）。");
    return 0;
  }

  const added = await addTracesToAnnotationQueue(lf, setup.queueId, traceIds);
  console.log(`[eval:lf] 评分配置 ${arg("score-config", "prediagnosis_quality")} id=${setup.scoreConfigId}${setup.scoreConfigCreated ? "（新建）" : "（已存在）"}`);
  console.log(`[eval:lf] 标注队列 id=${setup.queueId}${setup.queueCreated ? "（新建）" : "（已存在）"}：新增 ${added.added.length}，跳过已存在 ${added.skipped.length}`);
  console.log(`[eval:lf] 复核入口：${requireLf(config).baseUrl.replace(/\/$/, "")}/project/ticket-doctor/annotation-queues/${setup.queueId}`);
  return 0;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd || ["help", "-h", "--help"].includes(cmd)) {
    usage();
    process.exit(0);
  }
  let code: number;
  switch (cmd) {
    case "preflight": code = await cmdPreflight(); break;
    case "seed": code = await cmdSeed(); break;
    case "run": code = await cmdRun(); break;
    case "verify": code = await cmdVerify(); break;
    case "review": code = await cmdReview(); break;
    default:
      console.error(`未知子命令：${cmd}`);
      usage();
      code = 2;
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(`[eval:lf] 失败：${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
