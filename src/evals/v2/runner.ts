// 多轮运行器 v2（方案 §7）：每条调查轨迹一次新 Store → routeInbound 正式入站 → claim →
// executeRun（生产编排，含 RunSession/证据两阶段/finalize）→ processDeliveriesOnce + 捕获 sender
// → 持久化导出 trace → 控制器按脚本发布下一轮。
//
// 边界：
//   * 不碰飞书/调度/真实发送；回写语义由 CaptureSender 记录（§7.1）。
//   * 每轮材料视图（logDir）独立配置；未来轮材料在轮前不在工具范围（隔离由 isolation.ts 预检）。
//   * 真实模型（pi）必须显式选择且配置预检通过；默认 fake/scripted（§7.1）。
//   * 同一 trial 各轮共享 investigation/会话/历史证据；不同 trial/case 全新状态（§7.2）。
//   * 补充材料按 scheduled 轮次发布，不因模型问错而挽救首轮分数（§7.2.4）。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "../../config/index.ts";
import { buildAuditor, buildEngine } from "../../agent/factory.ts";
import { FakeDiagnosisEngine } from "../../agent/fake-engine.ts";
import { FakeEvidenceAuditor } from "../../agent/fake-auditor.ts";
import { buildSystemPrompt } from "../../agent/pi-engine.ts";
import { AUDIT_SYSTEM_PROMPT } from "../../agent/pi-auditor.ts";
import type { DiagnosisEngine, EngineResult } from "../../agent/types.ts";
import type { EvidenceAuditor } from "../../agent/audit-types.ts";
import { FileLogSource } from "../../sources/logs.ts";
import { openDatabase, migrate } from "../../storage/db.ts";
import { Store } from "../../storage/store.ts";
import { StoreEvidenceResolver } from "../../evidence/store-resolver.ts";
import { processDeliveriesOnce } from "../../delivery/delivery.ts";
import { executeRun } from "../../diagnosis/orchestrator.ts";
import { routeInbound } from "../../intake/router.ts";
import { SESSION_MARKER_PREFIX } from "../../domain/session.ts";
import type { InboundMessage } from "../../domain/types.ts";
import { loadCatalog, loadCase, loadRoundMessage, loadTruth, type CatalogEntry } from "./load.ts";
import { checkIsolation, isolationSummary } from "./isolation.ts";
import { validatePairing } from "./schema.ts";
import { scanResolvedTreeForIsolation } from "./isolation.ts";
import { CaptureSender } from "./capture.ts";
import { buildSuiteManifest, materialDrift, projectIdentity, projectIdentityDrift, snapshotCaseMaterials, type ManifestCase } from "./manifest.ts";
import { exportAuditEvents, exportEvidenceEvents, exportToolEvents, exportUsageEvent, TraceRecorder } from "./trace.ts";
import {
  RecordingFileLogSource,
  layerBByInvestigation,
  layerBatchesByCall,
  layerC1,
  citedEvidence,
  computeRequirementSatisfaction,
  type CallEvidence,
  type SourceCallRecord,
} from "./visibility.ts";
import { CapturingEngine, ScriptedAuditor, ScriptedDiagnosisEngine, type ScriptStep, type ScriptedAuditStep } from "./scripted-engine.ts";
import { SCORER_VERSION, scoreTrial, type CitationRecord, type RoundScoreInput, type ScorerInput } from "./scorer.ts";
import type {
  CaseDescriptorV2,
  CaseScoreV2,
  CaseStatus,
  EngineCallRecord,
  MetricValue,
  RoundArtifacts,
  RoundOutcomeKind,
  SuiteSummaryV2,
  TrialArtifacts,
  TruthFileV2,
} from "./types.ts";

const MIGRATIONS = "migrations";
const DELIVERY_DRAIN_CAP = 20;

export interface RunSuiteOptions {
  projectRoot: string;
  evalV2Root: string;
  suiteRunId: string;
  engine: "fake" | "scripted" | "pi";
  repeat: number;
  baseConfig: AppConfig;
  /** 只跑指定 case（缺省全量）。 */
  caseIds?: string[];
}

function outcomeOf(result: EngineResult | undefined): RoundOutcomeKind {
  if (!result) return "error";
  if (result.kind === "report") return "report";
  return result.reason === "clarify" ? "clarify" : "chat";
}

