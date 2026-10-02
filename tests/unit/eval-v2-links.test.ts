// 阶段一验收反例：真实访问边界（符号链接/目录别名/junction/空授权/扫描不完整）。
// junction 用例在非 Windows 环境标记 skip（保留回归，Windows 上运行）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { FileLogSource, LogAccessError } from "../../src/sources/logs.ts";
import { checkIsolation } from "../../src/evals/v2/isolation.ts";
import type { CaseDescriptorV2, TruthFileV2 } from "../../src/evals/v2/types.ts";

const FUTURE_LINE = "2026-09-06T10:41:00.000+08:00\tERROR\tFUTURE-GOLD-LINE\n";
const PAST_LINE = "2026-09-06T10:01:00.000+08:00\tERROR\tPAST-LOG-LINE\n";

function caseJson(rounds: Array<Record<string, unknown>>, caseId = "c1"): CaseDescriptorV2 {
  return {
    schemaVersion: "prediagnosis-case-v2",
    caseId, familyId: "f", split: "engineering", sourceTier: "synthetic_engineering",
    publicBenchmark: false, admission: "admitted", maxRounds: rounds.length,
    rounds: rounds as never,
  };
}

function round(roundId: string, materialView: string, services: string[] = ["svc"], repoDir?: string): Record<string, unknown> {
  return { roundId, messageRef: `${roundId}-message.txt`, receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: null, materialView, services, repos: [{ repoId: "app", dir: repoDir ?? join("fixtures", "demo-repo") }] };
}

/** 测试自足：在 tmp 内建最小 git 仓库，避免依赖 pretest 生成的 fixture 仓库。 */
function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code.txt"), "class X {}\n");
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
}

const truthStub: TruthFileV2 = {
  schemaVersion: "prediagnosis-truth-v2", caseId: "c1", locators: [],
  rounds: [{ roundId: "r1", allowedOutcomes: ["report"], allowedClaimDepth: "root", requiredFacts: [], forbiddenRules: [], materialNeeds: [], evidenceRequirements: [], contradictedClaims: [], writebackRequirements: [] }],
  review: { author: "a", reviewer: "b", provisional: true },
};

test("隔离：空授权列表拒绝一切查询——即使日志文件存在（空白名单反例）", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-emptyauth-"));
  try {
    mkdirSync(join(root, "round-1"), { recursive: true });
    writeFileSync(join(root, "round-1", "svc.log"), PAST_LINE);
    const source = new FileLogSource({ dir: join(root, "round-1"), allowedServices: [] });
    await assert.rejects(
      () => source.query({ service: "svc", from: 0, to: Date.now() + 1e9, keywords: [] }, new AbortController().signal),
      (err: unknown) => err instanceof LogAccessError && /授权列表为空/.test((err as Error).message),
      "空授权 = 不开放，而非开放全部",
    );
  } finally {
    /* tmp 留给系统清理 */
  }
});

test("隔离：未配置授权（undefined）保持既有行为；白名单仍生效", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-auth-"));
  try {
    mkdirSync(join(root, "round-1"), { recursive: true });
    writeFileSync(join(root, "round-1", "svc.log"), PAST_LINE);
    const signal = new AbortController().signal;
    const unrestricted = new FileLogSource({ dir: join(root, "round-1"), allowedServices: undefined });
    const entries = await unrestricted.query({ service: "svc", from: 0, to: Date.now() + 1e9, keywords: [] }, signal);
    assert.equal(entries.length, 1);
    const whitelisted = new FileLogSource({ dir: join(root, "round-1"), allowedServices: ["other"] });
    await assert.rejects(
      () => whitelisted.query({ service: "svc", from: 0, to: Date.now() + 1e9, keywords: [] }, signal),
      (err: unknown) => err instanceof LogAccessError && /不在授权范围内/.test((err as Error).message),
    );
  } finally {
    /* tmp */
  }
});

test("隔离：视图内文件符号链接指向未来轮 → FileLogSource 拒绝（真实路径核验）", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-symlink-"));
  try {
    mkdirSync(join(root, "round-1"), { recursive: true });
    mkdirSync(join(root, "round-2"), { recursive: true });
    writeFileSync(join(root, "round-2", "future-svc.log"), FUTURE_LINE);
    symlinkSync(join(root, "round-2", "future-svc.log"), join(root, "round-1", "future-svc.log"));
    const source = new FileLogSource({ dir: join(root, "round-1"), allowedServices: ["future-svc"] });
    await assert.rejects(
      () => source.query({ service: "future-svc", from: 0, to: Date.now() + 1e9, keywords: [] }, new AbortController().signal),
      (err: unknown) => err instanceof LogAccessError && /链接\/别名逃逸|越出日志目录/.test((err as Error).message),
      "链接逃逸必须被拒",
    );
  } finally {
    /* tmp */
  }
});

