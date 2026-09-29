// 证据负载的规范化序列化与哈希：Runner 与 Host 分处两进程也能算出同一 payload_hash。
//
// canonicalJson：键递归排序、丢弃 undefined，数组保序——JSON 传输的键序差异不影响哈希。
import { createHash } from "node:crypto";
import type { EvidenceRecord } from "../domain/types.ts";
import type { EvidenceItem, EvidenceRef } from "./types.ts";

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** 工具侧与 Host 侧共用的批次负载哈希；Host 在事务内重算比对，防传输损坏/篡改。 */
export function evidencePayloadHash(items: EvidenceItem[]): string {
  return createHash("sha256").update(canonicalJson(items)).digest("hex");
}

/** 未显式给 source 时按 codeRef 生成，与历史证据的 source 格式保持一致。 */
export function evidenceSourceOf(item: EvidenceItem): string {
  if (item.source) return item.source;
  if (item.codeRef) {
    const ref = item.codeRef;
    const line = ref.startLine === ref.endLine ? `L${ref.startLine}` : `L${ref.startLine}-L${ref.endLine}`;
    return `${ref.repoId}@${ref.sha.slice(0, 10)} ${ref.path}#${line}`;
  }
  return "unknown";
}

/** EvidenceRef → EvidenceRecord（过渡期：Runner 上报与评测打分仍消费 record 形态）。 */
export function evidenceRefToRecord(ref: EvidenceRef, runId: string): EvidenceRecord {
  return {
    evidenceId: ref.evidenceId,
    ...(ref.evidenceUid ? { evidenceUid: ref.evidenceUid } : {}),
    runId,
    kind: ref.kind,
    source: ref.source ?? evidenceSourceOf(ref),
    excerpt: ref.excerpt,
    truncated: ref.truncated,
    ...(ref.time !== undefined ? { time: ref.time } : {}),
    ...(ref.level !== undefined ? { level: ref.level } : {}),
    ...(ref.codeRef ? { codeRef: ref.codeRef } : {}),
  };
}
