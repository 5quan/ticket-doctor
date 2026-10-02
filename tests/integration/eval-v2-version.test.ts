// 阶段一验收：版本绑定——实际 prepare 得到的源码版本在模型读取前核验并阻断（工单 §2）。
// 覆盖：正文时间钉到修复版、HEAD 含修复、版本无法解析、补问轮也记录 scope。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeEngineeringCases } from "../../src/evals/v2/engcases.ts";
import { runSuite } from "../../src/evals/v2/runner.ts";
import { testConfig } from "../helpers.ts";

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..", "..");

interface TraceEventLite {
  eventType: string;
  payload?: Record<string, unknown>;
}

function readTrace(root: string, suite: string, caseId: string): TraceEventLite[] {
  return readFileSync(join(root, "runs", suite, caseId, "t1", "trace.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as TraceEventLite);
}

test("版本漂移：正文时间把源码钉到修复版 → scope_resolved 后读取前阻断", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-ver-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    const summary = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "ver-drift",
      engine: "scripted", repeat: 1, baseConfig: testConfig(), caseIds: ["eng-version-drift"],
    });
    const trial = summary.cases[0].trials[0];
    assert.equal(trial.executionSuccess, false, "版本错配 trial 必须失败");
    assert.equal(trial.roundScores[0].outcome, "error");
    assert.equal(trial.recall.C1!.value, 0, "需求未取得任何可见证据");

    const events = readTrace(root, "ver-drift", "eng-version-drift");
    const scope = events.find((e) => e.eventType === "scope_resolved");
    assert.ok(scope, "必须记录 scope_resolved");
    const resolved = (scope!.payload!.resolved as Array<{ repoId: string; resolvedSha: string | null; pinnedBy: string | null }>)[0];
    const expected = (scope!.payload!.expected as Record<string, string>).app;
    assert.notEqual(resolved.resolvedSha, expected, "时间钉版选中了另一个提交");
    assert.equal(resolved.pinnedBy, "time");
    const checks = scope!.payload!.checks as Array<{ repoId: string; check: string; expected: string | null }>;
    assert.equal(checks[0].check, "mismatch", "错配必须在读取前核验矩阵中标出");
    const readEvents = events.filter((e) => e.eventType === "tool_returned" || e.eventType === "evidence_committed");
    assert.deepEqual(readEvents, [], "阻断必须发生在任何取证之前（无工具/证据事件）");
    // 故障版内容不得出现在任何可见文本
    const allPayload = JSON.stringify(events);
    assert.ok(!allPayload.includes("FAULT-VERSION-MARKER"), "危险版本内容不得被读取");
    assert.ok(!allPayload.includes("FIXED-VERSION-MARKER"), "修复版内容同样不得在阻断前被读取");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HEAD 含修复：无发生时间 → HEAD 钉到修复版 → 读取前阻断", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-ver-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    const summary = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "ver-headfix",
      engine: "scripted", repeat: 1, baseConfig: testConfig(), caseIds: ["eng-version-headfix"],
    });
    assert.equal(summary.cases[0].trials[0].executionSuccess, false);
    const events = readTrace(root, "ver-headfix", "eng-version-headfix");
    const scope = events.find((e) => e.eventType === "scope_resolved")!;
    const resolved = (scope.payload!.resolved as Array<{ resolvedSha: string | null; pinnedBy: string | null }>)[0];
    assert.equal(resolved.pinnedBy, "head");
    const checks = scope.payload!.checks as Array<{ check: string }>;
    assert.equal(checks[0].check, "mismatch");
    assert.ok(events.filter((e) => e.eventType === "tool_returned" || e.eventType === "evidence_committed").length === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("版本无法解析：发生时间早于全部提交 → unresolved，读取前阻断", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-ver-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    // 派生 case：把时间改到全部提交之前（2026-08-01 < fault 2026-09-01）
    const caseDir = join(root, "public", "eng-version-future");
    const privateDir = join(root, "private", "eng-version-future");
        mkdirSync(join(caseDir, "round-1"), { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    cpSync(join(root, "public", "eng-version-drift", "repo"), join(caseDir, "repo"), { recursive: true });
    writeFileSync(join(caseDir, "round-1", "version-svc.log"), "2026-08-01T10:00:30.000+08:00\tERROR\tversion-svc request failed\n");
    writeFileSync(join(caseDir, "r1-message.txt"), "version-svc 服务：2026-08-01 10:00 起接口异常，帮忙看下源码");
    writeFileSync(join(caseDir, "case.json"), JSON.stringify({
      ...JSON.parse(readFileSync(join(root, "public", "eng-version-drift", "case.json"), "utf8")),
      caseId: "eng-version-future",
      scriptedEngine: false, // 派生 case 无脚本；本场景预期在取证前被阻断，引擎不应到达
      rounds: [{
        roundId: "r1", messageRef: "r1-message.txt", receivedAt: "2026-08-01T10:30:00+08:00",
        occurredAt: "2026-08-01T10:00:00+08:00", materialView: "round-1", services: ["version-svc"],
        repos: [{ repoId: "app", dir: join(caseDir, "repo"), expectedSha: JSON.parse(readFileSync(join(root, "public", "eng-version-drift", "case.json"), "utf8")).rounds[0].repos[0].expectedSha }],
      }],
    }));
    writeFileSync(join(privateDir, "truth.private.json"), readFileSync(join(root, "private", "eng-version-drift", "truth.private.json"), "utf8").toString().replace("eng-version-drift", "eng-version-future"));
    const catalogPath = join(root, "catalog", "catalog.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { cases: Array<{ caseId: string; publicDir: string; privateDir: string }> };
    catalog.cases.push({ caseId: "eng-version-future", publicDir: "public/eng-version-future", privateDir: "private/eng-version-future" });
    writeFileSync(catalogPath, JSON.stringify(catalog));

    const summary = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "ver-future",
      engine: "scripted", repeat: 1, baseConfig: testConfig(), caseIds: ["eng-version-future"],
    });
    assert.equal(summary.cases[0].trials[0].executionSuccess, false);
    const events = readTrace(root, "ver-future", "eng-version-future");
    const scope = events.find((e) => e.eventType === "scope_resolved")!;
    const resolved = (scope.payload!.resolved as Array<{ resolvedSha: string | null; pinnedBy: string | null }>)[0];
    assert.equal(resolved.resolvedSha, null, "早于全部提交的时间无法钉版");
    assert.equal(resolved.pinnedBy, "unresolved");
    const checks = scope.payload!.checks as Array<{ check: string }>;
    assert.equal(checks[0].check, "unresolved", "unresolved 不得漏检");
    assert.equal(events.filter((e) => e.eventType === "tool_returned" || e.eventType === "evidence_committed").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("补问轮同样记录 scope_resolved（无报告轮不缺席）", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-ver-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "ver-clarify",
      engine: "scripted", repeat: 1, baseConfig: testConfig(), caseIds: ["eng-clarify"],
    });
    const events = readTrace(root, "ver-clarify", "eng-clarify");
    const scopeEvents = events.filter((e) => e.eventType === "scope_resolved");
    assert.equal(scopeEvents.length, 2, "两轮都必须在取证前记录 scope_resolved");
    const first = (scopeEvents[0].payload!.resolved as Array<{ resolvedSha: string | null }>)[0];
    const expected = (scopeEvents[0].payload!.expected as Record<string, string>).app;
    assert.equal(first.resolvedSha, expected, "无时间轮按 HEAD 钉版且与期望一致（单提交仓库）");
    for (const se of scopeEvents) {
      const checks = se.payload!.checks as Array<{ check: string }>;
      assert.equal(checks[0].check, "ok", "期望与实际一致 → ok");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("缺席仓库：多仓一构建失败 → missing-in-scope，读取前阻断", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-ver-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    // 双仓 case：app（checkout fixture，时间可正常钉到期望提交）+ aux（提交时间 11:00
    // 晚于正文发生时间 10:01 → 运行期时间钉版失败 → scope 缺席 → missing-in-scope）。
    const caseDir = join(root, "public", "eng-version-missing");
    const privateDir = join(root, "private", "eng-version-missing");
        const { execFileSync } = await import("node:child_process");
    mkdirSync(join(caseDir, "round-1"), { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    const auxRepo = join(caseDir, "aux-repo");
    mkdirSync(auxRepo, { recursive: true });
    execFileSync("git", ["-C", auxRepo, "init", "-q"]);
    execFileSync("git", ["-C", auxRepo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", auxRepo, "config", "user.name", "t"]);
    writeFileSync(join(auxRepo, "readme.txt"), "AUX-CONTENT\n"); // 文件名避开 Windows 保留名 AUX（aux.txt 在 Windows 无法正常创建）
    execFileSync("git", ["-C", auxRepo, "add", "-A"]);
    const env = { ...process.env, GIT_AUTHOR_DATE: "2026-09-06T11:00:00+08:00", GIT_COMMITTER_DATE: "2026-09-06T11:00:00+08:00" };
    execFileSync("git", ["-C", auxRepo, "commit", "-qm", "aux after occurredAt"], { env });
    const auxSha = execFileSync("git", ["-C", auxRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const clarify = JSON.parse(readFileSync(join(root, "public", "eng-clarify", "case.json"), "utf8"));
    const appExpected = clarify.rounds[0].repos[0].expectedSha;
    writeFileSync(join(caseDir, "r1-message.txt"), "version-svc 服务：2026-09-06 10:01 起接口异常，帮忙看下日志和源码");
    writeFileSync(join(caseDir, "case.json"), JSON.stringify({
      ...clarify, caseId: "eng-version-missing", scriptedEngine: false, maxRounds: 1,
      rounds: [{
        roundId: "r1", messageRef: "r1-message.txt", receivedAt: "2026-09-06T10:30:00+08:00",
        occurredAt: "2026-09-06T10:01:00+08:00", materialView: "round-1",
        services: ["checkout-service", "version-svc"],
        repos: [
          { repoId: "app", dir: join(PROJECT_ROOT, "fixtures", "evals", "checkout-timeout", "repo"), expectedSha: appExpected },
          { repoId: "aux", dir: auxRepo, expectedSha: auxSha },
        ],
      }],
    }));
    writeFileSync(join(privateDir, "truth.private.json"), JSON.stringify({
      schemaVersion: "prediagnosis-truth-v2", caseId: "eng-version-missing", locators: [],
      rounds: [{ roundId: "r1", allowedOutcomes: ["report"], allowedClaimDepth: "root", requiredFacts: [], forbiddenRules: [], materialNeeds: [], evidenceRequirements: [], contradictedClaims: [], writebackRequirements: [] }],
      review: { author: "a", reviewer: "b", provisional: true },
    }));
    const catalogPath = join(root, "catalog", "catalog.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { cases: Array<{ caseId: string; publicDir: string; privateDir: string }> };
    catalog.cases.push({ caseId: "eng-version-missing", publicDir: "public/eng-version-missing", privateDir: "private/eng-version-missing" });
    writeFileSync(catalogPath, JSON.stringify(catalog));

    const summary = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "ver-missing",
      engine: "scripted", repeat: 1, baseConfig: testConfig(), caseIds: ["eng-version-missing"],
    });
    assert.equal(summary.cases[0].trials[0].executionSuccess, false);
    const events = readTrace(root, "ver-missing", "eng-version-missing");
    const scope = events.find((e) => e.eventType === "scope_resolved")!;
    const checks = scope.payload!.checks as Array<{ repoId: string; check: string }>;
    assert.ok(checks.some((c) => c.repoId === "aux" && c.check === "missing-in-scope"), JSON.stringify(checks));
    assert.equal(events.filter((e) => e.eventType === "tool_returned" || e.eventType === "evidence_committed").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("工程场景缺期望版本：仍核对实际可读版本（no-expected），不跳过检查进入运行", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-ver-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    // 派生 case：去掉 expectedSha（engineering 允许），仓库正常 → 核对通过并标记 no-expected
    const caseDir = join(root, "public", "eng-version-noexp");
    const privateDir = join(root, "private", "eng-version-noexp");
        mkdirSync(join(caseDir, "round-1"), { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    cpSync(join(root, "public", "eng-version-drift", "repo"), join(caseDir, "repo"), { recursive: true });
    cpSync(join(root, "public", "eng-version-drift", "round-1", "version-svc.log"), join(caseDir, "round-1", "version-svc.log"));
    const drift = JSON.parse(readFileSync(join(root, "public", "eng-version-drift", "case.json"), "utf8"));
    const noExp = JSON.parse(JSON.stringify({ ...drift, caseId: "eng-version-noexp", scriptedEngine: false }));
    noExp.rounds[0].repos[0].dir = join(caseDir, "repo");
    delete noExp.rounds[0].repos[0].expectedSha;
    noExp.rounds[0].occurredAt = null; // 无时间 → HEAD 钉版
    writeFileSync(join(caseDir, "r1-message.txt"), "version-svc 服务：接口异常，帮忙看下日志和源码（未提供时间）");
    writeFileSync(join(caseDir, "case.json"), JSON.stringify(noExp));
    writeFileSync(join(privateDir, "truth.private.json"), readFileSync(join(root, "private", "eng-version-drift", "truth.private.json"), "utf8").toString().replaceAll("eng-version-drift", "eng-version-noexp"));
    const catalogPath = join(root, "catalog", "catalog.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { cases: Array<{ caseId: string; publicDir: string; privateDir: string }> };
    catalog.cases.push({ caseId: "eng-version-noexp", publicDir: "public/eng-version-noexp", privateDir: "private/eng-version-noexp" });
    writeFileSync(catalogPath, JSON.stringify(catalog));

    const summary = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "ver-noexp",
      engine: "scripted", repeat: 1, baseConfig: testConfig(), caseIds: ["eng-version-noexp"],
    });
    const trial = summary.cases[0].trials[0];
    assert.equal(trial.executionSuccess, true, "无脚本引擎产出部分报告，链路完成；核对不阻断正常轮");
    const events = readTrace(root, "ver-noexp", "eng-version-noexp");
    const scope = events.find((e) => e.eventType === "scope_resolved")!;
    const checks = scope.payload!.checks as Array<{ check: string; resolvedSha: string | null }>;
    assert.equal(checks[0].check, "no-expected", "无期望仍执行实际版本核对");
    assert.match(checks[0].resolvedSha ?? "", /^[0-9a-f]{40}$/, "实际可读版本必须存在（unresolved 会被阻断）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 三提交仓库：c1(09-01 干净) → c2(09-02 可含答案/未来文本) → c3(09-06 干净，HEAD)。 */
function buildThreeCommitRepo(repoDir: string, c2Files: Record<string, string>, c3Deletes: string[] = []): { c1: string; c2: string; c3: string } {
  const env = (date: string) => ({ ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const g = (args: string[], extra?: Record<string, unknown>) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8", ...(extra ?? {}) });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(repoDir, "src", "App.java"), "class App { String v = \"C1\"; }");
  g(["add", "-A"]);
  g(["commit", "-qm", "c1"], { env: env("2026-09-01T00:00:00+08:00") });
  const c1 = g(["rev-parse", "HEAD"]).trim();
  for (const [rel, content] of Object.entries(c2Files)) {
    const p2 = join(repoDir, rel);
    mkdirSync(join(p2, ".."), { recursive: true });
    writeFileSync(p2, content);
  }
  g(["add", "-A"]);
  g(["commit", "-qm", "c2"], { env: env("2026-09-02T00:00:00+08:00") });
  const c2 = g(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repoDir, "src", "App.java"), "class App { String v = \"C3\"; }");
  for (const rel of c3Deletes) {
    execFileSync("git", ["-C", repoDir, "rm", "-q", rel]);
  }
  g(["add", "-A"]);
  g(["commit", "-qm", "c3"], { env: env("2026-09-06T00:00:00+08:00") });
  const c3 = g(["rev-parse", "HEAD"]).trim();
  return { c1, c2, c3 };
}

test("中间提交（无期望版本）含答案文件 → 解析树扫描在读取前阻断", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-mid-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    const caseDir = join(root, "public", "eng-version-mid");
    const privateDir = join(root, "private", "eng-version-mid");
        mkdirSync(join(caseDir, "round-1"), { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    const repoDir = join(caseDir, "repo");
    // c2 引入答案文件、c3 删除——预检的 HEAD 树干净，只有实际选中的中间提交暴露
    const shas = buildThreeCommitRepo(repoDir, { "docs/solution.md": "GOLD-ANSWER-CONTENT\n" }, ["docs/solution.md"]);
    cpSync(join(root, "public", "eng-version-drift", "round-1", "version-svc.log"), join(caseDir, "round-1", "version-svc.log"));
    writeFileSync(join(caseDir, "r1-message.txt"), "version-svc 服务：2026-09-03 10:00 起接口异常，帮忙看下源码");
    const drift = JSON.parse(readFileSync(join(root, "public", "eng-version-drift", "case.json"), "utf8"));
    const noExp = JSON.parse(JSON.stringify({ ...drift, caseId: "eng-version-mid", scriptedEngine: false }));
    noExp.rounds[0].repos[0].dir = repoDir;
    delete noExp.rounds[0].repos[0].expectedSha; // 无期望：预检只扫 HEAD(c3，干净)，扫不到 c2
    noExp.rounds[0].occurredAt = "2026-09-03T10:00:00+08:00";
    writeFileSync(join(caseDir, "case.json"), JSON.stringify(noExp));
    writeFileSync(join(privateDir, "truth.private.json"), readFileSync(join(root, "private", "eng-version-drift", "truth.private.json"), "utf8").toString().replaceAll("eng-version-drift", "eng-version-mid"));
    const catalogPath = join(root, "catalog", "catalog.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { cases: Array<{ caseId: string; publicDir: string; privateDir: string }> };
    catalog.cases.push({ caseId: "eng-version-mid", publicDir: "public/eng-version-mid", privateDir: "private/eng-version-mid" });
    writeFileSync(catalogPath, JSON.stringify(catalog));

    const summary = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "ver-mid",
      engine: "scripted", repeat: 1, baseConfig: testConfig(), caseIds: ["eng-version-mid"],
    });
    assert.equal(summary.cases[0].trials[0].executionSuccess, false);
    const events = readTrace(root, "ver-mid", "eng-version-mid");
    const scope = events.find((e) => e.eventType === "scope_resolved")!;
    const resolved = (scope.payload!.resolved as Array<{ resolvedSha: string }>)[0];
    assert.equal(resolved.resolvedSha, shas.c2, "时间钉版选中中间提交");
    const scans = scope.payload!.resolvedScans as Array<{ repoId: string; ok: boolean; codes: string[] }>;
    assert.equal(scans[0].ok, false);
    assert.ok(scans[0].codes.includes("answer_filename"), JSON.stringify(scans));
    assert.equal(events.filter((e) => e.eventType === "tool_returned" || e.eventType === "evidence_committed").length, 0, "阻断发生在取证前");
    const all = JSON.stringify(events);
    assert.ok(!all.includes("GOLD-ANSWER-CONTENT"), "答案内容不得被读取");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("中间提交（无期望版本）含未来消息文本 → 解析树扫描在读取前阻断", async () => {
  // 说明：带期望且 resolved≠expected 时身份核对（mismatch）先阻断，无需内容扫描；
  // 解析树扫描的独立价值在 no-expected 路径——预检只扫 HEAD，实际选中别的提交。
  const root = mkdtempSync(join(tmpdir(), "eval-v2-mid2-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    const FUTURE_MSG = "第二轮补充：库存服务其他调用方都正常，请复核完整日志再判断（机密核对文本 MHX-77）";
    const caseDir = join(root, "public", "eng-version-mid2");
    const privateDir = join(root, "private", "eng-version-mid2");
        mkdirSync(join(caseDir, "round-1"), { recursive: true });
    mkdirSync(join(caseDir, "round-2"), { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    const repoDir = join(caseDir, "repo");
    const shas = buildThreeCommitRepo(repoDir, { "docs/pending.md": FUTURE_MSG }, ["docs/pending.md"]);
    cpSync(join(root, "public", "eng-version-drift", "round-1", "version-svc.log"), join(caseDir, "round-1", "version-svc.log"));
    cpSync(join(root, "public", "eng-version-drift", "round-1", "version-svc.log"), join(caseDir, "round-2", "version-svc.log"));
    writeFileSync(join(caseDir, "r1-message.txt"), "version-svc 服务：2026-09-03 10:00 起接口异常，帮忙看下源码");
    writeFileSync(join(caseDir, "r2-message.txt"), FUTURE_MSG);
    const drift = JSON.parse(readFileSync(join(root, "public", "eng-version-drift", "case.json"), "utf8"));
    const withExp = JSON.parse(JSON.stringify({ ...drift, caseId: "eng-version-mid2", scriptedEngine: false, maxRounds: 2 }));
    withExp.rounds[0].repos[0].dir = repoDir;
    delete withExp.rounds[0].repos[0].expectedSha; // 无期望：预检只扫 HEAD(c3)，c2 只能靠解析树扫描拦截
    withExp.rounds[0].occurredAt = "2026-09-03T10:00:00+08:00";
    // 保留两轮：r2 的用户消息是"未来文本"，只有解析树扫描能发现它藏在 c2 里
    withExp.rounds.push({ roundId: "r2", messageRef: "r2-message.txt", receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: null, materialView: "round-2", services: ["version-svc"], repos: [{ repoId: "app", dir: repoDir }] });
    writeFileSync(join(caseDir, "case.json"), JSON.stringify(withExp));
    writeFileSync(join(caseDir, "r1-message.txt"), "version-svc 服务：2026-09-03 10:00 起接口异常，帮忙看下源码");
    writeFileSync(join(privateDir, "truth.private.json"), JSON.stringify({
      schemaVersion: "prediagnosis-truth-v2", caseId: "eng-version-mid2", locators: [],
      rounds: [
        { roundId: "r1", allowedOutcomes: ["report", "clarify"], allowedClaimDepth: "root", requiredFacts: [], forbiddenRules: [], materialNeeds: [], evidenceRequirements: [], contradictedClaims: [], writebackRequirements: [] },
        { roundId: "r2", allowedOutcomes: ["report"], allowedClaimDepth: "root", requiredFacts: [], forbiddenRules: [], materialNeeds: [], evidenceRequirements: [], contradictedClaims: [], writebackRequirements: [] },
      ],
      review: { author: "a", reviewer: "b", provisional: true },
    }));
    const catalogPath = join(root, "catalog", "catalog.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { cases: Array<{ caseId: string; publicDir: string; privateDir: string }> };
    catalog.cases.push({ caseId: "eng-version-mid2", publicDir: "public/eng-version-mid2", privateDir: "private/eng-version-mid2" });
    writeFileSync(catalogPath, JSON.stringify(catalog));

    const summary = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "ver-mid2",
      engine: "scripted", repeat: 1, baseConfig: testConfig(), caseIds: ["eng-version-mid2"],
    });
    assert.equal(summary.cases[0].trials[0].executionSuccess, false);
    const events = readTrace(root, "ver-mid2", "eng-version-mid2");
    const scope = events.find((e) => e.eventType === "scope_resolved")!;
    const resolved = (scope.payload!.resolved as Array<{ resolvedSha: string }>)[0];
    assert.equal(resolved.resolvedSha, shas.c2, "时间钉版选中中间提交（期望与 HEAD 都不在其列）");
    const scans = scope.payload!.resolvedScans as Array<{ ok: boolean; codes: string[]; detail: string }>;
    assert.equal(scans[0].ok, false);
    assert.ok(scans[0].codes.includes("future_message_leak"), JSON.stringify(scans));
    assert.equal(events.filter((e) => e.eventType === "tool_returned" || e.eventType === "evidence_committed").length, 0);
    assert.ok(!JSON.stringify(events).includes("MHX-77"), "未来消息文本不得出现在取证结果中");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
