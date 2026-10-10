// 加载器：catalog / case 描述 / 私有标准（方案 §6 数据协议）。
//
// 目录约定（相对 data/eval-v2/）：
//   catalog/catalog.json
//   public/<case-id>/            公开材料（round 视图目录 + 消息文本）
//   private/<case-id>/           私有标准 truth.private.json（Agent 结构性不可读）
//   candidates.json              外部候选资格记录（FastAPI 等；admission 由资格验证决定）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseDescriptorV2, TruthFileV2 } from "./types.ts";
import { validateCaseDescriptor, validateTruth, type SchemaIssue } from "./schema.ts";

export const EVAL_V2_ROOT = "data/eval-v2";

export interface CatalogEntry {
  caseId: string;
  publicDir: string;
  privateDir?: string;
}

export interface Catalog {
  schemaVersion: string;
  cases: CatalogEntry[];
}

export function loadCatalog(evalV2Root: string): Catalog {
  const raw = JSON.parse(readFileSync(join(evalV2Root, "catalog", "catalog.json"), "utf8")) as Catalog;
  if (!Array.isArray(raw.cases)) throw new Error("catalog.json 缺少 cases 数组");
  return raw;
}

export function loadCase(evalV2Root: string, entry: CatalogEntry, projectRoot: string, opts?: { requireAdmitted?: boolean }): CaseDescriptorV2 {
  const caseDir = join(evalV2Root, entry.publicDir);
  const raw = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as unknown;
  const result = validateCaseDescriptor(raw, { caseDir, projectRoot, requireAdmitted: opts?.requireAdmitted });
  if (!result.ok) throw schemaError("case.json", result.errors);
  return result.value;
}

export function loadTruth(evalV2Root: string, entry: CatalogEntry): TruthFileV2 {
  if (!entry.privateDir) throw new Error(`catalog 条目 ${entry.caseId} 缺少 privateDir`);
  const privateDir = join(evalV2Root, entry.privateDir);
  const raw = JSON.parse(readFileSync(join(privateDir, "truth.private.json"), "utf8")) as unknown;
  const result = validateTruth(raw, { caseId: entry.caseId, privateDir });
  if (!result.ok) throw schemaError("truth.private.json", result.errors);
  return result.value;
}

export function loadRoundMessage(caseDir: string, messageRef: string): string {
  return readFileSync(join(caseDir, messageRef), "utf8").trim();
}

function schemaError(file: string, errors: SchemaIssue[]): Error {
  const detail = errors.map((e) => `${e.path || "<root>"}: ${e.message}`).join("; ");
  return new Error(`评测 v2 数据校验失败（${file}）：${detail}`);
}
