// 交付三 C1/C2 反例与验收：
// C1 诊断形态/来源/污染标记入账 + 准入语义（自动 gold 未复核不入正式总体）。
// C2 compare 可比性门禁（口径/材料/案例集不一致拒绝）+ 工程基线冻结可重算。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeEngineeringCases } from "../../src/evals/v2/engcases.ts";
import { runSuite } from "../../src/evals/v2/runner.ts";
import { checkCompatibility, compareSuites } from "../../src/evals/v2/compare.ts";
import type { SuiteSummaryV2 } from "../../src/evals/v2/types.ts";
import type { SuiteManifestV2 } from "../../src/evals/v2/manifest.ts";
import { testConfig } from "../helpers.ts";

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..", "..");
const CLI = join(PROJECT_ROOT, "src", "evals", "v2", "cli.ts");

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

async function runEngSuite(root: string, suite: string): Promise<void> {
  materializeEngineeringCases(PROJECT_ROOT, root);
  await runSuite({
    projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: suite, engine: "scripted", repeat: 1,
    baseConfig: testConfig(), caseIds: ["eng-clarify", "eng-counter-evidence"],
  });
}

test("C1 engcases 带来源与诊断形态入账；manifest/评分透传", async () => {
  const root = mkdtempSync(join(tmpdir(), "c1-prov-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    const caseJson = readJson(join(root, "public", "eng-clarify", "case.json")) as {
      diagnosisKind?: string;
      provenance?: { questionSource: string; labelSource: string; contaminationRisk: string };
      publicBenchmark: boolean;
    };
    assert.equal(caseJson.diagnosisKind, "known-service");
    assert.equal(caseJson.provenance?.contaminationRisk, "synthetic");
    assert.ok(caseJson.provenance?.questionSource.length > 0);
    assert.ok(caseJson.provenance?.labelSource.length > 0);

    await runEngSuite(root, "c1-s");
    const summary = readJson(join(root, "runs", "c1-s", "summary.json")) as SuiteSummaryV2;
    assert.equal(summary.cases[0]!.trials[0]!.diagnosisKind, "known-service", "评分透传 diagnosisKind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C1 public-dataset 污染标记必须与 publicBenchmark 一致（schema 拒绝矛盾声明）", async () => {
  const root = mkdtempSync(join(tmpdir(), "c1-contam-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    const caseDir = join(root, "public", "c1-bad-prov");
    const privateDir = join(root, "private", "c1-bad-prov");
    mkdirSync(join(caseDir, "round-1"), { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(join(caseDir, "r1-message.txt"), "x");
    writeFileSync(join(caseDir, "case.json"), JSON.stringify({
      schemaVersion: "prediagnosis-case-v2", caseId: "c1-bad-prov", familyId: "c1", split: "engineering",
      sourceTier: "synthetic_engineering", publicBenchmark: false, admission: "admitted", maxRounds: 1,
      diagnosisKind: "unknown-service",
      provenance: { questionSource: "RCAEval", labelSource: "RCAEval gold", contaminationRisk: "public-dataset" },
      rounds: [{ roundId: "r1", messageRef: "r1-message.txt", receivedAt: "2026-09-06T10:30:00+08:00", occurredAt: null, materialView: "round-1", services: ["svc"], repos: [{ repoId: "app", dir: "fixtures/evals/checkout-timeout/repo" }] }],
    }));
    writeFileSync(join(privateDir, "truth.private.json"), JSON.stringify({
      schemaVersion: "prediagnosis-truth-v2", caseId: "c1-bad-prov", locators: [],
      rounds: [{ roundId: "r1", allowedOutcomes: ["report"], allowedClaimDepth: "root", requiredFacts: [], forbiddenRules: [], materialNeeds: [], evidenceRequirements: [], contradictedClaims: [], writebackRequirements: [] }],
      review: { author: "a", reviewer: "b", provisional: true },
    }));
    const catalogPath = join(root, "catalog", "catalog.json");
    const catalog = readJson(catalogPath) as { cases: Array<{ caseId: string; publicDir: string; privateDir: string }> };
    catalog.cases.push({ caseId: "c1-bad-prov", publicDir: "public/c1-bad-prov", privateDir: "private/c1-bad-prov" });
    writeFileSync(catalogPath, JSON.stringify(catalog));

    // publicBenchmark=false + contaminationRisk=public-dataset → 装载即拒绝（矛盾声明记 load_error）
    const summary = await runSuite({
      projectRoot: PROJECT_ROOT, evalV2Root: root, suiteRunId: "c1-contam", engine: "scripted", repeat: 1,
      baseConfig: testConfig(), caseIds: ["c1-bad-prov"],
    });
    assert.equal(summary.cases.length, 0, "矛盾声明的 case 不得进入评测");
    const status = summary.caseStatuses.find((s) => s.caseId === "c1-bad-prov")!;
    assert.equal(status.phase, "load_error");
    assert.match(status.reason ?? "", /provenance\.contaminationRisk/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2 compare：同口径同材料可比较；口径/材料/案例集变化拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "c2-compare-"));
  try {
    materializeEngineeringCases(PROJECT_ROOT, root);
    await runEngSuite(root, "c2-base");
    await runEngSuite(root, "c2-cand");
    const load = (suite: string): { summary: SuiteSummaryV2; manifest: SuiteManifestV2 | null } => ({
      summary: readJson(join(root, "runs", suite, "summary.json")) as SuiteSummaryV2,
      manifest: readJson(join(root, "runs", suite, "manifest.json")) as SuiteManifestV2,
    });
    const base = load("c2-base");
    const cand = load("c2-cand");

    // 可比：成对比较产出（无硬失败差、指标差 0 或 null）
    const result = compareSuites(base, cand);
    assert.equal(result.compatible, true, JSON.stringify(result.issues));
    assert.equal(result.pairs.length, 2);
    assert.equal(result.summary.newFailuresTotal, 0);

    // 口径不一致（伪造候选 manifest.scorerVersion）→ 拒绝
    const tampered = structuredClone(cand.manifest)! as SuiteManifestV2;
    tampered.scorerVersion = "0.0.0";
    const r1 = compareSuites(base, { summary: cand.summary, manifest: tampered });
    assert.equal(r1.compatible, false);
    assert.ok(r1.issues.some((i) => i.reason.includes("评分口径不一致")));

    // 材料变更（伪造 truthHash）→ 拒绝
    const tampered2 = structuredClone(cand.manifest)! as SuiteManifestV2;
    tampered2.cases[0]!.truthHash = "f".repeat(64);
    const r2 = compareSuites(base, { summary: cand.summary, manifest: tampered2 });
    assert.equal(r2.compatible, false);
    assert.ok(r2.issues.some((i) => i.reason.includes("私有标准已变更")));

    // 案例集缩小 → 拒绝（分母不得静默缩小）
    const tampered3 = structuredClone(cand.manifest)! as SuiteManifestV2;
    tampered3.cases = tampered3.cases.slice(0, 1);
    const r3 = compareSuites(base, { summary: cand.summary, manifest: tampered3 });
    assert.equal(r3.compatible, false);
    assert.ok(r3.issues.some((i) => i.reason.includes("分母不得静默缩小") || i.reason.includes("缺少基线案例")));

    // checkCompatibility 纯函数直查
    assert.deepEqual(checkCompatibility(base, base), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2 CLI compare 端到端：写 compare.json；缺产物拒绝", () => {
  const root = mkdtempSync(join(tmpdir(), "c2-cli-"));
  try {
    const runCli = (args: string[]): { status: number; out: string } => {
      try {
        return { status: 0, out: execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...args, "--eval-root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    };
    // 缺产物：拒绝
    const r0 = runCli(["compare", "--baseline", "nope-a", "--candidate", "nope-b"]);
    assert.equal(r0.status, 1);
    // 正常比较
    materializeEngineeringCases(PROJECT_ROOT, root);
    for (const suite of ["c2-cli-base", "c2-cli-cand"]) {
      const r = runCli(["run", "--suite", suite, "--engine", "scripted", "--cases", "eng-clarify,eng-counter-evidence"]);
      assert.equal(r.status, 0, r.out);
    }
    const r1 = runCli(["compare", "--baseline", "c2-cli-base", "--candidate", "c2-cli-cand"]);
    assert.equal(r1.status, 0, r1.out);
    assert.match(r1.out, /新增硬失败 0/);
    const compareJson = readJson(join(root, "runs", "c2-cli-cand", "compare.json")) as { compatible: boolean; pairs: unknown[] };
    assert.equal(compareJson.compatible, true);
    assert.equal(compareJson.pairs.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
