// manifest（方案 §11.2）：一次 suite 运行的完整口径锚点。
//
// 完整 SHA-256 指纹；材料 = 逐轮视图文件清单 + 仓库（HEAD/tree/dirty）；口径 = prompt/rules/
// scorer/工具/模型参数/预算/脚本/审计提示词。不存在的字段记 null，不猜测；凭据值绝不入 manifest。
//
// 冻结语义（A3）：逐 case 材料快照在**运行 trial 之前**冻结（snapshotCaseMaterials），
// 全部 trial 结束后**重取快照并对比**（materialDrift）——manifest 记录的是运行开始时的口径，
// 结束时的漂移单列在 freezeCheck，不允许悄悄混入。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildMaterialManifest, repoFingerprint, sha256Bytes, sha256File } from "./hash.ts";
import { materialRealPaths } from "./isolation.ts";
import { AUDIT_POLICY_VERSION } from "../../agent/audit-types.ts";
import { AUDIT_SYSTEM_PROMPT } from "../../agent/pi-auditor.ts";
import { LIST_FILES_LIMIT, READ_PAGE_LINES, SEARCH_PAGE_SIZE } from "../../sources/code.ts";
import { LOG_PAGE_SIZE_DEFAULT } from "../../sources/logs.ts";
import type { CaseDescriptorV2, MaterialManifestV2 } from "./types.ts";

export interface SuiteManifestV2 {
  schemaVersion: "prediagnosis-manifest-v2";
  suiteRunId: string;
  /** 请求的引擎口径（run --engine 的值）。 */
  engine: string;
  /** 实际执行的诊断引擎（捕获装饰器的内层 engine.name，A1）。 */
  engineActual: string;
  repeat: number;
  /** 被评项目（ticket-doctor 自身）的 git 状态；非干净提交时归档修改指纹（A3）。 */
  project: { head: string | null; dirty: boolean; dirtyFiles: string[]; diffHash: string | null };
  /** 模型/口径配置（不含 apiKey）。 */
  diagnosis: {
    engineConfig: string;
    provider: string;
    modelId: string;
    promptHash: string;
    maxToolCalls: number;
    timeoutMs: number;
    maxModelTurns: number;
    /** 截断预算（决定 B\C1 差距的关键配置）。 */
    maxToolResultChars: number;
    maxResultChars: number;
    /** 时间窗配置（决定日志可及范围）。 */
    defaultTimeWindowMs: number;
    fallbackTimeWindowMs: number;
    enforced: string[];
    /** 独立审计口径（OQ-30/A1）：策略版本 + 开关/轮次 + **实际审计引擎与提示词指纹**。 */
    audit: { policyVersion: string; enabled: boolean; maxRounds: number; failBlocks: boolean; engine: string | null; promptHash: string | null };
    /** 覆盖口径（T7）：源侧分页上限，直接决定 B\C1 差距。 */
    coverage: { searchPageSize: number; readPageLines: number; listFilesLimit: number; logPageSize: number };
  };
  scorerVersion: string;
  wall: { startedAt: number; finishedAt: number };
  /** 材料/仓库指纹漂移检查（A3）：manifest 冻结于运行前，结束时复核。 */
  freezeCheck: { checkedAt: number; ok: boolean; drifts: Array<{ caseId: string; details: string[] }> };
  cases: ManifestCase[];
}

export interface ManifestCase {
  caseId: string;
  familyId: string;
  split: string;
  admission: string;
  caseHash: string;
  truthHash: string | null;
  /** 脚本引擎步骤文件指纹（scriptedEngine 时非空，A3）。 */
  scriptHash: string | null;
  /** 脚本审计步骤文件指纹（scriptedAudit 时非空，A3）。 */
  auditScriptHash: string | null;
  isolation: { ok: boolean; counts: Record<string, number> };
  rounds: Array<{
    roundId: string;
    receivedAt: string;
    occurredAt: string | null;
    messageHash: string;
    viewRealPath: string;
    authorizedServices: string[];
    material: MaterialManifestV2;
    repos: Array<{ repoId: string; expectedSha: string | null; head: string | null; treeHash: string | null; dirty: boolean | null }>;
  }>;
}

