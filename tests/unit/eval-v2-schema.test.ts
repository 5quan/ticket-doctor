// 评测 v2：schema 严格校验、manifest hash、隔离预检（方案 §10.2/§11.2）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildMaterialManifest, sha256File } from "../../src/evals/v2/hash.ts";
import { checkIsolation } from "../../src/evals/v2/isolation.ts";
import { isPlaceholderSha, validateCaseDescriptor, validateTruth } from "../../src/evals/v2/schema.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "eval-v2-test-"));
}

function baseCaseJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "prediagnosis-case-v2",
    caseId: "c1",
    familyId: "f1",
    split: "engineering",
    sourceTier: "synthetic_engineering",
    publicBenchmark: false,
    admission: "admitted",
    maxRounds: 1,
    rounds: [
      { roundId: "r1", messageRef: "r1-message.txt", receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: null, materialView: "round-1", services: [], repos: [{ repoId: "app", dir: "fixtures/demo-repo" }] },
    ],
    ...over,
  };
}

function baseTruthJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "prediagnosis-truth-v2",
    caseId: "c1",
    locators: [],
    rounds: [
      { roundId: "r1", allowedOutcomes: ["report"], allowedClaimDepth: "root", requiredFacts: [], forbiddenRules: [], materialNeeds: [], evidenceRequirements: [], contradictedClaims: [], writebackRequirements: [] },
    ],
    review: { author: "a", reviewer: "b", provisional: true },
    ...over,
  };
}

function setupCase(root: string, caseJson: Record<string, unknown>, truthJson: Record<string, unknown>): { caseDir: string; privateDir: string } {
  const caseDir = join(root, "public", "c1");
  const privateDir = join(root, "private", "c1");
  mkdirSync(join(caseDir, "round-1"), { recursive: true });
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(caseDir, "case.json"), JSON.stringify(caseJson));
  writeFileSync(join(caseDir, "r1-message.txt"), "工单正文");
  writeFileSync(join(privateDir, "truth.private.json"), JSON.stringify(truthJson));
  return { caseDir, privateDir };
}

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..", "..");

// ---------- schema ----------

