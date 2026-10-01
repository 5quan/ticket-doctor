// manifest（方案 §11.2）：一次 suite 运行的完整口径锚点。
//
// 完整 SHA-256 指纹；材料 = 逐轮视图文件清单 + 仓库（HEAD/tree/dirty）；口径 = prompt/rules/
// scorer/工具/模型参数/预算。不存在的字段记 null，不猜测；凭据值绝不入 manifest。
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { buildMaterialManifest, repoFingerprint, sha256File } from "./hash.ts";
import type { CaseDescriptorV2, MaterialManifestV2, TruthFileV2 } from "./types.ts";

export interface SuiteManifestV2 {
  schemaVersion: "prediagnosis-manifest-v2";
  suiteRunId: string;
  engine: string;
  repeat: number;
  /** 被评项目（ticket-doctor 自身）的 git 状态。 */
  project: { head: string | null; dirty: boolean };
  /** 模型/口径配置（不含 apiKey）。 */
  diagnosis: {
    engineConfig: string;
    provider: string;
    modelId: string;
    promptHash: string;
    maxToolCalls: number;
    timeoutMs: number;
    maxModelTurns: number;
    enforced: string[];
  };
  scorerVersion: string;
  wall: { startedAt: number; finishedAt: number };
  cases: Array<{
    caseId: string;
    familyId: string;
    split: string;
    admission: string;
    caseHash: string;
    truthHash: string | null;
    isolation: { ok: boolean; counts: Record<string, number> };
    rounds: Array<{
      roundId: string;
      receivedAt: string;
      occurredAt: string | null;
      messageHash: string;
      material: MaterialManifestV2;
      repos: Array<{ repoId: string; expectedSha: string | null; head: string | null; treeHash: string | null; dirty: boolean | null }>;
    }>;
  }>;
}

function gitHead(repoDir: string): string | null {
  try {
    return execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function buildSuiteManifest(args: {
  suiteRunId: string;
  engine: string;
  repeat: number;
  projectRoot: string;
  caseDirOf: (caseId: string) => string;
  privateDirOf: (caseId: string) => string;
  cases: Array<{ caseDesc: CaseDescriptorV2; truth: TruthFileV2 | null; isolation: { ok: boolean; counts: Record<string, number> } }>;
  diagnosis: { provider: string; modelId: string; promptHash: string; maxToolCalls: number; timeoutMs: number; maxModelTurns: number };
  scorerVersion: string;
  wall: { startedAt: number; finishedAt: number };
}): SuiteManifestV2 {
  const projectHead = gitHead(args.projectRoot);
  const projectDirty = (() => {
    try {
      return execFileSync("git", ["-C", args.projectRoot, "status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    } catch {
      return false;
    }
  })();

  return {
    schemaVersion: "prediagnosis-manifest-v2",
    suiteRunId: args.suiteRunId,
    engine: args.engine,
    repeat: args.repeat,
    project: { head: projectHead, dirty: projectDirty },
    diagnosis: {
      engineConfig: args.engine,
      provider: args.diagnosis.provider,
      modelId: args.diagnosis.modelId,
      promptHash: args.diagnosis.promptHash,
      maxToolCalls: args.diagnosis.maxToolCalls,
      timeoutMs: args.diagnosis.timeoutMs,
      maxModelTurns: args.diagnosis.maxModelTurns,
      // 首版强制执行的是工具数与时间预算；token 硬限制在运行接口支持前记观测（§7.4）。
      enforced: ["maxToolCalls", "timeoutMs", "maxRounds"],
    },
    scorerVersion: args.scorerVersion,
    wall: args.wall,
    cases: args.cases.map(({ caseDesc, truth, isolation }) => {
      const caseDir = args.caseDirOf(caseDesc.caseId);
      return {
        caseId: caseDesc.caseId,
        familyId: caseDesc.familyId,
        split: caseDesc.split,
        admission: caseDesc.admission,
        caseHash: sha256File(join(caseDir, "case.json")),
        truthHash: truth ? sha256File(join(args.privateDirOf(caseDesc.caseId), "truth.private.json")) : null,
        isolation,
        rounds: caseDesc.rounds.map((round) => ({
          roundId: round.roundId,
          receivedAt: round.receivedAt,
          occurredAt: round.occurredAt,
          messageHash: sha256File(join(caseDir, round.messageRef)),
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
        })),
      };
    }),
  };
}
