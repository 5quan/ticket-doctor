# 自改进冻结基线 v2（GEPA 之前）

> 对应方案 `docs/self-improvement-implementation-plan.md` §8 第 3 步、§11 冻结与比较。
> 状态：**已冻结**。v1（仅 3 例）因案例集扩充而作废，不混比。

## 1. 冻结坐标

| 项 | 值 |
|---|---|
| 运行时间 | 2026-10-11 |
| 代码基线 | `b06ec01` + 案例扩充（rubric 见指纹） |
| 模型 / 引擎 | provider=deepseek，model=deepseek-flash；engine=pi（真实模型）；审计关闭 |
| 提示词 | 基线模式：不加外部规则，直接用生产内置提示词；`compiledPromptHash=33c2e56febdc…` |
| 评分器 | `src/evolve/grade.ts` sha256 `f598628adc6c…`（确定性；无模型裁判） |
| rubric 源 | `src/evolve/materials/rubrics.ts` sha256 `14308efd39fa…` |
| 数据集 | Langfuse `ticket-doctor-rsi-bootstrap-v1`（7 条）；本地指纹见 `data/evolve/rsi-bootstrap/cases-manifest.json` |
| 训练 | `rcb-001`、`rcb-002`、`rcb-003`、`rcb-004` |
| 验证 | `rcb-005`、`rcb-006`、`rcb-007` |
| 保留（holdout） | `rcb-008`、`rcb-009`——**未准入、不参与搜索**，留最终验收 |
| 重复 | 每例 ×3（21 trial） |

## 2. 结果（每例 repeat=3）

| 案例 | split | 逐次分数 | 均值 | 关键缺口 |
|---|---|---|---|---|
| rcb-001 | train | 1 / 1 / 1 | **1.00** | — |
| rcb-002 | train | 1 / 1 / 1 | **1.00** | — |
| rcb-003 | train | 0.85 / 0.85 / 0.85 | **0.85** | `req-upstream-timeout`（cartservice 上游超时）四层全未满足——未取该证据 |
| rcb-004 | train | 1 / 1 / 1 | **1.00** | — |
| rcb-005 | validation | 1 / 1 / 1 | **1.00** | — |
| rcb-006 | validation | 0 / 1 / 1 | **0.67** | 一次把 productcatalogservice 的**正常 ~400ms**当 `supported` 根因（真阳性禁用断言） |
| rcb-007 | validation | 1 / 1 / 1 | **1.00** | — |

成本：本轮 21 trial，**1,180,879 token**，墙钟约 641s。累计全部运行 **2,099,693 token / 1 亿**。

## 3. 结论：出现了可优化的区分度

- `rcb-003` 稳定 0.85：缺上游受害证据 → 有稳定提升空间。
- `rcb-006` 0.67：一次把下游正常延迟误判为根因（正确答案是客户端 deadline 收紧）→ 有可修正的判断错误。
- 其余 5 例满分：在扩充集上仍无空间，属正常。

这满足进入 GEPA 的前提：**基线不再全线饱和，存在可被候选规则改善的、可复现的缺口。**

## 4. 诚实边界

- 案例为公开模拟／重建材料，应用内 commit 为虚构替身；不能据此声称真实生产根因能力。
- 评分只覆盖可机器判的确定性子集（概念组 + 否定窗口 + 同窗口共现 + `onlyWhenStatus`）；语义裁判未接。
- `rcb-003` 的 `req-upstream-timeout` 是否必须，属 rubric 设计取舍；当前作为软扣分保留，等更多真实案例校准。
- 公开数据可能已进入底座模型训练语料（污染风险）。

## 5. 复现

```bash
node --experimental-strip-types scripts/evolve-materials.ts convert --all
node --experimental-strip-types scripts/evolve-materials.ts build
# 训练
echo '{"runId":"baseline-train","candidateId":"baseline","baseline":true,"caseIds":["rcb-001","rcb-002","rcb-003","rcb-004"],"split":"train","repeat":3,"captureTraces":true,"budget":{"maxTokens":100000000}}' \
  | node --experimental-strip-types scripts/evolve-batch.ts
# 验证
echo '{"runId":"baseline-val","candidateId":"baseline","baseline":true,"caseIds":["rcb-005","rcb-006","rcb-007"],"split":"validation","repeat":3,"captureTraces":true,"budget":{"maxTokens":100000000}}' \
  | node --experimental-strip-types scripts/evolve-batch.ts
```

## 6. 下一步

1. **锁定搜索配置**（§8 第 4 步）：GEPA 参数、总预算、候选范围写成冻结配置。
2. **进 C（GEPA 搜索）**：环境补齐 Node 24.9 / Python 3.13 / GEPA 0.1.4 后启动。
3. holdout `rcb-008/009` 仅在候选固定后由独立验收流程准入。
