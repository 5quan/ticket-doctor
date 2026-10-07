# 评测 ↔ Langfuse 闭环：验收标准与操作手册（eval/langfuse 分支）

> 本分支回答一个问题：**评测闭环里 Langfuse 承担哪一段、项目端保留哪一段，以及怎样算"跑通"。**
> 结构与口径承接 `docs/eval-v2.md`；本文只写 Langfuse 侧的边界、命令与验收标准。
> 易变事实以 `docs/status.json` 的 `eval_langfuse_loop` 为准。

## 0. 职责边界（不可谈判的部分）

| 职责 | 归属 | 依据 |
|---|---|---|
| 运行器（驱动真实 Agent、多轮、隔离、版本核对） | 项目端 `src/evals/v2/runner.ts` | Langfuse v4 experiment 只是"逐 item 调你的函数/收你的 trace"，不托管执行 |
| 评分（确定性硬检查/逐轮行为/维度汇总，SCORER_VERSION） | 项目端 `src/evals/v2/scorer.ts` | 领域 rubric；Langfuse Code Evaluator 沙箱（stdlib/2s/无网络）装不下 |
| 复核与重评分（绑定五元组、outputsHash、claimId） | 项目端 `src/evals/v2/review.ts` + CLI rescore | 人工裁决工件留在本地，Langfuse 标注队列只是入口 |
| 比较（可比性前置 + 成对差值） | 项目端 `src/evals/v2/compare.ts` | 平台对比不校验口径/材料指纹一致性 |
| 案例集存储与版本快照 | **Langfuse Dataset** | item 任意 JSON、自动版本戳、按版本复跑 |
| 实验记录/展示/对比 UI、人工标注队列 | **Langfuse** | 账本层 |
| trace↔实验↔dataset item 关联 | **Langfuse v4**：OTel `langfuse.experiment.*` span 属性 | `OtelIngestionProcessor.extractExperimentFields` |

## 1. 平台能力矩阵（本机 4.50.0，`LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only`）

| 面 | 端点 | 状态 |
|---|---|---|
| 建数据集 | POST `/api/public/datasets` | ✅ |
| 建条目（按 id upsert） | POST `/api/public/dataset-items` | ✅ |
| 注册实验（换 experimentId） | POST `/api/public/dataset-run-items` | ✅（events_only 下不落旧表，返回确定性 datasetRunId） |
| 读数据集/条目 | GET `/datasets/{name}`、`/dataset-items` | ✅（Postgres 侧，未被门禁） |
| 读实验/实验条目 | GET `/experiments`、`/experiment-items` | ✅（v4 events 表；条目需 span 带 `langfuse.experiment.item.root_observation_id`＝根 span 自身 spanId） |
| 读观测 | GET `/v2/observations` | ✅ |
| 读分数 | v1/v2 scores、`/v3/scores` | ❌/❌/⚠：v1、v2 被 events_only 拒绝；v3 读旧 `scores` 表——events_only 下 score-create 2xx 受理但**任何 API 均回空**。分数可读性以 **UI 核对**为准（`datasets verify` 记 warning 不阻断） |

结论：**trace/观测/实验关联的读回全部可用；分数只有 UI 是可信读面**（平台侧限制，升级 Langfuse 后复查）。

## 2. 操作序列（全部命令，scripted 引擎零成本可复跑）

```bash
# 1. 本地跑 suite（确定性工程自测）
npm run eval:v2 -- run --suite lf-loop-1 --engine scripted

# 2. 案例集 → Langfuse Dataset（幂等 upsert；非 admitted case 显式跳过）
npm run eval:v2 -- datasets sync --dataset eval-v2-eng

# 3. trial trace+分数上平台，并关联到实验（run-item 换 experimentId → span 属性关联）
npm run eval:v2 -- push --suite lf-loop-1 --dataset eval-v2-eng
#    重复同步幂等（确定性 traceId/score id/experimentId）；失败续传，--force 重推

# 4. 平台可读性对账（dataset/items/实验关联/观测回读/分数回读）
npm run eval:v2 -- datasets verify --dataset eval-v2-eng --suite lf-loop-1

# 5. 复核闭环（Langfuse UI 标注队列完成后，导出/填写 review 工件）
npm run eval:v2 -- rescore --suite lf-loop-1 --case eng-clarify --trial t1 --review review.json
npm run eval:v2 -- summary --suite lf-loop-1        # 复核聚合
npm run eval:v2 -- push --suite lf-loop-1 --dataset eval-v2-eng   # .reviewed 侧车分

# 6. 口径一致的比较（平台 UI 端在同 dataset 下并排看两次实验）
npm run eval:v2 -- compare --baseline baseline-v0-eng-1 --candidate lf-loop-1
```

