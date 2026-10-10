// 自改进方案交付 A：把冻结案例物化成 Agent 可见的日志材料视图（§4.3 / §5）。
//
// 布局（data/evolve/rsi-bootstrap/<caseId>/）：
//   round-1/logs/<service>.log      Agent 可见（FileLogSource 格式）
//   round-1/logs/_mapping.json      输出行 → 原始 NDJSON 行号映射
//   materials.json                  冻结指纹：源 hash、逐服务 hash、视图 hash、归档附件 hash
//
// 变更 diff / 部署 / flags / metrics / traces / patterns 只登记为「归档附件」（readable=false），
// 不放进日志视图：现有工具没有附件读取入口，保存了不等于 Agent 读到（方案 §4.3）。
// 结果随版本冻结；重建会覆盖同一 caseId 的产物（幂等）。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMaterialManifest, listFilesRecursive, sha256Bytes } from "../../eval/lf/internals/hash.ts";
import { convertLogsNdjson, type CaseMaterialConversion } from "./convert.ts";
import type { RsiBootstrapCase } from "./catalog.ts";
import { RSI_BOOTSTRAP_ROOT } from "./catalog.ts";

export const EVOLVE_MATERIALS_ROOT = "data/evolve/rsi-bootstrap";
export const LOG_MATERIAL_VIEW = "round-1";

export interface ArchivedAttachment {
  path: string;
  sha256: string;
  bytes: number;
  /** 首期日志-only 基线：这些材料存档但不可读，评分不计（方案 §4.3）。 */
  readable: false;
}

export interface CaseMaterialManifest {
  schemaVersion: "rsi-material-manifest/v0";
  caseId: string;
  upstreamScenario: string;
  familyId: string;
  split: string;
  sourceType: string;
  reviewStatus: string;
  /** 源 NDJSON 的冻结指纹。 */
  source: { file: string; sha256: string; bytes: number };
  /** Agent 可见日志视图指纹。 */
  logView: { materialView: string; viewHash: string; files: Array<{ path: string; sha256: string; bytes: number }> };
  /** 归档但不可读的附件（不进入日志视图）。 */
  archivedAttachments: ArchivedAttachment[];
}

export interface MaterializeResult {
  caseId: string;
  manifest: CaseMaterialManifest;
  conversion: CaseMaterialConversion;
}

function relativeCaseDir(caseEntry: RsiBootstrapCase): string {
  // manifest 的 agentMaterialDir 形如 "public/rcb-001"。
  return join(RSI_BOOTSTRAP_ROOT, caseEntry.agentMaterialDir);
}

/** 转换单个案例并落盘到 outRoot（幂等覆盖）。 */
export function materializeCase(projectRoot: string, outRoot: string, caseEntry: RsiBootstrapCase): MaterializeResult {
  const caseDirRel = relativeCaseDir(caseEntry);
  const sourceAbs = join(projectRoot, caseDirRel, "logs.ndjson");
  if (!existsSync(sourceAbs)) throw new Error(`案例 ${caseEntry.caseId} 缺少 logs.ndjson：${sourceAbs}`);
  const raw = readFileSync(sourceAbs, "utf8");
  const conversion = convertLogsNdjson(caseEntry.caseId, `${caseDirRel}/logs.ndjson`, raw);

  const caseOut = join(outRoot, caseEntry.caseId);
  const logsDir = join(caseOut, LOG_MATERIAL_VIEW, "logs");
  rmSync(caseOut, { recursive: true, force: true });
  mkdirSync(logsDir, { recursive: true });

  for (const svc of conversion.services) {
    writeFileSync(join(logsDir, svc.fileName), svc.content, "utf8");
  }
  writeFileSync(
    join(caseOut, LOG_MATERIAL_VIEW, "mapping.json"),
    JSON.stringify(
      {
        schemaVersion: "rsi-material-mapping/v0",
        caseId: caseEntry.caseId,
        source: { file: conversion.sourceFile, sha256: conversion.sourceSha256, bytes: conversion.sourceBytes },
        services: conversion.services.map((s) => ({
          service: s.service,
          fileName: s.fileName,
          sha256: s.sha256,
          bytes: s.bytes,
          lines: s.lines,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

  // 归档附件：案例目录内除 logs.ndjson 外的全部文件，只登记 hash，不放入日志视图。
  const sourceDirAbs = join(projectRoot, caseDirRel);
  const archivedAttachments: ArchivedAttachment[] = listFilesRecursive(sourceDirAbs)
    .filter((f) => f.path !== "logs.ndjson")
    .map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes, readable: false as const }));

  const logView = buildMaterialManifest(logsDir, LOG_MATERIAL_VIEW);
  const manifest: CaseMaterialManifest = {
    schemaVersion: "rsi-material-manifest/v0",
    caseId: caseEntry.caseId,
    upstreamScenario: caseEntry.upstreamScenario,
    familyId: caseEntry.familyId,
    split: caseEntry.split,
    sourceType: caseEntry.sourceType,
    reviewStatus: caseEntry.reviewStatus,
    source: { file: conversion.sourceFile, sha256: conversion.sourceSha256, bytes: conversion.sourceBytes },
    logView: { materialView: LOG_MATERIAL_VIEW, viewHash: logView.viewHash, files: logView.files },
    archivedAttachments,
  };
  writeFileSync(join(caseOut, "materials.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { caseId: caseEntry.caseId, manifest, conversion };
}

export interface MaterialsAggregateManifest {
  schemaVersion: "rsi-materials-aggregate/v0";
  converterHash: string;
  sourceCommit: string;
  cases: Array<{ caseId: string; split: string; sourceSha256: string; logViewHash: string }>;
}

/**
 * 物化一批案例并写聚合 manifest。converterHash 由调用方传入（代码/锁文件指纹），
 * 便于方案 §5「转换器 hash」入账。
 */
export function materializeCases(
  projectRoot: string,
  outRoot: string,
  cases: RsiBootstrapCase[],
  opts: { converterSource: string; sourceCommit: string },
): MaterialsAggregateManifest {
  mkdirSync(outRoot, { recursive: true });
  const results = cases.map((c) => materializeCase(projectRoot, outRoot, c));
  const aggregate: MaterialsAggregateManifest = {
    schemaVersion: "rsi-materials-aggregate/v0",
    converterHash: sha256Bytes(opts.converterSource),
    sourceCommit: opts.sourceCommit,
    cases: results.map((r) => ({
      caseId: r.caseId,
      split: r.manifest.split,
      sourceSha256: r.manifest.source.sha256,
      logViewHash: r.manifest.logView.viewHash,
    })),
  };
  writeFileSync(join(outRoot, "materials-manifest.json"), JSON.stringify(aggregate, null, 2), "utf8");
  return aggregate;
}
