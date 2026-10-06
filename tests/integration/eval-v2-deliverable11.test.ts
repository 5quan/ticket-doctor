// 交付 1.1 验收反例（七项逐条锁定）。每条先在 a3ebbf3 上复现缺陷，本文件锁定修复后的判定。
//
// #1 outcome 以持久化运行终态 + 成功提交事实为准：审计 failBlocks=true 失败、补证引擎
//    预算耗尽等路径，不得因已有成功草稿而记 report 或通过门禁；failBlocks=false 合法降级正常发布。
// #2 replay 按冻结的 case/trial 身份清单对账：缺 trial 产物、混入清单外目录必须失败。
// #3 显式选题中出现准入拒绝 → 运行即失败；门禁阈值非法（NaN/负数）→ 拒绝。
// #7 审计事件（决定/失败/应用）连同真实时间导出到 trace；脚本审计耗尽 = 硬失败暴露。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateGate } from "../../src/evals/v2/gate.ts";
import { materializeEngineeringCases } from "../../src/evals/v2/engcases.ts";
import { runSuite } from "../../src/evals/v2/runner.ts";
import type { CaseScoreV2, SuiteSummaryV2, TrialArtifacts } from "../../src/evals/v2/types.ts";
import { testConfig } from "../helpers.ts";

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..", "..");
const CLI = join(PROJECT_ROOT, "src", "evals", "v2", "cli.ts");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 在临时 eval root 写一个单轮 scripted+审计工程 case 并入 catalog（隔离预检合法）。 */
function writeAuditCase(
  root: string,
  opts: { caseId: string; script: unknown[]; audit?: unknown[]; auditEnabled?: boolean },
): void {
  const caseDir = join(root, "public", opts.caseId);
  const privateDir = join(root, "private", opts.caseId);
  mkdirSync(join(caseDir, "round-1"), { recursive: true });
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(caseDir, "r1-message.txt"), "checkout-service 服务: 2026-09-06 10:01 起下单失败，帮忙看下");
  writeFileSync(
    join(caseDir, "round-1", "checkout-service.log"),
    "2026-09-06T10:01:58.312+08:00\tERROR\tInventoryClient 调用库存服务失败 timeout after 3000ms traceId=tr_9f2c81\n",
  );
  writeFileSync(
    join(caseDir, "case.json"),
    JSON.stringify({
      schemaVersion: "prediagnosis-case-v2", caseId: opts.caseId, familyId: "d11", split: "engineering",
      sourceTier: "synthetic_engineering", publicBenchmark: false, admission: "admitted", maxRounds: 2,
      scriptedEngine: true, ...(opts.audit ? { scriptedAudit: true } : {}),
      rounds: [{ roundId: "r1", messageRef: "r1-message.txt", receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: "2026-09-06T10:01:00+08:00", materialView: "round-1", services: ["checkout-service"], repos: [{ repoId: "app", dir: "fixtures/evals/checkout-timeout/repo" }] }],
    }),
  );
  writeFileSync(
    join(privateDir, "truth.private.json"),
    JSON.stringify({
      schemaVersion: "prediagnosis-truth-v2", caseId: opts.caseId, locators: [],
      rounds: [{ roundId: "r1", allowedOutcomes: ["report"], allowedClaimDepth: "root", requiredFacts: [], forbiddenRules: [], materialNeeds: [], evidenceRequirements: [], contradictedClaims: [], writebackRequirements: [] }],
      review: { author: "a", reviewer: "b", provisional: true },
    }),
  );
  writeFileSync(join(privateDir, "script.json"), JSON.stringify(opts.script));
  if (opts.audit) writeFileSync(join(privateDir, "audit.json"), JSON.stringify(opts.audit));
  const catalogPath = join(root, "catalog", "catalog.json");
  const catalog = readJson(catalogPath) as { cases: Array<{ caseId: string; publicDir: string; privateDir: string }> };
  catalog.cases.push({ caseId: opts.caseId, publicDir: `public/${opts.caseId}`, privateDir: `private/${opts.caseId}` });
  writeFileSync(catalogPath, JSON.stringify(catalog));
}

