// 进程级故障：Host 被强杀后重启，验证
//   1) 未完成轮次被租约回收并重新执行到成功；
//   2) 会话不重复追加用户输入；
//   3) 消息不重复入队。
// 真实 spawn `src/entrypoints/host.ts`，走 process 模式 Runner。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// 测试从仓库根运行（npm test），spawn 的 Host 也需要仓库根作为 cwd。
const ROOT = process.cwd();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function spawnHost(port: number, dbPath: string, dataDir: string): { child: ChildProcess; log: () => string } {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/entrypoints/host.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      TD_FEISHU_DIRECT: "false",
      TD_RUNNER_MODE: "process",
      TD_ENGINE: "fake",
      TD_DB_PATH: dbPath,
      TD_DATA_DIR: dataDir,
      TD_HOST: "127.0.0.1",
      TD_HOST_PORT: String(port),
      TD_LEASE_MS: "800",
      TD_HEARTBEAT_MS: "150",
      TD_WORKER_COUNT: "2",
      TD_REPOS: `app:${join(ROOT, "fixtures", "demo-repo")}`,
      TD_ALLOWED_REPOS: "app",
      TD_LOG_DIR: join(ROOT, "fixtures", "samples"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  child.stdout?.on("data", (d: Buffer) => (buffer += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (buffer += d.toString()));
  return { child, log: () => buffer };
}

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  label: string,
  diagnostics: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
    } catch {
      // 继续重试
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} 超时（${timeoutMs}ms）\n--- host log ---\n${diagnostics()}`);
}

test("Host 强杀重启：恢复未完成轮次且不重复入队/追加输入", async () => {
  const dir = mkdtempSync(join(tmpdir(), "td-restart-"));
  const dbPath = join(dir, "ticket-doctor.sqlite");
  const port = await freePort();

  const hostA = spawnHost(port, dbPath, dir);
  let investigationId = "";
  let runId = "";
  try {
    await waitFor(
      async () => ((await fetch(`http://127.0.0.1:${port}/api/agent/capabilities`)).ok ? true : undefined),
      20_000,
      "Host A 启动",
      hostA.log,
    );

    const submit = await (
      await fetch(`http://127.0.0.1:${port}/api/agent/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "web", text: "checkout-service 下单接口报 500" }),
      })
    ).json();
    investigationId = submit.investigationId;
    runId = submit.runId;
    assert.ok(investigationId && runId, "提交应返回调查与轮次");

    // 在轮次执行中强杀 Host
    await new Promise((resolve) => setTimeout(resolve, 150));
    hostA.child.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 400));

    const hostB = spawnHost(port, dbPath, dir);
    try {
      const detail = await waitFor(
        async () => {
          const res = await fetch(`http://127.0.0.1:${port}/api/agent/investigations/${investigationId}`);
          if (!res.ok) return undefined;
          const data = await res.json();
          return data.runs?.[0]?.status === "succeeded" ? data : undefined;
        },
        40_000,
        "Host B 恢复并完成轮次",
        hostB.log,
      );
      assert.equal(detail.runs.length, 1, "同一消息不应产生第二个轮次");
      assert.equal(detail.messages.length, 1, "消息不应重复入队");
      assert.ok(detail.report, "应产出报告");
    } finally {
      hostB.child.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const db = new DatabaseSync(dbPath);
    try {
      const userEntries = db
        .prepare("SELECT COUNT(*) AS n FROM session_entries WHERE run_id = ? AND type = 'message'")
        .get(runId) as { n: number | bigint };
      assert.equal(Number(userEntries.n), 1, "恢复不应重复追加用户输入");
    } finally {
      db.close();
    }
  } finally {
    if (hostA.child.exitCode === null) hostA.child.kill("SIGKILL");
  }
});
