// 评测记录读写与变量分组：异构旧格式必须被安全跳过（避免混入旧口径）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJsonl, type EvalRecord } from "../../src/eval/report.ts";
import { groupVariants, variantKey } from "../../src/eval/compare.ts";

function record(scenario: string, audit: boolean): EvalRecord {
  return {
    fingerprint: {
      gitRev: "x",
      gitDirty: false,
      scenario,
      engine: "fake",
      model: "fake",
      systemPromptHash: "p",
      rulesHash: null,
      materialHash: "m",
      repoHead: null,
      budget: { maxToolCalls: 12, maxModelTurns: 10, timeoutMs: 1, maxToolResultChars: 1, maxResultChars: 1 },
      scorerVersion: "mvp-0.1.0",
      auditEnabled: audit,
      auditPolicyVersion: "1.0.0",
      auditMaxRounds: 1,
    },
    caseId: "c1",
    runIndex: 0,
    ok: true,
    evidence: [],
    score: {
      scorerVersion: "mvp-0.1.0",
      gradeMode: "material-only",
      calibrated: false,
      evidenceRecall: 1,
      evidencePrecision: 0.5,
      goldTotal: 2,
      goldMatched: 2,
      citedTotal: 2,
      citedDistractor: 1,
      semanticCorrect: "unscored",
      reviewStatus: "unreviewed",
      citationInvalid: 0,
      note: "",
    },
    metrics: { toolCalls: 2, modelTurns: 1, auditRounds: 0, durationMs: 5, inputTokens: 0, outputTokens: 0, totalTokens: 10 },
  };
}

test("readJsonl：跳过 header 与异构旧格式（无 fingerprint/caseId）", () => {
  const dir = mkdtempSync(join(tmpdir(), "td-eval-"));
  try {
    const p = join(dir, "x.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ kind: "header", fingerprint: {} }),
        JSON.stringify({ ts: 1790329842378, scenario: "checkout-timeout", cases: [] }), // 旧 v1 格式
        JSON.stringify(record("s", false)),
      ].join("\n") + "\n",
    );
    const records = readJsonl(p);
    assert.equal(records.length, 1, "只保留符合现行格式的记录");
    assert.equal(records[0]!.caseId, "c1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("variantKey 含 scenario；groupVariants 按变量分组", () => {
  assert.match(variantKey(record("a", true)), /scenario=a/);
  const groups = groupVariants([record("a", false), record("a", true), record("b", false)]);
  assert.equal(groups.length, 3);
});