const REPORT_STEP = {
  kind: "report",
  tools: [{ tool: "queryLogs", args: { service: "checkout-service", from: 0, to: Date.parse("2026-09-06T12:00:00+08:00"), keywords: [] } }],
  draft: {
    completeness: "complete", summary: "库存服务调用超时导致下单失败", confirmedFacts: [],
    hypotheses: [{ cause: "库存服务调用超时导致下单失败", confidence: "high", status: "supported", evidenceIds: [] }],
    uncertainties: [], nextSteps: [], missingMaterial: [],
  },
};

// ---------- #1a 审计 failBlocks=true 失败：不得因已有草稿记 report ----------

test("#1a 审计失败（failBlocks=true）：运行终态 failed → outcome=error + 硬失败，不是 report", async () => {
  const root = mkdtempSync(join(tmpdir(), "d11-auditfail-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    writeAuditCase(root, {
      caseId: "d11-audit-fail",
      script: [REPORT_STEP],
      audit: [{ failure: "审计器确定性故障注入" }],
    });
    const cfg = testConfig();
    cfg.diagnosis.audit = { enabled: true, allowRetrieval: false, failBlocks: true, maxRounds: 1 };
    const summary = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "d11-a", engine: "scripted", repeat: 1,
      baseConfig: cfg, caseIds: ["d11-audit-fail"],
    });
    const trial: CaseScoreV2 | undefined = summary.cases.find((c) => c.caseId === "d11-audit-fail")?.trials[0];
    assert.ok(trial, "trial 应出分");
    assert.equal(trial.roundScores[0]!.outcome, "error", "运行终态非 succeeded → outcome 必须是 error（修复前：report）");
    assert.equal(trial.executionSuccess, false);
    assert.ok(
      trial.hardFailures.some((f) => f.code === "outcome_out_of_policy"),
      "失败轮必须产生硬失败（门禁可拦截）",
    );
    // 事实核对：草稿确实被捕获过（成功草稿存在），但落库终态是失败——outcome 不看草稿。
    const outputs = readJson(join(root, "runs", "d11-a", "d11-audit-fail", "t1", "outputs.json")) as { artifacts: TrialArtifacts };
    assert.ok(outputs.artifacts.rounds[0]!.rawDraft, "初稿仍保留（不因失败删除）");
    assert.notEqual(outputs.artifacts.rounds[0]!.status, "succeeded", "持久化终态应为失败/重试");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- #1b 补证引擎预算耗尽：不得记 report ----------

