// 评测结果记录与汇总：JSONL 追加，保存模型原输出 / 程序校验 / 审计后 三层结果 + 打分 + 指纹。
// 每次运行完整保留；脚本自测可离线重打分，真实模型波动如实记录（不要求答案相同）。
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvidenceRef } from "../evidence/types.ts";
import type { EvalFingerprint } from "./fingerprint.ts";
import type { CaseRunResult } from "./runner.ts";
import type { CaseReview, EvalScore } from "./scorer.ts";

const EVIDENCE_EXCERPT_CHARS = 1_000;

export interface EvalRecord {
  fingerprint: EvalFingerprint;
  caseId: string;
  runIndex: number;
  ok: boolean;
  error?: string;
  kind?: string;
  replyText?: string;
  draft?: unknown;
  validated?: unknown;
  report?: unknown;
  audit?: unknown;
  auditFailure?: string;
  validationIssues?: unknown;
  evidence: Array<{
    evidenceUid: string;
    evidenceId: string;
    kind: string;
    source?: string;
    level?: string;
    time?: number;
    codeRef?: unknown;
    excerpt: string;
    excerptTruncated: boolean;
  }>;
  score: EvalScore;
  metrics: CaseRunResult["metrics"];
}

function evidenceForRecord(evidence: EvidenceRef[]): EvalRecord["evidence"] {
  return evidence.map((e) => ({
    evidenceUid: e.evidenceUid,
    evidenceId: e.evidenceId,
    kind: e.kind,
    source: e.source,
    level: e.level,
    time: e.time,
    codeRef: e.codeRef,
    excerpt: e.excerpt.length > EVIDENCE_EXCERPT_CHARS ? `${e.excerpt.slice(0, EVIDENCE_EXCERPT_CHARS)}…` : e.excerpt,
    excerptTruncated: e.excerpt.length > EVIDENCE_EXCERPT_CHARS,
  }));
}

export function buildRecord(fingerprint: EvalFingerprint, result: CaseRunResult, score: EvalScore): EvalRecord {
  return {
    fingerprint,
    caseId: result.caseId,
    runIndex: result.runIndex,
    ok: result.ok,
    error: result.error,
    kind: result.kind,
    replyText: result.replyText,
    draft: result.draft,
    validated: result.validated,
    report: result.report,
    audit: result.audit,
    auditFailure: result.auditFailure,
    validationIssues: result.validationIssues,
    evidence: evidenceForRecord(result.evidence),
    score,
    metrics: result.metrics,
  };
}

export function appendJsonl(path: string, records: EvalRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join("\n");
  appendFileSync(path, lines.length > 0 ? `${lines}\n` : "");
}

export function writeRunHeader(path: string, fingerprint: EvalFingerprint): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ kind: "header", startedAt: new Date().toISOString(), fingerprint })}\n`, { flag: "a" });
}

export interface EvalSummary {
  runs: number;
  ok: number;
  failed: number;
  /** 仅在全部运行都已人工复核时给出；否则为 null（未评分）。 */
  meanRecall: number | null;
  meanPrecision: number | null;
  reviewedCorrect: number | null;
  meanToolCalls: number;
  meanModelTurns: number;
  meanDurationMs: number;
  meanTotalTokens: number;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function summarize(records: EvalRecord[]): EvalSummary {
  const ok = records.filter((r) => r.ok);
  const recalls = ok.map((r) => r.score.evidenceRecall).filter((v): v is number => v !== null);
  const precisions = ok.map((r) => r.score.evidencePrecision).filter((v): v is number => v !== null);
  const reviewed = ok.filter((r) => r.score.reviewStatus === "reviewed");
  return {
    runs: records.length,
    ok: ok.length,
    failed: records.length - ok.length,
    meanRecall: recalls.length === ok.length && recalls.length > 0 ? mean(recalls) : null,
    meanPrecision: precisions.length === ok.length && precisions.length > 0 ? mean(precisions) : null,
    reviewedCorrect: reviewed.length > 0 ? reviewed.filter((r) => r.score.semanticCorrect === true).length / reviewed.length : null,
    meanToolCalls: mean(ok.map((r) => r.metrics.toolCalls)) ?? 0,
    meanModelTurns: mean(ok.map((r) => r.metrics.modelTurns)) ?? 0,
    meanDurationMs: mean(ok.map((r) => r.metrics.durationMs)) ?? 0,
    meanTotalTokens: mean(ok.map((r) => r.metrics.totalTokens)) ?? 0,
  };
}

/** 读取 JSONL（跳过 header 行）；文件不存在返回空。 */
export function readJsonl(path: string): EvalRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: EvalRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as EvalRecord | { kind?: string };
      if ((parsed as { kind?: string }).kind === "header") continue;
      out.push(parsed as EvalRecord);
    } catch {
      // 忽略坏行
    }
  }
  return out;
}

/** 人工复核文件 reviews.json（可选）：{ "<caseId>": { "correct": true, "note": "..." } }。 */
export function loadReviews(scenarioDir: string): Map<string, CaseReview> {
  const file = join(scenarioDir, "reviews.json");
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, CaseReview>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}
