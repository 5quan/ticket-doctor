// 测试公共工具：内存数据库 + 最小配置。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../src/config/index.ts";
import { migrate, openDatabase } from "../src/storage/db.ts";
import { Store } from "../src/storage/store.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function memoryStore(): Store {
  const db = openDatabase(":memory:");
  migrate(db, join(ROOT, "migrations"));
  return new Store(db);
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    projectRoot: ROOT,
    dbPath: ":memory:",
    scheduler: { workerCount: 1, pollIntervalMs: 5, heartbeatMs: 10, leaseMs: 60_000, maxAttempts: 2, retryDelayMs: 5 },
    diagnosis: {
      engine: "fake",
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      timeoutMs: 5_000,
      maxToolCalls: 5,
      maxResultChars: 2_000,
      maxToolResultChars: 8_000,
      maxModelTurns: 5,
      defaultTimeWindowMs: 6 * 60 * 60 * 1000,
      compactionEnabled: true,
    },
    feishu: { botOpenId: "ou_bot", requireMention: true },
    sources: { logDir: join(ROOT, "fixtures", "samples"), repoDir: ROOT, allowedServices: [], allowedRepos: [], repos: [] },
    delivery: { maxAttempts: 3, baseBackoffMs: 10 },
  };
  return { ...base, ...overrides };
}
