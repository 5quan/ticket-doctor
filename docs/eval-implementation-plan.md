# 评测实现方案与设计（v2 迁移路线）

> 面向执行者（zcode）：**一次只做一项**；做完跑 `npm run typecheck && npm test && npm run docs:check`，更新本文件与
> `docs/status.json`，再 commit/push。本文是评测的**唯一实施方案与设计说明**。
> 历史：`docs/eval-design.md`（v1 历史，已作废）；`docs/eval-v2.md`（v2 使用说明，随 v2 资产一并保留）。
> 版本铁律：每项指标**一个明确定义 + 一个版本**；改口径必须递增对应版本（`SCORER_VERSION` / `AUDIT_POLICY_VERSION`），
> **不同版本禁止同表比较**。

---

## 0. 最高层：目标

把"这个诊断 Agent 行不行、改动后变好还是变坏"从**主观**变成**可量化、可回归、可优化**。

达成后被回答的问题：材料范围对不对、结论有没有证据支持、缺料会不会追问、反证出现会不会修正、回写可不可核验，
以及成本/时延。**工程验收标准是"评测能正确揭示失败"，不是"诊断分数高"。**

## 0.1 三条线与职责分工（Langfuse 的位置）

| 线 | 是什么 | 数据去向 |
|---|---|---|
| 生产主链路 | Host → Runner → 诊断会话 + 审计会话 → 报告 | SQLite + 投递 |
| 观测 | 每次 attempt 的 trace | Langfuse |
| 评测 | 固定案例批量跑主链路并评分 | 本地冻结快照 + Langfuse 实验 |

**纠偏**：Langfuse **能做评测**（datasets / experiments / scores / code evaluators / annotation / 对比 / 调度），
不是"只是观测后端、只是门面"。它承担：**数据集版本、实验调度、评分执行、结果对比、人工复核**。

**它唯二不做**：① 真正执行 Agent（那是我们的主链路/`runCase`）；② 知道业务标准答案（那是我们定的 gold）。

**职责分工**：

| 环节 | Langfuse 承担 | 我们负责 |
|---|---|---|
| 案例与标准 | Dataset 存输入/参考答案/标签/版本 | 制作可信案例、定义业务标准、准备脱敏日志与代码材料 |
| 批量运行 | Experiment SDK 遍历、并发、关联实验 | 提供"如何跑一条 case"的 `runCase`（多轮、材料发布、会话状态、工具、生产编排） |
| 程序评分 | 执行 Code Evaluator，或接收外部评分 | 编写并验证规则（首期在项目端，便于查 Git/SQLite/跨轮证据/隔离），准备好评分数据 |
| 内容质量评分 | 模型裁判、人工标注 | 定义标准、校准裁判、处理争议 |
| 查看/比较 | 轨迹、分数、实验差异、人工复核 | 据结果做改进决策 |

**执行位置**：SDK 实验的 task 与评分函数**在我们的进程运行**（可访问项目/SQLite/材料，调用真实生产链路），
不受自托管 Code Evaluator 沙箱（标准库/无网络/~2s）限制——**dispatcher 只影响平台内 Code Evaluator，不阻碍 SDK 接入**。

## 0.2 评分单元 / 触发时机 / 分母（决定指标含义）

| 层 | 对象 | 是否评分单元 |
|---|---|---|
| 调查（会话） | `investigation` | ❌ 多轮、可能长期不关闭 |
| **轮次运行** | `run`（终态那次） | ✅ **评分单元**；触发点 = Host `finalizeEngineResult` |
| 执行尝试 | `attempt`（重试） | ⚠️ 只有终态算质量；重试次数进可靠性 |
| 工具/证据 | `tool_execution`/`evidence` | ❌ 只用于**定位问题**与作为评分输入 |

- 质量分母 = 被评的 **report run 数**（不是 tool call / 消息 / 所有 run）；
- `reply`（闲聊/追问）run 单独一类分母；
- 失败/取消/超时不进质量分母，走可靠性指标。

## 0.3 两栏：评测（考试） vs 线上监控

| | 评测（考试） | 线上监控 |
|---|---|---|
| 对谁 | 固定考卷 | 每条真实工单跑完 |
| 有标准答案吗 | **有** → 能算对错 | **没有** → 只能算代理分（引用/成本/审计结果） |
| 触发 | 手动/CI | 每次 run finalize 自动 |
| 用途 | 比好坏、防退化、调优 | 监控、找异常、**攒候选案例** |

线上代理分**不能替代**评测，但**喂养**评测（低分 run → 人工标 gold → 新考题）。

---

## 1. 设计思路（为什么这么做）

1. **复用生产主链路**：评测**不改编排**，调用 `prepareDiagnosis → runDiagnosisLoop → validateDraft → applyAudit`
   （多轮时经 `executeRun`）；证据、审计、校验都是生产同一份代码，避免"评测测的不是线上行为"。
