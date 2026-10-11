# 自改进项目交接（GEPA 起步，C 之前）

> 给下一个接手会话：**先读本文**，再读原方案与各交付记录。
> 状态：已执行到「开始使用 GEPA 自进化之前」；环境已备好，适配器（交付 C）尚未实现。

---

## 1. 原方案是什么

权威方案：`docs/self-improvement-implementation-plan.md`（2026-10-09）。核心：

- **目标**：跑一次受预算约束的实验，得到候选诊断规则、逐案例效果变化、失败原因、成本与采用建议；人工审核后发布，可回滚。无可靠提升就输出「保留基线」。
- **第一版选 GEPA + 现有 TS Agent + Langfuse**；改进对象**只允许**是外部诊断规则（`diagnosis_rules`）；基础 prompt、工具、Agent 核心、案例、答案、评分器**不参与**自动修改。
- **Dash-RSI 留作第二阶段**（改探索/调度策略 + 历史回放），先积累候选树再做。
- **交付 A–F**：A 材料与标准；B 固定评测桥梁；C GEPA 搜索；D 审核与发布；E 真实案例扩展（FastAPI 历史故障）；F 有限回放。A→B→C→D 为第一版必需路径。
- **§8 十步**：1 整合固定基线 → 2 转换案例并审定 rubric → 3 用当前规则跑基线 → 4 锁定可变规则与搜索配置 → **5 跑 GEPA 搜索** → 6 验证候选 → 7 固定最终候选 → 8 独立验收 → 9 人工审核报告 → 10 发布或保留。
- 另一份背景方案：`docs/pre-diagnosis-evaluation-plan.md`（预诊断评测，供参考，路径为早期 `src/evals/` 时点，实施以现码为准）。
- 冻结案例：`fixtures/research/rsi-bootstrap/`（RootCauseBench 9 例，Apache-2.0，公开模拟材料）。

## 2. 本会话做了什么（都已并入 main）

仓库整理与底座：

- 把 `codex/langfuse-eval`（Langfuse 原生离线评测）+ `codex/langfuse-sdk-migration`（观测迁移官方 tracing SDK）整合进 `main`（PR #2）；清理旧分支，legacy 用 `archive/eval-v2-migrate`、`archive/eval-langfuse` tag 保留。
- 旧评测平台事实与新实现见 `docs/langfuse-sdk-migration.md`、`docs/langfuse-eval-implementation-plan.md`。

交付 A（材料与标准）：

- 材料转换器 NDJSON → 每服务 `.log`（保真、行号映射、归档附件不可读）：`src/evolve/materials/convert.ts`、`materialize.ts`、`catalog.ts`。
- 协议扩展 `split=train|validation`、`sourceTier=public_simulated`、`loadCase({requireAdmitted})`。
- 9 例 rubric 起草（`src/evolve/materials/rubrics.ts`）；案例装配（`build-cases.ts`）；数据集 builder（`dataset.ts`）。
- **人工复核/准入工具**（`src/evolve/materials/review.ts` + `scripts/evolve-review.ts`）：批准记录入 `evolve/reviews/<caseId>.json`，与 `rubricHash` 绑定；`rubric` 改动即失效。
- 已准入 **train `rcb-001~004`、validation `rcb-005~007`**；holdout `rcb-008/009` 起草但**未准入**。
- 交付记录：`docs/self-improvement-materials.md`。

交付 B（固定评测桥梁）：

- 候选编译器（基础 prompt + 规则，范围校验）、确定性评分器、预算账本、批量协议：`src/evolve/{compile,grade,budget,batch}.ts`；CLI `scripts/evolve-batch.ts`。
- 评分器要点：事实/证据/引用/边界确定性判定；禁用断言**同窗口共现**且支持 `onlyWhenStatus`（只对 `supported` 假设判定）；硬失败单独阻断。
- 交付记录：`docs/self-improvement-bridge.md`。

基线 + 搜索配置：

