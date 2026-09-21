// Worker 入口：只做诊断执行与队列回收，不接触飞书。
// 运行：npm run worker
import { loadConfig } from "../config/index.ts";
import { startWorkerPool } from "../scheduling/worker-pool.ts";
import { bootstrap } from "./bootstrap.ts";

const config = loadConfig();
const { store, engine } = bootstrap(config);
const pool = startWorkerPool({
  store,
  config,
  engine,
  workerCount: config.scheduler.workerCount,
});

console.log(
  `[ticket-doctor] worker 启动：${config.scheduler.workerCount} 个，引擎=${config.diagnosis.engine}，db=${config.dbPath}`,
);

function shutdown(): void {
  console.log("[ticket-doctor] worker 退出");
  pool.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
