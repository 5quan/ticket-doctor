// benchmark 加载与证据定位匹配。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EvidenceRecord } from "../domain/types.ts";
import type { Benchmark, EvidenceLocator } from "./types.ts";

export function loadBenchmark(path: string): Benchmark {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Benchmark;
  if (!parsed.scenario || !Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`benchmark 格式非法（缺 scenario/cases）：${path}`);
  }
  return parsed;
}

/** benchmark 内容版本（sha256 前 12 位）：内容变更即换口径，禁止与旧版本分数同表对比。 */
export function benchmarkVersion(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
}

export function describeLocator(loc: EvidenceLocator): string {
  return loc.kind === "log"
    ? `log[${loc.level ?? "*"}] "${loc.substring}"`
    : `code ${loc.path}#${loc.lineStart}-${loc.lineEnd}`;
}

/** 判断一条已签发证据是否命中某个源级定位。 */
export function evidenceMatches(record: EvidenceRecord, loc: EvidenceLocator): boolean {
  if (record.kind !== loc.kind) return false;
  if (loc.kind === "log") {
    if (loc.level && record.level !== loc.level) return false;
    return record.excerpt.includes(loc.substring);
  }
  const ref = record.codeRef;
  if (!ref) return false;
  if (ref.repoId !== loc.repoId || ref.path !== loc.path) return false;
  // 行区间重叠即算命中（search_code 为单行、read_code 为区间）。
  return ref.startLine <= loc.lineEnd && ref.endLine >= loc.lineStart;
}