- **冻结基线 v2**（真实 pi，deepseek-flash，21 trial，1,180,879 token）：`docs/self-improvement-baseline.md`。`rcb-003` 稳定 0.85（缺上游证据），`rcb-006` 0.67（把正常延迟误判为根因），其余满分——**存在可复现缺口**。
- **冻结搜索配置** `evolve/config/search-v1.json` + `src/evolve/config.ts` + `evolve:config:{show,verify}`：`docs/self-improvement-search-config.md`。
- Langfuse 数据集 `ticket-doctor-rsi-bootstrap-v1` 已同步 7 条（`evolve:dataset:*`）。

仓库约定：所有改动经分支 + PR 合入 `main`；`main` 是唯一分支。

## 3. 剩余需要实现的

### C：GEPA 搜索（下一步）

1. **Python `GEPAAdapter`**（放 `tools/evolve/`）：
   - `evaluate(batch, candidate, capture_traces)`：以子进程参数数组 + stdin 调用 `scripts/evolve-batch.ts`（不要拼 shell）；候选 = `{"diagnosis_rules": "规则全文"}`。
   - `make_reflective_dataset(candidate, eval_batch, components_to_update)`：整理输入、实际输出与**具体失败反馈**。
   - 参考 `docs/self-improvement-implementation-plan.md` §6.1/§6.2；读完 `evolve/config/search-v1.json` 的 `gepa` 参数。
2. **请求前预算拦截**（方案 §8）：当前无统一可拒绝的模型 transport，账本默认 `monitor`；要硬限额需接统一 gateway。
3. **候选选择/报告（交付 D）**：接受/拒绝、逐例差异、成本、待审制品、发布与回滚入口。

### 仍缺

- **语义裁判**：当前只做确定性评分；模型裁判需先在人工标注正反例上校准（§7.3）。
- **E 真实案例扩展**：FastAPI 历史故障（§4.4）与更多真实案例；当前基线多为公开模拟、偏易。
- **F 有限回放**（第二阶段，延后）。
- **holdout 验收**：`rcb-008/009` 候选固定后由独立流程准入（`evolve:review`）。

## 4. 环境（已备好，可复现）

`bash scripts/evolve-env-setup.sh`（幂等）安装到独立位置，不改系统默认：

- **Node 24.9.0**：`/opt/node-v24.9.0-linux-x64/bin/node`（别名 `node24` / `npm24`）。系统默认仍是 Node 22，现有测试沿用默认 `node`。
- **Python 3.13.16 + gepa 0.1.4**：venv `/opt/venvs/ticket-doctor-gepa/bin/python`。
- GEPA 接口已核验：`gepa.core.adapter.GEPAAdapter.{evaluate, make_reflective_dataset}` 存在。

## 5. 接手第一步

1. 读：`docs/self-improvement-implementation-plan.md` → 本文 → `docs/self-improvement-{materials,bridge,baseline,search-config}.md`。
2. 验证现状（不需要付费模型）：
   ```bash
   npm run typecheck && npm test && npm run docs:check
   node --experimental-strip-types scripts/evolve-materials.ts convert --all && node --experimental-strip-types scripts/evolve-materials.ts build
   npm run evolve:review:verify
   npm run evolve:config:verify
   npm run evolve:dataset:verify
   ```
3. 从 **C** 起步：写 `tools/evolve/` 的 GEPAAdapter，用 `node24` 与 `/opt/venvs/ticket-doctor-gepa/bin/python`。
4. 每次改动按 `main` 分支 + PR；收尾按 `docs/handover.md` §七（先改 `docs/status.json` → `npm run docs:check`）。

## 6. 边界与禁止事项

- **holdout `rcb-008/009` 不得准入/混入搜索**，只在候选固定后独立验收；`evolve:config:verify` 会拦。
- **不得伪造人工复核**：`reviewer` 必须是真实审阅人；AI 预审要如实标注（现有记录为「AI 预审 + 用户授权」）。
- **评分协议/材料/基线变化**：`rubric` 改动使批准失效；评分器或 prompt 变化使 search-v1 配置过期，必须重新冻结并重跑基线，禁止混比旧成绩。
- 生产诊断逻辑、审计器、工具权限、输出格式**保持现状**；实验本身不发布。
- 公开数据集可能已入底座模型语料（污染风险）；不得据此声称真实生产根因能力。
