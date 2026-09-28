// Host 侧 Runner 监管：为每个轮次启动独立 Node 子进程，解析结构化输出并代其落库。
//
// 职责边界（对齐平台文档 04/05）：
//   * Host 负责数据库、任务状态、结果提交与投递；Runner 只执行、只上报。
//   * 每个执行尝试独立子进程 → 单个 Runner 崩溃不影响其他进程。
//   * 心跳/租约/取消/超时都在 Host 侧判定；Runner 只收到 cancel 并协作中止。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config/index.ts";
import { classifyRunError, failRun, finalizeEngineResult } from "../diagnosis/finalize.ts";
import type { RunnerMessage, RunnerTask } from "../runner/protocol.ts";
import type { ClaimedRun, Store } from "../storage/store.ts";
import type { EventStore } from "./event-store.ts";

export interface RunnerExecutorDeps {
  store: Store;
  config: AppConfig;
  eventStore?: EventStore;
  /** 覆盖 Runner 入口（测试注入）。默认 src/entrypoints/runner.ts。 */
  runnerEntry?: string;
}

export type RunExecutor = (claimed: ClaimedRun) => Promise<void>;

/** 独立子进程执行一轮诊断；Host 负责全部持久化与终态提交。 */
export function createRunnerExecutor(deps: RunnerExecutorDeps): RunExecutor {
  const { store, config } = deps;
  const runnerEntry = deps.runnerEntry ?? join(config.projectRoot, "src/entrypoints/runner.ts");

  return function executeWithRunner(claimed: ClaimedRun): Promise<void> {
    const run = claimed.run;
    const message = store.getMessageById(run.message_id);
    const investigation = store.getInvestigation(run.investigation_id);
    if (!message || !investigation) {
      return failRun(deps, claimed, "runtime_error", "运行缺少消息或调查记录");
    }

    const task: RunnerTask = {
      runId: run.id,
      attemptId: claimed.attemptId,
      generation: claimed.generation,
      investigationId: investigation.id,
      text: message.text,
      receivedAt: message.received_at,
      service: investigation.service ?? undefined,
      environment: investigation.environment ?? undefined,
      contextSummary: investigation.context_summary ?? undefined,
      priorEntries: store.listSessionEntries(investigation.id) as SessionEntry[],
      resumed: store.hasSessionEntriesForRun(run.id),
      engine: config.diagnosis.engine,
      diagnosis: config.diagnosis,
      sources: config.sources,
    };

    return new Promise<void>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(process.execPath, ["--experimental-strip-types", runnerEntry], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        void failRun(deps, claimed, "runtime_error", err instanceof Error ? err.message : String(err)).then(resolve);
        return;
      }

      let settled = false;
      let resultSeen = false;
      let cancelRequested = false;
      let leaseLost = false;
      let timedOut = false;
      let buffer = "";

      const killChild = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      };
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearInterval(heartbeatTimer);
        killChild();
        resolve();
      };
      const sendCancel = () => {
        try {
          child.stdin.write(`${JSON.stringify({ type: "cancel" })}\n`);
        } catch {
          // stdin 已关闭
        }
      };

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        sendCancel();
        setTimeout(done, 2_000);
      }, config.diagnosis.timeoutMs);
      const heartbeatTimer = setInterval(() => {
        if (store.isCancelRequested(run.id)) {
          cancelRequested = true;
          sendCancel();
        }
        if (!store.heartbeat(run.id, claimed.attemptId, claimed.generation, config.scheduler.leaseMs)) {
          leaseLost = true;
          sendCancel();
        }
      }, config.scheduler.heartbeatMs);

      const handleMessage = (message_: RunnerMessage): void => {
        switch (message_.type) {
          case "ready":
            return;
          case "session_entry":
            store.appendSessionEntry({
              investigationId: investigation.id,
              runId: run.id,
              attemptId: claimed.attemptId,
              generation: claimed.generation,
              entry: message_.entry as unknown as { id: string; parentId: string | null; type: string; timestamp: string },
            });
            return;
          case "tool_execution":
            store.recordToolExecution({
              investigationId: investigation.id,
              runId: run.id,
              attemptId: claimed.attemptId,
              ...message_.record,
            });
            return;
          case "progress":
            store.appendRunEvent(run.id, claimed.attemptId, message_.name, message_.payload ?? null);
            try {
              deps.eventStore?.publish(investigation.id, message_.name, message_.payload);
            } catch {
              // 事件推送失败不影响执行
            }
            return;
          case "result": {
            resultSeen = true;
            const result = message_.result;
            finalizeEngineResult(deps, claimed, {
              investigation,
              message,
              result,
              evidence: result.kind === "report" ? result.evidence : undefined,
              scope: result.kind === "report" ? result.scope : undefined,
              missingMaterial: result.kind === "report" ? result.missingMaterial : undefined,
              toolCalls: result.toolCalls,
              question: message.text,
            });
            done();
            return;
          }
          case "error": {
            resultSeen = true;
            if (cancelRequested || message_.error.code === "cancelled") {
              store.finishCancelled(run.id, claimed.generation, "用户取消", Date.now());
              store.appendRunEvent(run.id, claimed.attemptId, "run_cancelled", null);
              try {
                deps.eventStore?.publish(investigation.id, "cancelled", { runId: run.id });
              } catch {
                // ignore
              }
            } else {
              const code = timedOut ? "timeout" : leaseLost ? "interrupted" : classifyRunError(message_.error.message);
              void failRun(deps, claimed, code, message_.error.message);
            }
            done();
            return;
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            try {
              handleMessage(JSON.parse(line) as RunnerMessage);
            } catch {
              // 忽略非法行（stderr 才是日志，stdout 只应出现协议消息）
            }
          }
          idx = buffer.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(`[runner:${run.id.slice(0, 8)}] ${chunk.toString("utf8")}`);
      });
      child.on("error", (err) => {
        if (!resultSeen) void failRun(deps, claimed, "runtime_error", `Runner 启动失败：${err.message}`);
        done();
      });
      child.on("exit", (code, signal) => {
        if (!resultSeen) {
          if (cancelRequested) {
            store.finishCancelled(run.id, claimed.generation, "用户取消", Date.now());
            store.appendRunEvent(run.id, claimed.attemptId, "run_cancelled", null);
          } else if (timedOut) {
            void failRun(deps, claimed, "timeout", `Runner 超时（${config.diagnosis.timeoutMs}ms）`);
          } else if (leaseLost) {
            void failRun(deps, claimed, "interrupted", "执行租约丢失");
          } else {
            void failRun(deps, claimed, "runtime_error", `Runner 异常退出（code=${code}, signal=${signal}）`);
          }
        }
        done();
      });

      store.appendRunEvent(run.id, claimed.attemptId, "run_started", { runner: true });
      try {
        deps.eventStore?.publish(investigation.id, "run_started", {
          runId: run.id,
          round: run.round,
          source: run.source,
        });
      } catch {
        // ignore
      }
      child.stdin.write(`${JSON.stringify(task)}\n`);
    });
  };
}
