// 集成测试：走真实编排（假引擎 + 文件日志源 + git 代码源），验证一轮与多轮。
import assert from "node:assert/strict";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FakeDiagnosisEngine } from "../../src/agent/fake-engine.ts";
import { processDeliveriesOnce } from "../../src/delivery/delivery.ts";
import { executeRun } from "../../src/diagnosis/orchestrator.ts";
import { FakeFeishuClient } from "../../src/integrations/feishu/fake-client.ts";
import { extractSessionCode } from "../../src/domain/session.ts";
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

test("完整链路：新建调查 → 诊断 → 报告 → 投递，且报告带会话标号", async () => {
  const store = memoryStore();
  const cfg = config();
  const engine = new FakeDiagnosisEngine({ defaultService: "checkout-service" });
  const feishu = new FakeFeishuClient();

  const routed = routeInbound(store, cfg, msg({ externalMessageId: "om_1" }));
  assert.equal(routed.decision.kind, "new_investigation");
  const claimed = store.claimNextRun("w1", 60_000)!;
  assert.ok(claimed);
  await executeRun({ store, config: cfg, engine }, claimed);
  assert.equal(store.getRun(claimed.run.id)!.status, "succeeded");

  while ((await processDeliveriesOnce(store, cfg, feishu)) > 0) {
    // drain
  }
  assert.equal(feishu.sent.length, 1);
  const report = feishu.sent[0].text;
  assert.match(report, /【预检报告】/);
  assert.match(report, /已确认事实/);
  assert.equal(extractSessionCode(report), routed.sessionCode);
});

test("同一调查多轮：第二轮通过会话标号续接并保留上下文", async () => {
  const store = memoryStore();
  const cfg = config();
  const engine = new FakeDiagnosisEngine({ defaultService: "checkout-service" });
  const feishu = new FakeFeishuClient();

  routeInbound(store, cfg, msg({ externalMessageId: "om_1" }));
  await executeRun({ store, config: cfg, engine }, store.claimNextRun("w1", 60_000)!);
  while ((await processDeliveriesOnce(store, cfg, feishu)) > 0) {}
  const code = extractSessionCode(feishu.sent[0].text)!;

  const follow = routeInbound(
    store,
    cfg,
    msg({ externalMessageId: "om_2", mentionedBot: false, text: `补充 [TD-${code}] 只在 10:01 复现`, parentId: "om_1" }),
  );
  assert.equal(follow.decision.kind, "continue_investigation");
  await executeRun({ store, config: cfg, engine }, store.claimNextRun("w1", 60_000)!);
  while ((await processDeliveriesOnce(store, cfg, feishu)) > 0) {}

  assert.equal(feishu.sent.length, 2);
  assert.match(feishu.sent[1].text, /第 2 轮/);
});
