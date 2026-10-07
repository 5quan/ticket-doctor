// Langfuse 原生评测：单案例多轮执行核心（从 eval/v2-migrate 的 runTrial 提取瘦身）。
//
// 复用（来自 origin/eval/v2-migrate，internals/ 下原样提取）：
//   * 每轮独立材料视图 + 日志授权白名单（§7.2.2）
//   * 生产链路 routeInbound → claim → executeRun → 捕获投递（§7.1）
//   * 读取前版本核对 + 解析树隔离扫描（onPrepared 观察点，fail-closed）
//   * 引用解析记录（raw=首轮草稿 E# 短号 / validated=终稿 uid，含 wrongSha）
//   * 四层可见性上下文（A 源返回/B 入库/C1 工具返回/D 报告引用；C2 恒 null 不冒充）
// 不迁入：suite 管理、打分器、manifest 冻结、对比、推送协议（评分改走官方 SDK evaluators）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "../../config/index.ts";
import { buildAuditor, buildEngine } from "../../agent/factory.ts";
import { FakeDiagnosisEngine } from "../../agent/fake-engine.ts";
import { FakeEvidenceAuditor } from "../../agent/fake-auditor.ts";
import { buildSystemPrompt } from "../../agent/pi-engine.ts";
import type { EvidenceAuditor } from "../../agent/audit-types.ts";
import { openDatabase, migrate } from "../../storage/db.ts";
import { Store } from "../../storage/store.ts";
import { StoreEvidenceResolver } from "../../evidence/store-resolver.ts";
import { processDeliveriesOnce } from "../../delivery/delivery.ts";
import { executeRun } from "../../diagnosis/orchestrator.ts";
import { routeInbound } from "../../intake/router.ts";
import { SESSION_MARKER_PREFIX } from "../../domain/session.ts";
import type { InboundMessage } from "../../domain/types.ts";
import { loadCase, loadRoundMessage, loadTruth, type CatalogEntry } from "./internals/load.ts";
import { checkIsolation, isolationSummary, scanResolvedTreeForIsolation } from "./internals/isolation.ts";
import { validatePairing } from "./internals/schema.ts";
import { CaptureSender } from "./internals/capture.ts";
import { exportAuditEvents, exportEvidenceEvents, exportToolEvents, exportUsageEvent, TraceRecorder } from "./internals/trace.ts";
import {
  RecordingFileLogSource,
  layerBByInvestigation,
  layerBatchesByCall,
  layerC1,
  citedEvidence,
  computeRequirementSatisfaction,
  type CallEvidence,
  type SourceCallRecord,
} from "./internals/visibility.ts";
import { CapturingEngine, ScriptedAuditor, ScriptedDiagnosisEngine, type ScriptStep, type ScriptedAuditStep } from "./internals/scripted-engine.ts";
import type {
  CaseDescriptorV2,
  EngineCallRecord,
  RoundArtifacts,
  RoundOutcomeKind,
  TruthFileV2,
} from "./internals/types.ts";
import type { DiagnosisEngine, EngineResult } from "../../agent/types.ts";
import { createHash } from "node:crypto";

const MIGRATIONS = "migrations";
const DELIVERY_DRAIN_CAP = 20;

export type EvalEngine = "fake" | "scripted" | "pi";

export interface RunCaseOptions {
  projectRoot: string;
  /** 冻结材料根（catalog/public/private 由 seed 物化，plan §4：服务器冻结工件）。 */
  evalRoot: string;
  entry: CatalogEntry;
  engine: EvalEngine;
  baseConfig: AppConfig;
  /** 候选提示词（缺省 = 生产内置）；注入走 buildEngine(config, systemPrompt)（plan §5）。 */
  systemPrompt?: string;
  /** 实验输出目录（trace.jsonl / artifacts.json 落盘，仅调试与导出用）。 */
  outDir: string;
  /** 观测接入：SDK task 的 active context（本案例成为实验 item trace 的子节点，plan §6）。 */
  otelParentContext?: import("@opentelemetry/api").Context;
  /** Langfuse 观测记录器（plan §6 过程捕获）：提供时传入生产编排链路。 */
  recorder?: import("../../observability/langfuse.ts").ObservationRecorder;
}

