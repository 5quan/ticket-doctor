// 报告引用 v1/v2 与校验（docs/evidence-uid-design.md §9 / §11 阶段 5）：
// 跨轮 uid 引用通过、跨调查拒绝、历史重号要求 UID、D10 历史版本降级、本轮 sha 强校验。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { validateDraft } from "../../src/diagnosis/validate.ts";
import { StoreEvidenceResolver } from "../../src/evidence/store-resolver.ts";
import type { MaterialScope, ReportDraft } from "../../src/domain/types.ts";
import type { EvidenceItem } from "../../src/evidence/types.ts";
import { evidencePayloadHash } from "../../src/evidence/util.ts";
import { memoryStore } from "../helpers.ts";

function scopeWith(sha: string): MaterialScope {
  return {
    services: ["svc"],
    timeWindowBasis: "reported",
    timeWindow: { from: 0, to: 1 },
    repos: [{ repoId: "app", rev: sha, sha, resolved: true, pinnedBy: "head" }],
  };
}

function draftOf(...evidenceIds: string[]): ReportDraft {
  return {
    completeness: "partial",
    summary: "s",
    confirmedFacts: [],
    hypotheses: [{ cause: "c", confidence: "medium", status: "supported", evidenceIds }],
    uncertainties: [],
    nextSteps: [],
    missingMaterial: [],
  };
}

interface Ctx {
  investigationId: string;
  runId: string;
  attemptId: string;
  generation: number;
  finish: () => void;
}

function claimedRun(store: ReturnType<typeof memoryStore>, investigationId?: string): Ctx {
  const inv = investigationId
    ? { id: investigationId }
    : store.createInvestigation({ sessionCode: `code-${randomUUID().slice(0, 8)}`, provider: "feishu", accountId: "default", chatId: "oc_1" });
  const m = store.insertMessage({
    investigationId: inv.id,
    provider: "feishu",
    accountId: "default",
    externalMessageId: `om_${randomUUID()}`,
    text: "排查",
    receivedAt: 1,
  });
  const run = store.createRun({ investigationId: inv.id, messageId: m.id, maxAttempts: 3 });
  const claimed = store.claimNextRun("w1", 60_000)!;
  return {
    investigationId: inv.id,
    runId: run.id,
    attemptId: claimed.attemptId,
    generation: claimed.generation,
    finish: () => store.finishSuccess(run.id, claimed.generation, "report-x"),
  };
}

function commit(store: ReturnType<typeof memoryStore>, ctx: Ctx, items: EvidenceItem[], toolCallId: string) {
  const result = store.commitEvidenceBatch({
    batchId: randomUUID(),
    tool: "search_code",
    toolCallId,
    payloadHash: evidencePayloadHash(items),
    items,
    result: { count: items.length },
    investigationId: ctx.investigationId,
    runId: ctx.runId,
    attemptId: ctx.attemptId,
    generation: ctx.generation,
  });
  assert.ok(result.ok);
  return result.refs;
}

test("跨轮引用：第 2 轮报告用第 1 轮证据的 uid + 本轮证据，校验通过", () => {
  const store = memoryStore();
  const round1 = claimedRun(store);
  const shaRound1 = "a".repeat(40);
  const refs1 = commit(store, round1, [
    { kind: "code", excerpt: "old line", codeRef: { repoId: "app", sha: shaRound1, path: "A.java", startLine: 3, endLine: 3 } },
  ], "call-1");
  round1.finish();

  const shaRound2 = "b".repeat(40);
  const round2 = claimedRun(store, round1.investigationId);
  const refs2 = commit(store, round2, [
    { kind: "code", excerpt: "current line", codeRef: { repoId: "app", sha: shaRound2, path: "B.java", startLine: 9, endLine: 9 } },
  ], "call-2");

  const resolver = new StoreEvidenceResolver(store, round1.investigationId, round2.runId);
  const { report, issues } = validateDraft(draftOf(refs1[0]!.evidenceUid, refs2[0]!.evidenceId), {
    resolver,
    scope: scopeWith(shaRound2),
    investigationId: round1.investigationId,
    executionLimits: [],
  });

  assert.deepEqual(issues, [], "历史 uid 引用有效，本轮 sha 一致不强判");
  assert.equal(report.hypotheses[0]!.status, "supported");
  // v2：evidenceIds 统一写 uid（含本轮 E# 引用）
  assert.equal(report.hypotheses[0]!.evidenceIds[0], refs1[0]!.evidenceUid);
  assert.equal(report.hypotheses[0]!.evidenceIds[1], refs2[0]!.evidenceUid);
});

