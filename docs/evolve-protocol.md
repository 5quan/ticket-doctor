# AI 操控的规则迭代协议（L1）

> 让 AI（agent）**操控**「改规则 → 评测 → 择优」的循环；客观评测与采纳由**程序 / 冻结基准**负责。
> 对齐 GEPA（反思轨迹、Pareto 选候选、带文字的反馈函数 μ_f）与 ACE（条目化、增量 delta、程序合并）。
> 设计背景见 `docs/eval-design.md` 第 7、12、13 节。

## 一、角色分工（不可越界）

| 角色 | 谁 | 做什么 |
|---|---|---|
| Generator | 诊断引擎（pi）+ 评测 | 跑 case，产出执行轨迹（会话日志）与失败明细 |
| Reflector / Proposer | **AI（agent）** | 读轨迹与失败明细，产出**增量 delta 规则** |
| Curator | **程序 / 人工** | 按 id 确定性合并 delta、更新计数、去重 |
| Selector | **程序 / 冻结基准** | 算分、比 best、护栏、回滚——**不得由 AI 代替** |

## 二、硬禁区（AI 绝对不能改）

- `src/evals/scorer.ts`（打分口径）
- `fixtures/evals/*/benchmark.json`（考卷 / gold）
- `src/diagnosis/**`、`src/agent/**`（被评测对象）

要做这些改动，走**单独的人工评审 PR**，不混进规则迭代循环。否则等于"自己改考卷给自己加分"。

## 三、每轮协议

1. **基线**：`npm run eval -- --scenario <s>`（真实分数加 `TD_ENGINE=pi`）。把 `{round, score, gitRev}` 追加到 `data/evals/<s>.jsonl`。
2. **归因**：读上一轮结果 + 失败 case 的**会话日志**（`data/sessions/*.jsonl`）+ report，写清"为什么失败"（漏了哪个 gold、引用了哪个干扰、是否材料不足却下结论）。
3. **产 delta**：只对 `fixtures/evals/<s>/rules.md` 输出**增量**（`add / update / remove` 条目），**不重写全文**。
4. **合并**：按条目 id 确定性合并（`Curator`，程序或人工），更新 `helpful/harmful` 计数。
5. **复评**：先在**小批**（2~3 个 case）上跑；优于父代才跑全量。
6. **择优（护栏，三条同时满足才保留）**：
   - `fitness` 上升超过容差（防采样抖动）；
   - `accuracy` 不退；
   - **原来答对的 case 仍然答对**（防拆东墙补西墙）。
   不满足则 `git checkout -- fixtures/evals/<s>/rules.md` 回滚。
7. **记录**：`{round, delta, score, accepted, rationale}` 写入 `data/evals/evolve/<s>/history.jsonl`；每轮候选快照到 `round-N.md`。
8. **停止**：连续 K 轮无提升 / 达到 `--rounds` 上限 / 预算耗尽。

## 四、Pareto 选择（照 GEPA）

选"下一步改哪个候选"时，不取平均分最高，而是：
- 记录每个候选在**每个 case** 上的分；
- 保留"在至少一个 case 上最好"的候选（Pareto 前沿），剪掉被支配的；
- 按"领跑 case 数"加权采样。

目的：跳局部最优，并容纳"修好 A 但 B 略降"的互补候选。

## 五、反馈函数 μ_f（照 GEPA）

给 AI 的输入不止分数，必须带**逐 case 的文字反馈**（从会话日志与 report 提取）：

```jsonc
{ "score": { "recall": 0.9, "precision": 0.307, "accuracy": 0.8 },
  "failures": [
    { "id": "ct-005", "labels": ["insufficient-material"],
      "expected": "现有材料无法确定根因", "actual": "疑似库存超时",
      "missedGold": [], "citedDistractors": ["E7","E9"] }
  ] }
```

## 六、规则条目格式（照 ACE）

```markdown
# 场景：<scenario>

- [R1] helpful=3 harmful=0 #timeout #trace
  该记住：跨服务调用失败的 ERROR 日志（含 traceId）→ 必查
- [R3] helpful=0 harmful=2 #partial
  不该记住：材料不足时不得给出 supported 结论，completeness 必须 partial
```

- **id** 稳定；**helpful/harmful** 计数；**标签** 便于检索分组。
- Proposer 只输出 delta，程序 Curator 合并——防 `context collapse / brevity bias`。

## 七、预算与去抖

- `--rounds` 上限、每轮 case 数上限、minibatch 先行。
- 温度 0；关键 case 多次采样取中位数，避免把噪声当提升。
- CI 里用 `fake` 引擎跑，真实模型只在本地/按需跑。

## 八、升级路径

| 级别 | 谁写规则 | 谁决定接受 | 说明 |
|---|---|---|---|
| **L1（本协议）** | AI | 程序护栏 + 人工 `--apply` | 候选先写 `data/evals/evolve/`，确认后才写回 `rules.md` |
| L2 | AI | 程序（`evolve.ts`） | 样本扩到 20+ 且稳定后再开 |
| L3 | AI 多轮 | 程序 + 独立 test 集 | 自主搜索，风险最高 |

## 九、参考

- GEPA：arXiv **2507.19457**，Genetic-Pareto，代码 `github.com/gepa-ai/gepa`。
- ACE：arXiv **2510.04618**，Generator–Reflector–Curator + 条目化 playbook。
- 详见 `docs/eval-design.md` 第 13 节。
