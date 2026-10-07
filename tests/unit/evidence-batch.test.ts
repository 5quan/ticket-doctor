// 证据批次提交（Store.commitEvidenceBatch）与 006 迁移：docs/evidence-uid-design.md §11 阶段 1。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { EvidenceItem } from "../../src/evidence/types.ts";
import { evidencePayloadHash } from "../../src/evidence/util.ts";
import { migrate, openDatabase } from "../../src/storage/db.ts";
import type { Store } from "../../src/storage/store.ts";
import { memoryStore } from "../helpers.ts";
import { emptyPage } from "../../src/sources/page.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const LOG_ITEM: EvidenceItem = { kind: "log", source: "stub", excerpt: "boom", time: 1, level: "ERROR" };
const CODE_ITEM: EvidenceItem = {
  kind: "code",
  excerpt: "return null;",
  codeRef: { repoId: "app", sha: "a".repeat(40), path: "A.java", startLine: 3, endLine: 3 },
};

function claimedRun(store: Store, investigationId?: string): {
  investigationId: string;
  runId: string;
  attemptId: string;
  generation: number;
  finish: () => void;
} {
  const inv = investigationId
    ? { id: investigationId }
    : store.createInvestigation({
        sessionCode: `code-${randomUUID().slice(0, 8)}`,
        provider: "feishu",
        accountId: "default",
        chatId: "oc_1",
      });
  const m = store.insertMessage({
    investigationId: inv.id,
    provider: "feishu",
    accountId: "default",
    externalMessageId: `om_${randomUUID()}`,
    text: "checkout-service 报错",
    receivedAt: 1,
  });
  const run = store.createRun({ investigationId: inv.id, messageId: m.id, maxAttempts: 3 });
  const claimed = store.claimNextRun("w1", 60_000)!;
  assert.equal(claimed.run.id, run.id);
  return {
    investigationId: inv.id,
    runId: run.id,
    attemptId: claimed.attemptId,
    generation: claimed.generation,
    finish: () => store.finishSuccess(run.id, claimed.generation, "report-x"),
  };
}

function commit(
  store: Store,
  ctx: ReturnType<typeof claimedRun>,
  items: EvidenceItem[],
  over: { batchId?: string; toolCallId?: string; payloadHash?: string; generation?: number } = {},
) {
  return store.commitEvidenceBatch({
    batchId: over.batchId ?? randomUUID(),
    tool: "query_logs",
    toolCallId: over.toolCallId ?? `call_${randomUUID().slice(0, 8)}`,
    payloadHash: over.payloadHash ?? evidencePayloadHash(items),
    items,
    result: { items: items.length },
    investigationId: ctx.investigationId,
    runId: ctx.runId,
    attemptId: ctx.attemptId,
    generation: over.generation ?? ctx.generation,
  });
}

test("006 迁移回填历史行 UID 且全局唯一，历史行内容零改写", () => {
  const db = openDatabase(":memory:");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  for (const f of [
    "001_init.sql",
    "002_session_log.sql",
    "003_attempt_session_log.sql",
    "004_session_entries.sql",
    "005_host_queue.sql",
  ]) {
    db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(f, Date.now());
  }
  // 历史数据：同一调查两轮各自 E1（run 级唯一，调查级重复——正是本设计要兼容的形态）
  const legacy = [
    ["run-1", "E1", "inv-1"],
    ["run-2", "E1", "inv-1"],
    ["run-2", "E2", "inv-1"],
  ];
  for (const [runId, evidenceId, invId] of legacy) {
    db.prepare(
      "INSERT INTO evidence (run_id, evidence_id, investigation_id, kind, source, excerpt, truncated, created_at) VALUES (?, ?, ?, 'log', 'stub', 'x', 0, 1)",
    ).run(runId, evidenceId, invId);
  }

  const ran = migrate(db, join(ROOT, "migrations"));
  // 交付四 D：新增 007（eval_scores 线上评分表）；006 的回填语义不受影响。
  assert.deepEqual(ran, ["006_evidence_uid.sql", "007_eval_scores.sql"]);

  const rows = db.prepare("SELECT run_id, evidence_id, evidence_uid, excerpt FROM evidence ORDER BY run_id, evidence_id").all() as Array<{
    run_id: string;
    evidence_id: string;
    evidence_uid: string | null;
    excerpt: string;
  }>;
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(row.evidence_uid, `历史行 ${row.run_id}/${row.evidence_id} 应回填 UID`);
    assert.equal(row.excerpt, "x", "历史行内容不得改写");
  }
  assert.equal(new Set(rows.map((r) => r.evidence_uid)).size, 3, "UID 必须全局唯一");

  // 报告引用格式版本：历史报告默认 v1
  assert.ok(db.prepare("SELECT reference_format_version FROM reports").all());
});

