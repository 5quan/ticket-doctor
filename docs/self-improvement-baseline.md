# 自改进冻结基线 v1（GEPA 之前）

> 对应方案 `docs/self-improvement-implementation-plan.md` §8 第 3 步、§11 冻结与比较。
> 状态：**已冻结**。本基线用于验证评测链路与发现明显退化；**不用于声称质量提升**。

## 1. 冻结坐标

| 项 | 值 |
|---|---|
| 运行时间 | 2026-10-11 |
| 代码基线 | `fcf8b0c` + 本 PR 的评分器修复（`onlyWhenStatus`）；评分器文件指纹见下 |
| 模型 / 引擎 | provider=deepseek，model=deepseek-flash；engine=pi（真实模型） |
| 审计 | 关闭（默认） |
| 提示词 | 基线模式：不加外部规则，直接用生产内置提示词；`compiledPromptHash=33c2e56febdc…` |
| 评分器 | `src/evolve/grade.ts` sha256 `f598628adc6c…`（确定性：事实/证据/引用/边界；无模型裁判） |
| rubric 源 | `src/evolve/materials/rubrics.ts` sha256 `cfc289a1656e…` |
| 数据集 | Langfuse `ticket-doctor-rsi-bootstrap-v1`（3 条）；本地指纹见 `data/evolve/rsi-bootstrap/cases-manifest.json` |
| 案例 | 训练 `rcb-001`、`rcb-004`；验证 `rcb-007`；全部 `admitted` |
| 重复 | 每例 ×3 |

## 2. 结果（每例 repeat=3）

| 案例 | split | 逐次分数 | 均值 | 事实 | 证据 B∧C1∧D | 引用有效 | 硬失败 |
|---|---|---|---|---|---|---|---|
| rcb-001 | train | 1 / 1 / 1 | **1.0** | 1/1 | 1/1 | 14/10/11 全有效 | 0 |
| rcb-004 | train | 1 / 1 / 1 | **1.0** | 2/2 | 2/2 | 16/24/17 全有效 | 0 |
| rcb-007 | validation | 1 / 1 / 1 | **1.0** | 1/1 | 1/1 | 7/11/15 全有效 | 0 |

成本：本轮 9 trial，**409,757 token**，墙钟约 239s（预算 100,000,000）。

## 3. 关键结论：基线已在**天花板**

三例全部 1.0、零硬失败——说明当前生产提示词在这 3 条公开模拟案例上**没有问题可改**。

- 因此这份基线是**链路冻结 + 退化哨兵**，不是可区分优劣的基线；**GEPA 在它上面没有提升空间**。
- 按方案 §4.1：初始 9 家族各一例「仅够验证流程及发现明显退化；不能据此声称统计稳定的泛化提升」。首批 3 例更小。
- 进入 GEPA 搜索前，应先**扩充/加深案例**（其余 `rcb-002/003/005/006` 与 §4.4 的 FastAPI 历史故障），否则优化无信号。

## 4. 诚实边界

- 案例为公开模拟／重建材料，应用内 commit 为虚构替身；不能据此声称真实生产根因能力。
- 评分只覆盖可机器判的确定性子集（概念组 + 否定窗口 + 同窗口共现 + `onlyWhenStatus`）；语义裁判未接。
- 公开数据可能已进入底座模型训练语料，存在污染风险。
- 另有一次旧口径运行（`baseline-*-r1`）在 `rcb-004` 上因评分器误伤判了 0：模型把 `gateway_strict_audience_check` 写成 `candidate` 假设并明确"是否为根因尚不能确定"，旧评分器忽略假设状态当成肯定断言。已修复（禁用断言仅对 `supported` 假设判定），旧结果作废、不混比。

## 5. 复现

```bash
# 训练
echo '{"runId":"baseline-train","candidateId":"baseline","baseline":true,"caseIds":["rcb-001","rcb-004"],"split":"train","repeat":3,"captureTraces":true,"budget":{"maxTokens":100000000}}' \
  | node --experimental-strip-types scripts/evolve-batch.ts
# 验证
echo '{"runId":"baseline-val","candidateId":"baseline","baseline":true,"caseIds":["rcb-007"],"split":"validation","repeat":3,"captureTraces":true,"budget":{"maxTokens":100000000}}' \
  | node --experimental-strip-types scripts/evolve-batch.ts
```

## 6. 下一步

1. **锁定搜索配置**（§8 第 4 步）：GEPA 参数、总预算、候选范围写成冻结配置。
2. **扩充案例**：其余 6 例与 FastAPI 历史故障，做出有区分度的基线。
3. 之后再进 C（GEPA 搜索）。