test("schema：合法 case/truth 通过", () => {
  const root = tmpRoot();
  try {
    const { caseDir, privateDir } = setupCase(root, baseCaseJson(), baseTruthJson());
    const rawCase = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8"));
    const caseResult = validateCaseDescriptor(rawCase, { caseDir, projectRoot: PROJECT_ROOT });
    assert.equal(caseResult.ok, true);
    const rawTruth = JSON.parse(readFileSync(join(privateDir, "truth.private.json"), "utf8"));
    const truthResult = validateTruth(rawTruth, { caseId: "c1", privateDir });
    assert.equal(truthResult.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema：占位 SHA / 假 SHA 拒绝", () => {
  assert.equal(isPlaceholderSha("0".repeat(40)), true);
  assert.equal(isPlaceholderSha("a".repeat(40)), true);
  assert.equal(isPlaceholderSha("0123456789abcdef0123456789abcdef01234567"), true);
  assert.equal(isPlaceholderSha("cc4c13e4ae3f65fc76c23962b316df4a60e0c7e0"), false);
  const root = tmpRoot();
  try {
    const bad = baseCaseJson({ split: "development", admission: "admitted", rounds: [{ roundId: "r1", messageRef: "r1-message.txt", receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: null, materialView: "round-1", services: [], repos: [{ repoId: "app", dir: "fixtures/demo-repo", expectedSha: "0".repeat(40) }] }] });
    const { caseDir } = setupCase(root, bad, baseTruthJson());
    const result = validateCaseDescriptor(JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")), { caseDir, projectRoot: PROJECT_ROOT });
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.path.includes("expectedSha")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema：非 engineering 拆分必须 admitted；scriptedEngine 只许 engineering", () => {
  const root = tmpRoot();
  try {
    const bad1 = setupCase(root, baseCaseJson({ split: "development", admission: "candidate" }), baseTruthJson());
    const r1 = validateCaseDescriptor(JSON.parse(readFileSync(join(bad1.caseDir, "case.json"), "utf8")), { caseDir: bad1.caseDir, projectRoot: PROJECT_ROOT });
    assert.equal(r1.ok, false);
    const bad2 = setupCase(root, baseCaseJson({ scriptedEngine: true, split: "development", admission: "admitted" }), baseTruthJson());
    const r2 = validateCaseDescriptor(JSON.parse(readFileSync(join(bad2.caseDir, "case.json"), "utf8")), { caseDir: bad2.caseDir, projectRoot: PROJECT_ROOT });
    assert.equal(r2.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema：truth 引用未定义 locator / caseId 不匹配 → 拒绝", () => {
  const root = tmpRoot();
  try {
    const badTruth = baseTruthJson({
      caseId: "other-case",
      locators: [],
      rounds: [
        baseTruthRoundJson({ evidenceRequirements: [{ requirementId: "req1", depth: "root", supportsAnyOf: [{ allOf: ["ghost"] }] }] }),
      ],
    });
    const { privateDir } = setupCase(root, baseCaseJson(), badTruth);
    const result = validateTruth(JSON.parse(readFileSync(join(privateDir, "truth.private.json"), "utf8")), { caseId: "c1", privateDir });
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function baseTruthRoundJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { roundId: "r1", allowedOutcomes: ["report"], allowedClaimDepth: "root", requiredFacts: [], forbiddenRules: [], materialNeeds: [], evidenceRequirements: [], contradictedClaims: [], writebackRequirements: [], ...over };
}

// ---------- manifest / hash ----------

test("manifest：内容变化改变 hash；同内容稳定；目录 hash 覆盖文件清单", () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, "view"), { recursive: true });
    writeFileSync(join(root, "view", "a.log"), "line-1\n");
    const m1 = buildMaterialManifest(join(root, "view"), "view");
    assert.equal(m1.viewHash, buildMaterialManifest(join(root, "view"), "view").viewHash);
    assert.equal(m1.files.length, 1);
    assert.equal(m1.files[0].sha256, sha256File(join(root, "view", "a.log")));
    writeFileSync(join(root, "view", "a.log"), "line-1\nline-2\n");
    const m2 = buildMaterialManifest(join(root, "view"), "view");
    assert.notEqual(m1.viewHash, m2.viewHash);
    writeFileSync(join(root, "view", "b.log"), "other\n");
    const m3 = buildMaterialManifest(join(root, "view"), "view");
    assert.equal(m3.files.length, 2);
    assert.notEqual(m2.viewHash, m3.viewHash, "新增文件必须改变目录 hash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 隔离预检 ----------

function gitInit(dir: string): void {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
}

test("隔离：私有目录落在材料视图内 → path_overlap", () => {
  const root = tmpRoot();
  try {
    const caseDir = join(root, "public", "c1");
    const privateDir = join(caseDir, "round-1", "private");
    mkdirSync(join(caseDir, "round-1"), { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(join(caseDir, "case.json"), JSON.stringify(baseCaseJson()));
    writeFileSync(join(caseDir, "r1-message.txt"), "m");
    writeFileSync(join(privateDir, "truth.private.json"), JSON.stringify(baseTruthJson()));
    const violations = checkIsolation(root, caseDir, baseCaseJson() as never, baseTruthJson() as never, join(caseDir, "round-1", "private"));
    assert.ok(violations.some((v) => v.code === "path_overlap"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("隔离：未来轮消息正文出现在当前轮日志 → future_message_leak", () => {
  const root = tmpRoot();
  try {
    const caseDir = join(root, "public", "c1");
    const privateDir = join(root, "private", "c1");
    mkdirSync(join(caseDir, "round-1"), { recursive: true });
    mkdirSync(join(caseDir, "round-2"), { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    const futureText = "补充信息：库存服务当时其他调用方都正常，请复核日志再判断";
    const caseJson = baseCaseJson({ maxRounds: 2, rounds: [
      { roundId: "r1", messageRef: "r1-message.txt", receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: null, materialView: "round-1", services: [], repos: [{ repoId: "app", dir: "fixtures/demo-repo" }] },
      { roundId: "r2", messageRef: "r2-message.txt", receivedAt: "2026-09-06T10:40:00+08:00", occurredAt: null, materialView: "round-2", services: [], repos: [{ repoId: "app", dir: "fixtures/demo-repo" }] },
    ] });
    writeFileSync(join(caseDir, "case.json"), JSON.stringify(caseJson));
    writeFileSync(join(caseDir, "r1-message.txt"), "第一轮工单正文");
    writeFileSync(join(caseDir, "r2-message.txt"), futureText);
    writeFileSync(join(caseDir, "round-1", "checkout-service.log"), `别的日志行\n${futureText}\n`);
    writeFileSync(join(privateDir, "truth.private.json"), JSON.stringify(baseTruthJson({ rounds: [baseTruthRoundJson(), baseTruthRoundJson({ roundId: "r2" })] })));
    const violations = checkIsolation(root, caseDir, caseJson as never, baseTruthJson() as never, join(privateDir));
    assert.ok(violations.some((v) => v.code === "future_message_leak"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("隔离：仓库 tree 出现答案性文件名 → answer_filename", () => {
  const root = tmpRoot();
  const repoDir = join(root, "repo");
  try {
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "code.java"), "class X {}");
    writeFileSync(join(repoDir, "gold-answer.md"), "答案");
    gitInit(repoDir);
    const caseDir = join(root, "public", "c1");
    const privateDir = join(root, "private", "c1");
    mkdirSync(join(caseDir, "round-1"), { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    const caseJson = baseCaseJson({ rounds: [{ roundId: "r1", messageRef: "r1-message.txt", receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: null, materialView: "round-1", services: [], repos: [{ repoId: "app", dir: repoDir }] }] });
    writeFileSync(join(caseDir, "case.json"), JSON.stringify(caseJson));
    writeFileSync(join(caseDir, "r1-message.txt"), "m");
    writeFileSync(join(privateDir, "truth.private.json"), JSON.stringify(baseTruthJson()));
    const violations = checkIsolation(root, caseDir, caseJson as never, baseTruthJson() as never, join("private", "c1"));
    assert.ok(violations.some((v) => v.code === "answer_filename"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("schema：正式 case（非 engineering）缺 expectedSha → 拒绝（读取前核验依据）", () => {
  const root = tmpRoot();
  try {
    const formal = baseCaseJson({
      split: "development",
      admission: "admitted",
      rounds: [{ roundId: "r1", messageRef: "r1-message.txt", receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: null, materialView: "round-1", services: ["svc"], repos: [{ repoId: "app", dir: "fixtures/demo-repo" }] }],
    });
    const { caseDir } = setupCase(root, formal, baseTruthJson());
    const result = validateCaseDescriptor(JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")), { caseDir, projectRoot: PROJECT_ROOT });
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.path.includes("expectedSha")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
