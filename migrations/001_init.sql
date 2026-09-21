-- ticket-doctor 第一版 schema
-- 设计原则：
--   * 业务事实（调查/消息/轮次/尝试/证据/报告/投递）全部落 SQLite，pi 会话文件只存模型上下文。
--   * 事件去重、消息映射、轮次幂等各自有唯一约束兜底。
--   * 所有时间用 epoch ms 整数，避免时区解析歧义。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- 平台事件去重：同一 (provider, account, message_id) 只处理一次
CREATE TABLE IF NOT EXISTS inbound_events (
  id                  TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  chat_id             TEXT NOT NULL,
  status              TEXT NOT NULL,          -- received | processed | ignored | failed
  payload             TEXT,
  error               TEXT,
  received_at         INTEGER NOT NULL,
  processed_at        INTEGER,
  UNIQUE (provider, account_id, external_message_id)
);
CREATE INDEX IF NOT EXISTS idx_inbound_status ON inbound_events(status, received_at);

-- 一个 Bug = 一个调查
CREATE TABLE IF NOT EXISTS investigations (
  id              TEXT PRIMARY KEY,
  session_code    TEXT NOT NULL UNIQUE,       -- 回复里展示的 [TD-xxxx]
  provider        TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  root_message_id TEXT,
  thread_id       TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  title           TEXT,
  service         TEXT,
  environment     TEXT,
  created_by      TEXT,
  context_summary TEXT,                        -- 上一轮有效上下文摘要
  total_rounds    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_investigation_route
  ON investigations(provider, account_id, chat_id, root_message_id);
CREATE INDEX IF NOT EXISTS idx_investigation_thread
  ON investigations(provider, account_id, chat_id, thread_id);

-- 用户输入（每轮一条），保留发送者与平台消息 ID
CREATE TABLE IF NOT EXISTS messages (
  id                  TEXT PRIMARY KEY,
  investigation_id    TEXT NOT NULL,
  provider            TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  root_id             TEXT,
  thread_id           TEXT,
  sender_id           TEXT,
  sender_name         TEXT,
  text                TEXT NOT NULL,
  received_at         INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  UNIQUE (provider, account_id, external_message_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_investigation
  ON messages(investigation_id, received_at);

-- 一轮诊断
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  status          TEXT NOT NULL,              -- queued | running | succeeded | failed | interrupted
  generation      INTEGER NOT NULL DEFAULT 0,-- 执行代次：过期执行者不能提交
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL,
  available_at    INTEGER NOT NULL,
  lease_expires_at INTEGER,
  error_code      TEXT,
  error_message   TEXT,
  report_id       TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_claim
  ON runs(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_investigation
  ON runs(investigation_id, created_at);

-- 一次执行尝试（一轮可能多次，比如中断重试）
CREATE TABLE IF NOT EXISTS attempts (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  generation      INTEGER NOT NULL,
  worker_id       TEXT NOT NULL,
  status          TEXT NOT NULL,              -- running | succeeded | failed | interrupted
  lease_expires_at INTEGER NOT NULL,
  heartbeat_at    INTEGER NOT NULL,
  error_code      TEXT,
  error_message   TEXT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  UNIQUE (run_id, generation)
);
CREATE INDEX IF NOT EXISTS idx_attempts_lease ON attempts(status, lease_expires_at);

-- 业务事件：阶段变化、工具调用、异常等
CREATE TABLE IF NOT EXISTS run_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,
  attempt_id TEXT,
  sequence   INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, sequence)
);

-- 证据：程序签发 ID，模型只引用
CREATE TABLE IF NOT EXISTS evidence (
  run_id           TEXT NOT NULL,
  evidence_id      TEXT NOT NULL,            -- E1, E2 ...（运行内唯一）
  investigation_id TEXT NOT NULL,
  kind             TEXT NOT NULL,            -- log | code
  source           TEXT NOT NULL,
  excerpt          TEXT NOT NULL,
  truncated        INTEGER NOT NULL DEFAULT 0,
  time_ms          INTEGER,
  level            TEXT,
  repo_id          TEXT,
  sha              TEXT,
  path             TEXT,
  start_line       INTEGER,
  end_line         INTEGER,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (run_id, evidence_id)
);

-- 结构化报告
CREATE TABLE IF NOT EXISTS reports (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  run_id           TEXT NOT NULL UNIQUE,
  completeness     TEXT NOT NULL,            -- complete | partial
  content          TEXT NOT NULL,            -- DiagnosisReport JSON
  created_at       INTEGER NOT NULL
);

-- 待发送记录：与报告在同一事务提交，由投递模块独立发送
CREATE TABLE IF NOT EXISTS deliveries (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  run_id           TEXT NOT NULL,
  report_id        TEXT,
  kind             TEXT NOT NULL,            -- report | progress | notice
  target_message_id TEXT,
  content          TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL,            -- pending | sending | sent | uncertain | failed
  provider_message_id TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0,
  available_at     INTEGER NOT NULL,
  lease_expires_at INTEGER,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  delivered_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deliveries_claim ON deliveries(status, available_at, created_at);