function sha256Text(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

interface LoadedCase {
  entry: CatalogEntry;
  caseDesc: CaseDescriptorV2;
  truth: TruthFileV2;
  caseDir: string;
  privateDir: string;
  steps: ScriptStep[];
  auditSteps: ScriptedAuditStep[];
  isolation: { ok: boolean; counts: Record<string, number> };
  violationText?: string;
}

function loadLoadedCase(opts: RunSuiteOptions, entry: CatalogEntry): LoadedCase {
  const caseDesc = loadCase(opts.evalV2Root, entry, opts.projectRoot);
  const truth = loadTruth(opts.evalV2Root, entry);
  const caseDir = join(opts.evalV2Root, entry.publicDir);
  const privateDir = join(opts.evalV2Root, entry.privateDir ?? "");
  const loaded: LoadedCase = { entry, caseDesc, truth, caseDir, privateDir, steps: [], auditSteps: [], isolation: { ok: true, counts: {} } };
  // 隔离预检先行：失败的 case 不再加载任何制作侧资源（含脚本）。
  const violations = checkIsolation(opts.projectRoot, caseDir, caseDesc, truth, privateDir);
  loaded.isolation = isolationSummary(violations);
  if (!loaded.isolation.ok) {
    loaded.violationText = violations.map((v) => `${v.code}: ${v.message}`).join("; ");
    return loaded;
  }
  if (caseDesc.scriptedEngine) {
    loaded.steps = JSON.parse(readFileSync(join(privateDir, "script.json"), "utf8")) as ScriptStep[];
    if (loaded.steps.length < caseDesc.rounds.length) {
      throw new Error(`case ${entry.caseId} 脚本步数 ${loaded.steps.length} 少于轮数 ${caseDesc.rounds.length}`);
    }
  }
  if (caseDesc.scriptedAudit) {
    const auditPath = join(privateDir, "audit.json");
    if (!existsSync(auditPath)) throw new Error(`case ${entry.caseId} 声明 scriptedAudit 但缺少 ${auditPath}`);
    loaded.auditSteps = JSON.parse(readFileSync(auditPath, "utf8")) as ScriptedAuditStep[];
  }
  return loaded;
}

/**
 * 审计器注入（A1）：评测运行的审计引擎必须显式确定，禁止隐式回落。
 * scripted/fake → 确定性审计器（脚本审计优先，否则零成本假审计）；
 * pi → 按 pi 配置构建真实审计器（与诊断引擎同源，凭据缺失直接报错）。
 * 该显式注入同时封死「环境配置 TD_ENGINE=pi 时工程自测隐式调用真实模型」的费用边界问题。
 */
function buildEvalAuditor(opts: RunSuiteOptions, loaded: LoadedCase): EvidenceAuditor | undefined {
  if (!opts.baseConfig.diagnosis.audit.enabled) return undefined;
  if (opts.engine === "pi") {
    return buildAuditor({ ...opts.baseConfig, diagnosis: { ...opts.baseConfig.diagnosis, engine: "pi" } });
  }
  if (loaded.auditSteps.length > 0) return new ScriptedAuditor(loaded.auditSteps);
  return new FakeEvidenceAuditor();
}

/** manifest 里的审计引擎名（与 buildEvalAuditor 同一规则，避免为取名字构造实例）。 */
function auditEngineNameOf(opts: RunSuiteOptions, loaded: LoadedCase): string | null {
  if (!opts.baseConfig.diagnosis.audit.enabled) return null;
  if (opts.engine === "pi") return "pi-audit";
  return loaded.auditSteps.length > 0 ? "scripted-audit" : "fake-audit";
}

export async function runSuite(opts: RunSuiteOptions): Promise<SuiteSummaryV2> {
  const startedAt = Date.now();
  const runDir = join(opts.evalV2Root, "runs", opts.suiteRunId);
  // 同名 suite 拒绝重跑：不同时间的运行混在同一目录会让新旧记录无法区分（审计配套项）。
  if (existsSync(runDir) && readdirSync(runDir).length > 0) {
    throw new Error(`suite 运行目录已存在且非空：${runDir}——请换一个 suiteRunId（评分口径变更须另建结果目录）`);
  }
  mkdirSync(runDir, { recursive: true });

  const catalog = loadCatalog(opts.evalV2Root);
  // 未知 case 显式失败（A3）：静默缩小评测范围会让"看起来跑过"的 suite 缺样本。
  if (opts.caseIds && opts.caseIds.length > 0) {
    const known = new Set(catalog.cases.map((c) => c.caseId));
    const unknown = opts.caseIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`未知 case：${unknown.join(", ")}（catalog 现有 ${catalog.cases.length} 例）`);
  }
  const entries = catalog.cases.filter((c) => !opts.caseIds || opts.caseIds.includes(c.caseId));
  if (entries.length === 0) throw new Error("catalog 中没有匹配的 case");
  // 准入预筛（A3/交付 1.1 #3）：非 engineering 且未 admitted 的 case 是**准入拒绝**（独立终态），
  // 不进评测总体、不进计划口径；工程自测拆分不受准入门槛约束（schema 同规则）。
  // 显式选题（--cases）中出现准入拒绝 → 直接失败：固定基线案例不得因准入退化静默缩小分母。
  const admissionRejected: CatalogEntry[] = [];
  const admissible: CatalogEntry[] = [];
  for (const entry of entries) {
    try {
      const raw = JSON.parse(readFileSync(join(opts.evalV2Root, entry.publicDir, "case.json"), "utf8")) as { split?: string; admission?: string };
      if (raw.split !== "engineering" && raw.admission !== "admitted") {
        admissionRejected.push(entry);
        continue;
      }
    } catch {
      // 读不出 case.json 的按装载错误处理（下方正常流程记录）。
    }
    admissible.push(entry);
  }
  if (opts.caseIds && opts.caseIds.length > 0 && admissionRejected.length > 0) {
    throw new Error(
      `显式选题中存在准入拒绝的 case：${admissionRejected.map((c) => c.caseId).join(", ")}——请先完成准入或改用全量运行（分母不得静默缩小）`,
    );
  }
  if (admissible.length === 0) {
    throw new Error(`可评案例为 0（selected=${entries.length}，准入拒绝=${admissionRejected.length}）——拒绝以空评测冒充通过`);
  }
  const repeat = Math.max(1, opts.repeat);
  const plannedTrials = admissible.length * repeat;

  // pi 预检：显式选择且 key 就绪才允许（§7.1）；构建失败立即停止。
  if (opts.engine === "pi") {
    const probe = buildEngine({ ...opts.baseConfig, diagnosis: { ...opts.baseConfig.diagnosis, engine: "pi" } });
    if (probe.name !== "pi") throw new Error("pi 引擎构建失败");
  }

  const promptHash = sha256Text(buildSystemPrompt());
  const caseSummaries: SuiteSummaryV2["cases"] = [];
  const frozenCases: ManifestCase[] = [];
  const caseStatuses: CaseStatus[] = [];
  // 审计引擎口径（A1）：同一 suite 内审计器构造规则一致，取首个启用 case 的引擎名。
  let auditEngine: string | null = null;

  // 冻结 case/trial 身份清单（交付 1.1 #2）：在 trial 运行**前**落盘，replay 据此对账——
  // 缺 trial / 缺 case / 混入清单外产物都必须失败，不允许"目录里有什么就对什么账"。
  const identities = admissible.flatMap((entry) => Array.from({ length: repeat }, (_, t) => ({ caseId: entry.caseId, trialId: `t${t + 1}` })));
  writeFileSync(
    join(runDir, "trials.json"),
    JSON.stringify({ schemaVersion: "prediagnosis-trials-v1", suiteRunId: opts.suiteRunId, engine: opts.engine, repeat, createdAt: startedAt, identities }, null, 2),
    "utf8",
  );
  // 项目身份运行前冻结（交付 1.1 #4）：HEAD/工作区/未跟踪实现文件指纹；结束时复核漂移。
  const projectBefore = projectIdentity(opts.projectRoot);

  for (const entry of admissionRejected) {
    caseStatuses.push({ caseId: entry.caseId, phase: "admission_rejected", trials: 0, reason: "非 engineering 拆分且未 admitted（准入拒绝，不入评测总体）" });
  }

  for (const entry of admissible) {
    // 装载/校验失败不终止 suite：记 load_error 后继续（A3：终态必须显式入账）。
    let loaded: LoadedCase;
    try {
      loaded = loadLoadedCase(opts, entry);
      validatePairing(loaded.caseDesc, loaded.truth);
    } catch (err) {
      caseStatuses.push({ caseId: entry.caseId, phase: "load_error", trials: 0, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!loaded.isolation.ok) {
      caseStatuses.push({ caseId: entry.caseId, phase: "isolation_blocked", trials: 0, reason: `隔离预检失败：${loaded.violationText}` });
      continue;
    }

    // 材料/配置指纹冻结于 trial 运行前（A3）：manifest 记录"运行开始时"的口径。
    let frozen: ManifestCase;
    try {
      frozen = snapshotCaseMaterials({
        projectRoot: opts.projectRoot,
        caseDir: loaded.caseDir,
        privateDir: loaded.privateDir,
        caseDesc: loaded.caseDesc,
        isolation: loaded.isolation,
      });
    } catch (err) {
      caseStatuses.push({ caseId: entry.caseId, phase: "load_error", trials: 0, reason: `材料快照失败：${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    frozenCases.push(frozen);
    if (auditEngine === null) auditEngine = auditEngineNameOf(opts, loaded);

    const trials: CaseScoreV2[] = [];
    let trialFailure: string | undefined;
    for (let t = 1; t <= repeat && !trialFailure; t++) {
      try {
        trials.push(await runTrial(opts, loaded, runDir, `t${t}`));
      } catch (err) {
        trialFailure = `t${t}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (trialFailure) {
      caseStatuses.push({ caseId: entry.caseId, phase: "run_error", trials: trials.length, reason: `case 异常（其余 case 继续）：${trialFailure}` });
      if (trials.length > 0) {
        caseSummaries.push({
          caseId: loaded.caseDesc.caseId,
          familyId: loaded.caseDesc.familyId,
          split: loaded.caseDesc.split,
          admission: loaded.caseDesc.admission,
          trials,
        });
      }
      continue;
    }
    caseSummaries.push({
      caseId: loaded.caseDesc.caseId,
      familyId: loaded.caseDesc.familyId,
      split: loaded.caseDesc.split,
      admission: loaded.caseDesc.admission,
      trials,
    });
    caseStatuses.push({ caseId: entry.caseId, phase: "scored", trials: trials.length });
  }

  // 冻结复核（A3/交付 1.1 #4）：全部 trial 结束后重取快照对比；漂移不影响已产生的记录，但必须显式暴露。
  const freezeDrifts: Array<{ caseId: string; details: string[] }> = [];
  for (const frozen of frozenCases) {
    const entry = catalog.cases.find((c) => c.caseId === frozen.caseId)!;
    try {
      const afterDesc = loadCase(opts.evalV2Root, entry, opts.projectRoot);
      const after = snapshotCaseMaterials({
        projectRoot: opts.projectRoot,
        caseDir: join(opts.evalV2Root, entry.publicDir),
        privateDir: join(opts.evalV2Root, entry.privateDir ?? ""),
        caseDesc: afterDesc,
        isolation: frozen.isolation,
      });
      const details = materialDrift(frozen, after);
      if (details.length > 0) freezeDrifts.push({ caseId: frozen.caseId, details });
    } catch (err) {
      freezeDrifts.push({ caseId: frozen.caseId, details: [`复核失败：${err instanceof Error ? err.message : String(err)}`] });
    }
  }
  // 项目身份漂移（交付 1.1 #4）：HEAD/工作区/未跟踪实现文件在运行中途变化都算漂移。
  const projectAfter = projectIdentity(opts.projectRoot);
  const projectDrift = projectIdentityDrift(projectBefore, projectAfter);
  if (projectDrift.length > 0) freezeDrifts.push({ caseId: "<project>", details: projectDrift });
  const freezeCheck = { checkedAt: Date.now(), ok: freezeDrifts.length === 0, drifts: freezeDrifts };

  const wall = { startedAt, finishedAt: Date.now() };
  const scoredTrials = caseSummaries.reduce((n, c) => n + c.trials.length, 0);
  const blockedExpectedTrials = caseSummaries.reduce(
    (n, c) => n + c.trials.filter((t) => t.roundScores.length > 0 && t.roundScores.every((r) => r.outcome === "blocked")).length,
    0,
  );
  const summary: SuiteSummaryV2 = {
    schemaVersion: "prediagnosis-score-v2",
    suiteRunId: opts.suiteRunId,
    engine: opts.engine,
    repeat,
    selected: entries.length,
    planned: { cases: admissible.length, trials: plannedTrials },
    counts: {
      scoredTrials,
      blockedExpectedTrials,
      admissionRejected: admissionRejected.length,
      unscoredCases: caseStatuses.filter((s) => s.phase !== "scored" && s.phase !== "admission_rejected").length,
    },
    caseStatuses,
    cases: caseSummaries,
    aggregate: aggregateMetrics(caseSummaries),
    families: buildFamilies(caseSummaries),
    wall,
  };

  const manifest = buildSuiteManifest({
    suiteRunId: opts.suiteRunId,
    engine: opts.engine,
    engineActual: caseSummaries.length > 0 ? (caseSummaries[0]?.trials[0]?.engine ?? opts.engine) : opts.engine,
    repeat,
    projectRoot: opts.projectRoot,
    project: projectBefore,
    auditEngine,
    frozenCases,
    freezeCheck,
    diagnosis: {
      provider: opts.baseConfig.diagnosis.provider,
      modelId: opts.baseConfig.diagnosis.modelId,
      promptHash,
      maxToolCalls: opts.baseConfig.diagnosis.maxToolCalls,
      timeoutMs: opts.baseConfig.diagnosis.timeoutMs,
      maxModelTurns: opts.baseConfig.diagnosis.maxModelTurns,
      maxToolResultChars: opts.baseConfig.diagnosis.maxToolResultChars,
      maxResultChars: opts.baseConfig.diagnosis.maxResultChars,
      defaultTimeWindowMs: opts.baseConfig.diagnosis.defaultTimeWindowMs,
      fallbackTimeWindowMs: opts.baseConfig.diagnosis.fallbackTimeWindowMs,
      audit: {
        enabled: opts.baseConfig.diagnosis.audit.enabled,
        maxRounds: opts.baseConfig.diagnosis.audit.maxRounds,
        failBlocks: opts.baseConfig.diagnosis.audit.failBlocks,
      },
    },
    scorerVersion: SCORER_VERSION,
    wall,
  });

  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  const unscored = caseStatuses.filter((s) => s.phase !== "scored");
  if (unscored.length > 0) {
    writeFileSync(join(runDir, "blocked.json"), JSON.stringify({ planned: summary.planned, caseStatuses: unscored }, null, 2), "utf8");
  }
  if (!freezeCheck.ok) {
    console.warn(`[eval:v2][freeze] 材料指纹漂移（manifest 冻结于运行前）：${JSON.stringify(freezeCheck.drifts)}`);
  }
  return summary;
}

async function runTrial(opts: RunSuiteOptions, loaded: LoadedCase, runDir: string, trialId: string): Promise<CaseScoreV2> {
  const { caseDesc, truth, caseDir } = loaded;
  const suiteRunId = opts.suiteRunId;
  const trace = new TraceRecorder(
    { suiteRunId, caseId: caseDesc.caseId, familyId: caseDesc.familyId, trialId },
    join(runDir, caseDesc.caseId, trialId, "trace.jsonl"),
  );
  const db = openDatabase(":memory:");
  migrate(db, join(opts.projectRoot, MIGRATIONS));
  const store = new Store(db);
  const sender = new CaptureSender();

  // 引擎：每 trial 全新实例（脚本步数按轮消费）。
  let engine: DiagnosisEngine;
  if (opts.engine === "scripted") engine = new ScriptedDiagnosisEngine(loaded.steps);
  else if (opts.engine === "fake") {
    engine = new FakeDiagnosisEngine({ defaultService: caseDesc.rounds[0]?.services[0] ?? "checkout-service" });
  } else {
    engine = buildEngine({ ...opts.baseConfig, diagnosis: { ...opts.baseConfig.diagnosis, engine: "pi" } });
  }
  const capture = new CapturingEngine(engine);
  // 审计器显式注入（A1）：scripted/fake 强制确定性审计，pi 才允许真实审计器。
  const auditor = buildEvalAuditor(opts, loaded);
  const auditEngine = auditor?.name ?? null;

  const artifacts: TrialArtifacts = {
    suiteRunId,
    caseId: caseDesc.caseId,
    familyId: caseDesc.familyId,
    trialId,
    engine: capture.name,
    auditEngine,
    ...(auditor instanceof ScriptedAuditor
      ? { auditScript: { provided: 0, consumed: 0, exhaustedCalls: 0 } }
      : {}),
    rounds: [],
    sourceReturned: [],
    wall: { startedAt: Date.now(), finishedAt: 0 },
  };
  const roundInputs: RoundScoreInput[] = [];
  let executionError: string | undefined;
  let investigationId = "";
  let sessionCode: string | undefined;
  let prevExternalId: string | undefined;
  const sourceCalls: SourceCallRecord[] = [];

  trace.emit("trial_started", { engine: capture.name, maxRounds: caseDesc.maxRounds });

  try {
    for (let r = 0; r < caseDesc.rounds.length; r++) {
      const round = caseDesc.rounds[r];
      const roundTruth = truth.rounds.find((t) => t.roundId === round.roundId);
      if (!roundTruth) throw new Error(`case ${caseDesc.caseId} 缺少 round ${round.roundId} 的私有标准`);

      // 每轮独立材料视图与白名单（§7.2.2）。
      const cfg: AppConfig = {
        ...opts.baseConfig,
        sources: {
          ...opts.baseConfig.sources,
          logDir: join(caseDir, round.materialView),
          // 逐轮授权（方案 §10.2）：空列表 = 显式空授权 → FileLogSource 全拒，不打开全部服务。
          allowedServices: [...round.services],
          allowedRepos: round.repos.map((repo) => repo.repoId),
          // 不注入 rev：评测必须走生产「按发生时间/HEAD 钉版本」的真实路径（本批工单 §2），
          // expectedSha 的核对由 onPrepared 观察点在模型取证前执行，不匹配即阻断。
          repos: round.repos.map((repo) => ({ repoId: repo.repoId, dir: resolve(opts.projectRoot, repo.dir) })),
        },
      };
      const recordingSource = new RecordingFileLogSource({
        dir: cfg.sources.logDir,
        allowedServices: cfg.sources.allowedServices,
      });

      // 入站消息：轮文本 + 会话标号续接（生产同一路径 routeInbound）。
      const baseText = loadRoundMessage(caseDir, round.messageRef);
      const text = r === 0 ? baseText : `${baseText}\n[${SESSION_MARKER_PREFIX}${sessionCode ?? ""}]`;
      const externalMessageId = `${caseDesc.caseId}-${trialId}-r${r + 1}`;
      const inbound: InboundMessage = {
        provider: "feishu",
        accountId: "eval-v2",
        externalMessageId,
        chatId: `oc-eval-${caseDesc.caseId}-${trialId}`,
        chatType: "group",
        mentionedBot: true,
        text,
        receivedAt: Date.parse(round.receivedAt),
        parentId: r > 0 ? prevExternalId : undefined,
      };
      const presentEvents = new Set<string>(["round_input"]);
      trace.emit("round_input", { roundId: round.roundId, text, receivedAt: inbound.receivedAt, materialView: round.materialView }, { roundId: round.roundId });

      const routed = routeInbound(store, cfg, inbound);
      if (routed.decision.kind !== "new_investigation" && routed.decision.kind !== "continue_investigation") {
        throw new Error(`round ${round.roundId} 入站被拒绝：${JSON.stringify(routed.decision)}`);
      }
      investigationId = routed.investigationId ?? investigationId;
      if (!investigationId) throw new Error(`round ${round.roundId} 入站未返回调查 ID`);
      if (r === 0) sessionCode = routed.sessionCode;
      prevExternalId = externalMessageId;

      const claimed = store.claimNextRun("eval-v2", 60_000);
      if (!claimed) throw new Error(`round ${round.roundId} 没有可领取的 run`);
      trace.emit("run_claimed", { round }, { roundId: round.roundId, runId: claimed.run.id, attemptId: claimed.attemptId });

      let runError: string | undefined;
      let preReadBlock: string | undefined; // 观察钩抛错会被 executeRun 消化转 failRun，用闭包标志带回阻断事实
      const expectedByRepo = new Map<string, string>();
      for (const repo of round.repos) if (repo.expectedSha) expectedByRepo.set(repo.repoId, repo.expectedSha);
      // 捕获按"本轮 executeRun 期间实际发生的调用"切片（A1）：审计补证会让一次 run 内
      // 产生多次引擎调用，按轮指针取单条会把补证稿错挂到下一轮。
      const capStart = capture.captured.length;
      try {
        await executeRun(
          {
            store,
            config: cfg,
            engine: capture,
            auditor,
            logSource: recordingSource,
            // 读取前核验（方案 §10.1/§10.2）：prepare 得到的实际源码版本与期望不符时，
            // 在模型取证前阻断。事件先落 trace，随后抛错由编排层 failRun（fail-closed）。
            onPrepared: ({ scope }) => {
              const resolved = scope.repos.map((r) => ({ repoId: r.repoId, resolvedSha: r.sha ?? null, pinnedBy: r.pinnedBy ?? null }));
              // 按全部期望仓库逐一核对（工单 §2）：缺席/unresolved/错配都不得漏检；
              // 工程场景允许缺期望版本，但仍必须核对实际准备出的可读版本，不能跳过检查进入运行。
              const checks = round.repos.map((repo) => {
                const expected = repo.expectedSha ?? null;
                const actual = resolved.find((x) => x.repoId === repo.repoId);
                if (!actual) {
                  return { repoId: repo.repoId, expected, resolvedSha: null, pinnedBy: null, check: "missing-in-scope" as const };
                }
                if (!actual.resolvedSha) {
                  return { repoId: repo.repoId, expected, resolvedSha: null, pinnedBy: actual.pinnedBy, check: "unresolved" as const };
                }
                if (expected && actual.resolvedSha !== expected) {
                  return { repoId: repo.repoId, expected, resolvedSha: actual.resolvedSha, pinnedBy: actual.pinnedBy, check: "mismatch" as const };
                }
                return { repoId: repo.repoId, expected, resolvedSha: actual.resolvedSha, pinnedBy: actual.pinnedBy, check: expected ? ("ok" as const) : ("no-expected" as const) };
              });
              // 实际解析 SHA 的隔离扫描（工单 §2）：预检只覆盖 expectedSha/HEAD 两棵树，
              // 按时间选中中间提交时必须对真实可读版本单独扫描——答案文件名、未来消息、完整性。
              const futureTexts = caseDesc.rounds.slice(r + 1).map((x) => loadRoundMessage(caseDir, x.messageRef));
              const repoDirByRepoId = new Map(round.repos.map((repo) => [repo.repoId, resolve(opts.projectRoot, repo.dir)]));
              const resolvedScans: Array<{ repoId: string; sha: string; ok: boolean; codes: string[]; detail: string }> = [];
              for (const c of checks) {
                const repoDir = repoDirByRepoId.get(c.repoId);
                if ((c.check === "ok" || c.check === "no-expected") && c.resolvedSha && repoDir) {
                  const scanViolations = scanResolvedTreeForIsolation({
                    repoDir,
                    sha: c.resolvedSha,
                    label: `${c.repoId}@${c.resolvedSha.slice(0, 10)}`,
                    futureTexts,
                  });
                  resolvedScans.push({
                    repoId: c.repoId,
                    sha: c.resolvedSha,
                    ok: scanViolations.length === 0,
                    codes: scanViolations.map((v) => v.code),
                    detail: scanViolations.map((v) => v.message).join("; "),
                  });
                }
              }
              trace.emit(
                "scope_resolved",
                {
                  expected: Object.fromEntries(expectedByRepo),
                  resolved,
                  checks,
                  resolvedScans,
                  pinnedByBasis: "time|head|explicit|unresolved（见 pinnedBy）",
                  timeWindowBasis: scope.timeWindowBasis ?? null,
                  occurredAt: scope.occurredAt ?? null,
                  authorizedServices: [...round.services],
                  materialView: round.materialView,
                },
                { roundId: round.roundId, runId: claimed.run.id },
              );
              presentEvents.add("scope_resolved");
              const bad = checks.find((c) => c.check !== "ok" && c.check !== "no-expected");
              const badScan = resolvedScans.find((x) => !x.ok);
              if (badScan) {
                preReadBlock = `版本一致性阻断（模型取证前）：repo ${badScan.repoId} 实际解析版本 ${badScan.sha.slice(0, 10)} 隔离扫描失败 [${badScan.codes.join(",")}] ${badScan.detail}`;
              } else if (bad) {
                const detail =
                  bad.check === "mismatch"
                    ? `resolved=${bad.resolvedSha} ≠ expected ${bad.expected}`
                    : bad.check === "missing-in-scope"
                      ? "实际材料范围缺少该仓库（构建失败或未解析）"
                      : "实际未解析出可读版本（unresolved）";
                preReadBlock = `版本一致性阻断（模型取证前）：repo ${bad.repoId} ${detail}（pinnedBy=${bad.pinnedBy ?? "?"}）`;
              }
              if (preReadBlock) {
                throw new Error(preReadBlock);
              }
            },
          },
          claimed,
        );
      } catch (err) {
        runError = err instanceof Error ? err.message : String(err);
      }
      if (preReadBlock) {
        runError = preReadBlock; // 观察钩失败已被编排层 failRun，这里收回阻断事实用于中止 trial
      }

      const runRow = store.getRun(claimed.run.id)!;
      // 本轮实际发生的全部引擎调用（A1）：initial=首轮草稿，其后为审计补证再诊断。
      // 失败轮按实际发生切片：executeRun 在引擎调用前失败 → 空切片，不占位。
      const roundCalls = capture.captured.slice(capStart);
      const engineCalls: EngineCallRecord[] = roundCalls.map((c, i) => ({
        index: i,
        phase: i === 0 ? ("initial" as const) : ("supplement" as const),
        kind: c.kind,
        ...(c.kind === "report" ? { draft: structuredClone(c.draft) as unknown } : { replyText: c.text, reason: c.reason }),
        modelTurns: c.modelTurns,
        ...(c.model ? { model: c.model } : {}),
        wallTime: Date.now(),
      }));
      const initialCall = roundCalls[0];
      const finalCall = roundCalls.at(-1);
      for (const [i, c] of roundCalls.entries()) {
        trace.emit(
          "engine_call",
          {
            callIndex: i,
            phase: i === 0 ? "initial" : "supplement",
            kind: c.kind,
            ...(c.kind === "report" ? { draft: c.draft } : { replyText: c.text, reason: c.reason }),
            modelTurns: c.modelTurns,
            model: c.model ?? null,
          },
          { roundId: round.roundId, runId: claimed.run.id, attemptId: claimed.attemptId },
        );
      }
      // 预期内的读取前阻断（版本/隔离预检）单独记 blocked，不与真实 error 混同。
      // outcome 以**持久化运行终态 + 成功提交事实**为准（交付 1.1 #1）：run 未 succeeded
      // （审计 failBlocks=true 失败、补证引擎失败、预算耗尽、超时、提交被拒等）一律记 error，
      // 不得因引擎已产出草稿而记 report——否则失败轮会以"合法产出"通过门禁。
      // failBlocks=false 的合法降级仍走 finalize 正常发布（status=succeeded → outcome 照常）。
      const committed = runRow.status === "succeeded";
      const outcome: RoundOutcomeKind = preReadBlock ? "blocked" : committed && !runError ? outcomeOf(finalCall) : "error";
      const reportRow = store.getReportByRun(claimed.run.id);
      const validatedReport = reportRow
        ? (JSON.parse(reportRow.content) as NonNullable<RoundArtifacts["rawDraft"]> & { scope?: unknown; corrections?: string[] })
        : undefined;

      // 投递排水（捕获发送端记录回写文本）。
      sender.currentRoundId = round.roundId;
      let drained = 0;
      while (drained < DELIVERY_DRAIN_CAP && (await processDeliveriesOnce(store, cfg, sender)) > 0) drained++;
      const roundSends = sender.sent.filter((s) => s.roundId === round.roundId);
      const writebackText = roundSends.at(-1)?.text;

      // 持久化导出（derived 事件）。
      exportToolEvents(trace, db, { roundId: round.roundId, runId: claimed.run.id });
      exportEvidenceEvents(trace, db, { roundId: round.roundId, runId: claimed.run.id });
      exportUsageEvent(trace, db, { roundId: round.roundId, attemptId: claimed.attemptId });
      // 审计决定/失败/最终应用（交付 1.1 #7）：连同真实发生时间导出，trial 结束不丢。
      exportAuditEvents(trace, db, { roundId: round.roundId, runId: claimed.run.id });
      presentEvents.add("evidence_committed");
      presentEvents.add("usage");
      if ((finalCall?.toolCalls ?? 0) > 0) presentEvents.add("tool_returned");
      // engine_result_raw：本轮**最终**引擎结果摘要（与 finalize 落库的产出一致）；
      // 逐次调用细节见 engine_call 事件与 artifacts.engineCalls。
      trace.emit(
        "engine_result_raw",
        {
          kind: finalCall?.kind,
          draft: finalCall?.kind === "report" ? finalCall.draft : undefined,
          reply: finalCall?.kind === "reply" ? finalCall.text : undefined,
          engineCallCount: roundCalls.length,
        },
        { roundId: round.roundId, runId: claimed.run.id },
      );
      presentEvents.add("engine_result_raw");
      trace.emit("output_persisted", { kind: outcome, status: runRow.status }, { roundId: round.roundId, runId: claimed.run.id });
      presentEvents.add("output_persisted");
      if (roundSends.length > 0) {
        trace.emit("delivery_captured", { sends: roundSends }, { roundId: round.roundId });
        presentEvents.add("delivery_captured");
      }

      // 引用解析记录（raw=初稿的 E# 短号，validated=终稿 uid），带版本核对。
      // raw 阶段固定取**首轮草稿**（A1）：初稿错误不因审计纠正而抹去。
      const resolver = new StoreEvidenceResolver(store, investigationId, claimed.run.id);
      const expectedShas: Record<string, string> = {};
      for (const repo of round.repos) if (repo.expectedSha) expectedShas[repo.repoId] = repo.expectedSha;
      const citations: CitationRecord[] = [];
      const recordCitations = (stage: "raw" | "validated", ids: string[]) => {
        for (const rawId of ids) {
          const ref = resolver.byUid(investigationId, rawId) ?? resolver.byRunShortId(claimed.run.id, rawId);
          const codeRef = ref?.codeRef ?? undefined;
          const wrongSha = !!codeRef && !!expectedShas[codeRef.repoId] && codeRef.sha !== expectedShas[codeRef.repoId];
          citations.push({
            rawId,
            stage,
            roundId: round.roundId,
            resolved: !!ref,
            ...(ref
              ? {
                  evidence: {
                    evidenceId: ref.evidenceId,
                    evidenceUid: ref.evidenceUid,
                    kind: ref.kind,
                    excerpt: ref.excerpt,
                    truncated: ref.truncated,
                    level: ref.level ?? null,
                    codeRef: codeRef ?? null,
                  },
                }
              : {}),
            ...(wrongSha ? { wrongSha } : {}),
          });
        }
      };
      const rawReport = initialCall && initialCall.kind === "report" ? initialCall.draft : undefined;
      const draftHypotheses = rawReport?.hypotheses as Array<{ evidenceIds?: string[] }> | undefined;
      if (draftHypotheses) recordCitations("raw", draftHypotheses.flatMap((h) => h.evidenceIds ?? []));
      if (validatedReport) {
        recordCitations(
          "validated",
          (validatedReport as { hypotheses?: Array<{ evidenceIds?: string[] }> }).hypotheses?.flatMap((h) => h.evidenceIds ?? []) ?? [],
        );
      }

      // 累计可见性上下文（A/B/C1 跨轮累计；D 本轮报告引用）。
      sourceCalls.push(...recordingSource.calls);
      const toolReturns = layerC1(db, investigationId);
      const batchByCall = layerBatchesByCall(db, investigationId);
      const callEvidence: CallEvidence[] = toolReturns.map((t) => ({
        callId: t.callId,
        text: t.text,
        isError: t.isError,
        evidence: batchByCall.get(t.callId) ?? [],
      }));
      const persisted = layerBByInvestigation(db, investigationId);
      const cited = validatedReport
        ? citedEvidence(db, investigationId, (validatedReport as { hypotheses?: Array<{ evidenceIds?: string[] }> }).hypotheses?.flatMap((h) => h.evidenceIds ?? []) ?? [])
        : [];
      const visibility = computeRequirementSatisfaction({
        caseRoundIds: caseDesc.rounds.map((x) => x.roundId),
        truth,
        roundId: round.roundId,
        ctx: {
          sourceCalls,
          persisted,
          callEvidence,
          cited,
          observationLevel: "b-c1-d",
          c2Reason: "未接请求观测（C2 恒 null）",
        },
      });

      // 事后核对记录（读取前核验已由 onPrepared 观察点承担并阻断；此处仅对已产生报告的
      // 轮次补记 scope 实际 SHA 与期望的差值，供评分层 wrong_sha 留痕）。
      const scopeShaMismatch: RoundScoreInput["scopeShaMismatch"] = [];
      const scopeRepos = (validatedReport as { scope?: { repos?: Array<{ repoId?: string; sha?: string }> } } | undefined)?.scope?.repos;
      if (scopeRepos) {
        for (const repo of round.repos) {
          if (!repo.expectedSha) continue;
          const resolved = scopeRepos.find((x) => x.repoId === repo.repoId)?.sha ?? null;
          if (resolved !== repo.expectedSha) {
            scopeShaMismatch.push({ repoId: repo.repoId, expected: repo.expectedSha, resolved });
          }
        }
      }

      const allLogQueriesEmpty = recordingSource.calls.length > 0 && recordingSource.calls.every((c) => c.entries.length === 0);

      artifacts.rounds.push({
        roundId: round.roundId,
        runId: claimed.run.id,
        status: runRow.status,
        errorCode: (runRow as unknown as { error_code?: string | null }).error_code ?? null,
        errorMessage: (runRow as unknown as { error_message?: string | null }).error_message ?? null,
        outcome,
        rawDraft: initialCall?.kind === "report" ? (initialCall.draft as unknown) : undefined,
        engineCalls,
        report: validatedReport,
        replyText: finalCall?.kind === "reply" ? finalCall.text : undefined,
        writebackText,
        corrections: (validatedReport as { corrections?: string[] } | undefined)?.corrections,
        toolCalls: finalCall?.toolCalls ?? 0,
        allLogQueriesEmpty,
        scopeResolved: (validatedReport as { scope?: unknown } | undefined)?.scope,
        ...(runError ? { error: runError } : {}),
      });
      artifacts.sourceReturned.push(
        ...recordingSource.calls.map((c) => ({
          roundId: round.roundId,
          tool: c.tool,
          args: c.args as unknown,
          entries: c.entries.length,
          excerptHead: c.entries.slice(0, 3).map((e) => e.message.slice(0, 80)),
        })),
      );

      roundInputs.push({
        roundId: round.roundId,
        truth: roundTruth,
        outcome,
        status: runRow.status,
        errorCode: (runRow as unknown as { error_code?: string | null }).error_code ?? null,
        rawDraft: initialCall?.kind === "report" ? initialCall.draft : undefined,
        validatedReport: validatedReport as RoundScoreInput["validatedReport"],
        replyText: finalCall?.kind === "reply" ? finalCall.text : undefined,
        writebackText,
        citations,
        allLogQueriesEmpty,
        expectedShas,
        scopeShaMismatch,
        visibility,
        requiredTraceEvents: ["round_input", "scope_resolved", "engine_result_raw", "output_persisted", "usage", "round_finished"],
        presentTraceEvents: [...presentEvents, "round_finished"],
      });

      trace.emit("round_finished", { outcome, status: runRow.status }, { roundId: round.roundId, runId: claimed.run.id });

      // 读取前阻断（隔离/版本完整性失败）→ 中止整个 trial：
      // 材料契约已破坏，后续轮次不再发布（避免继续消耗预算并污染 trace）。
      if (runError?.startsWith("版本一致性阻断")) {
        executionError = runError;
        trace.emit("run_error", { error: runError, blockedPreRead: true }, { roundId: round.roundId, runId: claimed.run.id });
        break;
      }
    }
  } catch (err) {
    executionError = err instanceof Error ? err.message : String(err);
    trace.emit("run_error", { error: executionError });
  }

  artifacts.wall.finishedAt = Date.now();
  const usageRow = db.prepare("SELECT COALESCE(SUM(usage_total_tokens), 0) AS t FROM attempts").get() as { t: number | bigint };
  artifacts.usage = { totalTokens: Number(usageRow.t) };
  // 逐 trial 审计器账目（交付 1.1 #7）：脚本审计记录提供/消费/耗尽。
  if (auditor instanceof ScriptedAuditor && artifacts.auditScript) {
    artifacts.auditScript = { provided: auditor.stepsConsumed.length + auditor.remaining, consumed: auditor.stepsConsumed.length, exhaustedCalls: auditor.exhaustedCalls };
  }

  const scorerInput: ScorerInput = {
    caseDesc,
    truth,
    engine: capture.name,
    trialId,
    suiteRunId,
    rounds: roundInputs,
    ...(executionError ? { executionError } : {}),
    ...(auditor instanceof ScriptedAuditor && auditor.exhausted ? { auditScriptExhausted: true } : {}),
  };
  const score = scoreTrial(scorerInput);

  const trialDir = join(runDir, caseDesc.caseId, trialId);
  mkdirSync(trialDir, { recursive: true });
  writeFileSync(join(trialDir, "outputs.json"), JSON.stringify({ artifacts, scorerInput }, null, 2), "utf8");
  writeFileSync(join(trialDir, "score.json"), JSON.stringify(score, null, 2), "utf8");
  trace.emit("trial_finished", { executionSuccess: score.executionSuccess });
  return score;
}

/** 汇总聚合：按指标合并分子/分母（pooled），不做无分母均值。 */
export function aggregateMetrics(cases: SuiteSummaryV2["cases"]): Record<string, MetricValue> {
  const keys = [
    "traceCompletion",
    "citationValidity",
    "claimSupport",
    "requiredFactCoverage",
    "unsupportedAssertionRate",
    "clarificationSuccess",
    "contradictionUpdateSuccess",
    "writebackSuccess",
  ];
  const trials = cases.flatMap((c) => c.trials);
  // 汇总不得重新生成未评分（P3）：任一构成 trial 缺测（unscored>0）或无分母时，
  // 聚合 value 保持 null——缺测不允许被分子分母平均成 0/1。
  const pool = (get: (t: CaseScoreV2) => MetricValue | null | undefined): MetricValue => {
    let num = 0;
    let den = 0;
    let na = 0;
    let unscored = 0;
    for (const t of trials) {
      const m = get(t);
      if (!m) continue;
      num += m.numerator;
      den += m.denominator;
      na += m.notApplicable;
      unscored += m.unscored;
    }
    return { numerator: num, denominator: den, notApplicable: na, unscored, value: den > 0 && unscored === 0 ? num / den : null };
  };
  const out: Record<string, MetricValue> = {};
  for (const key of keys) {
    out[key] = pool((t) => (t as unknown as Record<string, MetricValue>)[key]);
  }
  for (const layer of ["A", "B", "C1", "C2", "D"] as const) {
    out[`recall.${layer}`] = pool((t) => t.recall[layer]);
  }
  const okCount = trials.filter((t) => t.executionSuccess).length;
  out.executionSuccess = {
    numerator: okCount,
    denominator: trials.length,
    notApplicable: 0,
    unscored: 0,
    value: trials.length > 0 ? okCount / trials.length : null,
  };
  out.hardFailures = {
    numerator: trials.reduce((n, t) => n + t.hardFailures.length, 0),
    denominator: trials.length,
    notApplicable: 0,
    unscored: 0,
    value: null,
  };
  return out;
}

function buildFamilies(cases: SuiteSummaryV2["cases"]): SuiteSummaryV2["families"] {
  const map = new Map<string, { trials: number; hardFailures: number }>();
  for (const c of cases) {
    const cur = map.get(c.familyId) ?? { trials: 0, hardFailures: 0 };
    cur.trials += c.trials.length;
    cur.hardFailures += c.trials.reduce((n, t) => n + t.hardFailures.length, 0);
    map.set(c.familyId, cur);
  }
  return [...map.entries()].map(([familyId, v]) => ({ familyId, ...v }));
}