function gitHead(repoDir: string): string | null {
  try {
    return execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function gitStatus(repoDir: string): { dirty: boolean; files: string[]; diffHash: string | null } {
  try {
    const porcelain = execFileSync("git", ["-C", repoDir, "status", "--porcelain"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const files = porcelain.split(/\r?\n/).filter(Boolean);
    let diffHash: string | null = null;
    if (files.length > 0) {
      // A3：非干净提交时归档完整修改内容指纹（工作区 diff HEAD；无 HEAD 时归档空 diff hash）。
      try {
        const diff = execFileSync("git", ["-C", repoDir, "diff", "HEAD"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        diffHash = sha256Bytes(diff);
      } catch {
        diffHash = null;
      }
    }
    return { dirty: files.length > 0, files, diffHash };
  } catch {
    return { dirty: false, files: [], diffHash: null };
  }
}

/** 冻结单 case 的材料与口径指纹（trial 运行前调用；A3）。 */
export function snapshotCaseMaterials(args: {
  projectRoot: string;
  caseDir: string;
  privateDir: string;
  caseDesc: CaseDescriptorV2;
  isolation: { ok: boolean; counts: Record<string, number> };
}): ManifestCase {
  const { caseDesc } = args;
  const caseDir = args.caseDir;
  const scriptHash = caseDesc.scriptedEngine ? sha256File(join(args.privateDir, "script.json")) : null;
  const auditScriptHash = caseDesc.scriptedAudit ? sha256File(join(args.privateDir, "audit.json")) : null;
  const truthPath = join(args.privateDir, "truth.private.json");
  return {
    caseId: caseDesc.caseId,
    familyId: caseDesc.familyId,
    split: caseDesc.split,
    admission: caseDesc.admission,
    caseHash: sha256File(join(caseDir, "case.json")),
    truthHash: existsSync(truthPath) ? sha256File(truthPath) : null,
    scriptHash,
    auditScriptHash,
    isolation: args.isolation,
    rounds: caseDesc.rounds.map((round) => {
      const realPaths = materialRealPaths(args.projectRoot, caseDir, caseDesc).find((x) => x.roundId === round.roundId)!;
      return {
        roundId: round.roundId,
        receivedAt: round.receivedAt,
        occurredAt: round.occurredAt,
        messageHash: sha256File(join(caseDir, round.messageRef)),
        viewRealPath: realPaths.realViewDir,
        authorizedServices: realPaths.authorizedServices,
        material: buildMaterialManifest(join(caseDir, round.materialView), round.materialView),
        repos: round.repos.map((repo) => {
          const fp = repoFingerprint(resolve(args.projectRoot, repo.dir));
          return {
            repoId: repo.repoId,
            expectedSha: repo.expectedSha ?? null,
            head: fp.head ?? null,
            treeHash: fp.treeHash ?? null,
            dirty: fp.dirty ?? null,
          };
        }),
      };
    }),
  };
}

/** 对比冻结快照与当前快照：返回漂移描述（空数组 = 无漂移）。 */
export function materialDrift(before: ManifestCase, after: ManifestCase): string[] {
  const details: string[] = [];
  if (before.caseHash !== after.caseHash) details.push("case.json 变更");
  if (before.truthHash !== after.truthHash) details.push("truth.private.json 变更");
  if (before.scriptHash !== after.scriptHash) details.push("script.json 变更");
  if (before.auditScriptHash !== after.auditScriptHash) details.push("audit.json 变更");
  for (const rb of before.rounds) {
    const ra = after.rounds.find((r) => r.roundId === rb.roundId);
    if (!ra) {
      details.push(`round ${rb.roundId} 快照缺失`);
      continue;
    }
    if (rb.messageHash !== ra.messageHash) details.push(`round ${rb.roundId} 题面变更`);
    if (rb.material.viewHash !== ra.material.viewHash) details.push(`round ${rb.roundId} 材料视图变更`);
    for (const repoB of rb.repos) {
      const repoA = ra.repos.find((x) => x.repoId === repoB.repoId);
      if (!repoA) {
        details.push(`round ${rb.roundId} repo ${repoB.repoId} 缺失`);
        continue;
      }
      if (repoB.treeHash !== repoA.treeHash) details.push(`round ${rb.roundId} repo ${repoB.repoId} tree 变更`);
    }
  }
  return details;
}

export function buildSuiteManifest(args: {
  suiteRunId: string;
  engine: string;
  engineActual: string;
  repeat: number;
  projectRoot: string;
  auditEngine: string | null;
  frozenCases: ManifestCase[];
  freezeCheck: { checkedAt: number; ok: boolean; drifts: Array<{ caseId: string; details: string[] }> };
  diagnosis: { provider: string; modelId: string; promptHash: string; maxToolCalls: number; timeoutMs: number; maxModelTurns: number; maxToolResultChars: number; maxResultChars: number; defaultTimeWindowMs: number; fallbackTimeWindowMs: number; audit: { enabled: boolean; maxRounds: number; failBlocks: boolean } };
  scorerVersion: string;
  wall: { startedAt: number; finishedAt: number };
}): SuiteManifestV2 {
  const projectHead = gitHead(args.projectRoot);
  const projectStatus = gitStatus(args.projectRoot);

  return {
    schemaVersion: "prediagnosis-manifest-v2",
    suiteRunId: args.suiteRunId,
    engine: args.engine,
    engineActual: args.engineActual,
    repeat: args.repeat,
    project: { head: projectHead, dirty: projectStatus.dirty, dirtyFiles: projectStatus.files, diffHash: projectStatus.diffHash },
    diagnosis: {
      engineConfig: args.engine,
      provider: args.diagnosis.provider,
      modelId: args.diagnosis.modelId,
      promptHash: args.diagnosis.promptHash,
      maxToolCalls: args.diagnosis.maxToolCalls,
      timeoutMs: args.diagnosis.timeoutMs,
      maxModelTurns: args.diagnosis.maxModelTurns,
      maxToolResultChars: args.diagnosis.maxToolResultChars,
      maxResultChars: args.diagnosis.maxResultChars,
      defaultTimeWindowMs: args.diagnosis.defaultTimeWindowMs,
      fallbackTimeWindowMs: args.diagnosis.fallbackTimeWindowMs,
      // 首版强制执行的是工具数与时间预算；token 硬限制在运行接口支持前记观测（§7.4）。
      enforced: ["maxToolCalls", "timeoutMs", "maxRounds"],
      audit: {
        policyVersion: AUDIT_POLICY_VERSION,
        enabled: args.diagnosis.audit.enabled,
        maxRounds: args.diagnosis.audit.maxRounds,
        failBlocks: args.diagnosis.audit.failBlocks,
        // 实际审计引擎（A1）：scripted-audit / fake-audit / pi-audit；未启用为 null。
        engine: args.auditEngine,
        // pi 审计提示词指纹；确定性审计器无模型提示词，记 null。
        promptHash: args.auditEngine === "pi-audit" ? sha256Bytes(AUDIT_SYSTEM_PROMPT) : null,
      },
      coverage: {
        searchPageSize: SEARCH_PAGE_SIZE,
        readPageLines: READ_PAGE_LINES,
        listFilesLimit: LIST_FILES_LIMIT,
        logPageSize: LOG_PAGE_SIZE_DEFAULT,
      },
    },
    scorerVersion: args.scorerVersion,
    wall: args.wall,
    freezeCheck: args.freezeCheck,
    // 冻结快照（运行前）原样入账；运行中的漂移只出现在 freezeCheck，不回写快照。
    cases: args.frozenCases,
  };
}
