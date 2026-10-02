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

test("预检：视图父子包含——两个方向都拒绝（工单 §1）", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-nest-"));
  try {
    gitInit(join(root, "repo"));
    // 方向一：未来轮视图位于先前轮视图内部（round-2 ⊂ round-1）
    mkdirSync(join(root, "public", "c1", "round-1", "inner"), { recursive: true });
    writeFileSync(join(root, "public", "c1", "round-1", "past.log"), PAST_LINE);
    writeFileSync(join(root, "public", "c1", "round-1", "inner", "future-svc.log"), FUTURE_LINE);
    writeFileSync(join(root, "public", "c1", "r1-message.txt"), "m1");
    writeFileSync(join(root, "public", "c1", "r2-message.txt"), "m2");
    const desc1 = caseJson([round("r1", "round-1", ["svc"], join(root, "repo")), round("r2", "round-1/inner", ["future-svc"], join(root, "repo"))]);
    const v1 = checkIsolation(root, join(root, "public", "c1"), desc1, truthStub, join(root, "private", "c1"));
    assert.ok(v1.some((v) => v.code === "path_overlap" && /位于先前轮.*内部/.test(v.message)), JSON.stringify(v1));

    // 方向二：先前轮视图位于未来轮视图内部（round-1 ⊂ round-2）——边界同样不成立
    mkdirSync(join(root, "public", "c2", "round-2"), { recursive: true });
    mkdirSync(join(root, "public", "c2", "round-2", "past"));
    writeFileSync(join(root, "public", "c2", "round-2", "future-svc.log"), FUTURE_LINE);
    writeFileSync(join(root, "public", "c2", "round-2", "past", "past.log"), PAST_LINE);
    writeFileSync(join(root, "public", "c2", "r1-message.txt"), "m1");
    writeFileSync(join(root, "public", "c2", "r2-message.txt"), "m2");
    const desc2 = { ...caseJson([round("r1", "round-2/past", ["svc"], join(root, "repo")), round("r2", "round-2", ["future-svc"], join(root, "repo"))]), caseId: "c1" } as CaseDescriptorV2;
    const v2 = checkIsolation(root, join(root, "public", "c2"), desc2, truthStub, join(root, "private", "c1"));
    assert.ok(v2.some((v) => v.code === "path_overlap" && /视图边界不成立/.test(v.message)), JSON.stringify(v2));
  } finally {
    /* tmp */
  }
});

test("回归：首轮合法已授权服务经硬链接实际读到未来日志 → 预检按 inode 阻断（运行期规则发现不了）", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-hardlink-"));
  try {
    gitInit(join(root, "repo"));
    mkdirSync(join(root, "public", "c1", "round-1"), { recursive: true });
    mkdirSync(join(root, "public", "c1", "round-2"), { recursive: true });
    writeFileSync(join(root, "public", "c1", "round-2", "future-svc.log"), FUTURE_LINE);
    // 首轮的 svc.log 是指向未来轮日志的硬链接：首轮授权合法、路径合法、realpath 也在视图内
    const { linkSync, statSync } = await import("node:fs");
    linkSync(join(root, "public", "c1", "round-2", "future-svc.log"), join(root, "public", "c1", "round-1", "svc.log"));
    assert.equal(statSync(join(root, "public", "c1", "round-1", "svc.log")).ino, statSync(join(root, "public", "c1", "round-2", "future-svc.log")).ino, "前置：硬链接已建立");

    // 运行期规则（服务名/realpath）发现不了它——授权服务真的能读到未来内容（这就是缺口本身）
    const runtime = new FileLogSource({ dir: join(root, "public", "c1", "round-1"), allowedServices: ["svc"] });
    const leaked = await runtime.query({ service: "svc", from: 0, to: Date.now() + 1e9, keywords: [] }, new AbortController().signal);
    assert.equal(leaked.length, 1);
    assert.match(leaked[0].message, /FUTURE-GOLD-LINE/, "前置：运行期确实读到未来日志（证明必须由预检阻断）");

    // 预检按 inode 识别并阻断
    writeFileSync(join(root, "public", "c1", "r1-message.txt"), "m1");
    writeFileSync(join(root, "public", "c1", "r2-message.txt"), "m2");
    const desc = caseJson([round("r1", "round-1", ["svc"], join(root, "repo")), round("r2", "round-2", ["future-svc"], join(root, "repo"))]);
    const violations = checkIsolation(root, join(root, "public", "c1"), desc, truthStub, join(root, "private", "c1"));
    assert.ok(violations.some((v) => v.code === "hardlink_escape"), JSON.stringify(violations));
  } finally {
    /* tmp */
  }
});

test("回归：Windows junction 真正触达路径检查（preflight 视图别名 + 运行期文件 junction realpath），异步断言", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-v2-junction2-"));
  try {
    gitInit(join(root, "repo"));
    mkdirSync(join(root, "public", "c1", "round-1"), { recursive: true });
    mkdirSync(join(root, "public", "c1", "round-2"), { recursive: true });
    writeFileSync(join(root, "public", "c1", "round-2", "future-svc.log"), FUTURE_LINE);
    // (a) 视图目录 junction：round-1 → round-2（别名）→ 预检真实路径判重阻断
    symlinkSync(join(root, "public", "c1", "round-2"), join(root, "public", "c1", "round-1"), "junction");
    writeFileSync(join(root, "public", "c1", "r1-message.txt"), "m1");
    writeFileSync(join(root, "public", "c1", "r2-message.txt"), "m2");
    const desc = caseJson([round("r1", "round-1", ["svc"], join(root, "repo")), round("r2", "round-2", ["future-svc"], join(root, "repo"))]);
    const violations = checkIsolation(root, join(root, "public", "c1"), desc, truthStub, join(root, "private", "c1"));
    assert.ok(violations.some((v) => v.code === "path_overlap"), JSON.stringify(violations));

    // (b) 视图内文件 junction 指向未来日志 → FileLogSource 真实路径核验拒绝（非服务名规则）
    mkdirSync(join(root, "plain", "round-1"), { recursive: true });
    symlinkSync(join(root, "public", "c1", "round-2", "future-svc.log"), join(root, "plain", "round-1", "future-svc.log"), "junction");
    const source = new FileLogSource({ dir: join(root, "plain", "round-1"), allowedServices: ["future-svc"] });
    await assert.rejects(
      () => source.query({ service: "future-svc", from: 0, to: Date.now() + 1e9, keywords: [] }, new AbortController().signal),
      (err: unknown) => err instanceof LogAccessError && /链接\/别名逃逸|越出日志目录/.test((err as Error).message),
    );
  } finally {
    /* tmp */
  }
});
