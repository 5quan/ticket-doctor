// Host 入口：常驻调度器（Web API + SSE + 会话队列 + worker；可选内嵌飞书直连过渡）。
//
// 新架构下飞书由 Go 接入适配器调用 POST /api/agent/message 进入 Host；
// 迁移期可用 TD_FEISHU_DIRECT=true（默认）在 Host 内直连飞书，行为与旧 gateway 一致。
// 运行：npm run host
import { loadConfig } from "../config/index.ts";
import { processDeliveriesOnce } from "../delivery/delivery.ts";
import { EventStore } from "../host/event-store.ts";
import { createRunnerExecutor } from "../host/runner-executor.ts";
import { createHostServer } from "../host/server.ts";
import { FeishuClient } from "../integrations/feishu/client.ts";
import { createFeishuGateway } from "../integrations/feishu/gateway.ts";
import { startWorkerPool } from "../scheduling/worker-pool.ts";
import { bootstrap } from "./bootstrap.ts";

const config = loadConfig();
const { store, engine } = bootstrap(config);
const eventStore = new EventStore(store);

// 生产默认可用独立 Runner 子进程（TD_RUNNER_MODE=process）；内联模式用于本地/测试。
const execute =
  config.scheduler.runnerMode === "process" ? createRunnerExecutor({ store, config, eventStore }) : undefined;
const pool = startWorkerPool({
  store,
  config,
  engine,
  workerCount: config.scheduler.workerCount,
  eventStore,
  execute,
});
const host = createHostServer({ store, config, eventStore });
const { host: bindHost, port } = await host.listen();
console.log(
  `[ticket-doctor] Host 已启动：http://${bindHost}:${port}，worker=${config.scheduler.workerCount}，执行模式=${config.scheduler.runnerMode}`,
);

// 过渡期：Host 内直接接飞书（长连接 + 投递）。关闭后由 Go 适配器接入。
let feishu: FeishuClient | undefined;
let deliveryTimer: NodeJS.Timeout | undefined;
if (config.host.feishuDirect && config.feishu.appId && config.feishu.appSecret) {
  feishu = new FeishuClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    botOpenId: config.feishu.botOpenId,
    logLevel: config.feishu.logLevel,
  });
  await feishu.refreshBotOpenId();
  config.feishu.botOpenId = feishu.getBotOpenId();
  if (!config.feishu.botOpenId) {
    console.warn("[ticket-doctor] 未获取到 bot open_id，群聊新会话将 fail-closed");
  }
  const gateway = createFeishuGateway({ store, config, sender: feishu });
  deliveryTimer = setInterval(() => {
    processDeliveriesOnce(store, config, feishu!).catch((err) => {
      console.error("[ticket-doctor] 投递循环异常", err);
    });
  }, config.scheduler.pollIntervalMs);
  await feishu.start(async (event) => {
    const outcome = await gateway.handleEvent(event);
    console.log(`[ticket-doctor] 飞书事件处理：${JSON.stringify(outcome)}`);
  });
  console.log("[ticket-doctor] 飞书直连已开启（TD_FEISHU_DIRECT）");
} else {
  console.log("[ticket-doctor] 未开启飞书直连，等待 Go 接入适配器调用 /api/agent/message");
}

async function shutdown(): Promise<void> {
  pool.stop();
  if (deliveryTimer) clearInterval(deliveryTimer);
  await feishu?.stop().catch(() => {});
  await host.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
