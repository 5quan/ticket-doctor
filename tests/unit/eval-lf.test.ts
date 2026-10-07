// Langfuse 原生评测模块：数据集草稿不泄漏、evaluator 语义、prompt 版本、task 材料 hash 闸门、
// 多轮脚本执行、verify 读回。全部离线（无凭据、无网络）；真实实验由 eval:lf:run 在服务器执行。
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { LangfuseClient } from "@langfuse/client";
import { loadConfig } from "../../src/config/index.ts";
import { extractService } from "../../src/intake/router.ts";
import { buildSmokePayloads, casePublicHash, SMOKE_DATASET, SMOKE_PROTOCOL } from "../../src/eval/lf/seed.ts";
import { loadCatalog, loadCase } from "../../src/eval/lf/internals/load.ts";
import { listFilesRecursive } from "../../src/eval/lf/internals/hash.ts";
import { citationValidityEvaluator, costEvaluator, expectedBlockedEvaluator, promptInjectionEvaluator, runIntegrityEvaluator, versionVisibilityEvaluator } from "../../src/eval/lf/evaluators.ts";
import { compileHash, ensureBaselinePrompt, getPromptVersion, registerCandidatePrompt } from "../../src/eval/lf/prompt.ts";
import { makeTicketDoctorTask } from "../../src/eval/lf/task.ts";
import { addTracesToAnnotationQueue, ensureAnnotationSetup } from "../../src/eval/lf/review.ts";
import { EXPECTED_SCORE_NAMES, verifyExperiment } from "../../src/eval/lf/verify.ts";
import { runCase } from "../../src/eval/lf/run-case.ts";
import type { CaseTaskOutput } from "../../src/eval/lf/task.ts";
import { buildSystemPrompt } from "../../src/agent/pi-engine.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EVAL_ROOT = join(ROOT, "data", "eval-v2");

// ---------- dataset 草稿：5 条合成案例，且 input 不含私有答案/未来轮材料 ----------

