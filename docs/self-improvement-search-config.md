# 自改进冻结搜索配置（GEPA 启动前）

> 对应方案 `docs/self-improvement-implementation-plan.md` §8 第 4 步「锁定可变规则及搜索配置」。
> 配置入库：`evolve/config/search-v1.json`。这是「开始使用 GEPA」前的最后一块。

## 1. 配置内容

| 字段 | 值 | 含义 |
|---|---|---|
| `datasetName` | `ticket-doctor-rsi-bootstrap-v1` | Langfuse 数据集（7 条，train×4/validation×3） |
| `splits.train` | `rcb-001~004` | 只给优化器训练材料与反馈 |
| `splits.validation` | `rcb-005~007` | 搜索择优用 |
| `splits.holdout` | `rcb-008/009` | **保留，不参与搜索**，候选固定后独立验收 |
| `repeat` | 3 | 每例 trial 次数（取均值，原始 trial 全保留） |
| `model` | deepseek / deepseek-flash | 与冻结基线一致 |
| `candidate.component` | `diagnosis_rules` | 唯一可变组件；基础 prompt/工具/案例/评分器不动 |
| `candidate.maxChars` | 20000 | 上限（与编译器一致）；范围校验拒绝 case/trace/commit ID、私有路径、答案文件、覆盖系统提示词 |
| `budget` | maxTokens 50,000,000；maxTrials 200；maxWallMs 3,600,000 | 搜索总预算（含所有诊断/审计/反思/裁判调用） |
| `gepa` | 候选≤12、metricCalls≤200、并发 2、连续无改善≤4、时限 60min | GEPA 搜索参数（§8 初始建议） |
| `selection` | 禁止新增硬失败、禁止基线通过用例退化、minMeanGain=0.02、holdoutReserved | 接受/拒绝规则 |

坐标指纹：`basePromptHash`、`scorerHash`、`rubricsSourceHash` 均写入配置。

## 2. 校验（fail-closed）

```bash
npm run evolve:config:show      # 打印冻结配置
npm run evolve:config:verify    # 与当前状态比对
```

`verify` 检查并阻断：

- 配置里的 train/validation 案例必须都已准入；已准入案例不得漏出配置；
- holdout 案例**不得**被准入或混入 train/validation；
- 案例不得跨 split 重复；
- `basePromptHash` / `scorerHash` / `rubricsSourceHash` 与当前仓库一致（**任一改动即使配置过期，必须重新冻结**）；
- 候选组件、`maxChars`、预算与 GEPA 数值合法。

## 3. 重新冻结的条件

以下任一变化都要更新配置并重跑基线：基础提示词、评分器（`src/evolve/grade.ts`）、rubric 源（`src/evolve/materials/rubrics.ts`）、准入清单、模型。

## 4. 与基线的衔接

冻结基线见 [基线](self-improvement-baseline.md)：`rcb-003` 稳定 0.85、`rcb-006` 0.67，存在可复现缺口——搜索有明确目标。GEPA 适配器（交付 C）将按本配置以子进程 + stdin 调用 `scripts/evolve-batch.ts`，不拼 shell。