export interface RoundVisibilitySummary {
  roundId: string;
  requirements: number;
  applicable: number;
  /** B∧C1∧D 全命中的需求数（组合 OR 语义下的充分满足）。 */
  fullySatisfiedBc1d: number;
  details: Array<{ requirementId: string; applicable: boolean; satisfied: { A: boolean | null; B: boolean; C1: boolean; C2: boolean | null; D: boolean } }>;
}

export interface ScopeCheckRecord {
  roundId: string;
  repoId: string;
  expected: string | null;
  resolvedSha: string | null;
  check: "ok" | "no-expected" | "mismatch" | "missing-in-scope" | "unresolved";
  resolvedScanOk: boolean | null;
}

export interface CaseRunResult {
  caseId: string;
  engine: string;
  auditEngine: string | null;
  promptHash: string;
  /** plan §5：验证注入实际生效（pi 引擎回报 getSystemPrompt()；scripted/fake 无模型，null）。 */
  injectedPrompt: { verified: boolean; matches: boolean | null; head: string | null };
  isolation: { ok: boolean; counts: Record<string, number>; violationText?: string };
  rounds: Array<{
    roundId: string;
    runId: string;
    status: string;
    outcome: RoundOutcomeKind;
    blocked: boolean;
    error?: string;
    engineCalls: number;
    engineCallDetails: Array<{ phase: "initial" | "supplement"; kind: string; replyReason?: string }>;
    report: unknown;
    replyText: string | null;
    writebackText: string | null;
    toolCalls: number;
    /** plan §6/§7 P2：本轮 attempt 的 token 用量（字段缺失记 null，不猜测）。 */
    usage: { inputTokens: number | null; outputTokens: number | null; cacheTokens: number | null; totalTokens: number | null };
    citations: Array<{ stage: "raw" | "validated"; rawId: string; resolved: boolean; wrongSha: boolean }>;
    scopeChecks: ScopeCheckRecord[];
    visibility: RoundVisibilitySummary;
    allLogQueriesEmpty: boolean;
  }>;
  wall: { startedAt: number; finishedAt: number; ms: number };
}

