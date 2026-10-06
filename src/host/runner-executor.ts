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
import { usageOf } from "../diagnosis/run-session.ts";
import { buildSavedToolResults } from "../evidence/recovery.ts";
import { StoreEvidenceResolver } from "../evidence/store-resolver.ts";
import type { ObservationRecorder, ObservationRunIdentity } from "../observability/langfuse.ts";
import {
  EVIDENCE_PROTOCOL_VERSION,
  encodeMessage,
  type RunnerControl,
  type RunnerMessage,
  type RunnerTask,
} from "../runner/protocol.ts";
import type { ClaimedRun, Store } from "../storage/store.ts";
import type { EventStore } from "./event-store.ts";

export interface RunnerExecutorDeps {
  store: Store;
  config: AppConfig;
  eventStore?: EventStore;
  /** Langfuse 观测记录器：未启用时缺省（Runner 不产生观测事件）。 */
  recorder?: ObservationRecorder;
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

    const priorEntries = store.listSessionEntries(investigation.id) as SessionEntry[];
    const savedMap = buildSavedToolResults(store, run.id, priorEntries, config.diagnosis.maxToolResultChars);
    const task: RunnerTask = {
      runId: run.id,
      attemptId: claimed.attemptId,
      generation: claimed.generation,
      investigationId: investigation.id,
      text: message.text,
      receivedAt: message.received_at,
      protocolVersion: EVIDENCE_PROTOCOL_VERSION,
      service: investigation.service ?? undefined,
      environment: investigation.environment ?? undefined,
      contextSummary: investigation.context_summary ?? undefined,
      priorEntries,
      resumed: store.hasSessionEntriesForRun(run.id),
      savedToolResults:
        savedMap.size > 0
          ? [...savedMap.entries()].map(([toolCallId, saved]) => ({ toolCallId, ...saved }))
          : undefined,
      engine: config.diagnosis.engine,
      diagnosis: config.diagnosis,
      sources: config.sources,
      // 审计开启时才传（避免无谓放大任务体积）：本调查既往证据，供跨轮引用在 Runner 内解析。
      priorEvidence: config.diagnosis.audit.enabled
        ? new StoreEvidenceResolver(store, investigation.id, run.id).listByInvestigation(investigation.id).slice(-200)
        : undefined,
    };
    // 发送前协议版本校验（D12）：不匹配不派发，判本轮失败
    if (task.protocolVersion !== EVIDENCE_PROTOCOL_VERSION) {
      return failRun(deps, claimed, "runtime_error", "Runner 任务协议版本不匹配");
    }

