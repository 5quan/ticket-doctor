// Agent Runner 入口：由 Host 作为独立子进程启动，只负责执行诊断，不碰数据库。
//
// 运行：node --experimental-strip-types src/entrypoints/runner.ts
// stdin：一行任务 JSON；之后可下发 cancel / evidence_ack / evidence_reject
// stdout：NDJSON 结构化消息（session_entry / tool_execution / evidence_commit / progress / result / error）
// stderr：运行日志
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { buildEngine } from "../agent/factory.ts";
import type { SavedToolResult, SessionSink, ToolExecutionRecord } from "../agent/types.ts";
import type { AppConfig } from "../config/index.ts";
import { renderDiagnosisInput } from "../agent/input-text.ts";
import { IpcEvidenceSink } from "../evidence/ipc-sink.ts";
import { prepareDiagnosis } from "../diagnosis/prepare.ts";
import type { AttemptObservationScope, ObservationEvent, ObservationSink } from "../observability/types.ts";
import {
  EVIDENCE_PROTOCOL_VERSION,
  encodeMessage,
  type RunnerControl,
  type RunnerMessage,
  type RunnerTask,
} from "../runner/protocol.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function log(message: string): void {
  process.stderr.write(`[runner] ${message}\n`);
}

function emit(message: RunnerMessage): void {
  process.stdout.write(encodeMessage(message));
}

function emitFinal(message: RunnerMessage): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(encodeMessage(message), () => resolve());
  });
}

/** Runner 只需要诊断/材料配置；其余字段是构造 AppConfig 的占位，不参与执行。 */
function runnerConfig(task: RunnerTask): AppConfig {
  return {
    projectRoot: process.cwd(),
    dbPath: ":memory:",
    sessionDir: process.cwd(),
    scheduler: {
      workerCount: 1,
      pollIntervalMs: 1_000,
      heartbeatMs: 1_000,
      leaseMs: 60_000,
      maxAttempts: 1,
      retryDelayMs: 0,
      runnerMode: "inprocess",
    },
    diagnosis: task.diagnosis,
    feishu: { requireMention: true },
    host: { host: "127.0.0.1", port: 0, sseReplayLimit: 1_000, feishuDirect: false },
    sources: task.sources,
    delivery: { maxAttempts: 1, baseBackoffMs: 0 },
    observability: {
      enabled: false,
      environment: "runner",
      maxEventBytes: task.observability?.maxEventBytes ?? 524_288,
      shutdownMs: 5_000,
    },
  };
}

/**
 * 观测事件经 stdout 上报（fire-and-forget，异常自捕获，不影响业务协议）。
 * seq 在此统一重排：stdout 的发送顺序即序号顺序，Host 用它做 FIFO 完整性校验。
 */
class IpcObservationSink implements ObservationSink {
  private seq = 0;
  record(event: ObservationEvent): void {
    try {
      emit({ type: "observation", event: { ...event, seq: ++this.seq } });
    } catch {
      // 采集失败允许丢弃（best-effort）
    }
  }
}

/** 会话槽：把 pi 条目通过 IPC 上报给 Host 落库，不在 Runner 内持久化。 */
class IpcSessionSink implements SessionSink {
  readonly priorEntries: SessionEntry[];
  readonly resumed: boolean;
  readonly savedToolResults?: ReadonlyMap<string, SavedToolResult>;
  constructor(task: RunnerTask) {
    this.priorEntries = task.priorEntries;
    this.resumed = task.resumed;
    if (task.savedToolResults && task.savedToolResults.length > 0) {
      this.savedToolResults = new Map(task.savedToolResults.map((s) => [s.toolCallId, s]));
    }
  }
  appendEntry(entry: SessionEntry): void {
    emit({ type: "session_entry", entry });
  }
  recordTool(record: ToolExecutionRecord): void {
    emit({ type: "tool_execution", record });
  }
  appendUserMessage(text: string): void {
    const entry = {
      type: "message",
      id: randomUUID(),
      parentId: this.priorEntries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: text, timestamp: Date.now() },
    } as unknown as SessionEntry;
    this.appendEntry(entry);
    this.priorEntries.push(entry);
  }
}