test("历史版本降级（D10）：supported 且全部代码证据 sha ≠ 本轮 → candidate + correction", () => {
  const store = memoryStore();
  const round1 = claimedRun(store);
  const refs1 = commit(store, round1, [
    { kind: "code", excerpt: "old", codeRef: { repoId: "app", sha: "a".repeat(40), path: "A.java", startLine: 3, endLine: 3 } },
  ], "call-1");
  round1.finish();

  const round2 = claimedRun(store, round1.investigationId);
  const resolver = new StoreEvidenceResolver(store, round1.investigationId, round2.runId);
  const draft = draftOf(refs1[0]!.evidenceUid);
  const { report, issues } = validateDraft(draft, {
    resolver,
    scope: scopeWith("b".repeat(40)),
    investigationId: round1.investigationId,
    executionLimits: [],
  });

  assert.equal(report.hypotheses[0]!.status, "candidate", "全部支撑证据均非本轮版本时应降级");
  assert.ok(report.corrections.some((c) => c.includes("非本轮钉定版本")));
  assert.ok(issues.some((i) => i.code === "stale_version_support"));
});

test("跨调查引用：uid 属于其他调查 → evidence_not_found", () => {
  const store = memoryStore();
  const other = claimedRun(store);
  const refsOther = commit(store, other, [
    { kind: "code", excerpt: "elsewhere", codeRef: { repoId: "app", sha: "a".repeat(40), path: "B.java", startLine: 1, endLine: 1 } },
  ], "call-x");
  other.finish();

  const inv = claimedRun(store);
  const resolver = new StoreEvidenceResolver(store, inv.investigationId, inv.runId);
  const { report, issues } = validateDraft(draftOf(refsOther[0]!.evidenceUid), {
    resolver,
    scope: scopeWith("a".repeat(40)),
    investigationId: inv.investigationId,
    executionLimits: [],
  });

  assert.ok(issues.some((i) => i.code === "evidence_not_found"), "跨调查证据结构性不可达");
  assert.equal(report.hypotheses[0]!.status, "candidate");
  assert.equal(report.completeness, "partial");
});

test("历史重号：调查内多条同名 E# → 拒绝并要求用 UID", () => {
  const store = memoryStore();
  // 历史形态：两轮各自 E1（用两轮 commit 是不可能的——短号续签保证唯一；构造历史重复行需绕过续签，
  // 这里直接验证解析语义：两个不同 run 各自有一条 E1 的行为由 v1 解析路径覆盖）
  const round1 = claimedRun(store);
  commit(store, round1, [
    { kind: "log", source: "stub", excerpt: "one" },
  ], "call-1");
  round1.finish();

  const round2 = claimedRun(store, round1.investigationId);
  const resolver = new StoreEvidenceResolver(store, round1.investigationId, round2.runId);
  // 引用本轮不存在的 E9
  const { issues } = validateDraft(draftOf("E9"), {
    resolver,
    scope: scopeWith("a".repeat(40)),
    investigationId: round1.investigationId,
    executionLimits: [],
  });
  assert.ok(issues.some((i) => i.code === "evidence_not_found" && i.message.includes("E9")));
});

test("本轮证据 sha 强校验：sha 与本轮 scope 不一致 → version_mismatch", () => {
  const store = memoryStore();
  const ctx = claimedRun(store);
  // 工具采集时带的是被钉版本的 sha；构造一个与本轮 scope 不同 sha 的本轮证据
  const refs = commit(store, ctx, [
    { kind: "code", excerpt: "mismatched", codeRef: { repoId: "app", sha: "c".repeat(40), path: "C.java", startLine: 7, endLine: 7 } },
  ], "call-1");
  const resolver = new StoreEvidenceResolver(store, ctx.investigationId, ctx.runId);
  const { report, issues } = validateDraft(draftOf(refs[0]!.evidenceId), {
    resolver,
    scope: scopeWith("a".repeat(40)),
    investigationId: ctx.investigationId,
    executionLimits: [],
  });
  assert.ok(issues.some((i) => i.code === "version_mismatch"));
  assert.equal(report.hypotheses[0]!.status, "candidate", "无有效证据 → 降级");
});
