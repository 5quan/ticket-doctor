-- 证据持久化与稳定 UID（docs/evidence-uid-design.md §3）。
-- 历史行零改写：只回填 UID（不动作业内容、不改主键、不改 evidence_id）。

ALTER TABLE evidence ADD COLUMN evidence_uid TEXT;
ALTER TABLE evidence ADD COLUMN batch_id TEXT;
ALTER TABLE evidence ADD COLUMN item_index INTEGER;

-- 回填历史行 UID（不透明字符串即可；新行由代码用 randomUUID）
UPDATE evidence SET evidence_uid = lower(hex(randomblob(16))) WHERE evidence_uid IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_evidence_uid ON evidence(evidence_uid);
CREATE INDEX IF NOT EXISTS idx_evidence_batch ON evidence(batch_id, item_index);
CREATE INDEX IF NOT EXISTS idx_evidence_investigation ON evidence(investigation_id, created_at);

CREATE TABLE IF NOT EXISTS evidence_batches (
  batch_id         TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  run_id           TEXT NOT NULL,
  attempt_id       TEXT NOT NULL,
  generation       INTEGER NOT NULL,
  tool             TEXT NOT NULL,
  tool_call_id     TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  result_json      TEXT NOT NULL,      -- 结构化工具结果（pre-ID），用于恢复重建与内容一致性校验
  created_at       INTEGER NOT NULL,
  UNIQUE (run_id, tool_call_id)
);
CREATE INDEX IF NOT EXISTS idx_evidence_batches_investigation
  ON evidence_batches(investigation_id, created_at);

ALTER TABLE reports ADD COLUMN reference_format_version INTEGER NOT NULL DEFAULT 1;