async function runTask(task: RunnerTask, controller: AbortController): Promise<void> {
  if (task.protocolVersion !== EVIDENCE_PROTOCOL_VERSION) {
    log(`协议版本不匹配：task=${task.protocolVersion} runner=${EVIDENCE_PROTOCOL_VERSION}`);
    await emitFinal({
      type: "error",
      error: { code: "protocol_mismatch", message: "Runner 与 Host 的协议版本不一致" },
    });
    return;
  }

  const config = runnerConfig(task);
  const engine = buildEngine(config);
  const sink = new IpcSessionSink(task);
  // 观测：scopeId 由 Host 注入（Runner 不自报身份）；未启用时不产生任何观测事件。
  const obs: AttemptObservationScope | undefined =
    task.observability?.enabled && task.observability.scopeId
      ? { scopeId: task.observability.scopeId, sink: new IpcObservationSink() }
      : undefined;
  // 证据两阶段提交（D4/D9）：evidence_commit 写 stdout，等待 Host 的 evidence_ack/reject
  const ipcEvidenceSink = new IpcEvidenceSink({ emit: (message) => emit(message), signal: controller.signal });
  evidenceSink = ipcEvidenceSink;
  emit({ type: "ready", protocolVersion: EVIDENCE_PROTOCOL_VERSION });

  try {
    const { input, scope, toolbox, missingMaterial } = await prepareDiagnosis(config, {
      investigationId: task.investigationId,
      runId: task.runId,
      text: task.text,
      receivedAt: task.receivedAt,
      service: task.service,
      environment: task.environment,
      contextSummary: task.contextSummary,
      signal: controller.signal,
      sink: ipcEvidenceSink,
    });
    if (!sink.resumed) sink.appendUserMessage(renderDiagnosisInput(input));
    emit({ type: "progress", name: "prepared", payload: { services: scope.services, repos: scope.repos.length } });

    const result = await engine.run(input, toolbox, controller.signal, sink, obs);
    if (result.kind === "reply") {
      await emitFinal({
        type: "result",
        result: {
          kind: "reply",
          reason: result.reason,
          text: result.text,
          toolCalls: result.toolCalls,
          modelTurns: result.modelTurns,
          model: result.model,
        },
      });
      return;
    }
    await emitFinal({
      type: "result",
      result: {
        kind: "report",
        draft: result.draft,
        // 证据已在工具 commit 时经 IPC 落库（D8）；result 只带草稿与范围
        scope,
        missingMaterial,
        toolCalls: result.toolCalls,
        modelTurns: result.modelTurns,
        model: result.model,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`执行失败：${message}`);
    await emitFinal({ type: "error", error: { code: controller.signal.aborted ? "cancelled" : "engine_error", message } });
  }
}

const controller = new AbortController();
const rl = readline.createInterface({ input: process.stdin });
let started = false;
/** runTask 启动时注入；ack/reject 回执经此分发到等待中的 commit。 */
let evidenceSink: IpcEvidenceSink | undefined;

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (!started) {
    started = true;
    let task: RunnerTask;
    try {
      task = JSON.parse(trimmed) as RunnerTask;
    } catch (err) {
      log(`任务解析失败：${err instanceof Error ? err.message : String(err)}`);
      void emitFinal({ type: "error", error: { code: "invalid_task", message: "任务不是合法 JSON" } }).then(() =>
        process.exit(1),
      );
      return;
    }
    void runTask(task, controller).then(() => {
      rl.close();
      process.exit(0);
    });
    return;
  }
  try {
    const control = JSON.parse(trimmed) as RunnerControl;
    if (control.type === "cancel") {
      log("收到取消请求");
      controller.abort();
    } else if (!evidenceSink?.handleControl(control)) {
      log(`未知控制消息：${String((control as { type?: string }).type)}`);
    }
  } catch {
    // 忽略非法控制行（Host→Runner 方向不作协议硬失败，避免误杀正常轮次）
  }
});

process.stdin.on("close", () => {
  // Host 关闭 stdin（异常退出）时中止执行，避免孤儿进程继续跑。
  if (!controller.signal.aborted) controller.abort();
});
