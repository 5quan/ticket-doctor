// Agent Runner 入口：由 Host 作为独立子进程启动，只负责执行诊断，不碰数据库。
//
// 运行：node --experimental-strip-types src/entrypoints/runner.ts
// stdin：一行任务 JSON；之后可下发 {"type":"cancel"}
// stdout：NDJSON 结构化消息（session_entry / tool_execution / progress / result / error）
// stderr：运行日志
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { buildEngine } from "../agent/factory.ts";
import type { SessionSink, ToolExecutionRecord } from "../agent/types.ts";
import type { AppConfig } from "../config/index.ts";
import { renderDiagnosisInput } from "../agent/input-text.ts";
import { MemoryEvidenceSink } from "../evidence/memory-sink.ts";
import { evidenceRefToRecord } from "../evidence/util.ts";
import { prepareDiagnosis } from "../diagnosis/prepare.ts";
import { encodeMessage, type RunnerMessage, type RunnerTask } from "../runner/protocol.ts";
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
  };
}

/** 会话槽：把 pi 条目通过 IPC 上报给 Host 落库，不在 Runner 内持久化。 */
class IpcSessionSink implements SessionSink {
  readonly priorEntries: SessionEntry[];
  readonly resumed: boolean;
  constructor(task: RunnerTask) {
    this.priorEntries = task.priorEntries;
    this.resumed = task.resumed;
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
  const config = runnerConfig(task);
  const engine = buildEngine(config);
  const sink = new IpcSessionSink(task);
  emit({ type: "ready" });

  try {
    // 过渡期（阶段 3 前）：Runner 内用内存 sink 签发，证据随 result 上报、Host 代为落库。
    const evidenceSink = new MemoryEvidenceSink();
    const { input, scope, toolbox, missingMaterial } = await prepareDiagnosis(config, {
      investigationId: task.investigationId,
      runId: task.runId,
      text: task.text,
      receivedAt: task.receivedAt,
      service: task.service,
      environment: task.environment,
      contextSummary: task.contextSummary,
      signal: controller.signal,
      sink: evidenceSink,
    });
    if (!sink.resumed) sink.appendUserMessage(renderDiagnosisInput(input));
    emit({ type: "progress", name: "prepared", payload: { services: scope.services, repos: scope.repos.length } });

    const result = await engine.run(input, toolbox, controller.signal, sink);
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
        // 过渡期（阶段 3 前）：Runner 用内存 sink 签发，证据随 result 上报由 Host 代为落库；
        // 协议切换后证据在工具 commit 时经 IPC 实时落库，result 不再携带。
        evidence: evidenceSink.all().map((ref) => evidenceRefToRecord(ref, task.runId)),
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
    const control = JSON.parse(trimmed) as { type?: string };
    if (control.type === "cancel") {
      log("收到取消请求");
      controller.abort();
    }
  } catch {
    // 忽略非法控制行
  }
});

process.stdin.on("close", () => {
  // Host 关闭 stdin（异常退出）时中止执行，避免孤儿进程继续跑。
  if (!controller.signal.aborted) controller.abort();
});
