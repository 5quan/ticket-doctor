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
import { buildEngine } from "../../agent/factory.ts";
import { FakeDiagnosisEngine } from "../../agent/fake-engine.ts";
import { buildSystemPrompt } from "../../agent/pi-engine.ts";
import type { DiagnosisEngine, EngineResult } from "../../agent/types.ts";
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
import { CaptureSender } from "./capture.ts";
import { buildSuiteManifest } from "./manifest.ts";
import { exportEvidenceEvents, exportToolEvents, exportUsageEvent, TraceRecorder } from "./trace.ts";
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
import { CapturingEngine, ScriptedDiagnosisEngine, type ScriptStep } from "./scripted-engine.ts";
import { SCORER_VERSION, scoreTrial, type CitationRecord, type RoundScoreInput, type ScorerInput } from "./scorer.ts";
import type {
  CaseDescriptorV2,
  CaseScoreV2,
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
  isolation: { ok: boolean; counts: Record<string, number> };
  violationText?: string;
}

function loadLoadedCase(opts: RunSuiteOptions, entry: CatalogEntry): LoadedCase {
  const caseDesc = loadCase(opts.evalV2Root, entry, opts.projectRoot);
  const truth = loadTruth(opts.evalV2Root, entry);
  const caseDir = join(opts.evalV2Root, entry.publicDir);
  const privateDir = join(opts.evalV2Root, entry.privateDir ?? "");
  const loaded: LoadedCase = { entry, caseDesc, truth, caseDir, privateDir, steps: [], isolation: { ok: true, counts: {} } };
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
  return loaded;
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
  const entries = catalog.cases.filter((c) => !opts.caseIds || opts.caseIds.includes(c.caseId));
  if (entries.length === 0) throw new Error("catalog 中没有匹配的 case");

  // pi 预检：显式选择且 key 就绪才允许（§7.1）；构建失败立即停止。
  if (opts.engine === "pi") {
    const probe = buildEngine({ ...opts.baseConfig, diagnosis: { ...opts.baseConfig.diagnosis, engine: "pi" } });
    if (probe.name !== "pi") throw new Error("pi 引擎构建失败");
  }

  const promptHash = sha256Text(buildSystemPrompt());
  const caseSummaries: SuiteSummaryV2["cases"] = [];
  const manifestCases: Parameters<typeof buildSuiteManifest>[0]["cases"] = [];
  const blockedCases: Array<{ caseId: string; reason: string }> = [];

  for (const entry of entries) {
    // 单 case 失败（装载/预检/执行/评分）不得终止整个 suite：记 blocked/异常后继续。
    try {
      const loaded = loadLoadedCase(opts, entry);
      if (!loaded.isolation.ok) {
        blockedCases.push({ caseId: entry.caseId, reason: `隔离预检失败：${loaded.violationText}` });
        continue;
      }
      // case 与 truth 的轮次必须配对一致（审计配套项：schema 完整性）。
      validatePairing(loaded.caseDesc, loaded.truth);

      const trials: CaseScoreV2[] = [];
      for (let t = 1; t <= Math.max(1, opts.repeat); t++) {
        trials.push(await runTrial(opts, loaded, runDir, `t${t}`));
      }
      caseSummaries.push({
        caseId: loaded.caseDesc.caseId,
        familyId: loaded.caseDesc.familyId,
        split: loaded.caseDesc.split,
        admission: loaded.caseDesc.admission,
        trials,
      });
      manifestCases.push({ caseDesc: loaded.caseDesc, truth: loaded.truth, isolation: loaded.isolation });
    } catch (err) {
      blockedCases.push({
        caseId: entry.caseId,
        reason: `case 异常（其余 case 继续）：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const wall = { startedAt, finishedAt: Date.now() };
  const summary: SuiteSummaryV2 = {
    schemaVersion: "prediagnosis-score-v2",
    suiteRunId: opts.suiteRunId,
    engine: opts.engine,
    repeat: Math.max(1, opts.repeat),
    cases: caseSummaries,
    aggregate: aggregateMetrics(caseSummaries),
    families: buildFamilies(caseSummaries),
    wall,
  };

  const manifest = buildSuiteManifest({
    suiteRunId: opts.suiteRunId,
    engine: opts.engine,
    repeat: Math.max(1, opts.repeat),
    projectRoot: opts.projectRoot,
    caseDirOf: (caseId) => join(opts.evalV2Root, catalog.cases.find((c) => c.caseId === caseId)!.publicDir),
    privateDirOf: (caseId) => join(opts.evalV2Root, catalog.cases.find((c) => c.caseId === caseId)!.privateDir ?? ""),
    cases: manifestCases,
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
    },
    scorerVersion: SCORER_VERSION,
    wall,
  });

  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  if (blockedCases.length > 0) {
    writeFileSync(join(runDir, "blocked.json"), JSON.stringify(blockedCases, null, 2), "utf8");
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

  const artifacts: TrialArtifacts = {
    suiteRunId,
    caseId: caseDesc.caseId,
    familyId: caseDesc.familyId,
    trialId,
    engine: capture.name,
    rounds: [],
    sourceReturned: [],
    wall: { startedAt: Date.now(), finishedAt: 0 },
  };
  const roundInputs: RoundScoreInput[] = [];
  let executionError: string | undefined;
  let investigationId = "";
  let sessionCode: string | undefined;
  let prevExternalId: string | undefined;
  let capturePtr = 0;
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
      const expectedByRepo = new Map<string, string>();
      for (const repo of round.repos) if (repo.expectedSha) expectedByRepo.set(repo.repoId, repo.expectedSha);
      try {
        await executeRun(
          {
            store,
            config: cfg,
            engine: capture,
            logSource: recordingSource,
            // 读取前核验（方案 §10.1/§10.2）：prepare 得到的实际源码版本与期望不符时，
            // 在模型取证前阻断。事件先落 trace，随后抛错由编排层 failRun（fail-closed）。
            onPrepared: ({ scope }) => {
              const resolved = scope.repos.map((r) => ({ repoId: r.repoId, resolvedSha: r.sha ?? null, pinnedBy: r.pinnedBy ?? null }));
              trace.emit(
                "scope_resolved",
                {
                  expected: Object.fromEntries(expectedByRepo),
                  resolved,
                  pinnedByBasis: "time|head|explicit|unresolved（见 pinnedBy）",
                  timeWindowBasis: scope.timeWindowBasis ?? null,
                  occurredAt: scope.occurredAt ?? null,
                  authorizedServices: [...round.services],
                  materialView: round.materialView,
                },
                { roundId: round.roundId, runId: claimed.run.id },
              );
              presentEvents.add("scope_resolved");
              for (const r of resolved) {
                const expected = expectedByRepo.get(r.repoId);
                if (expected && r.resolvedSha !== expected) {
                  throw new Error(
                    `版本一致性阻断（模型取证前）：repo ${r.repoId} resolved=${r.resolvedSha ?? "unresolved"} (pinnedBy=${r.pinnedBy ?? "?"}) ≠ expected ${expected}`,
                  );
                }
              }
            },
          },
          claimed,
        );
      } catch (err) {
        runError = err instanceof Error ? err.message : String(err);
      }

      const runRow = store.getRun(claimed.run.id)!;
      // 原始结果按"实际发生的引擎调用"消费（指针），失败轮不占位——
      // capture.captured.at(r) 会在失败轮后错位（审计配套项）。
      const raw = capture.captured[capturePtr];
      if (raw) capturePtr += 1;
      const outcome = runError ? "error" : outcomeOf(raw);
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
      presentEvents.add("evidence_committed");
      presentEvents.add("usage");
      if ((raw?.toolCalls ?? 0) > 0) presentEvents.add("tool_returned");
      trace.emit(
        "engine_result_raw",
        { kind: raw?.kind, draft: raw?.kind === "report" ? raw.draft : undefined, reply: raw?.kind === "reply" ? raw.text : undefined },
        { roundId: round.roundId, runId: claimed.run.id },
      );
      presentEvents.add("engine_result_raw");
      trace.emit("output_persisted", { kind: outcome, status: runRow.status }, { roundId: round.roundId, runId: claimed.run.id });
      presentEvents.add("output_persisted");
      if (roundSends.length > 0) {
        trace.emit("delivery_captured", { sends: roundSends }, { roundId: round.roundId });
        presentEvents.add("delivery_captured");
      }

      // 引用解析记录（raw=E# 短号，validated=uid），带版本核对。
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
      const rawReport = raw && raw.kind === "report" ? raw.draft : undefined;
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
        rawDraft: raw?.kind === "report" ? (raw.draft as unknown) : undefined,
        report: validatedReport,
        replyText: raw?.kind === "reply" ? raw.text : undefined,
        writebackText,
        corrections: (validatedReport as { corrections?: string[] } | undefined)?.corrections,
        toolCalls: raw?.toolCalls ?? 0,
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
        rawDraft: raw?.kind === "report" ? raw.draft : undefined,
        validatedReport: validatedReport as RoundScoreInput["validatedReport"],
        replyText: raw?.kind === "reply" ? raw.text : undefined,
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
    }
  } catch (err) {
    executionError = err instanceof Error ? err.message : String(err);
    trace.emit("run_error", { error: executionError });
  }

  artifacts.wall.finishedAt = Date.now();
  const usageRow = db.prepare("SELECT COALESCE(SUM(usage_total_tokens), 0) AS t FROM attempts").get() as { t: number | bigint };
  artifacts.usage = { totalTokens: Number(usageRow.t) };

  const scorerInput: ScorerInput = {
    caseDesc,
    truth,
    engine: capture.name,
    trialId,
    suiteRunId,
    rounds: roundInputs,
    ...(executionError ? { executionError } : {}),
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
function aggregateMetrics(cases: SuiteSummaryV2["cases"]): Record<string, MetricValue> {
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
