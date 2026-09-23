// 配置：进程启动时从环境变量（含 .env）读取一次，运行期不可变。
// 所有"魔法数字"集中在这里，业务模块不得自己读 process.env。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 极简 .env 读取：只在环境变量缺失时填充，不覆盖已有值。 */
export function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = match[2].replace(/^["']|["']$/g, "");
  }
}

export interface SchedulerConfig {
  workerCount: number;
  pollIntervalMs: number;
  heartbeatMs: number;
  leaseMs: number;
  maxAttempts: number;
  retryDelayMs: number;
}

export interface DiagnosisConfig {
  engine: "fake" | "pi";
  provider: string;
  modelId: string;
  apiKey?: string;
  timeoutMs: number;
  maxToolCalls: number;
  /** 单条证据最大字符数。 */
  maxResultChars: number;
  /** 单次工具调用返回给模型的总字符数上限（防信息爆炸）。 */
  maxToolResultChars: number;
  maxModelTurns: number;
  defaultTimeWindowMs: number;
}

export interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  botOpenId?: string;
  /** 群聊是否必须 @机器人（默认 true，符合最小权限原则）。 */
  requireMention: boolean;
  /** 飞书 SDK 日志级别：error | warn | info | debug（排查事件订阅时用 debug）。 */
  logLevel?: string;
}

export interface SourcesConfig {
  logDir: string;
  repoDir: string;
  allowedServices: string[];
  allowedRepos: string[];
  /** repoId → 本地仓库路径。默认把 allowedRepos 全部指向 repoDir。 */
  repos: Array<{ repoId: string; dir: string }>;
}

export interface AppConfig {
  dbPath: string;
  scheduler: SchedulerConfig;
  diagnosis: DiagnosisConfig;
  feishu: FeishuConfig;
  sources: SourcesConfig;
  delivery: { maxAttempts: number; baseBackoffMs: number };
  projectRoot: string;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** 解析 TD_REPOS="app:/path/a,backend:/path/b"；缺省把 allowedRepos 指向 repoDir。 */
function parseRepos(raw: string | undefined, allowedRepos: string[], repoDir: string): Array<{ repoId: string; dir: string }> {
  if (!raw) return allowedRepos.map((repoId) => ({ repoId, dir: repoDir }));
  const repos: Array<{ repoId: string; dir: string }> = [];
  for (const part of raw.split(",")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    repos.push({ repoId: part.slice(0, idx).trim(), dir: part.slice(idx + 1).trim() });
  }
  return repos;
}

export function loadConfig(opts: { envFile?: string } = {}): AppConfig {
  loadDotEnv(opts.envFile ?? join(PROJECT_ROOT, ".env"));
  const dataDir = process.env.TD_DATA_DIR ?? join(PROJECT_ROOT, "data");
  return {
    projectRoot: PROJECT_ROOT,
    dbPath: process.env.TD_DB_PATH ?? join(dataDir, "ticket-doctor.sqlite"),
    scheduler: {
      workerCount: num("TD_WORKER_COUNT", 4),
      pollIntervalMs: num("TD_POLL_INTERVAL_MS", 1_000),
      heartbeatMs: num("TD_HEARTBEAT_MS", 10_000),
      leaseMs: num("TD_LEASE_MS", 60_000),
      maxAttempts: num("TD_MAX_ATTEMPTS", 2),
      retryDelayMs: num("TD_RETRY_DELAY_MS", 3_000),
    },
    diagnosis: {
      engine: process.env.TD_ENGINE === "pi" ? "pi" : "fake",
      provider: process.env.TD_PROVIDER ?? "deepseek",
      modelId: process.env.TD_MODEL ?? "deepseek-v4-flash",
      apiKey: process.env.DEEPSEEK_API_KEY,
      timeoutMs: num("TD_DIAGNOSIS_TIMEOUT_MS", 180_000),
      maxToolCalls: num("TD_MAX_TOOL_CALLS", 12),
      maxResultChars: num("TD_MAX_RESULT_CHARS", 4_000),
      maxToolResultChars: num("TD_MAX_TOOL_RESULT_CHARS", 8_000),
      maxModelTurns: num("TD_MAX_MODEL_TURNS", 10),
      defaultTimeWindowMs: num("TD_DEFAULT_TIME_WINDOW_MS", 6 * 60 * 60 * 1000),
    },
    feishu: {
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      botOpenId: process.env.FEISHU_BOT_OPEN_ID,
      requireMention: process.env.FEISHU_REQUIRE_MENTION !== "false",
      logLevel: process.env.FEISHU_LOG_LEVEL,
    },
    sources: {
      logDir: process.env.TD_LOG_DIR ?? join(PROJECT_ROOT, "fixtures", "samples"),
      repoDir: process.env.TD_REPO_DIR ?? PROJECT_ROOT,
      allowedServices: list("TD_ALLOWED_SERVICES", []),
      allowedRepos: list("TD_ALLOWED_REPOS", ["app"]),
      repos: parseRepos(
        process.env.TD_REPOS,
        list("TD_ALLOWED_REPOS", ["app"]),
        process.env.TD_REPO_DIR ?? PROJECT_ROOT,
      ),
    },
    delivery: {
      maxAttempts: num("TD_DELIVERY_MAX_ATTEMPTS", 3),
      baseBackoffMs: num("TD_DELIVERY_BACKOFF_MS", 3_000),
    },
  };
}
