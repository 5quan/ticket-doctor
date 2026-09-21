// Gateway 入口：飞书长连接接入 + 投递循环（可选内嵌 worker，便于单进程开发）。
// 运行：npm run gateway
import { loadConfig } from "../config/index.ts";
import { processDeliveriesOnce } from "../delivery/delivery.ts";
import { startWorkerPool } from "../scheduling/worker-pool.ts";
import { FeishuClient } from "../integrations/feishu/client.ts";
import { createFeishuGateway } from "../integrations/feishu/gateway.ts";
import { bootstrap } from "./bootstrap.ts";

const config = loadConfig();
if (!config.feishu.appId || !config.feishu.appSecret) {
  console.error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，请通过环境变量或 .env 提供。");
  process.exit(1);
}

const { store, engine } = bootstrap(config);
const client = new FeishuClient({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  botOpenId: config.feishu.botOpenId,
  logLevel: config.feishu.logLevel,
});

await client.refreshBotOpenId();
config.feishu.botOpenId = client.getBotOpenId();
if (!config.feishu.botOpenId) {
  console.warn("[ticket-doctor] 未能获取 bot open_id，群聊新会话将 fail-closed（需配置 FEISHU_BOT_OPEN_ID）");
}

const gateway = createFeishuGateway({ store, config, sender: client });

const runWorkersInGateway = process.env.TD_RUN_WORKERS_IN_GATEWAY !== "false";
const pool = runWorkersInGateway
  ? startWorkerPool({ store, config, engine, workerCount: config.scheduler.workerCount })
  : undefined;

const deliveryTimer = setInterval(() => {
  processDeliveriesOnce(store, config, client).catch((err) => {
    console.error("[ticket-doctor] 投递循环异常", err);
  });
}, config.scheduler.pollIntervalMs);

await client.start(async (event) => {
  const outcome = await gateway.handleEvent(event);
  console.log(`[ticket-doctor] 事件处理结果：${JSON.stringify(outcome)}`);
});
console.log(
  `[ticket-doctor] gateway 已启动：worker=${runWorkersInGateway ? config.scheduler.workerCount : "外部"}，引擎=${config.diagnosis.engine}`,
);

async function shutdown(): Promise<void> {
  clearInterval(deliveryTimer);
  pool?.stop();
  await client.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
