// 自改进方案交付 A：把物化材料装配成评测 v2 协议（case-v2 + truth-v2）（§6）。
//
// 输入：data/evolve/rsi-bootstrap/<caseId>/round-1/logs/*.log（由 evolve:materials:convert 产出）
// 输出：data/eval-v2/public/<caseId>/{case.json, r1-message.txt, round-1/*.log}
//       data/eval-v2/private/<caseId>/{truth.private.json, root-cause.md}
//       data/eval-v2/catalog/catalog.json（合并）
//       data/evolve/rsi-bootstrap/cases-manifest.json（控制器侧：split/admission/hash）
//
// 边界：本批案例 admission=qualified、review.provisional=true——**不得**进入正式运行；
// 数据集 builder 只纳入 admitted。日志视图只含 <service>.log；私有 rubric 在 private/ 下。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listFilesRecursive, sha256Bytes } from "../../eval/lf/internals/hash.ts";
import { validateCaseDescriptor, validatePairing, validateTruth } from "../../eval/lf/internals/schema.ts";
import type { CaseDescriptorV2, TruthFileV2 } from "../../eval/lf/internals/types.ts";
import { EVOLVE_MATERIALS_ROOT } from "./materialize.ts";
import { RSI_BOOTSTRAP_ROOT } from "./catalog.ts";
import { BOOTSTRAP_SPECS, type BootstrapCaseSpec } from "./rubrics.ts";
import { applyAdmission, rubricHash } from "./review.ts";

export const BOOTSTRAP_ADMISSION = "qualified" as const;
export const MATERIAL_VIEW = "round-1";

export interface BuiltCase {
  caseId: string;
  familyId: string;
  split: string;
  admission: string;
  services: string[];
  materialFiles: string[];
  casePublicHash: string;
  truthHash: string;
  rubricHash: string;
}

interface RsiTask {
  caseId: string;
  question: string;
  receivedAt: string;
}

function readTask(projectRoot: string, caseId: string): RsiTask {
  const path = join(projectRoot, RSI_BOOTSTRAP_ROOT, "tasks", `${caseId}.json`);
  const task = JSON.parse(readFileSync(path, "utf8")) as RsiTask;
  if (!task.question || !task.receivedAt) throw new Error(`${caseId} 任务缺少 question/receivedAt`);
  return task;
}

