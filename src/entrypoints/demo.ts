// 离线端到端演示：不接飞书、不调模型，验证"消息 → 调查/轮次 → 诊断 → 报告 → 投递"整条链路。
// 运行：npm run demo
import { join } from "node:path";
import { loadConfig } from "../config/index.ts";
import { processDeliveriesOnce } from "../delivery/delivery.ts";
import { createFeishuGateway } from "../integrations/feishu/gateway.ts";
import { FakeFeishuClient } from "../integrations/feishu/fake-client.ts";
import { startWorkerPool } from "../scheduling/worker-pool.ts";
import { bootstrap } from "./bootstrap.ts";

const config = loadConfig();
// 演示配置：内存库 + 假引擎 + 自带样例日志与样例仓库
config.dbPath = ":memory:";
config.diagnosis.engine = process.env.TD_ENGINE === "pi" ? "pi" : "fake";
config.feishu.botOpenId = "ou_bot";
config.feishu.requireMention = true;
config.sources.logDir = join(config.projectRoot, "fixtures", "samples");
config.sources.repos = [{ repoId: "app", dir: join(config.projectRoot, "fixtures", "demo-repo") }];
config.sources.allowedRepos = ["app"];

const { store, engine } = bootstrap(config);
const feishu = new FakeFeishuClient();
const gateway = createFeishuGateway({ store, config, sender: feishu, logger: () => {} });
const pool = startWorkerPool({ store, config, engine, workerCount: 1 });

function feishuEvent(input: {
  messageId: string;
  text: string;
  mentioned: boolean;
  parentId?: string;
  rootId?: string;
  at?: string;
}): unknown {
  return {
    sender: { sender_type: "user", sender_id: { open_id: "ou_tester" }, sender_name: "测试同学" },
    message: {
      message_id: input.messageId,
      chat_id: "oc_demo_chat",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: input.mentioned ? `@_user_1 ${input.text}` : input.text }),
      create_time: String(Date.parse(input.at ?? "2026-09-06T10:02:00+08:00")),
      root_id: input.rootId,
      parent_id: input.parentId,
      mentions: input.mentioned
        ? [{ key: "@_user_1", name: "TicketDoctor", id: { open_id: "ou_bot" } }]
        : [],
    },
  } as never;
}

async function drain(): Promise<void> {
  while (await pool.runOnce("worker-1")) {
    // 继续领取
  }
  while ((await processDeliveriesOnce(store, config, feishu)) > 0) {
    // 继续投递
  }
}

const first = await gateway.handleEvent(
  feishuEvent({ messageId: "om_1", text: "下单接口报 500，checkout-service 服务", mentioned: true }) as never,
);
console.log("第一轮接入结果：", JSON.stringify(first));
await drain();
console.log("\n===== 第 1 轮报告 =====\n" + (feishu.sent.at(-1)?.text ?? "(无)"));

const marker = feishu.sent.at(-1)?.text.match(/\[TD-[0-9a-z]{8}\]/)?.[0] ?? "";
const second = await gateway.handleEvent(
  feishuEvent({
    messageId: "om_2",
    text: `${marker} 补充：只在 10:01~10:03 之间复现，库存服务超时`,
    mentioned: false,
    parentId: "om_1",
    rootId: "om_1",
    at: "2026-09-06T10:03:00+08:00",
  }) as never,
);
console.log("\n第二轮接入结果：", JSON.stringify(second));
await drain();
console.log("\n===== 第 2 轮报告 =====\n" + (feishu.sent.at(-1)?.text ?? "(无)"));

console.log("\n===== 运行事件（第 2 轮）=====");
const lastRun = store.db
  .prepare("SELECT id FROM runs ORDER BY created_at DESC LIMIT 1")
  .get() as { id: string };
const events = store.db
  .prepare("SELECT sequence, type, payload FROM run_events WHERE run_id = ? ORDER BY sequence")
  .all(lastRun.id) as Array<{ sequence: number; type: string; payload: string | null }>;
for (const e of events) console.log(`${e.sequence}\t${e.type}\t${e.payload ?? ""}`);

pool.stop();
