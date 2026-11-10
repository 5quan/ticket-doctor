# 自改进项目交接（适配器已实现，真实搜索待执行）

> 给下一个接手会话：**先读本文**，再读原方案与各交付记录。
> 最后同步：2026-11-10；当前暂停开发，状态源见 [开发状态](status.json#development) 与 [自改进状态](status.json#self_improvement)。
> A/B、冻结基线与搜索配置、C 的 Python 适配器已实现；真实 GEPA 搜索尚未运行，完整审核发布闭环尚未完成。

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

## 2. 已入库的实现与历史验证

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
- **交付 C 适配器**：`tools/evolve/`（GEPAAdapter + 反射 LM + optimize 入口）+ `npm run evolve:gepa[:test]`；环境见 `scripts/evolve-env-setup.sh`。
- Langfuse 数据集 `ticket-doctor-rsi-bootstrap-v1` 已同步 7 条（`evolve:dataset:*`）。

仓库约定：所有改动经分支 + PR 合入 `main`；旧实现已由主干与归档标签保留。本地旧工作树或远程跟踪引用不代表 GitHub 仍保留对应开发分支。

## 3. 剩余需要实现的

### C：GEPA 搜索

1. **Python `GEPAAdapter`**：✅ 已实现（[适配器说明](../tools/evolve/README.md)）：`evaluate` 按 split 分组子进程调桥梁；`make_reflective_dataset` 产出反思样本；holdout 案例直接拒绝；token 累计 + `MaxTokensStopper`。原交付记录含无模型单测通过；当前 Windows 接手环境未重跑 Python 测试。
   **剩余：恢复环境并验证后，用真实反射 LM 跑一次搜索**。需要模型凭据、明确调用预算，以及下述预算和隔离条件核验；产物在 `data/evolve/gepa/<run>/`。搜索入口存在不等于已运行搜索。
2. **请求前预算拦截**（方案 §8）：当前账本 `monitor`，`MaxTokensStopper` 只在 trial 间停止；要请求前硬限需接统一 gateway。
3. **候选选择/报告（交付 D）**：`tools/evolve/optimize.py` 已具备生成 `report.json` / `best-rules.md` 及初步采用/保留判断的能力；尚未形成完整的逐例审核、独立验收、人工批准、生产加载与回滚入口。初步 `adopt-candidate` 不等于批准发布。
4. **搜索隔离与恢复验收**：运行前核对净化后的 train/validation 制品、优化器对私有答案和 holdout 的访问边界，以及检查点和预算状态恢复。适配器内拒绝 holdout ID 不等于完整的运行环境隔离。

### 仍缺

- **语义裁判**：当前只做确定性评分；模型裁判需先在人工标注正反例上校准（§7.3）。
- **E 真实案例扩展**：FastAPI 历史故障（§4.4）与更多真实案例；当前基线多为公开模拟、偏易。
- **F 有限回放**（第二阶段，延后）。
- **holdout 验收**：`rcb-008/009` 候选固定后由独立流程准入（`evolve:review`）。

## 4. 环境（Linux 安装脚本与历史验证）

`bash scripts/evolve-env-setup.sh`（幂等）安装到独立位置，不改系统默认：

- **Node 24.9.0**：`/opt/node-v24.9.0-linux-x64/bin/node`（别名 `node24` / `npm24`）。系统默认仍是 Node 22，现有测试沿用默认 `node`。
- **Python 3.13.16 + gepa 0.1.4**：venv `/opt/venvs/ticket-doctor-gepa/bin/python`。
- GEPA 接口已核验：`gepa.core.adapter.GEPAAdapter.{evaluate, make_reflective_dataset}` 存在。

以上是原 Linux 环境的安装位置与交付记录，不表示当前 Windows 机器已经安装这些组件。恢复时先确认运行位置；`package.json` 中 `evolve:gepa` / `evolve:gepa:test` 使用 Bash 变量语法，Windows 原生命令行不能直接照搬。Python 子进程使用 `TD_NODE_BIN` 指定实际 Node 可执行文件，不依赖交互式 shell 别名。

2026-11-10 当前 Windows 接手核验：

| 检查 | 结果与恢复要求 |
|---|---|
| 冻结原始材料 | 文件 hash 全部通过，材料仍在 Git 中 |
| 类型检查 | 缺少本地 Langfuse / OpenTelemetry 依赖；先按 lockfile 安装 |
| 搜索配置 | 派生案例未装配，源码 CRLF 字节也与冻结的 LF hash 不同 |
| 全量 TS / Python 测试 | 本轮尚未取得完整通过结果；历史全绿记录不代表当前环境 |

两个源码指纹在归一为 LF 后与冻结值一致，未发现内容漂移。恢复时使用 LF checkout，并重新验证原件、转换器、rubric 和配置指纹；不要通过改冻结 hash 或跳过校验来掩盖差异。若材料、评分或模型实际变化，仍须按规则重新冻结和跑基线。

## 5. 接手第一步

1. 读：本文 → [原实施方案](self-improvement-implementation-plan.md) → 材料/桥梁/基线/搜索配置记录 → [适配器说明](../tools/evolve/README.md)。总目录见 [文档索引](README.md)。
2. 恢复依赖并验证本地状态（不调用付费模型；在确认的运行环境执行）：
   ```bash
   npm ci
   npm run typecheck && npm test && npm run docs:check
   npm run evolve:materials:verify
   node --experimental-strip-types scripts/evolve-materials.ts convert --all && node --experimental-strip-types scripts/evolve-materials.ts build
   npm run evolve:review:verify
   npm run evolve:config:verify
   ```
3. 在 Linux 环境按安装脚本准备 Node/Python，设置 `TD_NODE_BIN=/opt/node-v24.9.0-linux-x64/bin/node`，用 `/opt/venvs/ticket-doctor-gepa/bin/python -m unittest tools.evolve.tests.test_adapter -v` 复验现有适配器。无需重写交付 C。
4. 恢复 Langfuse 服务和凭据后，另跑 `npm run evolve:dataset:verify`；它需要访问服务器，并非离线检查。本轮未读回服务端数据。
5. 先补请求前预算控制、核对隔离与恢复条件，再明确真实搜索预算；搜索后固定候选、独立 holdout 验收，再进入 D 的人工审核与发布。E 可并行制作，F 继续延后。
6. 每次改动按分支 + PR 合入 `main`；收尾按 [交接规程](handover.md#七交接规程)（先改 `docs/status.json` → `npm run docs:check`）。

## 6. 边界与禁止事项

- **holdout `rcb-008/009` 不得准入/混入搜索**，只在候选固定后独立验收；`evolve:config:verify` 会拦。
- **不得伪造人工复核**：`reviewer` 必须是真实审阅人；AI 预审要如实标注（现有记录为「AI 预审 + 用户授权」）。
- **评分协议/材料/基线变化**：`rubric` 改动使批准失效；评分器或 prompt 变化使 search-v1 配置过期，必须重新冻结并重跑基线，禁止混比旧成绩。
- 生产诊断逻辑、审计器、工具权限、输出格式**保持现状**；实验本身不发布。
- 公开数据集可能已入底座模型语料（污染风险）；不得据此声称真实生产根因能力。
