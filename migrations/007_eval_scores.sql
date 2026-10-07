-- 交付四 D：每轮终态自动评分（线上代理分）。
--
-- 设计边界：
--   * 只存可验证的结构/引用/运行指标（线上无 gold，正确率/召回率缺测，不造数）。
--   * 幂等：run_id + attempt_id + round_id + scorer_version 唯一——重复触发不重复计分。
--   * needs_review=1 的行即候选案例池（引用不可解析、非报告产出、提交失败等），
--     经材料冻结与标准审核后可加入新 Dataset 版本。
CREATE TABLE IF NOT EXISTS eval_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  attempt_id TEXT,
  round_id TEXT NOT NULL,
  investigation_id TEXT NOT NULL,
  scorer_version TEXT NOT NULL,
  outcome TEXT,
  metrics TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  needs_review_reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_scores_dedupe
  ON eval_scores(run_id, attempt_id, round_id, scorer_version);

CREATE INDEX IF NOT EXISTS idx_eval_scores_review
  ON eval_scores(needs_review, created_at);
