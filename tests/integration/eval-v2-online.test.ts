// 交付四 D 验收：每轮终态自动评分。
//   * 评分幂等：重复触发（重试/重启）不重复计分（唯一索引去重）。
//   * 无 gold 缺测语义：线上分只有结构/引用/运行指标，不冒充正确率。
//   * postFinalize 钩子：成功提交/失败路径都触发；评分抛错不阻塞主链路。
//   * 候选案例池：needs_review 行可查（回流入口）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listNeedsReview, persistOnlineScore, scoreOnlineRound } from "../../src/evals/v2/online.ts";
import { executeRun } from "../../src/diagnosis/orchestrator.ts";
import { FakeDiagnosisEngine } from "../../src/agent/fake-engine.ts";
import { routeInbound } from "../../src/intake/router.ts";
import { memoryStore, testConfig } from "../helpers.ts";
import type { Store } from "../../src/storage/store.ts";
import type { InboundMessage } from "../../src/domain/types.ts";

function inbound(over: Partial<InboundMessage>): InboundMessage {
  return {
    provider: "feishu",
    accountId: "default",
    externalMessageId: over.externalMessageId ?? "om_d",
    chatId: "oc_d",
    chatType: "group",
    mentionedBot: true,
    text: over.text ?? "checkout-service 下单接口报 500",
    receivedAt: Date.parse("2026-09-06T10:02:00+08:00"),
    ...over,
  };
}

const cfg = () => {
  const c = testConfig();
  c.sources.repos = [];
  c.sources.allowedRepos = [];
  return c;
};

test("D 线上评分：report 轮产出结构/引用/运行指标；无 gold 指标缺测不冒充", async () => {
  const store: Store = memoryStore();
  const cfgd = cfg();
  const routed = routeInbound(store, cfgd, inbound({ externalMessageId: "om_d1" }));
  const claimed = store.claimNextRun("w1", 60_000)!;
  await executeRun({ store, config: cfgd, engine: new FakeDiagnosisEngine({ defaultService: "checkout-service" }) }, claimed);
  const run = store.getRun(claimed.run.id)!;
  assert.equal(run.status, "succeeded");

  const m = scoreOnlineRound({
    store,
    investigationId: routed.investigationId!,
    runId: claimed.run.id,
    attemptId: claimed.attemptId,
    roundId: "r1",
  });
  assert.equal(m.scorerVersion.startsWith("online-"), true, "线上口径独立版本");
  assert.equal(m.outcome, "report", "fake 引擎产出报告");
  assert.equal(typeof m.toolCalls, "number", "工具次数指标存在（fake 引擎可能为 0）");
  assert.ok(m.durationMs === null || m.durationMs >= 0);
  assert.equal(m.needsReview, false, "正常轮不进候选池");
  // 无 gold：没有 recall/正确率字段（结构性缺测）
  assert.equal("recall" in m, false);
  assert.equal("accuracy" in m, false);

  // 持久化 + 幂等
  const id1 = persistOnlineScore(store, m);
  const id2 = persistOnlineScore(store, m);
  assert.equal(id1, id2, "重复触发不得重复计分（唯一索引去重）");
  const count = (store.db.prepare("SELECT COUNT(*) AS n FROM eval_scores").get() as { n: number }).n;
  assert.equal(count, 1);
});

test("D 引用不可解析 → needs_review 候选池；listNeedsReview 可查", async () => {
  const store: Store = memoryStore();
  const cfgd = cfg();
  const routed = routeInbound(store, cfgd, inbound({ externalMessageId: "om_d2" }));
  const claimed = store.claimNextRun("w1", 60_000)!;
  await executeRun({ store, config: cfgd, engine: new FakeDiagnosisEngine({ defaultService: "checkout-service" }) }, claimed);
  // 篡改报告：注入一个不存在的引用 uid → 引用可解析性下降
  const reportRow = store.getReportByRun(claimed.run.id)!;
  const report = JSON.parse(reportRow.content) as { hypotheses: Array<{ evidenceIds: string[] }> };
  if (report.hypotheses.length === 0) report.hypotheses.push({ cause: "x", status: "supported", confidence: "low", evidenceIds: [] });
  report.hypotheses[0]!.evidenceIds = ["uid-nonexistent-0001"];
  store.db
    .prepare("UPDATE reports SET content = ? WHERE id = ?")
    .run(JSON.stringify(report), reportRow.id);

  const m = scoreOnlineRound({
    store,
    investigationId: routed.investigationId!,
    runId: claimed.run.id,
    attemptId: claimed.attemptId,
    roundId: "r1",
  });
  assert.equal(m.citationTotal, 1);
  assert.equal(m.citationValidRatio, 0, "不可解析引用 → 0");
  assert.equal(m.needsReview, true);
  assert.match(m.needsReviewReason ?? "", /不可解析引用/);

  persistOnlineScore(store, m);
  const pool = listNeedsReview(store);
  assert.ok(pool.some((p) => p.runId === claimed.run.id), "候选池包含该轮");
});

test("D postFinalize 钩子：成功提交触发一次；钩子抛错不阻塞主链路", async () => {
  const store: Store = memoryStore();
  const cfgd = cfg();
  const routed = routeInbound(store, cfgd, inbound({ externalMessageId: "om_d3" }));
  const claimed = store.claimNextRun("w1", 60_000)!;
  const calls: Array<{ ok: boolean; kind: string; round: number }> = [];
  await executeRun({
    store,
    config: cfgd,
    engine: new FakeDiagnosisEngine({ defaultService: "checkout-service" }),
    postFinalize: (info) => {
      calls.push({ ok: info.ok, kind: info.kind, round: info.round });
      if (calls.length === 1) throw new Error("评分器故障注入（不得阻塞主链路）");
    },
  }, claimed);
  const run = store.getRun(claimed.run.id)!;
  assert.equal(run.status, "succeeded", "钩子抛错后主链路照常成功");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ok, true);
  assert.equal(calls[0]!.kind, "report");
  assert.ok(routed.investigationId);
});

test("D 失败轮触发 postFinalize(ok=false) 并进候选池", async () => {
  const store: Store = memoryStore();
  const cfgd = cfg();
  // 指向不存在的 runner 模式：用引擎抛错路径（maxToolCalls=0 → ToolBudgetExceeded）
  const bad = { ...cfgd, diagnosis: { ...cfgd.diagnosis, maxToolCalls: 0 } };
  routeInbound(store, bad, inbound({ externalMessageId: "om_d4" }));
  const claimed = store.claimNextRun("w1", 60_000)!;
  const calls: Array<{ ok: boolean; kind: string }> = [];
  await executeRun({
    store,
    config: bad,
    engine: new FakeDiagnosisEngine({ defaultService: "checkout-service" }),
    postFinalize: (info) => {
      calls.push({ ok: info.ok, kind: info.kind });
    },
  }, claimed);
  const run = store.getRun(claimed.run.id)!;
  assert.notEqual(run.status, "succeeded", "预算为 0 → 本轮失败");
  assert.deepEqual(calls, [{ ok: false, kind: "error" }], "失败路径也触发终态钩");

  const m = scoreOnlineRound({
    store,
    investigationId: run.investigation_id,
    runId: run.id,
    attemptId: claimed.attemptId,
    roundId: "r1",
  });
  assert.equal(m.outcome, "error");
  assert.equal(m.needsReview, true, "提交失败 → 候选池");
  persistOnlineScore(store, m);
  assert.ok(listNeedsReview(store).some((p) => p.runId === run.id));
});
