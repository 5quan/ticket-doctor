// 阶段一验收：版本绑定——实际 prepare 得到的源码版本在模型读取前核验并阻断（工单 §2）。
// 覆盖：正文时间钉到修复版、HEAD 含修复、版本无法解析、补问轮也记录 scope。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const { mkdirSync, cpSync } = await import("node:fs");
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
    const { mkdirSync, cpSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    mkdirSync(join(caseDir, "round-1"), { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    const auxRepo = join(caseDir, "aux-repo");
    mkdirSync(auxRepo, { recursive: true });
    execFileSync("git", ["-C", auxRepo, "init", "-q"]);
    execFileSync("git", ["-C", auxRepo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", auxRepo, "config", "user.name", "t"]);
    writeFileSync(join(auxRepo, "aux.txt"), "AUX-CONTENT\n");
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
    const { mkdirSync, cpSync } = await import("node:fs");
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