2. **标准答案留评分端**：Agent 只答问题；gold/*标准* 不进 Agent 上下文，防止照抄答案（隔离预检保证）。
3. **分层评分**：
   - **程序规则层**（确定性，自动）：引用可解析/版本一致、无证据却 supported、完整度矛盾、是否追问、覆盖使用、成本/时延、审计 verdict。
   - **语义层**（需 gold）：根因正确、证据语义支持结论、是否漏反证、追问是否命中。首期人工复核（Langfuse Annotation），后期模型裁判校准。
4. **可见性四层**：A 源返回 / B 入库 / C1 工具返回文本 / C2 请求上下文 / D 报告引用。把"入库≠模型可见"（预览上限、渲染预算）变成可测指标。
5. **隔离 / 冻结 / 重放**：路径闭包、未来消息泄漏、答案文件名、git tree 检查；manifest 固化 HEAD/材料/标准/提示词/预算 hash；评分可离线重放且逐字段一致。
6. **指标定义唯一**：每项指标一个明确定义 + 版本。同一**内容指标**可同时有人工分与模型分（用于校准裁判），各自记录**来源/评估器版本/理由**；**自动分不得覆盖正式人工裁决**。
7. **权威源**：接入 Langfuse 后，**人工裁决以 Langfuse 为准**；本地冻结快照只读，**镜像不得覆盖人工裁决**；模型评分可作为**独立来源**写入。
8. **硬失败单列**：引用不可解析、版本错配、越界断言、反证后固执、空日志推健康等，不进均值。

---

## 2. 现状盘点

- **薄 MVP（`src/eval/`）**：已建 benchmark 契约/指纹/内存 runner/scorer/JSONL/compare/review。用途：**验证思路 + 过渡**；
  能力远小于 eval2。迁移完成后**退役或并入**（见 M9）。
- **eval2 较晚版**：存在于 **`66d5425`**（`fc8ccba` 合并时被删除）。资产：`src/evals/v2/`（runner 31.9k、scorer 20.6k/`3.1.0`、
  isolation 19.6k、review、visibility、manifest/hash、schema/types、capture/trace、engcases/scripted-engine、cli）+
  6 个测试 + `docs/eval-v2.md`。**参考较晚版，不用初版 `6040850`（3.0.0）。**
- **当前 main 新增、v2 没有的**：独立审计 + 有界补证循环、工具覆盖信息（cursor/total/truncated）、协议 v4、证据 UID（v2 已有）。
  → **迁移必须适配**；静态检查不能证明兼容。

---

## 3. 迁移方案（按职责，不是整包照搬）

| v2 资产（`66d5425`） | 迁移 | 适配当前 main |
|---|---|---|
| `runner.ts` 多轮执行/材料发布/调查隔离（复用 `executeRun`） | ✅ 重点 | 现执行 `runDiagnosisLoop`；新增**审计/补证阶段**；调用次数/输出阶段/观测接口 |
| `visibility.ts` 四层可见性 | ✅ | 覆盖信息（cursor/total/truncated）纳入 C1/C2 |
| `isolation.ts` 隔离预检 | ✅ 安全前提 | 材料路径与当前 `sources` 对齐 |
| `manifest.ts`+`hash.ts` 指纹/冻结/重放 | ✅ | 纳入 `AUDIT_POLICY_VERSION` 与覆盖口径 |
| `review.ts` 人工复核导入 | ✅ | 与 Langfuse Annotation 对齐；权威源契约 |
| `scorer.ts` 3.1.0 逐轮标准 | ✅ 按当前口径重验 | 证据 UID v4、审计判定、覆盖命中 |
| `schema.ts`/`types.ts`/`load.ts` | ✅ | 扩展 audit/coverage 字段 |
| `capture.ts`/`trace.ts` 发送端捕获/trace | ⚠️ 部分 | 查看/对比可交 Langfuse；本地保留冻结快照 |
| `engcases.ts`/`scripted-engine.ts` 工程自测生成器 | ✅ | 加审计/补证/截断续查反例 |
| `cli.ts`（`npm run eval:v2`） | ✅ | 批量遍历可选交 SDK；保留本地离线 |
| `data/eval-v2/handoff/*.tar.gz` | ❌ | 历史交接包，不迁移 |
| `docs/eval-v2.md`/`session-handover-eval-v2.md` | ✅ | 更新到当前口径 |

**不迁移的通用外壳**：批量遍历、实验记录、分数对比 → **交 Langfuse SDK**。

---

## 4. 路线与工作单

**路线（4 步，1 与 2 可并行）**：
1. 盘点并迁移 `66d5425` 的必要领域能力，用**工程案例**验证运行与评分正确。
2. **并行**：准入真实案例 + 定 gold 与评分标准；接通 Langfuse 实验 + 人工复核。
3. **真实 Agent 跑完评测并经内容复核后**，冻结**正式质量基线**（此前只有工程/程序指标基线）。
4. 再扩线上自动评分、案例回流、CI 门禁。

| # | 任务 | 验收 | 状态 |
|---|---|---|---|
| M0 | 建分支 + 恢复 `66d5425` 的 v2 资产（`src/evals/v2`、6 测试、`docs/eval-v2.md`、`eval:v2` 入口、`fixtures/evals/checkout-timeout` + `scripts/init-eval-fixture.mjs`） | 资产在分支上；typecheck 绿；脚本套件可跑 | ✅ 完成（`eval/v2-migrate`）：T7 `SourcePage` 适配 + 恢复 `onPrepared` 钩子；脚本套件 `eng-clarify` 已过 |
| M1 | runner/脚本引擎适配当前主链路（`runDiagnosisLoop`：审计/补证、协议 v4、证据 UID） | 工程案例多轮跑通，审计阶段可见 | ✅ 完成：根因是 `extractService` 把日期当服务名（OQ-45，已修）；`eng-clarify`/`eng-counter-evidence`/`eng-truncation` 全通；version 用例为**预期阻断**，`eval-v2-version` 集成测试通过 |
| M2 | 可见性四层 + 覆盖信息 | 四层指标可产出；截断续查有对应指标 | ✅ 完成：`eval-v2-run` 可见性反例（B 命中、C1 不命中）集成测试通过 |
| M3 | scorer 3.1.0 按当前口径重验（UID/审计/覆盖） | 正反例测试全绿；旧口径作废声明 | 待办 |
| M4 | manifest/hash 纳入 audit policy + 覆盖口径；重放逐字段一致 | `replay` 与 `score.json` 一致 | ✅ 完成：manifest 新增 `diagnosis.audit`（policyVersion/enabled/maxRounds/failBlocks）与 `diagnosis.coverage`（search 50/read 200/list 200/log 20）；`replay` 5/5 逐字段一致 |
| M5 | 隔离预检适配当前 sources | 违规 case `blocked`，不进口径 | ✅ 完成：隔离/链接单测无失败；预检已适配 T7 `SourcePage` |
| M6 | review 与 Langfuse Annotation 对齐（权威源契约） | 人工裁决不被镜像覆盖 | 待办 |
| M7 | Langfuse 接入 | 一个带 Langfuse 复核的小闭环跑通 | 🟡 部分：**trace+score 推送已实现**（`src/evals/v2/langfuse.ts`，`npm run eval:v2 -- push`）——v4（4.50.0, `events_only`）下轨迹走 OTLP `/api/public/otel/v1/traces`、分数走 ingestion，均已 2xx；**dataset/experiment/annotation 待做**（v4 需 `@langfuse/*` 的 dataset/annotation API）。注意：v4 已下架 `/api/public/traces|observations|scores`（改用 `/api/public/v3/scores`），程序化验证需查 UI http://127.0.0.1:3001 |
| M8 | 真实案例准入 + gold/评分标准（**并行**） | ≥1 可信案例 | 🟡 已调研开源来源并定方案：首选 **RCAEval**（RE2/RE3：根因 gold + 日志 + 开源系统可钉版本）；转换方案见 `docs/eval-open-source-datasets.md`；待实现导入器（`import-rcaeval.mjs`）并转 5 例 |
| M9 | 冻结正式质量基线（含复核）；薄 MVP 退役/并入 | `status.json#eval_mvp` 落基线块 | 待办 |
| M10 | 线上代理分 + 案例回流 + CI 门禁 | 低分 run 可回填为候选案例 | 待办 |

---

## 5. 非目标 / 禁区

- **不改生产编排语义**：评测只调用，不修改诊断/审计/工具的判定逻辑。
- **禁止自查自证**：优化期间案例、`scorer`、评分口径是**禁区**；唯一迭代对象是 `rules.md`/提示词。
- **禁止把"命中 gold"当"诊断正确"**：语义未复核 = `unscored`。
- **禁止自动分覆盖人工裁决**（权威源契约）。
- **禁止笼统宣称覆盖生产链路**：内存/多轮运行器覆盖诊断核心；持久化、投递、代次守卫另测。

## 6. 执行规程

1. 先绿：`npm run typecheck && npm test && npm run docs:check`。
2. 认领一个 M 项，本文件改「进行中」。
3. 实现 → 测试 → 工程自测（`npm run eval:v2 -- run --engine scripted`）→ 更新本文件/`status.json`/`session-handover.md`。
4. `commit` + `push`；改口径必须 bump 版本并在提交信息注明。
5. 新迁移从 `007_` 起（本方案预期无迁移）。

## 7. 已知限制

- 语义正确性在人工复核前一律 `unscored`；未复核结果只能作**工程/程序指标**。
- 线上无 gold，代理分不等于质量分。
- 平台内 Code Evaluator 受沙箱限制，主要用于**纯记录内、轻量**规则；查 Git/SQLite 的规则留在项目端。
- `data/` 不入版本库；冻结快照需单独归档策略。
- **scripted 引擎未适配补证循环**：`--audit on` 时若审计建议 continue，补证轮会耗尽脚本步骤（报告被“脚本已耗尽”覆盖）。工程自测的审计开关需脚本引擎支持补证步，或对 engineering case 固定 `audit off`（真实效果由真实 case + `--engine pi` 比）。
