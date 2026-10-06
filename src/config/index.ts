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
  /** 执行模式：inprocess=worker 内联执行（测试/评测）；process=独立 Runner 子进程（生产）。 */
  runnerMode: "inprocess" | "process";
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
  /** 未获取到发生时间时，按上报时间回溯的兜底窗口（宁可宽，不可错窄）。 */
  fallbackTimeWindowMs: number;
  /** pi 会话上下文压缩兜底：开启后接近上下文窗口时自动总结旧内容。 */
  compactionEnabled: boolean;
  /** 独立审计 Agent（OQ-30）：诊断后由独立上下文逐结论复核草稿。 */
  audit: AuditConfig;
}

/** 独立审计（OQ-30）策略。首版：不主动检索、失败显式降级不阻断。 */
export interface AuditConfig {
  /** 总开关：默认 false（与观测一致，避免升级即变行为）。 */
  enabled: boolean;
  /** 审计会话是否允许调用检索工具；首版固定 false，只读冻结证据快照。 */
  allowRetrieval: boolean;
  /** 审计失败（报错/超时/未产出）是否阻断发布；false=显式降级后照常提交。 */
  failBlocks: boolean;
  /** 有界补证循环上限：审计建议 continue 且预算足够时，最多回主诊断补证几轮（0=单次审计）。 */
  maxRounds: number;
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

export interface HostConfig {
  /** Host Web API / SSE 监听地址。 */
  host: string;
  port: number;
  /** SSE 断线重连单次 replay 上限。 */
  sseReplayLimit: number;
  /**
   * 飞书是否由 Host 进程内直连（过渡开关）。
   * 新架构由 Go 接入适配器调用 /api/agent/message；迁移期可置 true 保留旧链路。
   */
  feishuDirect: boolean;
}

export interface SourcesConfig {
  logDir: string;
  repoDir: string;
  /**
   * 授权语义（方案 §10.2）：
   *   * `undefined` —— 未配置授权，保持既有默认（不限服务）；生产入口未设 TD_ALLOWED_SERVICES 时的行为。
   *   * `[]`       —— 显式空授权：拒绝一切查询（评测逐轮授权为空时不得打开全部服务）。
   *   * 非空数组   —— 服务白名单，越权直接报错。
   */
  allowedServices: string[] | undefined;
  /**
   * 部署级仓库硬白名单（与 allowedServices 同语义）：列表外的 repoId 一律不可检索。
   * 未显式设 TD_ALLOWED_REPOS 时，默认授权 TD_REPOS 声明的全部仓库。
   */
  allowedRepos: string[];
  /** repoId → 本地仓库路径（已按 allowedRepos 过滤）。rev 为可选显式版本钉定。 */
  repos: Array<{ repoId: string; dir: string; rev?: string }>;
}

export interface ObservabilityConfig {
  /** 总开关：默认 false，不发任何观测请求、不初始化 SDK。 */
  enabled: boolean;
  /** 启用时必填：本地/内网 Langfuse 地址，不允许落到云端默认值。 */
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
  /** 部署标签（development/production…），不混同被诊断业务的环境字段。 */
  environment: string;
  release?: string;
  /** 单事件字节上限（按 UTF-8 字节计），超出截断并标记。 */
  maxEventBytes: number;
  /** 进程退出前观测关闭的兜底期限（ms），超时不阻塞退出。 */
  shutdownMs: number;
}

export interface AppConfig {
  dbPath: string;
  /** 会话日志（JSONL）目录：逐次消息/工具/用量/压缩事件的真相源。 */
  sessionDir: string;
  scheduler: SchedulerConfig;
  diagnosis: DiagnosisConfig;
  feishu: FeishuConfig;
  host: HostConfig;
  sources: SourcesConfig;
  delivery: { maxAttempts: number; baseBackoffMs: number };
  observability: ObservabilityConfig;
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

/** 逗号分隔的去空白列表；未设置或空串 → 空数组。 */
function splitList(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** 解析 TD_REPOS="app:/path/a,backend:/path/b"；返回显式声明的仓库（可能为空）。 */
function parseReposRaw(raw: string | undefined): Array<{ repoId: string; dir: string }> {
  if (!raw) return [];
  const repos: Array<{ repoId: string; dir: string }> = [];
  for (const part of raw.split(",")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    repos.push({ repoId: part.slice(0, idx).trim(), dir: part.slice(idx + 1).trim() });
  }
  return repos;
}

/**
 * 材料源授权解析（纯函数，便于单测；不在运行期读 process.env）。
 * 仓库授权语义与 allowedServices 对齐：
 *   * 显式设置 TD_ALLOWED_REPOS —— 硬白名单；TD_REPOS 中不在白名单的仓库一律排除。
 *   * 未设置 —— 默认授权 TD_REPOS 声明的全部仓库；TD_REPOS 也没有时回退 ["app"]。
 * 此前 parseRepos 只在 TD_REPOS 缺省时才用 allowedRepos 兜底，显式 TD_REPOS 可越过
 * allowedRepos 读取未授权仓库（检索范围约束缺口）。
 * 说明：TD_REPOS 不携带 rev；rev 只经编程式配置注入（评测钉 expectedSha、部署方已知版本时）。
 */
export function resolveSources(env: Record<string, string | undefined>): SourcesConfig {
  const repoDir = env.TD_REPO_DIR ?? PROJECT_ROOT;
  const explicitRepos = parseReposRaw(env.TD_REPOS);
  const allowedRepos =
    env.TD_ALLOWED_REPOS === undefined
      ? explicitRepos.length > 0
        ? explicitRepos.map((r) => r.repoId)
        : ["app"]
      : splitList(env.TD_ALLOWED_REPOS);
  const candidates =
    explicitRepos.length > 0 ? explicitRepos : allowedRepos.map((repoId) => ({ repoId, dir: repoDir }));
  const allowed = new Set(allowedRepos);
  return {
    logDir: env.TD_LOG_DIR ?? join(PROJECT_ROOT, "fixtures", "samples"),
    repoDir,
    allowedServices: env.TD_ALLOWED_SERVICES === undefined ? undefined : splitList(env.TD_ALLOWED_SERVICES),
    allowedRepos,
    repos: candidates.filter((r) => allowed.has(r.repoId)),
  };
}

export function loadConfig(opts: { envFile?: string } = {}): AppConfig {
  loadDotEnv(opts.envFile ?? join(PROJECT_ROOT, ".env"));
  const dataDir = process.env.TD_DATA_DIR ?? join(PROJECT_ROOT, "data");
  return {
    projectRoot: PROJECT_ROOT,
    dbPath: process.env.TD_DB_PATH ?? join(dataDir, "ticket-doctor.sqlite"),
    sessionDir: process.env.TD_SESSION_DIR ?? join(dataDir, "sessions"),
    scheduler: {
      workerCount: num("TD_WORKER_COUNT", 4),
      pollIntervalMs: num("TD_POLL_INTERVAL_MS", 1_000),
      heartbeatMs: num("TD_HEARTBEAT_MS", 10_000),
      leaseMs: num("TD_LEASE_MS", 60_000),
      maxAttempts: num("TD_MAX_ATTEMPTS", 2),
      retryDelayMs: num("TD_RETRY_DELAY_MS", 3_000),
      runnerMode: process.env.TD_RUNNER_MODE === "process" ? "process" : "inprocess",
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
      fallbackTimeWindowMs: num("TD_FALLBACK_TIME_WINDOW_MS", 24 * 60 * 60 * 1000),
      compactionEnabled: process.env.TD_COMPACTION_ENABLED !== "false",
      audit: {
        enabled: process.env.TD_AUDIT_ENABLED === "true",
        allowRetrieval: process.env.TD_AUDIT_ALLOW_RETRIEVAL === "true",
        failBlocks: process.env.TD_AUDIT_FAIL_BLOCKS === "true",
        maxRounds: num("TD_AUDIT_MAX_ROUNDS", 1),
      },
    },
    feishu: {
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      botOpenId: process.env.FEISHU_BOT_OPEN_ID,
      requireMention: process.env.FEISHU_REQUIRE_MENTION !== "false",
      logLevel: process.env.FEISHU_LOG_LEVEL,
    },
    host: {
      host: process.env.TD_HOST ?? "0.0.0.0",
      port: num("TD_HOST_PORT", 3000),
      sseReplayLimit: num("TD_SSE_REPLAY_LIMIT", 1000),
      feishuDirect: process.env.TD_FEISHU_DIRECT !== "false",
    },
    sources: resolveSources(process.env),
    delivery: {
      maxAttempts: num("TD_DELIVERY_MAX_ATTEMPTS", 3),
      baseBackoffMs: num("TD_DELIVERY_BACKOFF_MS", 3_000),
    },
    observability: {
      enabled: process.env.TD_OBSERVABILITY_ENABLED === "true",
      baseUrl: process.env.LANGFUSE_BASE_URL,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? "development",
      release: process.env.LANGFUSE_TRACING_RELEASE,
      maxEventBytes: num("TD_OBSERVABILITY_MAX_EVENT_BYTES", 524_288),
      shutdownMs: num("TD_OBSERVABILITY_SHUTDOWN_MS", 5_000),
    },
  };
}