test("预检：视图目录别名（round-1 → round-2 符号链接）按真实路径判重 → 阻断", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-alias-"));
  try {
    gitInit(join(root, "repo"));
    mkdirSync(join(root, "public", "c1", "round-2"), { recursive: true });
    mkdirSync(join(root, "public", "c1"), { recursive: true });
    symlinkSync(join(root, "public", "c1", "round-2"), join(root, "public", "c1", "round-1"), "dir");
    writeFileSync(join(root, "public", "c1", "round-2", "svc.log"), FUTURE_LINE);
    writeFileSync(join(root, "public", "c1", "r1-message.txt"), "m1");
    writeFileSync(join(root, "public", "c1", "r2-message.txt"), "m2");
    const desc = caseJson([round("r1", "round-1", ["svc"], join(root, "repo")), round("r2", "round-2", ["svc"], join(root, "repo"))]);
    const violations = checkIsolation(root, join(root, "public", "c1"), desc, truthStub, join(root, "private", "c1"));
    assert.ok(violations.some((v) => v.code === "path_overlap" && /真实路径重合/.test(v.message)), JSON.stringify(violations));
  } finally {
    /* tmp */
  }
});

test("预检：视图内链接逃逸被记为 link_escape", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-linkesc-"));
  try {
    mkdirSync(join(root, "public", "c1", "round-1"), { recursive: true });
    mkdirSync(join(root, "outside"), { recursive: true });
    writeFileSync(join(root, "outside", "secret.log"), FUTURE_LINE);
    symlinkSync(join(root, "outside", "secret.log"), join(root, "public", "c1", "round-1", "leak.log"));
    writeFileSync(join(root, "public", "c1", "r1-message.txt"), "m");
    const desc = caseJson([round("r1", "round-1")]);
    const violations = checkIsolation(root, join(root, "public", "c1"), desc, truthStub, join(root, "private", "c1"));
    assert.ok(violations.some((v) => v.code === "link_escape"), JSON.stringify(violations));
  } finally {
    /* tmp */
  }
});

test("预检：扫描跳过的可读内容使隔离结论不完整（不得判通过）", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-scan-"));
  try {
    gitInit(join(root, "repo"));
    mkdirSync(join(root, "public", "c1", "round-1"), { recursive: true });
    writeFileSync(join(root, "public", "c1", "round-1", "big.log"), "x".repeat(64));
    writeFileSync(join(root, "public", "c1", "r1-message.txt"), "m");
    const desc = caseJson([round("r1", "round-1", ["svc"], join(root, "repo"))]);
    const violations = checkIsolation(root, join(root, "public", "c1"), desc, truthStub, join(root, "private", "c1"), { maxViewFileBytes: 8 });
    assert.ok(violations.some((v) => v.code === "incomplete_scan"), JSON.stringify(violations));
    // 默认阈值下同一内容应完整扫描、无该违规
    const defaultRun = checkIsolation(root, join(root, "public", "c1"), desc, truthStub, join(root, "private", "c1"));
    assert.ok(!defaultRun.some((v) => v.code === "incomplete_scan"));
  } finally {
    /* tmp */
  }
});

test("回归：Windows junction 逃逸（非 Windows 跳过，Windows 上运行）", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-junction-"));
  try {
    mkdirSync(join(root, "public", "c1", "round-1"), { recursive: true });
    mkdirSync(join(root, "public", "c1", "round-2"), { recursive: true });
    writeFileSync(join(root, "public", "c1", "round-2", "future-svc.log"), FUTURE_LINE);
    symlinkSync(join(root, "public", "c1", "round-2"), join(root, "public", "c1", "round-1", "future"), "junction");
    const source = new FileLogSource({ dir: join(root, "public", "c1", "round-1"), allowedServices: ["future-svc"] });
    assert.rejects(
      () => source.query({ service: "future/future-svc", from: 0, to: Date.now() + 1e9, keywords: [] }, new AbortController().signal),
      LogAccessError,
      "junction 目录别名必须被服务名规则或真实路径核验拒绝",
    );
  } finally {
    /* tmp */
  }
});