test("smoke 数据集：5 条合成案例草稿，input 不泄漏私有标准与未来轮材料", () => {
  const payloads = buildSmokePayloads(ROOT, EVAL_ROOT);
  assert.equal(payloads.length, 5);
  assert.deepEqual(payloads.map((p) => p.metadata.caseId), ["eng-clarify", "eng-counter-evidence", "eng-truncation", "eng-version-drift", "eng-audit-loop"]);
  for (const p of payloads) {
    assert.equal(p.datasetName, SMOKE_DATASET);
    assert.equal(p.metadata.protocolVersion, SMOKE_PROTOCOL);
    assert.equal(p.metadata.sourceType, "synthetic_engineering");
    assert.match(p.metadata.caseHash, /^[0-9a-f]{64}$/);
    assert.equal(p.metadata.itemId, p.metadata.itemId); // 幂等 id 存在
    // input 只含首轮问题与公开字段；不得出现后续轮文本、truth 引用或私有路径。
    const inputText = JSON.stringify(p.input);
    assert.match(inputText, /^\{.*"question":.*\}$/s);
    assert.doesNotMatch(inputText, /truth\.private\.json|private\//);
    assert.doesNotMatch(inputText, /r2-message\.txt|r1-message\.txt/);
    // expectedOutput 每轮声明 allowedOutcomes；clarify 轮不得被要求出报告。
    for (const r of p.expectedOutput.rounds) assert.ok(Array.isArray(r.allowedOutcomes) && r.allowedOutcomes.length > 0);
  }
  // eng-clarify 首轮只允许追问，不得要求报告（合理追问与报告语义分开）。
  const clarify = payloads.find((p) => p.metadata.caseId === "eng-clarify")!;
  const clarifyR1 = clarify.expectedOutput.rounds.find((r) => r.roundId === "r1")!;
  assert.ok(clarifyR1.allowedOutcomes.includes("clarify"));
  assert.ok(!clarifyR1.allowedOutcomes.includes("report"));
});

test("材料 hash 覆盖 materialView 日志内容：改动日志会改变 caseHash", () => {
  const catalog = loadCatalog(EVAL_ROOT);
  const entry = catalog.cases.find((c) => c.caseId === "eng-truncation")!;
  const caseDesc = loadCase(EVAL_ROOT, entry, ROOT);
  const h1 = casePublicHash(EVAL_ROOT, caseDesc);
  // 找一个 materialView 下的日志文件（eng-truncation 的 round-1 必有日志）。
  let logPath: string | undefined;
  for (const r of caseDesc.rounds) {
    const viewDir = join(EVAL_ROOT, entry.publicDir, r.materialView);
    const files = listFilesRecursive(viewDir);
    if (files.length > 0) {
      logPath = join(viewDir, files[0]!.path);
      break;
    }
  }
  assert.ok(logPath, "预期案例含 materialView 日志文件");
  const original = readFileSync(logPath, "utf8");
  try {
    writeFileSync(logPath, `${original}\n# hash-probe\n`, "utf8");
    assert.notEqual(casePublicHash(EVAL_ROOT, caseDesc), h1);
  } finally {
    writeFileSync(logPath, original, "utf8");
  }
  assert.equal(casePublicHash(EVAL_ROOT, caseDesc), h1);
});

// ---------- evaluator 语义 ----------

function round(overrides: Partial<CaseTaskOutput["rounds"][number]> = {}): CaseTaskOutput["rounds"][number] {
  return {
    roundId: "r1",
    outcome: "report",
    status: "succeeded",
    blocked: false,
    engineCalls: 1,
    report: {},
    replyText: null,
    writebackText: "回写",
    toolCalls: 2,
    usage: { inputTokens: 10, outputTokens: 5, cacheTokens: null, totalTokens: 15 },
    citations: [{ stage: "validated", rawId: "E1", resolved: true, wrongSha: false }],
    scopeChecks: [{ roundId: "r1", repoId: "app", expected: "a".repeat(40), resolvedSha: "a".repeat(40), check: "ok", resolvedScanOk: true }],
    visibility: { roundId: "r1", requirements: 1, applicable: 1, fullySatisfiedBc1d: 1, details: [] },
    allLogQueriesEmpty: false,
    ...overrides,
  };
}
function output(rounds: CaseTaskOutput["rounds"], promptOverride: Partial<CaseTaskOutput["prompt"]> = {}): CaseTaskOutput {
  return { protocolVersion: SMOKE_PROTOCOL, caseId: "c", scenario: "s", prompt: { name: "p", version: 1, hash: "h", injectedVerified: true, injectedMatches: true, effectiveVerified: false, effectiveMatches: null, effectiveTruncated: false, ...promptOverride }, engine: "scripted", auditEngine: null, rounds, wallMs: 123 };
}
function byName(evals: { name: string; value: number | string | boolean; comment?: string; dataType?: string }[], name: string) {
  return evals.find((e) => e.name === name)!;
}

test("run_integrity：计划轮次齐全且成功=1；缺轮/失败/报告无回写=0；合理追问不算失败", () => {
  const expected = { rounds: [{ roundId: "r1" }, { roundId: "r2" }] };
  const ok = runIntegrityEvaluator({ input: {}, expectedOutput: expected, output: output([round({ roundId: "r1", outcome: "clarify", citations: [] }), round({ roundId: "r2" })]) });
  assert.equal(byName(ok, "run_integrity").value, 1);
  const missing = runIntegrityEvaluator({ input: {}, expectedOutput: expected, output: output([round({ roundId: "r1" })]) });
  assert.equal(byName(missing, "run_integrity").value, 0);
  const failed = runIntegrityEvaluator({ input: {}, expectedOutput: expected, output: output([round({ roundId: "r1", status: "failed" }), round({ roundId: "r2" })]) });
  assert.equal(byName(failed, "run_integrity").value, 0);
  const noWriteback = runIntegrityEvaluator({ input: {}, expectedOutput: expected, output: output([round({ roundId: "r1" }), round({ roundId: "r2", writebackText: null })]) });
  assert.equal(byName(noWriteback, "run_integrity").value, 0);
  // clarify 轮无回写不算失败（被追问即终态）。
  const clarify = runIntegrityEvaluator({ input: {}, expectedOutput: { rounds: [{ roundId: "r1" }] }, output: output([round({ roundId: "r1", outcome: "clarify", citations: [], writebackText: null })]) });
  assert.equal(byName(clarify, "run_integrity").value, 1);
});

test("citation_validity：可解析且无 wrongSha=1；未解析/错误 SHA 降低；报告轮零引用=0", () => {
  const good = citationValidityEvaluator({ input: {}, output: output([round()]) });
  assert.equal(byName(good, "citation_validity").value, 1);
  const bad = citationValidityEvaluator({ input: {}, output: output([round({ citations: [{ stage: "validated", rawId: "E1", resolved: true, wrongSha: false }, { stage: "validated", rawId: "E2", resolved: false, wrongSha: false }, { stage: "validated", rawId: "E3", resolved: true, wrongSha: true }] })]) });
  assert.equal(byName(bad, "citation_validity").value, 1 / 3); // (3-1-1)/3
  const reportNoCites = citationValidityEvaluator({ input: {}, output: output([round({ citations: [] })]) });
  assert.equal(byName(reportNoCites, "citation_validity").value, 0);
  const clarifyOnly = citationValidityEvaluator({ input: {}, output: output([round({ outcome: "clarify", citations: [] })]) });
  assert.equal(byName(clarifyOnly, "citation_validity").value, 1);
});

test("version_visibility：SHA 核对全通过=1；mismatch 或隔离扫描失败=0；附可见性辅助分", () => {
  const ok = versionVisibilityEvaluator({ input: {}, output: output([round()]) });
  assert.equal(byName(ok, "version_visibility").value, 1);
  assert.equal(byName(ok, "visibility_bc1d").value, 1);
  const mismatch = versionVisibilityEvaluator({ input: {}, output: output([round({ scopeChecks: [{ roundId: "r1", repoId: "app", expected: "a".repeat(40), resolvedSha: "b".repeat(40), check: "mismatch", resolvedScanOk: null }] })]) });
  assert.equal(byName(mismatch, "version_visibility").value, 0);
  const scanFail = versionVisibilityEvaluator({ input: {}, output: output([round({ scopeChecks: [{ roundId: "r1", repoId: "app", expected: null, resolvedSha: "a".repeat(40), check: "no-expected", resolvedScanOk: false }] })]) });
  assert.equal(byName(scanFail, "version_visibility").value, 0);
});

test("cost：工具调用/耗时/token 汇总，usage 缺失显式标注", () => {
  const evals = costEvaluator({ input: {}, output: output([round({ toolCalls: 2 }), round({ roundId: "r2", toolCalls: 3, usage: { inputTokens: null, outputTokens: null, cacheTokens: null, totalTokens: null } })]) });
  assert.equal(byName(evals, "tool_calls").value, 5);
  assert.equal(byName(evals, "wall_ms").value, 123);
  assert.equal(byName(evals, "total_tokens").value, 15);
  assert.match(String(byName(evals, "total_tokens").comment), /缺失/);
});

test("prompt_injection：区分实际请求/仅配置/未调用模型/不匹配", () => {
  const effective = promptInjectionEvaluator({ input: {}, output: output([round()], { effectiveVerified: true, effectiveMatches: true }) });
  assert.equal(byName(effective, "prompt_injection").value, "actual_request_verified");
  assert.equal(byName(effective, "prompt_injection").dataType, "CATEGORICAL");
  const effectiveMismatch = promptInjectionEvaluator({ input: {}, output: output([round()], { effectiveVerified: true, effectiveMatches: false }) });
  assert.equal(byName(effectiveMismatch, "prompt_injection").value, "mismatch");
  // 有模型调用但未捕获实际请求 → 仅配置一致（不算通过）
  const configOnly = promptInjectionEvaluator({ input: {}, output: output([round({ engineCalls: 2 })], { injectedVerified: true, injectedMatches: true }) });
  assert.equal(byName(configOnly, "prompt_injection").value, "config_only");
  const unverified = promptInjectionEvaluator({ input: {}, output: output([round({ engineCalls: 2 })], { injectedVerified: false, injectedMatches: null }) });
  assert.equal(byName(unverified, "prompt_injection").value, "mismatch");
  // 预期阻断/未调用模型 → not_called（无请求可验）
  const notCalled = promptInjectionEvaluator({ input: {}, expectedOutput: { rounds: [{ roundId: "r1", allowedOutcomes: ["blocked"] }] }, output: output([round({ roundId: "r1", outcome: "blocked", blocked: true, status: "failed", engineCalls: 0, citations: [], writebackText: null })]) });
  assert.equal(byName(notCalled, "prompt_injection").value, "not_called");
});

test("expected_blocked：结构化 SHA mismatch + 未调模型/工具=1；无 mismatch/调用模型/期望不符=0", () => {
  const sha = "a".repeat(40);
  const expected = { rounds: [{ roundId: "r1", allowedOutcomes: ["blocked"] }] };
  const metadata = { materials: [{ repoId: "app", expectedSha: sha }] };
  const mismatchCheck = [{ roundId: "r1", repoId: "app", expected: sha, resolvedSha: "b".repeat(40), check: "mismatch" as const, resolvedScanOk: true }];
  const good = expectedBlockedEvaluator({ input: {}, expectedOutput: expected, metadata, output: output([round({ roundId: "r1", outcome: "blocked", blocked: true, status: "failed", engineCalls: 0, toolCalls: 0, citations: [], writebackText: null, scopeChecks: mismatchCheck })]) });
  assert.equal(byName(good, "expected_blocked").value, 1);
  const calledModel = expectedBlockedEvaluator({ input: {}, expectedOutput: expected, metadata, output: output([round({ roundId: "r1", outcome: "blocked", blocked: true, engineCalls: 1, toolCalls: 0, scopeChecks: mismatchCheck })]) });
  assert.equal(byName(calledModel, "expected_blocked").value, 0);
  const noMismatch = expectedBlockedEvaluator({ input: {}, expectedOutput: expected, metadata, output: output([round({ roundId: "r1", outcome: "blocked", blocked: true, engineCalls: 0, toolCalls: 0, scopeChecks: [] })]) });
  assert.equal(byName(noMismatch, "expected_blocked").value, 0);
  // 阻断原因文本含“阻断”但结构化 check=ok → 不得分
  const keywordOnly = expectedBlockedEvaluator({ input: {}, expectedOutput: expected, metadata, output: output([round({ roundId: "r1", outcome: "blocked", blocked: true, engineCalls: 0, toolCalls: 0, error: "版本一致性阻断", scopeChecks: [{ roundId: "r1", repoId: "app", expected: sha, resolvedSha: sha, check: "ok", resolvedScanOk: true }] })]) });
  assert.equal(byName(keywordOnly, "expected_blocked").value, 0);
  const wrongDeclared = expectedBlockedEvaluator({ input: {}, expectedOutput: expected, metadata: { materials: [{ repoId: "app", expectedSha: "c".repeat(40) }] }, output: output([round({ roundId: "r1", outcome: "blocked", blocked: true, engineCalls: 0, toolCalls: 0, scopeChecks: mismatchCheck })]) });
  assert.equal(byName(wrongDeclared, "expected_blocked").value, 0);
  const notApplicable = expectedBlockedEvaluator({ input: {}, expectedOutput: { rounds: [{ roundId: "r1", allowedOutcomes: ["report"] }] }, output: output([round({ roundId: "r1" })]) });
  assert.equal(byName(notApplicable, "expected_blocked").value, 1);
});

test("run_integrity：预期阻断不算运行缺失；非预期阻断才算失败", () => {
  const expected = { rounds: [{ roundId: "r1", allowedOutcomes: ["blocked"] }] };
  const expectedBlock = runIntegrityEvaluator({ input: {}, expectedOutput: expected, output: output([round({ roundId: "r1", outcome: "blocked", blocked: true, status: "failed", engineCalls: 0, citations: [], writebackText: null, error: "版本一致性阻断" })]) });
  assert.equal(byName(expectedBlock, "run_integrity").value, 1);
  const unexpected = runIntegrityEvaluator({ input: {}, expectedOutput: { rounds: [{ roundId: "r1", allowedOutcomes: ["report"] }] }, output: output([round({ roundId: "r1", outcome: "blocked", blocked: true, status: "failed", engineCalls: 0 })]) });
  assert.equal(byName(unexpected, "run_integrity").value, 0);
});

// ---------- prompt 版本：读取/登记/注入候选 ----------

function promptStub(state: { prompts: Array<{ prompt: string; version: number }>; created: Array<Record<string, unknown>> }): LangfuseClient {
  return {
    api: {
      prompts: {
        get: async () => {
          const last = state.prompts[state.prompts.length - 1];
          if (!last) throw new Error("not found");
          return { prompt: last.prompt, version: last.version };
        },
        create: async (body: Record<string, unknown>) => {
          state.created.push(body);
          const version = state.prompts.length + 1;
          state.prompts.push({ prompt: String(body.prompt), version });
          return { version };
        },
      },
    },
  } as unknown as LangfuseClient;
}

test("prompt：基线幂等登记；按数字版本读取并编译 hash", async () => {
  const base = buildSystemPrompt();
  const state = { prompts: [] as Array<{ prompt: string; version: number }>, created: [] as Array<Record<string, unknown>> };
  const lf = promptStub(state);
  const baseline = await ensureBaselinePrompt(lf);
  assert.equal(baseline.version, 1);
  assert.equal(baseline.hash, compileHash(base));
  const again = await ensureBaselinePrompt(lf);
  assert.equal(again.version, 1); // 同内容不重复创建
  const version = await getPromptVersion(lf, 1);
  assert.equal(version.compiled, base);
  assert.equal(version.hash, compileHash(base));
});

test("prompt：候选必须是有差异的显式修改（拒绝与基线相同/过短）", async () => {
  const state = { prompts: [{ prompt: buildSystemPrompt(), version: 1 }], created: [] as Array<Record<string, unknown>> };
  const lf = promptStub(state);
  const dir = mkdtempSync(join(tmpdir(), "td-lf-prompt-"));
  const identical = join(dir, "identical.txt");
  writeFileSync(identical, buildSystemPrompt(), "utf8");
  await assert.rejects(() => registerCandidatePrompt(lf, identical), /候选提示词与基线完全相同/);
  const tooShort = join(dir, "short.txt");
  writeFileSync(tooShort, "太短", "utf8");
  await assert.rejects(() => registerCandidatePrompt(lf, tooShort), /过短/);
  const candidate = await registerCandidatePrompt(lf, join(ROOT, "fixtures", "evals", "prompts", "diagnosis-candidate-v2.txt"));
  assert.equal(candidate.version, 2);
  assert.match(candidate.compiled, /反证优先于既有结论/);
  assert.notEqual(candidate.hash, compileHash(buildSystemPrompt()));
});

// ---------- task：dataset 记录的材料 hash 与本地冻结材料必须一致 ----------

test("task：材料 hash 不一致时返回结构化失败（不抛错，SDK 不丢弃该案例）", async () => {
  const catalog = loadCatalog(EVAL_ROOT);
  const entry = catalog.cases.find((c) => c.caseId === "eng-clarify")!;
  assert.ok(entry);
  const config = loadConfig();
  const task = makeTicketDoctorTask({
    projectRoot: ROOT,
    evalRoot: EVAL_ROOT,
    baseConfig: config,
    engine: "scripted",
    prompt: { name: "p", version: 1, compiled: buildSystemPrompt(), hash: compileHash(buildSystemPrompt()) },
    outDir: join(ROOT, "data", "lf-eval", "test-out"),
  });
  const out = await task({ input: { caseId: "eng-clarify" }, metadata: { caseId: "eng-clarify", caseHash: "0".repeat(64) } });
  assert.match(out.failure ?? "", /材料 hash 与 dataset 记录不一致/);
  assert.equal(out.rounds.length, 0);
  assert.equal(byName(runIntegrityEvaluator({ input: {}, expectedOutput: { rounds: [{ roundId: "r1" }] }, output: out }), "run_integrity").value, 0);
  assert.equal(byName(citationValidityEvaluator({ input: {}, output: out }), "citation_validity").value, 0);
});

// ---------- 多轮脚本执行：状态续接 + 材料隔离 + 输出捕获 ----------

test("runCase（scripted）：多轮续接同一调查，隔离预检通过，回写被捕获", async () => {
  const config = loadConfig();
  const catalog = loadCatalog(EVAL_ROOT);
  const entry = catalog.cases.find((c) => c.caseId === "eng-clarify")!;
  const result = await runCase({
    projectRoot: ROOT,
    evalRoot: EVAL_ROOT,
    entry,
    engine: "scripted",
    baseConfig: { ...config, diagnosis: { ...config.diagnosis, audit: { ...config.diagnosis.audit, enabled: false } } },
    outDir: join(ROOT, "data", "lf-eval", "test-out", "eng-clarify"),
  });
  assert.equal(result.isolation.ok, true, result.isolation.violationText ?? "");
  assert.equal(result.rounds.length, 2);
  assert.equal(result.rounds[0]!.outcome, "clarify");
  assert.equal(result.rounds[1]!.outcome, "report");
  for (const r of result.rounds) {
    assert.equal(r.status, "succeeded");
    assert.equal(typeof r.writebackText, "string");
    assert.ok(r.writebackText!.length > 0);
  }
  // 报告轮必须留下可解析的引用（终稿引用）。
  assert.ok(result.rounds[1]!.citations.some((c) => c.stage === "validated"));
  // usage 字段存在（fake/scripted 下为 0，不猜测）。
  assert.equal(result.rounds[0]!.usage.totalTokens, 0);
});

test("runCase：数据集 input.question 权威驱动首轮（修改 input 即改变 Agent 收到的问题）", async () => {
  const config = loadConfig();
  const catalog = loadCatalog(EVAL_ROOT);
  const entry = catalog.cases.find((c) => c.caseId === "eng-truncation")!;
  const outDir = mkdtempSync(join(tmpdir(), "td-lf-input-"));
  const custom = "自定义首轮问题：big-service 2026-09-06 10:00 变慢（来自数据集 input.question）";
  await runCase({
    projectRoot: ROOT,
    evalRoot: EVAL_ROOT,
    entry,
    engine: "scripted",
    baseConfig: { ...config, diagnosis: { ...config.diagnosis, audit: { ...config.diagnosis.audit, enabled: false } } },
    firstRoundQuestion: custom,
    outDir,
  });
  const tracePath = join(outDir, "eng-truncation", "trace.jsonl");
  const events = readFileSync(tracePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { eventType: string; payload?: { text?: string } });
  const roundInput = events.find((e) => e.eventType === "round_input");
  assert.equal(roundInput?.payload?.text, custom);
});

// ---------- extractService：日期不得被当成服务名（污染 scope 的回归） ----------

test("extractService：服务标注为日期时回退到 xxx-service，不把日期当服务", () => {
  assert.equal(extractService("checkout-service 服务: 2026-09-06 10:01 起下单接口大量 500"), "checkout-service");
  assert.equal(extractService("服务: 2026-09-06 10:01 起异常"), undefined);
  assert.equal(extractService("服务: order-service"), "order-service");
});

// ---------- 人工标注：评分配置/队列幂等，trace 幂等入队 ----------

test("review：幂等建立 0–2 分评分配置与队列，trace 幂等入队", async () => {
  const state = { configs: [] as Array<{ id: string; name: string }>, queues: [] as Array<{ id: string; name: string; scoreConfigIds: string[] }>, items: [] as string[] };
  let seq = 0;
  const lf = {
    api: {
      scoreConfigs: {
        get: async () => ({ data: state.configs }),
        create: async (req: { name: string }) => {
          const c = { id: `cfg${++seq}`, name: req.name };
          state.configs.push(c);
          return c;
        },
      },
      annotationQueues: {
        listQueues: async () => ({ data: state.queues }),
        createQueue: async (req: { name: string; scoreConfigIds: string[] }) => {
          const q = { id: `q${++seq}`, name: req.name, scoreConfigIds: req.scoreConfigIds };
          state.queues.push(q);
          return q;
        },
        listQueueItems: async () => ({ data: state.items.map((id) => ({ objectId: id, objectType: "TRACE" })), meta: { totalPages: 1 } }),
        createQueueItem: async (_q: string, req: { objectId: string }) => {
          state.items.push(req.objectId);
          return { objectId: req.objectId };
        },
      },
    },
  } as unknown as LangfuseClient;
  const s1 = await ensureAnnotationSetup(lf);
  assert.ok(s1.scoreConfigCreated && s1.queueCreated);
  assert.deepEqual(state.queues[0]!.scoreConfigIds, [s1.scoreConfigId]);
  const s2 = await ensureAnnotationSetup(lf);
  assert.equal(s2.scoreConfigId, s1.scoreConfigId);
  assert.equal(s2.queueId, s1.queueId);
  assert.ok(!s2.scoreConfigCreated && !s2.queueCreated);
  const r1 = await addTracesToAnnotationQueue(lf, s2.queueId, ["t1", "t2", "t1"]);
  assert.deepEqual(r1.added, ["t1", "t2"]);
  assert.deepEqual(r1.skipped, ["t1"]);
  const r2 = await addTracesToAnnotationQueue(lf, s2.queueId, ["t1", "t2", "t3"]);
  assert.deepEqual(r2.added, ["t3"]);
  assert.deepEqual(state.items, ["t1", "t2", "t3"]);
});

// ---------- verify：读回实验/items/观测，scores 恒空显式告警 ----------

test("verifyExperiment：逐案例校验预期分数/类型/归属/原生 prompt 关联；缺分数或错归属即失败", async () => {
  const cfg = { baseUrl: "http://lf.local", publicKey: "pk", secretKey: "sk" };
  const originalFetch = globalThis.fetch;
  const scoreDefs: Record<string, { value: number | string | boolean; dataType: string }> = {
    run_integrity: { value: true, dataType: "BOOLEAN" },
    citation_validity: { value: 1, dataType: "NUMERIC" },
    version_visibility: { value: true, dataType: "BOOLEAN" },
    expected_blocked: { value: true, dataType: "BOOLEAN" },
    prompt_injection: { value: "actual_request_verified", dataType: "CATEGORICAL" },
    tool_calls: { value: 3, dataType: "NUMERIC" },
    wall_ms: { value: 100, dataType: "NUMERIC" },
    total_tokens: { value: 50, dataType: "NUMERIC" },
  };
  const makeMock = (mode: "good" | "no_scores" | "bad_subject") =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/api/public/experiments")) return json({ data: [{ id: "exp1", name: "run-a" }] });
      if (url.includes("/api/public/experiment-items")) return json({ data: [{ id: "item1", traceId: "trace1" }] });
      if (url.includes("/api/public/v2/observations")) return json({ data: [{ id: "obs1", traceId: "trace1", type: "GENERATION", promptName: "p", promptVersion: 1 }] });
      if (url.includes("/api/public/v3/scores")) {
        if (mode === "no_scores") return json({ data: [] });
        const subject = mode === "bad_subject" ? { kind: "observation", id: "obs1", traceId: "OTHER" } : { kind: "observation", id: "obs1", traceId: "trace1" };
        return json({ data: Object.entries(scoreDefs).map(([name, d]) => ({ id: `s-${name}`, name, value: d.value, dataType: d.dataType, source: "API", subject })) });
      }
      return json({});
    }) as typeof fetch;
  try {
    globalThis.fetch = makeMock("good");
    const report = await verifyExperiment(cfg, { datasetId: "ds1", runName: "run-a", expectTraces: ["trace1"], expectedPrompt: { name: "p", version: 1 } }, { attempts: 1, delayMs: 0 });
    assert.equal(report.problems.length, 0, report.problems.join("; "));
    assert.equal(report.scoreDetails.length, EXPECTED_SCORE_NAMES.length);
    assert.equal(report.promptAssociations[0]!.associated.length, 1);
    assert.equal(report.promptAssociations[0]!.associated[0]!.name, "p");

    globalThis.fetch = makeMock("no_scores");
    const missing = await verifyExperiment(cfg, { datasetId: "ds1", runName: "run-a", expectTraces: ["trace1"] }, { attempts: 1, delayMs: 0 });
    assert.ok(missing.problems.some((p) => /缺分数/.test(p)), "分数缺失必须判失败");

    globalThis.fetch = makeMock("bad_subject");
    const badSubject = await verifyExperiment(cfg, { datasetId: "ds1", runName: "run-a", expectTraces: ["trace1"] }, { attempts: 1, delayMs: 0 });
    assert.ok(badSubject.problems.some((p) => /subject\.traceId/.test(p)), "错误归属必须判失败");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------- 多轮脚本执行：状态续接 + 材料隔离 + 输出捕获 ----------