    // 观测：scope 与身份都由 Host 生成/持有（观测方案 §6），Runner 只透传事件。
    const obsIdentity: ObservationRunIdentity = {
      investigationId: investigation.id,
      runId: run.id,
      attemptId: claimed.attemptId,
      generation: claimed.generation,
    };
    const scopeId = deps.recorder?.beginAttempt(obsIdentity, {
      question: message.text,
      service: investigation.service ?? undefined,
      environment: investigation.environment ?? undefined,
      engine: config.diagnosis.engine,
    });
    if (deps.recorder && scopeId) {
      task.observability = {
        enabled: true,
        maxEventBytes: config.observability.maxEventBytes,
        scopeId,
      };
    }

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
        sendControl({ type: "cancel" });
      };
      const sendControl = (control: RunnerControl) => {
        try {
          child.stdin.write(encodeMessage(control));
        } catch {
          // stdin 已关闭（Runner 已退出）；其结果会经 exit 分支收敛
        }
      };

      // usage 汇总（与 inprocess 路径同权）：Runner 上报的 assistant/compaction 条目带 usage，
      // 在此累计并在终态前写回 attempts/runs（recordSessionUsage 要求 run 仍为 running）。
      const usage = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0 };
      const flushUsage = (): void => {
        store.recordSessionUsage({
          runId: run.id,
          attemptId: claimed.attemptId,
          generation: claimed.generation,
          ...usage,
        });
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
          case "ready": {
            if (message_.protocolVersion !== EVIDENCE_PROTOCOL_VERSION) {
              resultSeen = true;
              void failRun(
                deps,
                claimed,
                "runtime_error",
                `Runner 协议版本不匹配：runner=${message_.protocolVersion} host=${EVIDENCE_PROTOCOL_VERSION}`,
              );
              deps.recorder?.endAttempt(obsIdentity, {
                status: "error",
                kind: "protocol_mismatch",
                error: "Runner 协议版本不匹配",
              });
              done();
            }
            return;
          }
          case "session_entry": {
            store.appendSessionEntry({
              investigationId: investigation.id,
              runId: run.id,
              attemptId: claimed.attemptId,
              generation: claimed.generation,
              entry: message_.entry as unknown as { id: string; parentId: string | null; type: string; timestamp: string },
            });
            const entryUsage = usageOf(message_.entry);
            if (entryUsage) {
              usage.inputTokens += entryUsage.inputTokens;
              usage.outputTokens += entryUsage.outputTokens;
              usage.cacheTokens += entryUsage.cacheTokens;
              usage.totalTokens += entryUsage.totalTokens;
            }
            return;
          }
          case "tool_execution":
            store.recordToolExecution({
              investigationId: investigation.id,
              runId: run.id,
              attemptId: claimed.attemptId,
              ...message_.record,
            });
            return;
          case "observation":
            // 观测 best-effort：身份由 Host 注入，事件结构异常不穿透到业务协议错误路径。
            try {
              deps.recorder?.record(message_.event, obsIdentity);
            } catch {
              // ignore
            }
            return;
          case "evidence_commit": {
            // 身份由 Host 从实际派发任务注入（D4），不信任 Runner 自带身份字段
            let response: RunnerControl;
            try {
              const committed = store.commitEvidenceBatch({
                batchId: message_.batchId,
                tool: message_.tool,
                toolCallId: message_.toolCallId,
                payloadHash: message_.payloadHash,
                items: message_.items,
                result: message_.result,
                investigationId: investigation.id,
                runId: run.id,
                attemptId: claimed.attemptId,
                generation: claimed.generation,
              });
              response = committed.ok
                ? { type: "evidence_ack", batchId: message_.batchId, refs: committed.refs }
                : { type: "evidence_reject", batchId: message_.batchId, code: committed.code, message: committed.message };
            } catch (err) {
              response = {
                type: "evidence_reject",
                batchId: message_.batchId,
                code: "internal",
                message: err instanceof Error ? err.message : String(err),
              };
            }
            sendControl(response);
            return;
          }
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
            flushUsage();
            finalizeEngineResult(deps, claimed, {
              investigation,
              message,
              result,
              scope: result.kind === "report" ? result.scope : undefined,
              missingMaterial: result.kind === "report" ? result.missingMaterial : undefined,
              toolCalls: result.toolCalls,
              question: message.text,
              audit: result.kind === "report" ? result.audit : undefined,
              auditFailure: result.kind === "report" ? result.auditFailure : undefined,
            });
            deps.recorder?.endAttempt(obsIdentity, {
              status: "ok",
              kind: result.kind === "report" ? "report" : `reply:${result.reason}`,
              summary: result.kind === "report" ? result.draft.summary : result.text.slice(0, 200),
            });
            done();
            return;
          }
          case "error": {
            resultSeen = true;
            flushUsage();
            if (cancelRequested || message_.error.code === "cancelled") {
              store.finishCancelled(run.id, claimed.generation, "用户取消", Date.now());
              store.appendRunEvent(run.id, claimed.attemptId, "run_cancelled", null);
              try {
                deps.eventStore?.publish(investigation.id, "cancelled", { runId: run.id });
              } catch {
                // ignore
              }
              deps.recorder?.endAttempt(obsIdentity, { status: "aborted", kind: "cancelled" });
            } else {
              const code = timedOut ? "timeout" : leaseLost ? "interrupted" : classifyRunError(message_.error.message);
              deps.recorder?.endAttempt(obsIdentity, { status: "error", kind: code, error: message_.error.message });
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
              // stdout 只应出现协议消息：解析失败 = 协议被破坏，终止本轮（不再忽略非法行）
              if (!resultSeen) {
                resultSeen = true;
                void failRun(deps, claimed, "runtime_error", `Runner 输出非法协议行：${line.slice(0, 120)}`);
              }
              done();
              return;
            }
          }
          if (settled) return;
          idx = buffer.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(`[runner:${run.id.slice(0, 8)}] ${chunk.toString("utf8")}`);
      });
      child.on("error", (err) => {
        if (!resultSeen) {
          flushUsage();
          void failRun(deps, claimed, "runtime_error", `Runner 启动失败：${err.message}`);
        }
        done();
      });
      child.on("exit", (code, signal) => {
        if (!resultSeen) {
          flushUsage();
          if (cancelRequested) {
            store.finishCancelled(run.id, claimed.generation, "用户取消", Date.now());
            store.appendRunEvent(run.id, claimed.attemptId, "run_cancelled", null);
            deps.recorder?.endAttempt(obsIdentity, { status: "aborted", kind: "cancelled" });
          } else if (timedOut) {
            deps.recorder?.endAttempt(obsIdentity, { status: "aborted", kind: "timeout", error: "执行超时" });
            void failRun(deps, claimed, "timeout", `Runner 超时（${config.diagnosis.timeoutMs}ms）`);
          } else if (leaseLost) {
            deps.recorder?.endAttempt(obsIdentity, { status: "aborted", kind: "interrupted", error: "租约丢失" });
            void failRun(deps, claimed, "interrupted", "执行租约丢失");
          } else {
            const messageText = `Runner 异常退出（code=${code}, signal=${signal}）`;
            deps.recorder?.endAttempt(obsIdentity, { status: "error", kind: "runtime_error", error: messageText });
            void failRun(deps, claimed, "runtime_error", messageText);
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