test("#1b 补证阶段预算耗尽：终态非 succeeded → outcome=error（修复前：拿初稿记 report）", async () => {
  const root = mkdtempSync(join(tmpdir(), "d11-budget-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    writeAuditCase(root, {
      caseId: "d11-budget",
      // 初稿 2 次工具调用成功 → 审计要求补证 → 补证稿再要 2 次 → 总预算 3 耗尽
      script: [
        { ...REPORT_STEP, tools: [{ tool: "queryLogs", args: { service: "checkout-service", from: 0, to: Date.parse("2026-09-06T12:00:00+08:00"), keywords: [] } }, { tool: "listFiles", args: { repoId: "app" } }] },
        { ...REPORT_STEP, tools: [{ tool: "queryLogs", args: { service: "checkout-service", from: 0, to: Date.parse("2026-09-06T12:00:00+08:00"), keywords: [] } }, { tool: "listFiles", args: { repoId: "app" } }] },
      ],
      audit: [{ missingEvidence: [{ hypothesisIndex: 0, what: "需要更多日志" }], stopAdvice: { action: "continue", reason: "材料不足" } }],
    });
    const cfg = testConfig();
    cfg.diagnosis.maxToolCalls = 3;
    cfg.diagnosis.audit = { enabled: true, allowRetrieval: false, failBlocks: false, maxRounds: 1 };
    const summary = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "d11-b", engine: "scripted", repeat: 1,
      baseConfig: cfg, caseIds: ["d11-budget"],
    });
    const trial = summary.cases.find((c) => c.caseId === "d11-budget")?.trials[0];
    assert.ok(trial, "trial 应出分");
    assert.equal(trial.roundScores[0]!.outcome, "error", "预算耗尽（budget_tools）→ outcome=error（修复前：初稿被记为 report）");
    assert.equal(trial.executionSuccess, false);
    assert.ok(trial.hardFailures.some((f) => f.code === "outcome_out_of_policy"));
    const outputs = readJson(join(root, "runs", "d11-b", "d11-budget", "t1", "outputs.json")) as { artifacts: TrialArtifacts };
    assert.equal(outputs.artifacts.rounds[0]!.engineCalls.length, 1, "只有初稿完成（补证调用未完成不占位）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- #1c failBlocks=false 合法降级：仍正常发布 ----------

test("#1c 审计失败但 failBlocks=false：合法降级发布，outcome=report 且无硬失败", async () => {
  const root = mkdtempSync(join(tmpdir(), "d11-degrade-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    writeAuditCase(root, {
      caseId: "d11-degrade",
      script: [REPORT_STEP],
      audit: [{ failure: "审计器确定性故障注入" }],
    });
    const cfg = testConfig();
    cfg.diagnosis.audit = { enabled: true, allowRetrieval: false, failBlocks: false, maxRounds: 1 };
    const summary = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "d11-c", engine: "scripted", repeat: 1,
      baseConfig: cfg, caseIds: ["d11-degrade"],
    });
    const trial = summary.cases.find((c) => c.caseId === "d11-degrade")?.trials[0];
    assert.ok(trial, "trial 应出分");
    assert.equal(trial.executionSuccess, true, "合法降级（failBlocks=false）应正常发布");
    assert.equal(trial.roundScores[0]!.outcome, "report");
    assert.deepEqual(trial.hardFailures.filter((f) => f.code === "outcome_out_of_policy"), [], "降级发布不产生越界硬失败");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- #7 脚本审计耗尽 = 硬失败 + 审计事件入 trace ----------

test("#7 审计脚本耗尽：硬失败暴露（修复前：默认放行静默通过）；审计事件带真实时间入 trace", async () => {
  const root = mkdtempSync(join(tmpdir(), "d11-exhaust-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    // 两轮 → 两次审计调用，但只提供 1 个审计步骤 → 第 2 次落在默认放行上
    const caseDir = join(root, "public", "d11-exhaust");
    const privateDir = join(root, "private", "d11-exhaust");
    mkdirSync(join(caseDir, "round-1"), { recursive: true });
    mkdirSync(join(caseDir, "round-2"), { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(join(caseDir, "r1-message.txt"), "checkout-service: 报障");
    writeFileSync(join(caseDir, "r2-message.txt"), "checkout-service: 跟进");
    writeFileSync(join(caseDir, "round-1", "checkout-service.log"), "2026-09-06T10:01:58+08:00\tERROR\tx\n");
    writeFileSync(join(caseDir, "round-2", "checkout-service.log"), "2026-09-06T10:01:58+08:00\tERROR\tx\n");
    writeFileSync(join(caseDir, "case.json"), JSON.stringify({
      schemaVersion: "prediagnosis-case-v2", caseId: "d11-exhaust", familyId: "d11", split: "engineering",
      sourceTier: "synthetic_engineering", publicBenchmark: false, admission: "admitted", maxRounds: 2,
      scriptedEngine: true, scriptedAudit: true,
      rounds: [
        { roundId: "r1", messageRef: "r1-message.txt", receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: null, materialView: "round-1", services: ["checkout-service"], repos: [{ repoId: "app", dir: "fixtures/evals/checkout-timeout/repo" }] },
        { roundId: "r2", messageRef: "r2-message.txt", receivedAt: "2026-09-06T10:40:00+08:00", occurredAt: null, materialView: "round-2", services: ["checkout-service"], repos: [{ repoId: "app", dir: "fixtures/evals/checkout-timeout/repo" }] },
      ],
    }));
    const truthRound = { roundId: "r1", allowedOutcomes: ["report"], allowedClaimDepth: "root", requiredFacts: [], forbiddenRules: [], materialNeeds: [], evidenceRequirements: [], contradictedClaims: [], writebackRequirements: [] };
    writeFileSync(join(privateDir, "truth.private.json"), JSON.stringify({
      schemaVersion: "prediagnosis-truth-v2", caseId: "d11-exhaust", locators: [],
      rounds: [truthRound, { ...truthRound, roundId: "r2" }],
      review: { author: "a", reviewer: "b", provisional: true },
    }));
    writeFileSync(join(privateDir, "script.json"), JSON.stringify([REPORT_STEP, REPORT_STEP]));
    // 只给 1 个审计步骤：r2 的审计调用必然耗尽
    writeFileSync(join(privateDir, "audit.json"), JSON.stringify([{ verdicts: [{ hypothesisIndex: 0, verdict: "supported", reason: "ok" }], missingEvidence: [], stopAdvice: { action: "stop", reason: "ok" } }]));
    const catalogPath = join(root, "catalog", "catalog.json");
    const catalog = readJson(catalogPath) as { cases: Array<{ caseId: string; publicDir: string; privateDir: string }> };
    catalog.cases.push({ caseId: "d11-exhaust", publicDir: "public/d11-exhaust", privateDir: "private/d11-exhaust" });
    writeFileSync(catalogPath, JSON.stringify(catalog));

    const cfg = testConfig();
    cfg.diagnosis.audit = { enabled: true, allowRetrieval: false, failBlocks: false, maxRounds: 1 };
    const summary = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "d11-e", engine: "scripted", repeat: 1,
      baseConfig: cfg, caseIds: ["d11-exhaust"],
    });
    const trial = summary.cases.find((c) => c.caseId === "d11-exhaust")?.trials[0];
    assert.ok(trial, "trial 应出分");
    assert.ok(
      trial.hardFailures.some((f) => f.code === "audit_script_exhausted"),
      "脚本耗尽必须硬失败暴露（修复前：默认放行静默通过）",
    );
    const trialDir = join(root, "runs", "d11-e", "d11-exhaust", "t1");
    const outputs = readJson(join(trialDir, "outputs.json")) as { artifacts: TrialArtifacts; scorerInput: { auditScriptExhausted?: boolean } };
    assert.equal(outputs.artifacts.auditEngine, "scripted-audit", "逐 trial 实际审计器入账");
    assert.deepEqual(outputs.artifacts.auditScript, { provided: 1, consumed: 1, exhaustedCalls: 1 });
    assert.equal(outputs.scorerInput.auditScriptExhausted, true);

    // 审计决定/应用事件导出：两轮各有 audit_event（含真实 occurredAt）
    const traceText = readFileSync(join(trialDir, "trace.jsonl"), "utf8");
    const auditEvents = traceText.trim().split("\n").map((l) => JSON.parse(l) as { eventType: string; roundId?: string; payload?: { auditType?: string; occurredAt?: number | null; derived?: boolean } }).filter((e) => e.eventType === "audit_event");
    assert.ok(auditEvents.length >= 3, `应导出 ≥3 条审计事件（round×audit_round + audit_applied）：实际 ${auditEvents.length}`);
    assert.ok(auditEvents.every((e) => e.payload?.derived === true));
    assert.ok(auditEvents.every((e) => typeof e.payload?.occurredAt === "number" && e.payload.occurredAt > 0), "必须携带真实发生时间");
    assert.ok(auditEvents.some((e) => e.payload?.auditType === "audit_applied"), "最终应用事件必须可回放");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- #2 replay 按冻结身份清单对账（CLI 级） ----------

test("#2 replay 对账：删除 trial 产物 / 混入清单外目录 → 失败；完整 → 通过", async () => {
  const root = mkdtempSync(join(tmpdir(), "d11-replay-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "d11-r", engine: "scripted", repeat: 2,
      baseConfig: testConfig(), caseIds: ["eng-clarify"],
    });
    const runDir = join(root, "runs", "d11-r");
    const trialsJson = readJson(join(runDir, "trials.json")) as { identities: Array<{ caseId: string; trialId: string }> };
    assert.equal(trialsJson.identities.length, 2, "冻结清单 = 计划 trial 数（运行前落盘）");

    const runCli = (args: string[]): { status: number; out: string } => {
      try {
        const out = execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...args, "--eval-root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { status: 0, out };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    };

    // 完整 → 通过
    let r = runCli(["replay", "--suite", "d11-r"]);
    assert.equal(r.status, 0, `完整产物应通过：${r.out}`);

    // 删除一个 trial 的 outputs.json → 失败
    rmSync(join(runDir, "eng-clarify", "t2", "outputs.json"));
    r = runCli(["replay", "--suite", "d11-r"]);
    assert.equal(r.status, 1, "缺 trial 产物必须失败");
    assert.match(r.out, /缺少必要产物/);

    // 整个 trial 目录消失 → 失败（修复前：目录遍历根本看不到它）
    rmSync(join(runDir, "eng-clarify", "t2"), { recursive: true, force: true });
    r = runCli(["replay", "--suite", "d11-r"]);
    assert.equal(r.status, 1, "缺完整 trial 必须失败");
    assert.match(r.out, /缺少产物目录/);

    // 混入清单外目录 → 失败
    mkdirSync(join(runDir, "eng-clarify", "t9"), { recursive: true });
    r = runCli(["replay", "--suite", "d11-r"]);
    assert.equal(r.status, 1, "清单外产物目录必须失败");
    assert.match(r.out, /不在冻结身份清单中/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- #3 显式选题准入拒绝 → 失败；门禁阈值非法 → 拒绝 ----------

test("#3 显式选题含准入拒绝 case → 运行即失败（分母不得静默缩小）", async () => {
  const root = mkdtempSync(join(tmpdir(), "d11-select-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    // 一个 development + qualified 的 case（未准入）
    const caseDir = join(root, "public", "d11-notadmitted");
    const privateDir = join(root, "private", "d11-notadmitted");
    mkdirSync(join(caseDir, "round-1"), { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(join(caseDir, "r1-message.txt"), "x");
    writeFileSync(join(caseDir, "case.json"), JSON.stringify({
      schemaVersion: "prediagnosis-case-v2", caseId: "d11-notadmitted", familyId: "d11", split: "development",
      sourceTier: "synthetic_engineering", publicBenchmark: false, admission: "qualified", maxRounds: 1,
      rounds: [{ roundId: "r1", messageRef: "r1-message.txt", receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: null, materialView: "round-1", services: [], repos: [] }],
    }));
    writeFileSync(join(privateDir, "truth.private.json"), JSON.stringify({
      schemaVersion: "prediagnosis-truth-v2", caseId: "d11-notadmitted", locators: [],
      rounds: [{ roundId: "r1", allowedOutcomes: ["report"], allowedClaimDepth: "root", requiredFacts: [], forbiddenRules: [], materialNeeds: [], evidenceRequirements: [], contradictedClaims: [], writebackRequirements: [] }],
      review: { author: "a", reviewer: "b", provisional: true },
    }));
    const catalogPath = join(root, "catalog", "catalog.json");
    const catalog = readJson(catalogPath) as { cases: Array<{ caseId: string; publicDir: string; privateDir: string }> };
    catalog.cases.push({ caseId: "d11-notadmitted", publicDir: "public/d11-notadmitted", privateDir: "private/d11-notadmitted" });
    writeFileSync(catalogPath, JSON.stringify(catalog));

    // 全量运行：准入拒绝单独计数，不算失败
    const summaryAll = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "d11-s-all", engine: "scripted", repeat: 1,
      baseConfig: testConfig(), caseIds: ["d11-notadmitted"],
    }).catch((err: Error) => err as unknown as SuiteSummaryV2);
    assert.ok((summaryAll as unknown as Error).message, "显式选题 = 只有未准入 case → 必须失败");
    assert.match((summaryAll as unknown as Error).message!, /准入拒绝/);

    // 全量（无 --cases）：准入拒绝计数，不失败
    const ok = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "d11-s-ok", engine: "scripted", repeat: 1,
      baseConfig: testConfig(),
    });
    assert.equal(ok.counts.admissionRejected, 1);
    assert.equal(ok.selected, ok.planned.cases + 1, "selected/planned 分离：selected 含被拒 case");
    assert.ok(ok.planned.cases >= 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#3 门禁阈值非法（NaN/负数）→ exit 2；冻结漂移/git unknown → 门禁失败", async () => {
  const root = mkdtempSync(join(tmpdir(), "d11-gate-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    const runCli = (args: string[]): { status: number; out: string } => {
      try {
        const out = execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...args, "--eval-root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { status: 0, out };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    };
    // NaN 阈值：运行前拒绝（修复前：hard > NaN 恒 false，静默通过）
    const r1 = runCli(["run", "--suite", "d11-g-nan", "--gate", "on", "--max-hard-failures", "abc"]);
    assert.equal(r1.status, 2, `NaN 阈值必须 exit 2：${r1.out}`);
    assert.match(r1.out, /非法 --max-hard-failures/);
    // 负数阈值：拒绝
    const r2 = runCli(["run", "--suite", "d11-g-neg", "--gate", "on", "--max-hard-failures", "-1"]);
    assert.equal(r2.status, 2, "负数阈值必须 exit 2");
    // 正常门禁（阈值 0、无硬失败）：通过
    const r3 = runCli(["run", "--suite", "d11-g-ok", "--engine", "scripted", "--gate", "on", "--max-hard-failures", "0"]);
    assert.equal(r3.status, 0, `合法门禁应通过：${r3.out}`);
    assert.match(r3.out, /freeze=ok/);
    assert.match(r3.out, /git=ok/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- #4 冻结复核与项目身份阻断门禁（gate.ts 纯函数 + CLI 阈值） ----------

test("#4 freezeCheck=false / git unknown → 门禁失败（修复前：门禁不读 manifest）", async () => {
  const root = mkdtempSync(join(tmpdir(), "d11-freeze-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    execFileSync(process.execPath, ["--experimental-strip-types", CLI, "run", "--suite", "d11-f", "--engine", "scripted", "--gate", "on", "--eval-root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const manifestPath = join(root, "runs", "d11-f", "manifest.json");
    const manifest = readJson(manifestPath) as { freezeCheck: { ok: boolean; drifts: unknown[] }; project: { gitState: string } };

    // 正常 manifest → 门禁通过（基线）
    const summaryAll = readJson(join(root, "runs", "d11-f", "summary.json")) as Parameters<typeof evaluateGate>[0]["summary"];
    const ok1 = evaluateGate({ summary: summaryAll, manifest: manifest as never, maxHard: 0 });
    assert.equal(ok1.ok, true, ok1.error);

    // 漂移：freezeCheck=false → 失败
    const drifted = structuredClone(manifest) as typeof manifest;
    drifted.freezeCheck = { ok: false, drifts: [{ caseId: "eng-clarify", details: ["材料视图变更"] }] };
    const ok2 = evaluateGate({ summary: summaryAll, manifest: drifted as never, maxHard: 0 });
    assert.equal(ok2.ok, false, "freezeCheck=false 必须阻断门禁");
    assert.match(ok2.error!, /冻结复核失败/);

    // git unknown：身份指纹不完整 → 失败
    const unknownGit = structuredClone(manifest) as typeof manifest;
    unknownGit.project.gitState = "unknown";
    const ok3 = evaluateGate({ summary: summaryAll, manifest: unknownGit as never, maxHard: 0 });
    assert.equal(ok3.ok, false, "git unknown 必须阻断门禁");
    assert.match(ok3.error!, /unknown/);

    // manifest 缺失 → 失败
    const ok4 = evaluateGate({ summary: summaryAll, manifest: null, maxHard: 0 });
    assert.equal(ok4.ok, false);
    assert.ok(existsSync(manifestPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
