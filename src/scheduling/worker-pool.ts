// Worker 池：单机诊断并发上限由这里的 workerCount 决定（默认 4）。
//
// 每个 worker 循环：回收过期租约 → 领取一个待执行轮次 → 执行。同一调查最多一个执行者
// 由 claimNextRun 的 SQL 保证；不同调查可并行。首版不做运行中动态扩缩容。
import { executeRun, type OrchestratorDeps } from "../diagnosis/orchestrator.ts";

export interface WorkerPoolOptions extends OrchestratorDeps {
  workerCount: number;
}

export interface WorkerPool {
  stop(): void;
  /** 跑一轮就返回（测试/演示用）。返回是否领取到了任务。 */
  runOnce(workerId: string): Promise<boolean>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startWorkerPool(opts: WorkerPoolOptions): WorkerPool {
  let stopped = false;
  const loops: Promise<void>[] = [];

  async function runOnce(workerId: string): Promise<boolean> {
    opts.store.recoverExpiredLeases();
    const claimed = opts.store.claimNextRun(workerId, opts.config.scheduler.leaseMs);
    if (!claimed) return false;
    await executeRun(opts, claimed);
    return true;
  }

  for (let i = 0; i < opts.workerCount; i++) {
    const workerId = `worker-${i + 1}`;
    loops.push(
      (async () => {
        while (!stopped) {
          let didWork = false;
          try {
            didWork = await runOnce(workerId);
          } catch (err) {
            console.error(`[${workerId}] 执行异常`, err);
          }
          if (!didWork) await sleep(opts.config.scheduler.pollIntervalMs);
        }
      })(),
    );
  }

  return {
    runOnce,
    stop() {
      stopped = true;
    },
  };
}
