// 故障注入：超时、运行中取消、租约过期后的会话恢复（不重复追加用户输入）。
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { DiagnosisEngine } from "../../src/agent/types.ts";
import { executeRun } from "../../src/diagnosis/orchestrator.ts";
import { RunSession } from "../../src/diagnosis/run-session.ts";
import type { InboundMessage } from "../../src/domain/types.ts";
import { routeInbound } from "../../src/intake/router.ts";
import { memoryStore, testConfig } from "../helpers.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function config() {
  const base = testConfig();
  base.sources.repos = [{ repoId: "app", dir: join(ROOT, "fixtures", "demo-repo") }];
  base.sources.allowedRepos = ["app"];
  return base;
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
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

/** 引擎：直到 abort 才 reject，用来模拟"卡住但可协作中止"。 */
function hangingEngine(onStart: () => void): DiagnosisEngine {
  return {
    name: "hang",
    run(_input, _toolbox, signal) {
      onStart();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted by signal")), { once: true });
      });
    },
  };
}

test("超时中止：按 timeout 判定，不当作成功", async () => {
  const store = memoryStore();
  const cfg = config();
  cfg.diagnosis.timeoutMs = 200;
  cfg.scheduler.heartbeatMs = 10;
  cfg.scheduler.maxAttempts = 1;
  const routed = routeInbound(store, cfg, msg({ externalMessageId: "om_timeout" }));
  const claimed = store.claimNextRun("w1", 60_000)!;

  await executeRun({ store, config: cfg, engine: hangingEngine(() => {}) }, claimed);
  const run = store.getRun(claimed.run.id)!;
  assert.equal(run.status, "failed");
  assert.equal(run.error_code, "timeout");
  assert.equal(store.getReportByRun(claimed.run.id), undefined);
  assert.ok(routed.investigationId);
});

test("运行中取消：终态 cancelled 且不自动重试", async () => {
  const store = memoryStore();
  const cfg = config();
  cfg.diagnosis.timeoutMs = 5_000;
  cfg.scheduler.heartbeatMs = 5;
  cfg.scheduler.maxAttempts = 3;
  const routed = routeInbound(store, cfg, msg({ externalMessageId: "om_cancel" }));
  const claimed = store.claimNextRun("w1", 60_000)!;

  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => (started = resolve));
  const running = executeRun({ store, config: cfg, engine: hangingEngine(started) }, claimed);

  await startedPromise;
  store.requestCancel(claimed.run.id);
  await running;

  const run = store.getRun(claimed.run.id)!;
  assert.equal(run.status, "cancelled", "取消后应为终态 cancelled，而非回到 queued");
  assert.equal(run.error_code, "cancelled");
  // 取消不产生失败通知投递
  assert.equal(store.claimNextDelivery(60_000), undefined);
  assert.ok(routed.investigationId);
});

test("租约过期接管后恢复会话：不重复追加用户输入", async () => {
  const store = memoryStore();
  const cfg = config();
  cfg.scheduler.leaseMs = -1; // 领取即过期
  const routed = routeInbound(store, cfg, msg({ externalMessageId: "om_resume" }));
  const investigationId = routed.investigationId!;
  const first = store.claimNextRun("w1", cfg.scheduler.leaseMs)!;

  // 第一次执行：落了用户输入条目后"崩溃"（不提交终态）
  const session1 = new RunSession(store, {
    investigationId,
    runId: first.run.id,
    attemptId: first.attemptId,
    generation: first.generation,
  });
  assert.equal(session1.resumed, false);
  session1.appendUserMessage("第一轮输入");
  assert.equal(store.listSessionEntries(investigationId).length, 1);

  // 租约过期 → 回收 → 重新领取（代次 +1）
  const recovered = store.recoverExpiredLeases(Date.now());
  assert.equal(recovered, 1);
  const second = store.claimNextRun("w2", 60_000, Date.now() + 10)!;
  assert.equal(second.run.id, first.run.id);
  assert.ok(second.generation > first.generation);

  // 恢复：本轮已有条目 → resumed=true，后端应 continue 而非重复 prompt
  const session2 = new RunSession(store, {
    investigationId,
    runId: second.run.id,
    attemptId: second.attemptId,
    generation: second.generation,
  });
  assert.equal(session2.resumed, true);
  assert.equal(store.listSessionEntries(investigationId).length, 1, "恢复不应重复追加用户输入");
});

test("过期执行者写入被代次守卫拒绝（Host 重启后的僵尸提交）", () => {
  const store = memoryStore();
  const cfg = config();
  const routed = routeInbound(store, cfg, msg({ externalMessageId: "om_zombie" }));
  const claimed = store.claimNextRun("w1", 60_000)!;
  // 模拟租约被回收后新执行者接管
  const recoveredAt = Date.now() + 120_000;
  store.recoverExpiredLeases(recoveredAt);
  const fresh = store.claimNextRun("w2", 60_000, recoveredAt + 10)!;
  assert.ok(fresh.generation > claimed.generation);

  // 旧执行者（过期代次）提交失败
  const rejected = store.finalizeSuccess({
    runId: claimed.run.id,
    generation: claimed.generation,
    attemptId: claimed.attemptId,
    investigationId: routed.investigationId!,
    round: 1,
    completeness: "complete",
    reportContent: { summary: "zombie" },
    evidence: [],
    contextSummary: "zombie",
  });
  assert.equal(rejected.ok, false);
});
