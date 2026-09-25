// 打分器：召回率 / 引用精确率 / 决策正确率，以及证据定位匹配。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiagnosisReport, EvidenceRecord } from "../../src/domain/types.ts";
import { evidenceMatches } from "../../src/evals/benchmark.ts";
import { scoreCase } from "../../src/evals/scorer.ts";
import type { BenchmarkCase } from "../../src/evals/types.ts";

function report(
  hypotheses: DiagnosisReport["hypotheses"],
  completeness: DiagnosisReport["completeness"] = "complete",
): DiagnosisReport {
  return {
    completeness,
    summary: "s",
    scope: { services: [], repos: [] },
    confirmedFacts: [],
    hypotheses,
    uncertainties: [],
    nextSteps: [],
    missingMaterial: [],
    corrections: [],
    executionLimits: [],
  };
}

function logEvidence(id: string, level: string, message: string): EvidenceRecord {
  return { evidenceId: id, runId: "r", kind: "log", source: "file", excerpt: message, truncated: false, level, time: 0 };
}

function codeEvidence(id: string, path: string, startLine: number, endLine: number): EvidenceRecord {
  return {
    evidenceId: id,
    runId: "r",
    kind: "code",
    source: "git",
    excerpt: "x",
    truncated: false,
    codeRef: { repoId: "app", sha: "abc", path, startLine, endLine },
  };
}

function baseCase(over: Partial<BenchmarkCase>): BenchmarkCase {
  return {
    id: "c",
    question: "q",
    occurredAt: "2026-09-06T10:01:00+08:00",
    receivedAt: "2026-09-06T10:30:00+08:00",
    service: "svc",
    gold: { answer: "库存超时", evidence: [] },
    distractors: [],
    ...over,
  };
}

test("命中 gold 且引用正确 → 三项全满", () => {
  const c = baseCase({
    gold: {
      answer: "库存超时",
      evidence: [{ kind: "log", level: "ERROR", substring: "InventoryClient 调用库存服务失败 timeout" }],
    },
    distractors: [{ kind: "log", level: "WARN", substring: "RedisPool" }],
  });
  const ev = [logEvidence("E1", "ERROR", "InventoryClient 调用库存服务失败 timeout after 3000ms")];
  const s = scoreCase(c, ev, report([{ cause: "库存超时", confidence: "high", status: "supported", evidenceIds: ["E1"] }]));
  assert.equal(s.recall, 1);
  assert.equal(s.precision, 1);
  assert.equal(s.correct, true);
});

test("被干扰证据带偏 → 不正确且记录引用干扰", () => {
  const c = baseCase({
    gold: {
      answer: "库存超时",
      evidence: [{ kind: "log", level: "ERROR", substring: "InventoryClient 调用库存服务失败 timeout" }],
    },
    distractors: [{ kind: "log", level: "WARN", substring: "RedisPool 连接池使用率" }],
  });
  const ev = [logEvidence("E1", "WARN", "RedisPool 连接池使用率 92% active=46/50")];
  const s = scoreCase(c, ev, report([{ cause: "Redis 连接池打满", confidence: "high", status: "supported", evidenceIds: ["E1"] }]));
  assert.equal(s.recall, 0);
  assert.equal(s.correct, false);
  assert.deepEqual(s.citedDistractor, ["E1"]);
  assert.equal(s.missedGold.length, 1);
});

test("代码证据按行区间重叠命中", () => {
  const c = baseCase({
    gold: { answer: "NPE", evidence: [{ kind: "code", repoId: "app", path: "OrderService.java", lineStart: 15, lineEnd: 17 }] },
  });
  const hit = codeEvidence("E1", "OrderService.java", 12, 20);
  const miss = codeEvidence("E2", "OrderService.java", 1, 5);
  const s = scoreCase(c, [hit, miss], report([{ cause: "库存返回 null", confidence: "high", status: "supported", evidenceIds: ["E1"] }]));
  assert.equal(s.recall, 1);
  assert.equal(s.correct, true);
});

test("材料不足类：partial 且无 supported 结论才算对", () => {
  const c = baseCase({ expect: "insufficient", gold: { answer: "无法确定", evidence: [] } });
  const ok = scoreCase(c, [], report([], "partial"));
  assert.equal(ok.correct, true);
  assert.equal(ok.recall, 1);
  const bad = scoreCase(c, [], report([{ cause: "臆断", confidence: "high", status: "supported", evidenceIds: [] }], "complete"));
  assert.equal(bad.correct, false);
});

test("evidenceMatches：级别不符不命中", () => {
  const rec = logEvidence("E1", "WARN", "RedisPool 连接池使用率 92%");
  assert.equal(evidenceMatches(rec, { kind: "log", level: "ERROR", substring: "RedisPool" }), false);
  assert.equal(evidenceMatches(rec, { kind: "log", substring: "RedisPool" }), true);
});