test("正常提交：分配 uid 与调查内短号，批次与证据可按 tool_call 找回", () => {
  const store = memoryStore();
  const ctx = claimedRun(store);

  const result = commit(store, ctx, [LOG_ITEM, CODE_ITEM], { toolCallId: "call-1" });
  assert.ok(result.ok);
  assert.deepEqual(result.refs.map((r) => r.evidenceId), ["E1", "E2"]);
  assert.ok(result.refs.every((r) => r.evidenceUid.length > 0));

  const found = store.getBatchByToolCall(ctx.runId, "call-1");
  assert.ok(found);
  assert.equal(found.batch.tool, "query_logs");
  assert.deepEqual(found.evidence.map((e) => e.evidence_id), ["E1", "E2"]);
  assert.deepEqual(found.evidence.map((e) => e.item_index), [0, 1]);
  assert.equal(found.evidence[0]!.evidence_uid, result.refs[0]!.evidenceUid);
});

test("短号续签：同调查下一轮从历史最大编号 +1 继续，跨 run 不重置", () => {
  const store = memoryStore();
  const first = claimedRun(store);
  const r1 = commit(store, first, [LOG_ITEM, CODE_ITEM]);
  assert.ok(r1.ok);
  first.finish();

  const second = claimedRun(store, first.investigationId);
  const r2 = commit(store, second, [LOG_ITEM]);
  assert.ok(r2.ok);
  assert.equal(r2.refs[0]!.evidenceId, "E3", "应从调查内最大编号 E2 续签为 E3");

  const rows = store.listEvidenceByInvestigation(first.investigationId);
  assert.deepEqual(
    rows.map((r) => r.evidence_id),
    ["E1", "E2", "E3"],
    "调查级列表按时间与数值序返回全部轮次证据",
  );
});

test("幂等：同批次同 payload 重发返回原映射，不重复落库", () => {
  const store = memoryStore();
  const ctx = claimedRun(store);
  const items = [LOG_ITEM, CODE_ITEM];
  const batchId = randomUUID();

  const first = commit(store, ctx, items, { batchId });
  assert.ok(first.ok);
  const again = commit(store, ctx, items, { batchId });
  assert.ok(again.ok);
  assert.deepEqual(
    again.refs.map((r) => [r.evidenceUid, r.evidenceId]),
    first.refs.map((r) => [r.evidenceUid, r.evidenceId]),
  );
  assert.equal(store.listEvidenceByInvestigation(ctx.investigationId).length, 2);
});

test("同批次不同 payload → conflict，且不产生半批数据", () => {
  const store = memoryStore();
  const ctx = claimedRun(store);
  const batchId = randomUUID();
  assert.ok(commit(store, ctx, [LOG_ITEM], { batchId }).ok);

  const rejected = commit(store, ctx, [LOG_ITEM, CODE_ITEM], { batchId });
  assert.ok(!rejected.ok);
  assert.equal(rejected.code, "conflict");
  assert.equal(store.listEvidenceByInvestigation(ctx.investigationId).length, 1, "冲突不得写入任何证据");
});

test("同一 tool_call 第二个批次 → conflict，且不产生半批数据", () => {
  const store = memoryStore();
  const ctx = claimedRun(store);
  assert.ok(commit(store, ctx, [LOG_ITEM], { toolCallId: "call-1" }).ok);

  const rejected = commit(store, ctx, [CODE_ITEM], { toolCallId: "call-1" });
  assert.ok(!rejected.ok);
  assert.equal(rejected.code, "conflict");
  assert.equal(store.listEvidenceByInvestigation(ctx.investigationId).length, 1);
  assert.equal(store.getBatchByToolCall(ctx.runId, "call-1")?.evidence.length, 1, "原批次保持原样");
});

test("payload 与 hash 不一致 → conflict（防传输损坏/篡改）", () => {
  const store = memoryStore();
  const ctx = claimedRun(store);
  const rejected = commit(store, ctx, [LOG_ITEM], { payloadHash: "deadbeef" });
  assert.ok(!rejected.ok);
  assert.equal(rejected.code, "conflict");
  assert.equal(store.listEvidenceByInvestigation(ctx.investigationId).length, 0);
});

