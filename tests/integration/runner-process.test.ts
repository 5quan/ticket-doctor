// 集成测试：Host 监管的独立 Runner 子进程（真实 spawn），验证结果回写与故障隔离。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { InboundMessage } from "../../src/domain/types.ts";
import { createRunnerExecutor } from "../../src/host/runner-executor.ts";
import { routeInbound } from "../../src/intake/router.ts";
import { evidencePayloadHash } from "../../src/evidence/util.ts";
import { memoryStore, testConfig } from "../helpers.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function config() {
  const base = testConfig();
  base.sources.repos = [{ repoId: "app", dir: join(ROOT, "fixtures", "demo-repo") }];
  base.sources.allowedRepos = ["app"];
  return base;
}

function msg(over: Partial<InboundMessage>): InboundMessage {
  return {
    provider: "feishu",
    accountId: "default",
    externalMessageId: over.externalMessageId ?? "om_x",
    chatId: "oc_1",
    chatType: "group",
    mentionedBot: true,
    text: "checkout-service 下单接口报 500",
    receivedAt: Date.parse("2026-09-06T10:02:00+08:00"),
    ...over,
  };
}

test("独立 Runner 子进程执行一轮诊断并由 Host 回写报告", async () => {
  const store = memoryStore();
  const cfg = config();
  const routed = routeInbound(store, cfg, msg({ externalMessageId: "om_proc_1" }));
  const claimed = store.claimNextRun("w1", 60_000)!;
  assert.ok(claimed);

  const execute = createRunnerExecutor({ store, config: cfg });
  await execute(claimed);

  assert.equal(store.getRun(claimed.run.id)!.status, "succeeded");
  const report = store.getReportByRun(claimed.run.id);
  assert.ok(report, "Host 应代 Runner 落库报告");
  // 会话条目由 Runner 上报、Host 带代次守卫落库
  assert.ok(store.listSessionEntries(routed.investigationId!).length >= 1);
  // 工具执行可观测（fake 引擎至少查一次日志）
  assert.ok(store.getRun(claimed.run.id)!.session_seq >= 1);
  // 证据经 IPC 两阶段提交：工具 commit 时已入库（阶段 3），带 uid 与批次溯源
  const evidence = store.listEvidenceByInvestigation(routed.investigationId!);
  assert.ok(evidence.length >= 1, "fake 引擎查日志应产生证据");
  for (const row of evidence) {
    assert.ok(row.evidence_uid, "每条证据应有 uid");
    assert.ok(row.batch_id, "每条证据应溯源到批次");
  }
});

test("Runner 输出非法协议行 → 本轮失败（不再忽略）", async () => {
  const store = memoryStore();
  const cfg = config();
  const routed = routeInbound(store, cfg, msg({ externalMessageId: "om_proc_garbage" }));
  const claimed = store.claimNextRun("w1", 60_000)!;
  const entry = join(tmpdir(), `bad-runner-${randomUUID()}.mjs`);
  writeFileSync(entry, `process.stdout.write("this is not json\\n");\nsetTimeout(() => process.exit(3), 200);\n`);
  try {
    const execute = createRunnerExecutor({ store, config: cfg, runnerEntry: entry });
    await execute(claimed);
    assert.equal(store.getRun(claimed.run.id)!.status, "failed", "非法协议行应判本轮失败");
    assert.equal(store.getReportByRun(claimed.run.id), undefined);
  } finally {
    rmSync(entry, { force: true });
    assert.ok(routed.investigationId);
  }
});

test("Runner 协议版本不匹配 → 拒绝本轮（D12 硬失败）", async () => {
  const store = memoryStore();
  const cfg = config();
  routeInbound(store, cfg, msg({ externalMessageId: "om_proc_version" }));
  const claimed = store.claimNextRun("w1", 60_000)!;
  const entry = join(tmpdir(), `old-runner-${randomUUID()}.mjs`);
  writeFileSync(
    entry,
    `process.stdout.write(JSON.stringify({type:"ready",protocolVersion:1}) + "\\n");\nsetTimeout(() => process.exit(0), 300);\n`,
  );
  try {
    const execute = createRunnerExecutor({ store, config: cfg, runnerEntry: entry });
    await execute(claimed);
    assert.equal(store.getRun(claimed.run.id)!.status, "failed", "协议版本不匹配应判本轮失败");
  } finally {
    rmSync(entry, { force: true });
  }
});

