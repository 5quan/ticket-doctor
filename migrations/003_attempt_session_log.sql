-- 会话日志：把"指针 + 用量汇总"下沉到 attempt 维度。
--
-- 背景：此前只把 session_file / usage_* 存在 runs 上，语义是"最新一次尝试"。
-- 重试会覆盖上一条指针，导致上一次尝试的 JSONL 仍在磁盘但无人关联（无法按 run 找到全部尝试）；
-- 用量也只剩最后一次，重试的真实成本被漏记。
--
-- 这里为每次尝试各存一份指针与用量；记录时同时把 runs 上的汇总刷新为"该 run 全部尝试之和"。
ALTER TABLE attempts ADD COLUMN session_file TEXT;
ALTER TABLE attempts ADD COLUMN session_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN usage_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN usage_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN usage_cache_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN usage_total_tokens INTEGER NOT NULL DEFAULT 0;

-- run_events 此前只有 (run_id, sequence) 唯一键；补按类型 + 时间的排查索引。
CREATE INDEX IF NOT EXISTS idx_run_events_type_time ON run_events(type, created_at);