## 3. 验收标准（"跑通"的定义，全部满足才算）

1. **数据集**：`datasets sync` 后平台 dataset 的 ACTIVE items 与本地同步状态一一对应
   （`datasets verify` ✅）。非 admitted 的 case 不上平台（⏭ 计数，不进评测总体）。
2. **推送与幂等**：`push` 全部 trial confirmed；重复执行 `skipped(已确认)=n` 且平台无重复记录。
3. **实验关联**：`experiment-items` 条数 = confirmed trial 数，且每个 trial 的 traceId 在列
   （`verify` ✅；断链记 ❌ 退出 1）。
4. **观测回读**：样本 trace 的 v2/observations 返回 根+各轮 子观测。
5. **分数**：推送 2xx 无逐条错误；API 回读为空时在 verify 输出中显式标注
   （当前平台限制），并由人工在 UI 抽查一条 trace 的分数面板。
6. **复核闭环**：review 工件 → rescore → summary 聚合 → push `.reviewed` 侧车
   （承接 eval-v2.md §3，本分支不改其语义）。
7. **回归**：`npm test`、`npm run typecheck`、`npm run docs:check` 全绿；
   `replay` 与 score.json 逐字段一致。

## 4. 白名单纪律（B1，红线）

- dataset item：`input` = 公开题面；`expectedOutput` **恒 null**；`metadata` 只含公开描述字段
  与指纹（caseHash/truthHash）。truth 内容/requirementId/禁用规则结构性不进平台
  （单测 `tests/unit/eval-v2-lfdataset.test.ts` 用标记字符串证明）。
- 评价标准的唯一权威在本地 `private/<case>/truth.private.json`；平台侧只留指纹引用。
- 实验记录（manifest/指纹/门禁）的冻结与对账规则不变，见 `docs/eval-v2.md`。

## 5. 已知限制与后续

- **分数 API 回读恒空**（本机 4.50.0 events_only）：score-create 受理后不可经 API 读回；
  需要程序化读分时，走本地 `score.json`/`langfuse-sync.json`（本地是权威源）。升级
  Langfuse 后用 `datasets verify` 复测。
- **官方 SDK 原生实验（`dataset.run`）在本 build 不可直接使用**：events_only 下
  `/api/public/ingestion` 拒收一切 trace/observation 事件（服务端 `ingestion.ts` 明确
  "only accepts score events"），SDK 实验的常规上报路径会被整批拒收。本分支的
  OTLP + `langfuse.experiment.*` span 属性方案正是其等价替代，且已端到端验证。
  平台升级前，编排循环留在项目端是**被迫的最优解**，不是偏好。
- **Code Evaluator 在本机未启用**：自托管需显式设 `LANGFUSE_CODE_EVAL_DISPATCHER`
  （缺省 = 整体禁用）。可选形态：`aws-lambda`（无网络出站、云上默认 2s）或
  `insecure-local`（TS-only、在 worker 进程内直跑，官方声明非安全边界）。
  即便启用，也只适合轻量确定性检查；rubric 主体留在项目端 scorer 不变。
- **模型裁判**：Langfuse 托管 judge 需要平台侧读分/评估器能力，本机 build 受限；
  裁判先在项目端实现（review `reviewerType=model`），产出仍走 rescore/push 通道。
- **Code Evaluator 沙箱**（云上：stdlib/2s/无网络/5.5MB）：适合轻量确定性检查，可消费
  `ctx.experiment`（item 的 expectedOutput/metadata）；当前 expectedOutput=null，
  若未来把"允许结论"等公开标签放 item，需先过一次泄漏评审再改。
- **切换到官方 `dataset.run` 驱动的触发条件**（满足其一再议）：平台升级到分数可读的
  版本；或需要 UI/webhook 触发实验、多团队共享案例集成为硬需求。届时本地
  runner/scorer/review 代码全部复用，只换循环与案例来源。
