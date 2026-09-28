-- 005：Host 统一入口与按会话调度
-- 设计原则：
--   * 队列隔离单位是"调查"（一个 Bug 会话），不是用户/群。
--   * 每轮由 Host 分配调查内单调轮次号（round），调度只认 round，不认平台时间戳。
--   * 入站来源（source）与回复目标逐轮保存：Web 发起的轮次不回 IM。
--   * 取消是显式请求：queued 直接取消，running 置 cancel_requested，执行者失租即止。
--   * events 表是 Host EventStore 的持久化：稳定自增 ID 供 SSE 断线重连 replay。

ALTER TABLE runs ADD COLUMN round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT 'feishu';
ALTER TABLE runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;

-- 回填历史轮次号：按调查内 created_at 顺序依次编号。
UPDATE runs SET round = (
  SELECT COUNT(*) FROM runs r2
  WHERE r2.investigation_id = runs.investigation_id
    AND (r2.created_at < runs.created_at OR (r2.created_at = runs.created_at AND r2.id <= runs.id))
);
CREATE INDEX IF NOT EXISTS idx_runs_round ON runs(investigation_id, round);
CREATE INDEX IF NOT EXISTS idx_runs_source ON runs(source, status, available_at);

-- SSE 事件流：stream 为订阅键（当前=调查 ID），id 全局自增 = SSE Last-Event-ID。
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stream     TEXT NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_stream ON events(stream, id);
