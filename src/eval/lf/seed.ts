// smoke-v1 数据集（plan §4）：5 条合成工程案例，覆盖 5 个场景，优先复用现有材料
//（internals/engcases.ts 物化的 public/private + 脚本）。全部明确标记 synthetic；
// 结果不得表述为真实工单质量提升。
//
// Dataset Item 职责划分（plan §4）：
//   input          = 首轮用户问题 + 公开业务字段（不含后续轮文本/答案）
//   expectedOutput = 每轮允许结果/必需事实/禁止断言/补问目标/证据要求（由 truth 派生）
//   metadata       = case ID、来源类型、故障族、轮次脚本与材料索引、SHA、hash、协议版本
// 日志与源码保留为服务器冻结工件，Langfuse 只存索引与校验信息。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog, loadCase, loadRoundMessage, loadTruth, type CatalogEntry } from "./internals/load.ts";
import { materializeEngineeringCases } from "./internals/engcases.ts";
import { validatePairing } from "./internals/schema.ts";
import type { CaseDescriptorV2, TruthFileV2 } from "./internals/types.ts";

export const SMOKE_DATASET = "ticket-doctor-smoke-v1";
export const SMOKE_PROTOCOL = "prediagnosis-smoke-v1";

/** 场景覆盖（plan §4 的 5 条）→ 现有工程案例映射；diff-order 即数据集顺序。 */
export const SMOKE_PLAN: Array<{ caseId: string; scenario: string }> = [
  { caseId: "eng-clarify", scenario: "首轮缺材料，追问后获得补充材料" },
  { caseId: "eng-counter-evidence", scenario: "出现反证，更新或撤回先前判断" },
  { caseId: "eng-truncation", scenario: "存在相似干扰，避免无依据归因" },
  { caseId: "eng-version-drift", scenario: "版本与证据约束（预期阻断路径）" },
  { caseId: "eng-audit-loop", scenario: "材料充分，输出有依据的预诊断" },
];

export interface SmokeItemPayload {
  datasetName: string;
  input: { caseId: string; question: string; scenario: string };
  expectedOutput: {
    protocolVersion: string;
    rounds: Array<{
      roundId: string;
      allowedOutcomes: string[];
      allowedClaimDepth: string;
      requiredFacts: string[];
      forbiddenAssertions: Array<{ ruleId: string; assertAnyOf: string[][] }>;
      clarifyGoals: string[];
      evidenceRequirements: number;
    }>;
  };
  metadata: {
    caseId: string;
    sourceType: string;
    familyId: string;
    split: string;
    maxRounds: number;
    scenario: string;
    protocolVersion: string;
    materials: Array<{ repoId: string; expectedSha: string | null }>;
    caseHash: string;
    truthRef: string;
    itemId: string;
  };
}

/** 确定性 item id：同 caseId 同 id（upsert 幂等）。 */
export function smokeItemId(caseId: string): string {
  return createHash("sha256").update(`smoke-item\u0000${caseId}`).digest("hex").slice(0, 32);
}

