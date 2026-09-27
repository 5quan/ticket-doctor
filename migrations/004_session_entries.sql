-- 会话条目进库：单存储（业务状态 + 模型会话同库），取代 data/sessions/*.jsonl。
--
-- 设计：一行 = 一条完整 pi SessionEntry（data 列存 JSON），按调查单调 seq 排列。
-- 引擎启动时按 seq 读回并灌进 SessionManager.inMemory(entries)，pi 仍负责树/压缩/上下文重建。
-- 好处：跨存储指针不一致、flush 排序、文件锁、torn write、pi 首写陷阱一并消失。
CREATE TABLE IF NOT EXISTS session_entries (
  investigation_id TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  run_id           TEXT NOT NULL,
  attempt_id       TEXT NOT NULL,
  entry_id         TEXT NOT NULL,
  parent_id        TEXT,
  type             TEXT NOT NULL,
  time_ms          INTEGER NOT NULL,
  data             TEXT NOT NULL,            -- 完整 pi SessionEntry JSON
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (investigation_id, seq),
  UNIQUE (investigation_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_session_entries_run ON session_entries(run_id);

-- 工具执行记录（T3 可观测）：入参/结果规模/耗时/成败/pi 调用 ID。
CREATE TABLE IF NOT EXISTS tool_executions (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  run_id           TEXT NOT NULL,
  attempt_id       TEXT NOT NULL,
  call_id          TEXT NOT NULL,            -- pi 的 toolCallId
  tool             TEXT NOT NULL,
  input            TEXT,
  ok               INTEGER,
  duration_ms      INTEGER,
  output_chars     INTEGER,
  error            TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_exec_run ON tool_executions(run_id, created_at);