test("代次不符或运行已结束 → lease_lost，不落任何数据", () => {
  const store = memoryStore();
  const ctx = claimedRun(store);
  const wrongGen = commit(store, ctx, [LOG_ITEM], { generation: ctx.generation + 1 });
  assert.ok(!wrongGen.ok);
  assert.equal(wrongGen.code, "lease_lost");
  assert.equal(store.listEvidenceByInvestigation(ctx.investigationId).length, 0);

  ctx.finish();
  const afterEnd = commit(store, ctx, [LOG_ITEM]);
  assert.ok(!afterEnd.ok);
  assert.equal(afterEnd.code, "lease_lost");
  assert.equal(store.listEvidenceByInvestigation(ctx.investigationId).length, 0);
});

// ---------- 阶段 2：工具经 StoreEvidenceSink 先 commit 后返回（fail-closed） ----------

test("工具返回前证据已入库：返回文本的 [E#] 与库中行一致", async () => {
  const { DiagnosisToolbox } = await import("../../src/agent/toolbox.ts");
  const { StoreEvidenceSink } = await import("../../src/evidence/store-sink.ts");
  const { GitCodeSource, MultiRepoCodeSource } = await import("../../src/sources/code.ts");
  const { join } = await import("node:path");

  const store = memoryStore();
  const ctx = claimedRun(store);
  const git = await GitCodeSource.create(join(process.cwd(), "fixtures", "demo-repo"), { repoId: "app" });
  const toolbox = new DiagnosisToolbox({
    logs: { name: "stub", async query() { return emptyPage(); } },
    code: new MultiRepoCodeSource([git]),
    sink: new StoreEvidenceSink(store, {
      investigationId: ctx.investigationId,
      runId: ctx.runId,
      attemptId: ctx.attemptId,
      generation: ctx.generation,
    }),
    scope: { services: [], repos: [] },
    maxToolCalls: 12,
    maxToolResultChars: 8_000,
    maxEvidenceChars: 4_000,
    signal: new AbortController().signal,
  });

  const out = await toolbox.searchCode({ pattern: "null" }, "call-inline-1");
  assert.match(out, /\[E1\] \S+:\d+: /);

  const rows = store.listEvidenceByInvestigation(ctx.investigationId);
  assert.equal(rows.length, 4, "工具返回时证据已持久化");
  assert.equal(rows[0]!.evidence_id, "E1");
  assert.ok(rows[0]!.evidence_uid);
  assert.equal(store.getBatchByToolCall(ctx.runId, "call-inline-1")?.batch.tool, "search_code");
});

test("commit 失败（lease_lost）→ 工具抛 EvidenceCommitError，不给模型返回材料", async () => {
  const { DiagnosisToolbox } = await import("../../src/agent/toolbox.ts");
  const { StoreEvidenceSink } = await import("../../src/evidence/store-sink.ts");
  const { EvidenceCommitError } = await import("../../src/evidence/errors.ts");
  const { GitCodeSource, MultiRepoCodeSource } = await import("../../src/sources/code.ts");
  const { join } = await import("node:path");

  const store = memoryStore();
  const ctx = claimedRun(store);
  ctx.finish(); // 运行已结束 → 提交必被拒

  const git = await GitCodeSource.create(join(process.cwd(), "fixtures", "demo-repo"), { repoId: "app" });
  const toolbox = new DiagnosisToolbox({
    logs: { name: "stub", async query() { return emptyPage(); } },
    code: new MultiRepoCodeSource([git]),
    sink: new StoreEvidenceSink(store, {
      investigationId: ctx.investigationId,
      runId: ctx.runId,
      attemptId: ctx.attemptId,
      generation: ctx.generation,
    }),
    scope: { services: [], repos: [] },
    maxToolCalls: 12,
    maxToolResultChars: 8_000,
    maxEvidenceChars: 4_000,
    signal: new AbortController().signal,
  });

  await assert.rejects(
    () => toolbox.searchCode({ pattern: "null" }),
    (err: unknown) => err instanceof EvidenceCommitError && err.code === "lease_lost",
  );
  assert.equal(store.listEvidenceByInvestigation(ctx.investigationId).length, 0);
});