function outcomeOf(result: EngineResult | undefined): RoundOutcomeKind {
  if (!result) return "error";
  if (result.kind === "report") return "report";
  return result.reason === "clarify" ? "clarify" : "chat";
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

function loadLoadedCase(evalRoot: string, projectRoot: string, entry: CatalogEntry): LoadedCase {
  const caseDesc = loadCase(evalRoot, entry, projectRoot);
  const truth = loadTruth(evalRoot, entry);
  const caseDir = join(evalRoot, entry.publicDir);
  const privateDir = join(evalRoot, entry.privateDir ?? "");
  const loaded: LoadedCase = { entry, caseDesc, truth, caseDir, privateDir, steps: [], auditSteps: [], isolation: { ok: true, counts: {} } };
  // 隔离预检先行：失败的 case 不再加载任何制作侧资源（含脚本）。
  const violations = checkIsolation(projectRoot, caseDir, caseDesc, truth, privateDir);
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

function buildCaseAuditor(opts: RunCaseOptions, loaded: LoadedCase): EvidenceAuditor | undefined {
  if (!opts.baseConfig.diagnosis.audit.enabled) return undefined;
  if (opts.engine === "pi") {
    return buildAuditor({ ...opts.baseConfig, diagnosis: { ...opts.baseConfig.diagnosis, engine: "pi" } });
  }
  if (loaded.auditSteps.length > 0) return new ScriptedAuditor(loaded.auditSteps);
  return new FakeEvidenceAuditor();
}

/** 加载一个 case（公开目录/私有标准/脚本/隔离预检），seed 与 task 共用。 */
export function loadFrozenCase(evalRoot: string, projectRoot: string, entry: CatalogEntry): LoadedCase {
  return loadLoadedCase(evalRoot, projectRoot, entry);
}

/**
 * 执行一次完整调查（一个 dataset item = 一次完整多轮调查，plan §3）。
 * 所有轮次共享 investigation/会话/历史证据；每轮独立材料视图与授权。
 */
export async function runCase(opts: RunCaseOptions): Promise<CaseRunResult> {
  const loaded = loadLoadedCase(opts.evalRoot, opts.projectRoot, opts.entry);
  const { caseDesc, truth, caseDir } = loaded;
  mkdirSync(opts.outDir, { recursive: true });
  const trace = new TraceRecorder(
    { suiteRunId: "lf-experiment", caseId: caseDesc.caseId, familyId: caseDesc.familyId, trialId: "t1" },
    join(opts.outDir, caseDesc.caseId, "trace.jsonl"),
  );
  const db = openDatabase(":memory:");
  migrate(db, join(opts.projectRoot, MIGRATIONS));
  const store = new Store(db);
  const sender = new CaptureSender();

  let engine: DiagnosisEngine;
  if (opts.engine === "scripted") engine = new ScriptedDiagnosisEngine(loaded.steps);
  else if (opts.engine === "fake") {
    engine = new FakeDiagnosisEngine({ defaultService: caseDesc.rounds[0]?.services[0] ?? "checkout-service" });
  } else {
    engine = buildEngine({ ...opts.baseConfig, diagnosis: { ...opts.baseConfig.diagnosis, engine: "pi" } }, opts.systemPrompt);
  }
  const capture = new CapturingEngine(engine);
  const auditor = buildCaseAuditor(opts, loaded);
  const auditEngine = auditor?.name ?? null;
  // plan §5：记录**编译后**提示词指纹；注入验证：pi 引擎回报实际生效的系统提示词。
  const expectedPrompt = opts.systemPrompt ?? buildSystemPrompt();
  const promptHash = createHash("sha256").update(expectedPrompt).digest("hex");
  let injectedPrompt: CaseRunResult["injectedPrompt"] = { verified: false, matches: null, head: null };
  if (opts.engine === "pi") {
    const probe = engine as unknown as { getSystemPrompt?: () => string };
    if (typeof probe.getSystemPrompt === "function") {
      const actual = probe.getSystemPrompt();
      injectedPrompt = { verified: true, matches: actual === expectedPrompt, head: actual.slice(0, 60) };
    }
  }

  const startedAt = Date.now();
  const result: CaseRunResult = {
    caseId: caseDesc.caseId,
    engine: capture.name,
    auditEngine,
    promptHash,
    injectedPrompt,
    isolation: { ...loaded.isolation, ...(loaded.violationText ? { violationText: loaded.violationText } : {}) },
    rounds: [],
    wall: { startedAt, finishedAt: 0, ms: 0 },
  };
  let executionError: string | undefined;
  let investigationId = "";
  let sessionCode: string | undefined;
  let prevExternalId: string | undefined;
  const sourceCalls: SourceCallRecord[] = [];

  trace.emit("case_started", { engine: capture.name, maxRounds: caseDesc.maxRounds, promptHash });

  if (!loaded.isolation.ok) {
    // 隔离预检失败：blocked，不进运行（与 eval-v2 同语义），错误如实上报 SDK。
    trace.emit("case_blocked", { violations: loaded.violationText });
    result.wall.finishedAt = Date.now();
    result.wall.ms = result.wall.finishedAt - startedAt;
    throw new Error(`case ${caseDesc.caseId} 隔离预检失败：${loaded.violationText}`);
  }

  try {
    for (let r = 0; r < caseDesc.rounds.length; r++) {
      const round = caseDesc.rounds[r];
      const roundTruth = truth.rounds.find((t) => t.roundId === round.roundId);
      if (!roundTruth) throw new Error(`case ${caseDesc.caseId} 缺少 round ${round.roundId} 的私有标准`);

      const cfg: AppConfig = {
        ...opts.baseConfig,
        sources: {
          ...opts.baseConfig.sources,
          logDir: join(caseDir, round.materialView),
          allowedServices: [...round.services],
          allowedRepos: round.repos.map((repo) => repo.repoId),
          repos: round.repos.map((repo) => ({ repoId: repo.repoId, dir: resolve(opts.projectRoot, repo.dir) })),
        },
      };
      const recordingSource = new RecordingFileLogSource({
        dir: cfg.sources.logDir,
        allowedServices: cfg.sources.allowedServices,
      });

      const baseText = loadRoundMessage(caseDir, round.messageRef);
      const text = r === 0 ? baseText : `${baseText}\n[${SESSION_MARKER_PREFIX}${sessionCode ?? ""}]`;
      const externalMessageId = `${caseDesc.caseId}-t1-r${r + 1}`;
      const inbound: InboundMessage = {
        provider: "feishu",
        accountId: "eval-lf",
        externalMessageId,
        chatId: `oc-eval-lf-${caseDesc.caseId}`,
        chatType: "group",
        mentionedBot: true,
        text,
        receivedAt: Date.parse(round.receivedAt),
        parentId: r > 0 ? prevExternalId : undefined,
      };
      trace.emit("round_input", { roundId: round.roundId, text, receivedAt: inbound.receivedAt, materialView: round.materialView }, { roundId: round.roundId });

      const routed = routeInbound(store, cfg, inbound);
      if (routed.decision.kind !== "new_investigation" && routed.decision.kind !== "continue_investigation") {
        throw new Error(`round ${round.roundId} 入站被拒绝：${JSON.stringify(routed.decision)}`);
      }
      investigationId = routed.investigationId ?? investigationId;
      if (!investigationId) throw new Error(`round ${round.roundId} 入站未返回调查 ID`);
      if (r === 0) sessionCode = routed.sessionCode;
      prevExternalId = externalMessageId;

      const claimed = store.claimNextRun("eval-lf", 60_000);
      if (!claimed) throw new Error(`round ${round.roundId} 没有可领取的 run`);
      trace.emit("run_claimed", { round }, { roundId: round.roundId, runId: claimed.run.id, attemptId: claimed.attemptId });

      let runError: string | undefined;
      let preReadBlock: string | undefined;
      const capStart = capture.captured.length;
      const scopeChecks: ScopeCheckRecord[] = [];
      try {
        await executeRun(
          {
            store,
            config: cfg,
            engine: capture,
            auditor,
            logSource: recordingSource,
            ...(opts.recorder ? { recorder: opts.recorder } : {}),
            onPrepared: ({ scope }) => {
              const resolved = scope.repos.map((r) => ({ repoId: r.repoId, resolvedSha: r.sha ?? null, pinnedBy: r.pinnedBy ?? null }));
              const checks = round.repos.map((repo) => {
                const expected = repo.expectedSha ?? null;
                const actual = resolved.find((x) => x.repoId === repo.repoId);
                if (!actual) return { repoId: repo.repoId, expected, resolvedSha: null, pinnedBy: null, check: "missing-in-scope" as const };
                if (!actual.resolvedSha) return { repoId: repo.repoId, expected, resolvedSha: null, pinnedBy: actual.pinnedBy, check: "unresolved" as const };
                if (expected && actual.resolvedSha !== expected) {
                  return { repoId: repo.repoId, expected, resolvedSha: actual.resolvedSha, pinnedBy: actual.pinnedBy, check: "mismatch" as const };
                }
                return { repoId: repo.repoId, expected, resolvedSha: actual.resolvedSha, pinnedBy: actual.pinnedBy, check: expected ? ("ok" as const) : ("no-expected" as const) };
              });
              const futureTexts = caseDesc.rounds.slice(r + 1).map((x) => loadRoundMessage(caseDir, x.messageRef));
              const repoDirByRepoId = new Map(round.repos.map((repo) => [repo.repoId, resolve(opts.projectRoot, repo.dir)]));
              const scanOkByRepo = new Map<string, { ok: boolean; codes: string[]; detail: string }>();
              for (const c of checks) {
                const repoDir = repoDirByRepoId.get(c.repoId);
                if ((c.check === "ok" || c.check === "no-expected") && c.resolvedSha && repoDir) {
                  const v = scanResolvedTreeForIsolation({ repoDir, sha: c.resolvedSha, label: `${c.repoId}@${c.resolvedSha.slice(0, 10)}`, futureTexts });
                  scanOkByRepo.set(c.repoId, { ok: v.length === 0, codes: v.map((x) => x.code), detail: v.map((x) => x.message).join("; ") });
                }
              }
              trace.emit(
                "scope_resolved",
                { resolved, checks, resolvedScans: [...scanOkByRepo.entries()].map(([repoId, s]) => ({ repoId, ...s })), authorizedServices: [...round.services], materialView: round.materialView },
                { roundId: round.roundId, runId: claimed.run.id },
              );
              for (const c of checks) {
                const scan = scanOkByRepo.get(c.repoId);
                scopeChecks.push({
                  roundId: round.roundId,
                  repoId: c.repoId,
                  expected: c.expected,
                  resolvedSha: c.resolvedSha,
                  check: c.check,
                  resolvedScanOk: scan ? scan.ok : null,
                });
              }
              const bad = checks.find((c) => c.check !== "ok" && c.check !== "no-expected");
              const badScan = [...scanOkByRepo.entries()].find(([, s]) => !s.ok);
              if (badScan) {
                preReadBlock = `版本一致性阻断（模型取证前）：repo ${badScan[0]} 隔离扫描失败 [${badScan[1].codes.join(",")}] ${badScan[1].detail}`;
              } else if (bad) {
                const detail =
                  bad.check === "mismatch"
                    ? `resolved=${bad.resolvedSha} ≠ expected ${bad.expected}`
                    : bad.check === "missing-in-scope"
                      ? "实际材料范围缺少该仓库"
                      : "实际未解析出可读版本（unresolved）";
                preReadBlock = `版本一致性阻断（模型取证前）：repo ${bad.repoId} ${detail}`;
              }
              if (preReadBlock) throw new Error(preReadBlock);
            },
          },
          claimed,
        );
      } catch (err) {
        runError = err instanceof Error ? err.message : String(err);
      }
      if (preReadBlock) runError = preReadBlock;

      const runRow = store.getRun(claimed.run.id)!;
      const roundCalls = capture.captured.slice(capStart);
      const engineCallDetails: EngineCallRecord[] = roundCalls.map((c, i) => ({
        index: i,
        phase: i === 0 ? ("initial" as const) : ("supplement" as const),
        kind: c.kind,
        ...(c.kind === "report" ? { draft: structuredClone(c.draft) as unknown } : { replyText: c.text, reason: c.reason }),
        modelTurns: c.modelTurns,
        ...(c.model ? { model: c.model } : {}),
        wallTime: Date.now(),
      }));
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
      const committed = runRow.status === "succeeded";
      const finalCall = roundCalls.at(-1);
      const initialCall = roundCalls[0];
      const outcome: RoundOutcomeKind = preReadBlock ? "blocked" : committed && !runError ? outcomeOf(finalCall) : "error";
      const reportRow = store.getReportByRun(claimed.run.id);
      const validatedReport = reportRow ? (JSON.parse(reportRow.content) as Record<string, unknown>) : undefined;

      sender.currentRoundId = round.roundId;
      let drained = 0;
      while (drained < DELIVERY_DRAIN_CAP && (await processDeliveriesOnce(store, cfg, sender)) > 0) drained++;
      const roundSends = sender.sent.filter((s) => s.roundId === round.roundId);
      const writebackText = roundSends.at(-1)?.text;

      exportToolEvents(trace, db, { roundId: round.roundId, runId: claimed.run.id });
      exportEvidenceEvents(trace, db, { roundId: round.roundId, runId: claimed.run.id });
      exportUsageEvent(trace, db, { roundId: round.roundId, attemptId: claimed.attemptId });
      const usageRow = db
        .prepare("SELECT usage_input_tokens, usage_output_tokens, usage_cache_tokens, usage_total_tokens FROM attempts WHERE id = ?")
        .get(claimed.attemptId) as Record<string, unknown> | undefined;
      const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
      const usage = {
        inputTokens: numOrNull(usageRow?.usage_input_tokens),
        outputTokens: numOrNull(usageRow?.usage_output_tokens),
        cacheTokens: numOrNull(usageRow?.usage_cache_tokens),
        totalTokens: numOrNull(usageRow?.usage_total_tokens),
      };
      exportAuditEvents(trace, db, { roundId: round.roundId, runId: claimed.run.id });
      trace.emit("output_persisted", { kind: outcome, status: runRow.status }, { roundId: round.roundId, runId: claimed.run.id });
      if (roundSends.length > 0) trace.emit("delivery_captured", { sends: roundSends }, { roundId: round.roundId });

      // 引用解析记录（raw=首轮草稿，validated=终稿；带 wrongSha 核对）。
      const resolver = new StoreEvidenceResolver(store, investigationId, claimed.run.id);
      const expectedShas: Record<string, string> = {};
      for (const repo of round.repos) if (repo.expectedSha) expectedShas[repo.repoId] = repo.expectedSha;
      const citations: CaseRunResult["rounds"][number]["citations"] = [];
      const recordCitations = (stage: "raw" | "validated", ids: string[]) => {
        for (const rawId of ids) {
          const ref = resolver.byUid(investigationId, rawId) ?? resolver.byRunShortId(claimed.run.id, rawId);
          const codeRef = ref?.codeRef ?? undefined;
          const wrongSha = !!codeRef && !!expectedShas[codeRef.repoId] && codeRef.sha !== expectedShas[codeRef.repoId];
          citations.push({ stage, rawId, resolved: !!ref, wrongSha });
        }
      };
      const rawReport = initialCall && initialCall.kind === "report" ? initialCall.draft : undefined;
      const draftHypotheses = rawReport?.hypotheses as Array<{ evidenceIds?: string[] }> | undefined;
      if (draftHypotheses) recordCitations("raw", draftHypotheses.flatMap((h) => h.evidenceIds ?? []));
      if (validatedReport) {
        recordCitations("validated", (validatedReport.hypotheses as Array<{ evidenceIds?: string[] }> | undefined)?.flatMap((h) => h.evidenceIds ?? []) ?? []);
      }

      // 四层可见性上下文（累计跨轮；供 P0「版本与可见性」评估器）。
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
        ? citedEvidence(db, investigationId, (validatedReport.hypotheses as Array<{ evidenceIds?: string[] }> | undefined)?.flatMap((h) => h.evidenceIds ?? []) ?? [])
        : [];
      const satisfaction = computeRequirementSatisfaction({
        caseRoundIds: caseDesc.rounds.map((x) => x.roundId),
        truth,
        roundId: round.roundId,
        ctx: { sourceCalls, persisted, callEvidence, cited, observationLevel: "b-c1-d", c2Reason: "未接请求观测（C2 恒 null）" },
      });
      const visibility: RoundVisibilitySummary = {
        roundId: round.roundId,
        requirements: satisfaction.length,
        applicable: satisfaction.filter((s) => s.applicable).length,
        fullySatisfiedBc1d: satisfaction.filter((s) => s.applicable && s.satisfied.B && s.satisfied.C1 && s.satisfied.D).length,
        details: satisfaction.map((s) => ({
          requirementId: s.requirementId,
          applicable: s.applicable,
          satisfied: { A: s.satisfied.A, B: s.satisfied.B, C1: s.satisfied.C1, C2: s.satisfied.C2, D: s.satisfied.D },
        })),
      };

      const allLogQueriesEmpty = recordingSource.calls.length > 0 && recordingSource.calls.every((c) => c.entries.length === 0);
      result.rounds.push({
        roundId: round.roundId,
        runId: claimed.run.id,
        status: runRow.status,
        outcome,
        blocked: !!preReadBlock,
        ...(runError ? { error: runError } : {}),
        engineCalls: roundCalls.length,
        engineCallDetails: engineCallDetails.map((c) => ({ phase: c.phase, kind: c.kind, ...(c.kind === "reply" ? { replyReason: c.reason } : {}) })),
        report: validatedReport ?? (finalCall?.kind === "reply" ? { kind: "reply", text: finalCall.text } : null),
        replyText: finalCall?.kind === "reply" ? finalCall.text : null,
        writebackText: writebackText ?? null,
        toolCalls: finalCall?.toolCalls ?? 0,
        usage,
        citations,
        scopeChecks,
        visibility,
        allLogQueriesEmpty,
      });
    }
  } catch (err) {
    executionError = err instanceof Error ? err.message : String(err);
    trace.emit("case_error", { error: executionError });
  }

  result.wall.finishedAt = Date.now();
  result.wall.ms = result.wall.finishedAt - startedAt;
  trace.emit("case_finished", { executionError: executionError ?? null, rounds: result.rounds.length, wallMs: result.wall.ms });
  writeFileSync(join(opts.outDir, "artifacts.json"), JSON.stringify({ result, executionError }, null, 2), "utf8");
  if (executionError) throw new Error(`case ${result.caseId} 执行失败：${executionError}`);
  return result;
}
