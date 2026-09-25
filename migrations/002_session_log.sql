-- 会话日志指针 + 用量汇总。
-- 模型层逐条事件（消息/工具调用/用量/压缩）落 JSONL 文件（append-only source of truth），
-- SQLite 只存指向该文件的指针与 token 聚合，便于按 run 快速定位与粗查。
ALTER TABLE runs ADD COLUMN session_file TEXT;
ALTER TABLE runs ADD COLUMN session_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN usage_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN usage_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN usage_cache_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN usage_total_tokens INTEGER NOT NULL DEFAULT 0;