/** 组装单个案例的 case-v2 + truth-v2 并校验；不写入 catalog。 */
export function buildBootstrapCase(
  projectRoot: string,
  evalV2Root: string,
  spec: BootstrapCaseSpec,
  opts?: { materialsRoot?: string; reviewRoot?: string },
): { caseDesc: CaseDescriptorV2; truth: TruthFileV2; built: BuiltCase } {
  const materialsRoot = opts?.materialsRoot ?? join(projectRoot, EVOLVE_MATERIALS_ROOT);
  const srcLogs = join(materialsRoot, spec.caseId, MATERIAL_VIEW, "logs");
  if (!existsSync(srcLogs)) {
    throw new Error(`案例 ${spec.caseId} 尚无转换材料：先运行 evolve:materials:convert（缺少 ${srcLogs}）`);
  }
  const task = readTask(projectRoot, spec.caseId);
  const caseDir = join(evalV2Root, "public", spec.caseId);
  const privateDir = join(evalV2Root, "private", spec.caseId);
  rmSync(caseDir, { recursive: true, force: true });
  rmSync(privateDir, { recursive: true, force: true });
  const viewDir = join(caseDir, MATERIAL_VIEW);
  mkdirSync(viewDir, { recursive: true });
  mkdirSync(privateDir, { recursive: true });

  const logFiles = readdirSync(srcLogs).filter((f) => f.endsWith(".log") && !f.startsWith("_")).sort();
  if (logFiles.length === 0) throw new Error(`案例 ${spec.caseId} 转换目录没有 .log：${srcLogs}`);
  for (const f of logFiles) copyFileSync(join(srcLogs, f), join(viewDir, f));

  const messageRef = "r1-message.txt";
  writeFileSync(join(caseDir, messageRef), `${task.question}\n`, "utf8");

  const caseDesc: CaseDescriptorV2 = {
    schemaVersion: "prediagnosis-case-v2",
    caseId: spec.caseId,
    familyId: spec.familyId,
    split: spec.split,
    sourceTier: "public_simulated",
    publicBenchmark: true,
    admission: BOOTSTRAP_ADMISSION,
    maxRounds: 1,
    rounds: [
      {
        roundId: "r1",
        messageRef,
        receivedAt: task.receivedAt,
        occurredAt: null,
        materialView: MATERIAL_VIEW,
        services: [...spec.services].sort(),
        environment: "evaluation",
        repos: [],
      },
    ],
    diagnosisKind: "known-service",
    provenance: {
      questionSource: "RootCauseBench 公开告警字段派生的中文任务（本地草稿）",
      labelSource: "RootCauseBench oracle（私有）+ AI 起草的暂定 rubric（provisional）",
      contaminationRisk: "public-dataset",
    },
  };

  const truth: TruthFileV2 = {
    schemaVersion: "prediagnosis-truth-v2",
    caseId: spec.caseId,
    rootCauseRef: spec.rootCauseRef,
    locators: spec.locators,
    rounds: [{ roundId: "r1", ...spec.round }],
    review: {
      author: "ai-draft",
      reviewer: "pending-human-review",
      provisional: true,
      notes: "AI 依据 RootCauseBench oracle 与公开告警字段起草；未经人工复核，不得用于质量结论或发布门禁。",
    },
  };
  // 复核记录（仓库内）决定是否准入；rubric 变更会使旧批准失效。
  const admission = applyAdmission(projectRoot, truth, { reviewRoot: opts?.reviewRoot });
  caseDesc.admission = admission.admission;
  truth.review = admission.review;

  const cErr = validateCaseDescriptor(caseDesc, { caseDir, projectRoot, requireAdmitted: false });
  if (!cErr.ok) throw new Error(`case.json 校验失败（${spec.caseId}）：${cErr.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  writeFileSync(join(caseDir, "case.json"), JSON.stringify(caseDesc, null, 2), "utf8");
  writeFileSync(join(privateDir, spec.rootCauseRef), `${spec.rootCauseText}\n`, "utf8");

  const tErr = validateTruth(truth, { caseId: spec.caseId, privateDir });
  if (!tErr.ok) throw new Error(`truth.private.json 校验失败（${spec.caseId}）：${tErr.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  writeFileSync(join(privateDir, "truth.private.json"), JSON.stringify(truth, null, 2), "utf8");
  validatePairing(caseDesc, truth);

  const casePublicHash = sha256Bytes(
    [
      readFileSync(join(caseDir, "case.json"), "utf8"),
      readFileSync(join(caseDir, messageRef), "utf8"),
      ...listFilesRecursive(viewDir).map((f) => `material:${MATERIAL_VIEW}/${f.path}\0${f.sha256}\0${f.bytes}`),
    ].join("\n"),
  );

  return {
    caseDesc,
    truth,
    built: {
      caseId: spec.caseId,
      familyId: spec.familyId,
      split: spec.split,
      admission: caseDesc.admission,
      services: [...spec.services].sort(),
      materialFiles: listFilesRecursive(viewDir).map((f) => f.path),
      casePublicHash,
      truthHash: sha256Bytes(readFileSync(join(privateDir, "truth.private.json"))),
      rubricHash: rubricHash(truth),
    },
  };
}

export interface CasesManifest {
  schemaVersion: "rsi-cases-manifest/v0";
  cases: Array<{ caseId: string; familyId: string; split: string; admission: string; casePublicHash: string; truthHash: string; rubricHash: string; services: string[] }>;
}

/** 装配一批案例，合并 catalog，写控制器清单。返回清单。 */
export function buildBootstrapCases(
  projectRoot: string,
  evalV2Root: string,
  specs: BootstrapCaseSpec[] = BOOTSTRAP_SPECS,
  opts?: { materialsRoot?: string; reviewRoot?: string },
): { manifest: CasesManifest; built: BuiltCase[] } {
  const built: BuiltCase[] = [];
  for (const spec of specs) built.push(buildBootstrapCase(projectRoot, evalV2Root, spec, opts).built);

  // 合并 catalog（保留既有条目，upsert 本批）。
  const catalogPath = join(evalV2Root, "catalog", "catalog.json");
  mkdirSync(join(evalV2Root, "catalog"), { recursive: true });
  let existing: Array<{ caseId: string; publicDir: string; privateDir?: string }> = [];
  if (existsSync(catalogPath)) {
    existing = (JSON.parse(readFileSync(catalogPath, "utf8")) as { cases?: typeof existing }).cases ?? [];
  }
  const byId = new Map(existing.map((e) => [e.caseId, e]));
  for (const b of built) byId.set(b.caseId, { caseId: b.caseId, publicDir: `public/${b.caseId}`, privateDir: `private/${b.caseId}` });
  const merged = [...byId.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
  writeFileSync(catalogPath, JSON.stringify({ schemaVersion: "prediagnosis-catalog-v2", cases: merged }, null, 2), "utf8");

  const manifest: CasesManifest = {
    schemaVersion: "rsi-cases-manifest/v0",
    cases: built.map((b) => ({
      caseId: b.caseId,
      familyId: b.familyId,
      split: b.split,
      admission: b.admission,
      casePublicHash: b.casePublicHash,
      truthHash: b.truthHash,
      rubricHash: b.rubricHash,
      services: b.services,
    })),
  };
  const manifestDir = opts?.materialsRoot ?? join(projectRoot, EVOLVE_MATERIALS_ROOT);
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "cases-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { manifest, built };
}