export function casePublicHash(evalRoot: string, caseDesc: CaseDescriptorV2): string {
  const caseDir = join(evalRoot, "public", caseDesc.caseId);
  const parts = [readFileSync(join(caseDir, "case.json"), "utf8"), ...caseDesc.rounds.map((r) => (existsSync(join(caseDir, r.messageRef)) ? readFileSync(join(caseDir, r.messageRef), "utf8") : `[missing:${r.roundId}]`))];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/** 组装一个案例的 dataset item（纯函数，无网络；供测试与 seed 共用）。 */
export function buildSmokeItem(projectRoot: string, evalRoot: string, entry: CatalogEntry, scenario: string): SmokeItemPayload {
  const caseDesc = loadCase(evalRoot, entry, projectRoot);
  const truth = loadTruth(evalRoot, entry);
  const caseDir = join(evalRoot, entry.publicDir);
  // 配对校验（复用 eval-v2 schema 语义）：truth/case 轮次必须对齐。
  validatePairing(caseDesc, truth);
  const question = loadRoundMessage(caseDir, caseDesc.rounds[0]!.messageRef);
  return {
    datasetName: SMOKE_DATASET,
    input: { caseId: caseDesc.caseId, question, scenario },
    expectedOutput: {
      protocolVersion: SMOKE_PROTOCOL,
      rounds: caseDesc.rounds.map((r) => {
        const t = truth.rounds.find((x) => x.roundId === r.roundId)!;
        return {
          roundId: r.roundId,
          allowedOutcomes: [...t.allowedOutcomes],
          allowedClaimDepth: t.allowedClaimDepth,
          requiredFacts: t.requiredFacts.map((f) => (typeof f === "string" ? f : JSON.stringify(f))),
          forbiddenAssertions: t.forbiddenRules.map((rule) => ({ ruleId: rule.ruleId, assertAnyOf: rule.assertAnyOf })),
          clarifyGoals: t.materialNeeds.map((n) => n.description),
          evidenceRequirements: t.evidenceRequirements.length,
        };
      }),
    },
    metadata: {
      caseId: caseDesc.caseId,
      sourceType: "synthetic_engineering",
      familyId: caseDesc.familyId,
      split: caseDesc.split,
      maxRounds: caseDesc.maxRounds,
      scenario,
      protocolVersion: SMOKE_PROTOCOL,
      materials: caseDesc.rounds.flatMap((r) => r.repos.map((repo) => ({ repoId: repo.repoId, expectedSha: repo.expectedSha ?? null }))),
      caseHash: casePublicHash(evalRoot, caseDesc),
      truthRef: `private/${caseDesc.caseId}/truth.private.json（服务器冻结工件，此处只存指纹索引）`,
      itemId: smokeItemId(caseDesc.caseId),
    },
  };
}

export interface SeedResult {
  datasetName: string;
  items: Array<{ caseId: string; itemId: string; ok: boolean; error?: string }>;
  datasetId: string | null;
}

/**
 * 构建 smoke 数据集全部 item（物化工程案例 + 组装载荷），不触网。
 * seed 与预览/测试共用，保证“先可审阅草稿、再同步”是同一份载荷。
 */
export function buildSmokePayloads(projectRoot: string, evalRoot: string): SmokeItemPayload[] {
  materializeEngineeringCases(projectRoot, evalRoot);
  const catalog = loadCatalog(evalRoot);
  const byId = new Map(catalog.cases.map((c) => [c.caseId, c]));
  return SMOKE_PLAN.map(({ caseId, scenario }) => {
    const entry = byId.get(caseId);
    if (!entry) throw new Error(`smoke 计划引用了不存在的案例：${caseId}`);
    return buildSmokeItem(projectRoot, evalRoot, entry, scenario);
  });
}

/**
 * 物化工程案例 → 构建 item 载荷 → 同步到 Langfuse（幂等 upsert）。
 * 注意：Dataset 版本只冻结 item 内容，不冻结服务器文件——运行时还要核对
 * 材料 hash（plan §4），由 task 侧在装载时完成。
 */
export async function seedSmokeDataset(lf: import("@langfuse/client").LangfuseClient, projectRoot: string, evalRoot: string, sync: boolean): Promise<SeedResult> {
  const payloads = buildSmokePayloads(projectRoot, evalRoot);
  const result: SeedResult = { datasetName: SMOKE_DATASET, items: [], datasetId: null };

  if (sync) {
    const ds = (await lf.api.datasets.create({ name: SMOKE_DATASET, description: "ticket-doctor 评测 smoke 集：5 条合成工程案例（synthetic；仅验证闭环，不代表真实工单质量）" })) as { id?: string };
    result.datasetId = ds.id ?? null;
    for (const p of payloads) {
      try {
        await lf.api.datasetItems.create({
          datasetName: SMOKE_DATASET,
          id: p.metadata.itemId,
          input: p.input as unknown,
          expectedOutput: p.expectedOutput as unknown,
          metadata: p.metadata as unknown,
        });
        result.items.push({ caseId: p.metadata.caseId, itemId: p.metadata.itemId, ok: true });
      } catch (err) {
        result.items.push({ caseId: p.metadata.caseId, itemId: p.metadata.itemId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } else {
    for (const p of payloads) result.items.push({ caseId: p.metadata.caseId, itemId: p.metadata.itemId, ok: true });
  }
  return result;
}

/** 读回已物化 case 的 truth（task 控制器用；Agent 结构性不可读私有目录）。 */
export function loadSmokeTruth(evalRoot: string, caseId: string): TruthFileV2 {
  const catalog = loadCatalog(evalRoot);
  const entry = catalog.cases.find((c) => c.caseId === caseId);
  if (!entry) throw new Error(`smoke 数据集缺案例：${caseId}`);
  return loadTruth(evalRoot, entry);
}
