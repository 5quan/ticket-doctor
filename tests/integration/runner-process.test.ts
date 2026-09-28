// 集成测试：Host 监管的独立 Runner 子进程（真实 spawn），验证结果回写与故障隔离。
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { InboundMessage } from "../../src/domain/types.ts";
import { createRunnerExecutor } from "../../src/host/runner-executor.ts";
import { routeInbound } from "../../src/intake/router.ts";
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
