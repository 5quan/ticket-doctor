// 证据登记：工具执行时签发运行内唯一 ID（E1、E2…）。
// 模型只提交 evidenceId，来源/版本/行号由程序回填——引用错位在结构上不可能发生。
import type { CodeLocator, EvidenceRecord, EvidenceKind } from "../domain/types.ts";

export interface EvidenceInput {
  kind: EvidenceKind;
  source?: string;
  excerpt: string;
  time?: number;
  level?: string;
  codeRef?: CodeLocator;
}

export class EvidenceRegistry {
  private readonly runId: string;
  private readonly maxChars: number;
  private readonly entries = new Map<string, EvidenceRecord>();
  private counter = 0;

  constructor(runId: string, maxChars: number) {
    this.runId = runId;
    this.maxChars = maxChars;
  }

  get size(): number {
    return this.entries.size;
  }

  register(input: EvidenceInput): EvidenceRecord {
    const truncated = input.excerpt.length > this.maxChars;
    const excerpt = truncated ? `${input.excerpt.slice(0, this.maxChars)}…` : input.excerpt;
    // 同一采集物（同 kind + 同来源/位置 + 同片段）只签发一个 ID
    for (const existing of this.entries.values()) {
      if (existing.kind === input.kind && existing.source === this.sourceOf(input) && existing.excerpt === excerpt) {
        return existing;
      }
    }
    this.counter += 1;
    const evidenceId = `E${this.counter}`;
    const record: EvidenceRecord = {
      evidenceId,
      runId: this.runId,
      kind: input.kind,
      source: this.sourceOf(input),
      excerpt,
      truncated,
      ...(input.time !== undefined ? { time: input.time } : {}),
      ...(input.level !== undefined ? { level: input.level } : {}),
      ...(input.codeRef ? { codeRef: input.codeRef } : {}),
    };
    this.entries.set(evidenceId, record);
    return record;
  }

  get(id: string): EvidenceRecord | undefined {
    return this.entries.get(id);
  }

  all(): EvidenceRecord[] {
    return [...this.entries.values()].sort((a, b) => Number(a.evidenceId.slice(1)) - Number(b.evidenceId.slice(1)));
  }

  private sourceOf(input: EvidenceInput): string {
    if (input.source) return input.source;
    if (input.codeRef) {
      const ref = input.codeRef;
      const line = ref.startLine === ref.endLine ? `L${ref.startLine}` : `L${ref.startLine}-L${ref.endLine}`;
      return `${ref.repoId}@${ref.sha.slice(0, 10)} ${ref.path}#${line}`;
    }
    return "unknown";
  }
}