test("commit 后崩溃：批次保留，重试轮恢复成功且批次不重复（§8）", async () => {
  const store = memoryStore();
  const cfg = config();
  const routed = routeInbound(store, cfg, msg({ externalMessageId: "om_proc_crash" }));
  const claimed = store.claimNextRun("w1", 60_000)!;

  // 假 Runner：上报一个未决 tool_call + 提交证据批次，随即崩溃（模拟"commit 后 ACK 前"被杀）
  const items = [{ kind: "log", source: "stub", excerpt: "crash-boom", time: 1_700_000_000_000, level: "ERROR" }];
  const payloadHash = evidencePayloadHash(items as never);
  const entry = join(tmpdir(), `crash-runner-${randomUUID()}.mjs`);
  const script = `
const items = ${JSON.stringify(items)};
const entry = { type: "message", id: "e-crash", parentId: null, timestamp: new Date().toISOString(),
  message: { role: "assistant", content: [{ type: "toolCall", id: "call-crash", name: "query_logs" }] } };
let started = false;
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 2 }) + "\\n");
process.stdin.on("data", (d) => {
  if (started) return;
  started = true;
  process.stdout.write(JSON.stringify({ type: "session_entry", entry }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "evidence_commit", batchId: "batch-crash", tool: "query_logs",
    toolCallId: "call-crash", payloadHash: ${JSON.stringify(payloadHash)}, items, result: { count: 1 } }) + "\\n");
  setTimeout(() => process.exit(9), 50);
});
`;
  writeFileSync(entry, script);
  try {
    const execute = createRunnerExecutor({ store, config: cfg, runnerEntry: entry });
    await execute(claimed);
    // 崩溃后：批次已持久化（证据不丢）；runtime_error 不可自动重试，走人工 retry 重新入队
    assert.ok(store.getBatchByToolCall(claimed.run.id, "call-crash"), "已提交批次应保留");
    assert.equal(store.getRun(claimed.run.id)!.status, "failed");
    assert.ok(store.retryRun(claimed.run.id), "人工重试应重新入队");

    // 重试轮：真实 Runner 跑完；已提交批次不重复、不重建
    const retried = store.claimNextRun("w1", 60_000)!;
    assert.equal(retried.run.id, claimed.run.id);
    const executeReal = createRunnerExecutor({ store, config: cfg });
    await executeReal(retried);

    assert.equal(store.getRun(claimed.run.id)!.status, "succeeded");
    const batch = store.getBatchByToolCall(claimed.run.id, "call-crash");
    assert.ok(batch);
    assert.equal(batch.evidence.length, 1, "崩溃轮批次不得重复写入");
    const evidence = store.listEvidenceByInvestigation(routed.investigationId!);
    assert.ok(evidence.length >= 2, "恢复轮新证据正常续签");
  } finally {
    rmSync(entry, { force: true });
  }
});

test("两个 Runner 并发执行互不影响", async () => {
  const store = memoryStore();
  const cfg = config();
  const a = routeInbound(store, cfg, msg({ externalMessageId: "om_proc_a", chatId: "oc_a" }));
  const b = routeInbound(store, cfg, msg({ externalMessageId: "om_proc_b", chatId: "oc_b" }));
  const execute = createRunnerExecutor({ store, config: cfg });
  const ca = store.claimNextRun("w1", 60_000)!;
  const cb = store.claimNextRun("w2", 60_000)!;
  assert.notEqual(ca.run.investigation_id, cb.run.investigation_id);

  await Promise.all([execute(ca), execute(cb)]);
  assert.equal(store.getRun(ca.run.id)!.status, "succeeded");
  assert.equal(store.getRun(cb.run.id)!.status, "succeeded");
  assert.ok(store.getReportByRun(a.runId!));
  assert.ok(store.getReportByRun(b.runId!));
});

test("Runner 异常退出只判本轮失败，不带走其他进程", async () => {
  const store = memoryStore();
  const cfg = config();
  const routed = routeInbound(store, cfg, msg({ externalMessageId: "om_proc_bad" }));
  const claimed = store.claimNextRun("w1", 60_000)!;
  // 指向不存在的 Runner 入口，模拟 Runner 启动即失败
  const execute = createRunnerExecutor({ store, config: cfg, runnerEntry: "/nonexistent/runner.ts" });
  await execute(claimed);
  const run = store.getRun(claimed.run.id)!;
  assert.ok(["failed", "queued"].includes(run.status), `Runner 崩溃应判失败/可重试，实际 ${run.status}`);
  assert.equal(store.getReportByRun(claimed.run.id), undefined);
  assert.ok(routed.investigationId);
});
