# 评测与记忆规则迭代（RSI）设计方案

> 针对「Bug 预诊断」场景的评测闭环设计。目标：用证据召回率 + 决策正确率两个指标，
> 冻结记忆引擎与诊断主链路，只迭代「该场景下什么该记 / 什么不该记」的规则文件。
> 对应 backlog Q6、路线图阶段二第一项。

## 实施状态

- **M1 已完成**：离线 harness（`npm run eval`）+ `fixtures/evals/checkout-timeout`（5 case + fixture 日志/仓库 + `rules.md`）+ 打分器（召回率 / 引用精确率 / 决策正确率）+ 结果 JSONL。
- **真实模型基线**（`TD_ENGINE=pi`，5 case）：证据召回率 **90%** / 引用精确率 **30.7%** / 决策正确率 **80%**。
- **待迭代**：`rules.md` 修掉「材料不足仍给 supported 结论」（ct-005）与「引用干扰证据」（ct-003 精确率低）。
- **设计已对齐文献**（见第 13 节）：规则将改为**条目化 + 增量 delta + 程序合并**（ACE）；候选选择用 **Pareto + 带文字的反馈函数 μ_f**（GEPA）。M1 的 `rules.md` 仍是自由文本，M2 换成条目格式。
- M2/M3 见第 10 节里程碑。

## 0. 定位与边界

- **是什么**：离线评测 harness（第四个入口，与 `gateway / worker / demo` 并列）。同一仓库，不新建 repo，不做 pi 插件。
- **测什么**：真实引擎 `pi` 在「输入 → 取证 → 报告」全链路上的行为，不含飞书 / 调度 / 投递。
- **不动什么**：记忆引擎、`query_logs/search_code/read_code` 工具语义、版本钉死、证据签发与校验——这些是"被评测对象"，必须与生产一致。
- **只动什么**：场景级「记忆规则」文件 + benchmark 样本。

## 1. 目标与非目标

**目标**
1. 把诊断效果量化成两个可追踪的数字：**证据召回率**、**决策正确率**。
2. 让每次规则 / 提示词改动都有回归证据，可保留、可回滚。
3. 为后续「独立审计 Agent 是否真的提升正确率」提供度量基准。

**非目标（第一版 / M1）**
- 不做规则自动生成与自动筛选（M3 再做，见第 12 节）；M1 只做 L0 人肉迭代。
- 不做跨场景迁移的自动验证（先单场景跑通）。
- 不用评测替换线上观测，只是离线回归。

## 2. 概念映射到 Bug 排查

| 通用概念 | 本场景含义 |
|---|---|
| 样本（case） | 一条飞书 Bug 消息 + 服务名 + 发生时间 |
| 标准答案 gold.answer | 该 Bug 的**根因假设**（如"库存服务调用超时导致下单失败"） |
| Gold 支撑证据 | 能直接支撑根因的日志行 / 代码行（源级定位） |
| 干扰证据 | 表面相关、实际无关的日志 / 代码（诱导错误归因） |
| 标签 labels | 故障类型、是否跨服务、是否单仓、是否 log+code 等 |
| 记忆规则 | 该场景「什么该记 / 什么不该记 / 检索顺序」的声明式文本 |

## 3. Benchmark 格式

每场景一个目录，含 `benchmark.json` + `rules.md` + fixture 日志与仓库：

```text
fixtures/evals/<scenario>/
├─ benchmark.json      # 样本定义
├─ rules.md            # 场景记忆规则（版本化，迭代对象）
├─ logs/<service>.log  # 含 gold + 干扰 + 噪音日志行
└─ repo/               # fixture git 仓库（含 gold 代码 + 干扰代码 + 历史）
```

`benchmark.json` 结构：

```jsonc
{
  "scenario": "checkout-timeout",
  "engine": "pi",
  "cases": [
    {
      "id": "ct-001",
      "question": "下单接口报 500，checkout-service 服务，10:01 开始大量失败",
      "occurredAt": "2026-09-06T10:01:00+08:00",
      "service": "checkout-service",
      "repo": "app",
      "gold": {
        "answer": "库存服务 InventoryClient 调用超时，导致下单失败",
        "evidence": [
          { "kind": "log", "level": "ERROR", "substring": "InventoryClient 调用库存服务失败 timeout" },
          { "kind": "code", "repoId": "app", "path": "src/main/java/com/example/order/OrderService.java", "lineStart": 15, "lineEnd": 17 }
        ]
      },
      "distractors": [
        { "kind": "log", "level": "WARN", "substring": "RedisPool 连接池使用率 92%" },
        { "kind": "code", "repoId": "app", "path": "src/main/java/com/example/order/RedisConfig.java", "lineStart": 1, "lineEnd": 10 }
      ],
      "labels": ["timeout", "cross-service", "log+code"]
    }
  ]
}
```

要点：
- **证据用"源级定位"表达，不用 `E#`**（`E#` 是 run 局部、每轮从 E1 重开，跨 case 无意义）。
- 日志定位 = `level + substring`（当前日志证据没有独立 traceId 字段，traceId 在 message 里，用唯一子串定位）。
- 代码定位 = `repoId + path + lineStart/lineEnd`（与证据 `codeRef` 区间**重叠**即命中）。
- `distractors` 必须"表面相关、实际无关"，且与 gold 在同一时间窗/仓库里，模型才可能被诱导。

## 4. 评测流水线

```text
npm run eval -- --scenario checkout-timeout
  │
  ├─ 读 benchmark.json + rules.md
  ├─ 逐 case：
  │    buildScope（occurredAt → 时间窗；repo 按时间钉 SHA，与生产一致）
  │    logSource  = FileLogSource(fixtures/evals/<scenario>/logs)      # 复用现实现
  │    codeSource = buildCodeSource([repoRef], { app: .../repo })       # 复用现实现
  │    registry   = EvidenceRegistry + DiagnosisToolbox                # 复用现实现
  │    engine     = PiDiagnosisEngine({ systemPrompt: SYSTEM_PROMPT + rules.md })
  │    result     = engine.run(input, toolbox, signal)
  │    report     = validateDraft(result.draft, …)                     # 复用现实现
  │    score      = scoreCase(case, registry.all(), report)
  │
  └─ 汇总 → results/<scenario>.jsonl（追加一轮）+ 控制台输出 + 退出码（供 CI）
```

**关键复用**：日志源、代码源、工具箱、证据登记、报告校验全部走生产同款代码；唯一拼装点是把 `rules.md` 注入系统提示词。引擎核心零改动，只需把 `SYSTEM_PROMPT` 抽成 `buildSystemPrompt(rules)` 供评测组合（生产默认规则为空）。

## 5. 打分器

记 `G`=gold 证据，`D`=干扰证据，`R`=本次运行 `registry.all()` 产出的证据，`C`=报告 hypotheses 引用的 evidenceIds 对应证据。

| 指标 | 公式 | 回答的问题 |
|---|---|---|
| 证据召回率 | `|{g∈G : 匹配(g,R)}| / |G|` | 该找的证据找到没 |
| 引用精确率 | `|{c∈C : c 命中某 g}| / |C|` | 引用的是不是 gold（而非干扰/无关） |
| 干扰抗性（v2） | `1 - |{d∈D : 匹配(d,C)}| / |D|` | 有没有被干扰证据带偏 |
| 决策正确率 | 每 case 0/1，见下 | 最终根因假设对不对 |

**证据匹配规则**
- log：`record.level === locator.level && record.excerpt.includes(locator.substring)`。
- code：`record.codeRef.repoId === locator.repoId && record.codeRef.path === locator.path && locator.line ∈ [startLine, endLine]`。

**正确率判定（v1 规则化，v2 升级 judge）**
取报告 top 假设（confidence 最高者，并列取第一条）：
- **诊断类**：`status = supported` 且其 `evidenceIds` 至少命中 1 条 gold 证据 → 算对（"结论必须建立在正确证据上"）。
- **材料不足类**（`expect: insufficient`）：`completeness = partial` 且没有任何 `supported` 结论 → 算对（不得臆断）。
- v2 再叠加语义匹配 / judge 模型（判定 `cause` 是否等价于 `gold.answer`）。

**召回取"检索到"，精确取"被引用"**：召回率用 `registry.all()`（本次真正取到的证据，无论是否被引用）；精确率用报告实际引用的证据。

每 case 输出：`{ id, recall, precision, correct, matchedGold, missedGold, citedDistractor }`。

## 6. fixture 注入（不动生产代码）

- **日志**：`FileLogSource` 读 `dir/<service>.log`（tab 分隔 `ISO时间\tLEVEL\tmessage`，时间窗内，关键词过滤）。fixture 日志文件按此格式埋入 gold 行、干扰行、噪音行。
- **代码**：`GitCodeSource` 按 `occurredAt` 用 `git rev-list -1 --before` 钉 SHA。fixture 仓库必须有历史，使"发生时间对应的提交"里恰好包含 gold 代码行（buggy 版本）与干扰代码。
- 两者都是现成实现，eval 只换 `dir` / `repoDir` 指向，零侵入。

## 7. 记忆规则（唯一的迭代对象）

### 7.1 形态：条目化的 bullets（照 ACE）

`rules.md` **不是整段自由文本**，而是一条条 bullet，每条 = 元数据 + 内容：

```markdown
# 场景：checkout-timeout

- [R1] helpful=3 harmful=0 #timeout #trace
  该记住：跨服务调用失败的 ERROR 日志（含 traceId）→ 必查
- [R2] helpful=2 harmful=1 #redis #distractor
  不该记住：RedisPool 连接池使用率类指标（除非伴随超时/等待队列）
- [R3] helpful=0 harmful=2 #partial
  不该记住：材料不足时不得给出 supported 结论，completeness 必须 partial
```

- **id**：稳定标识，供增量增删改与计数。
- **helpful / harmful 计数**：Generator 标注哪些条目有用/误导，供 Curator 剪枝。
- **标签**：便于按故障类型检索分组（对应 ACE 的 fine-grained retrieval）。

### 7.2 更新方式：增量 delta，不整篇重写（照 ACE，防 context collapse）

- Proposer（Reflector）**只输出增量 delta**（add / update / remove 哪些条目），**禁止重写全文**。
- **只让 LLM 产 delta，合并由程序做**（确定性、非 LLM）：按 id 追加/原地更新、累加计数、去重、超限剪枝。
- 理由：ACE 实证——让 LLM「整篇重写上下文」会 **context collapse / brevity bias**，越写越短、丢细节；条目化 + 增量更新能保住知识、可并行、省算力。

```jsonc
// Proposer 输出（delta，不是全文）
{ "add":    [ { "id": "R3", "tags": ["partial"], "text": "材料不足时不得给 supported 结论" } ],
  "update": [ { "id": "R1", "helpfulDelta": 1 } ],
  "remove": [ "R2" ],
  "rationale": "ct-005 无证据仍下结论；ct-003 被 Redis 告警带偏" }
```

### 7.3 注入与版本

- 注入点：`SYSTEM_PROMPT + 渲染后的 bullets`（引擎 `systemPrompt` 选项已存在，只做 prompt 组装）。
- 规则是**场景作用域**、**版本化**（git）、**可回滚**；引擎与打分器跨场景复用。
- 迁移说明：M1 的 `rules.md` 是自由文本，M2 改成上述条目格式（打分与组合逻辑不变）。

## 8. 迭代循环与回滚

```text
改 rules.md → npm run eval → results/<scenario>.jsonl 追加 { ts, gitRev, recall, precision, correct, perCase }
→ 看指标 diff → 提升则保留 / 下降则 git revert rules.md
```

- 分数历史是 JSONL，天然可画曲线、可对比两轮。
- **v1 是"人工改规则 + 评测门控"**，不做规则自动生成；退化即回滚。

## 9. 触发方式

- 手动：`npm run eval -- --scenario checkout-timeout`
- CI 回归：PR 跑 `npm run eval -- --scenario smoke`，召回率 / 正确率低于阈值即 fail（卡门槛）。

## 10. 里程碑

- **M1 最小闭环**：5 个 case，只算召回率 + 正确率，1 个 `rules.md`，CLI 跑通并输出 JSONL。
- **M2 扩充**：`rules.md` 改**条目化 + 增量 delta + 程序合并**（ACE）；候选选择用 **Pareto + μ_f**（GEPA）；加干扰抗性指标、20~30 case、judge 版正确率、独立 dev/test 集、CI 门禁。
- **M3 探索**：L1 自动迭代（Reflector 产 delta、程序 Curator 合并、人批准）、场景迁移验证。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 指标自欺 / 样本过拟合 | 固定独立 test 集，调规则只在 dev 集；最终报 test 集，如实标注样本量与判定方式 |
| 正确率不是 0/1 | v1 结构化匹配（cause 关键实体 + 引用 gold 证据）；v2 上 judge |
| 日志 substring 定位脆弱 | 用 traceId / 唯一短语做主定位键，避免通用词 |
| 版本钉死在 fixture 里错位 | fixture 仓库带历史，gold 行存在于"发生时间对应提交" |
| 模型采样抖动 → 假回归 | 关键 case 温度 0 / 多次采样取中位数 |
| 成本 / 时长 | 小样本起步，CI 只跑 smoke 集 |
| 评测工程化过重 | 先 M1 最小闭环，跑通再扩 |

## 12. 自动迭代（RSI 落地）

第 8 节是「人肉迭代」。**自动迭代 = 把「改规则」从人换成 LLM（Reflector/Proposer），由程序按分数决定收不收。** 生产系统仍不会运行时自我修改——这是离线批处理。设计对齐 GEPA / ACE（见第 13 节）。

### 12.1 角色分工（关键：AI 提案，程序/基准裁判）

| 角色 | 谁 | 做什么 |
|---|---|---|
| Generator | 诊断引擎(pi) + 评测 | 跑 case，产出**执行轨迹**（会话日志）与**评估轨迹**（失败明细） |
| Reflector / Proposer | LLM | 读轨迹与失败明细，产出**增量 delta 规则**（不是全文） |
| Curator | **程序** | 按 id 确定性合并 delta、更新计数、去重剪枝 |
| Selector | **程序** | 按客观分数 + 护栏决定采纳/回滚 |

**硬禁区**：Proposer 不得自评自过；其「改」只允许落在规则文件（`benchmark.json` / `scorer.ts` 是禁区，防刷分）。

### 12.2 反馈函数 μ_f（照 GEPA：不只给分数，要给文字）

每轮给 Reflector 的不只是 `{recall, precision, accuracy}`，还要**逐 case 的文字反馈**：

```jsonc
{ "score": { "recall": 0.9, "precision": 0.307, "accuracy": 0.8 },
  "failures": [
    { "id": "ct-005", "labels": ["insufficient-material"],
      "expected": "现有材料无法确定根因", "actual": "疑似库存超时",
      "missedGold": [], "citedDistractors": ["E7","E9"] },
    { "id": "ct-003", "labels": ["distractor"],
      "expected": "根因不是 Redis…", "actual": "Redis 连接池打满",
      "missedGold": [], "citedDistractors": ["E3","E5","E6"] }
  ] }
```

其中 `actual / citedDistractors / missedGold` 都从**会话日志与 report** 里取（即 GEPA 的 `feedback_text`）。

### 12.3 候选选择：Pareto，而非单一总分（照 GEPA）

不用「平均分最高」选下一步改谁——会困在局部最优。改为：
- 记录每个候选在**每个 case**上的分；
- 保留「在至少一个 case 上最好」的候选（Pareto 前沿），剪掉被支配的；
- 按「领跑 case 数」加权采样下一步要改的候选。

既保多样性，又能容纳「修好 ct-005 但 ct-003 略降」这类互补候选。

### 12.4 成本控制：minibatch 先试、全量再评（照 GEPA）

候选先在一小撮 case（2~3 个）上跑；**只有优于父代**才跑全量 benchmark。省真实模型调用。

### 12.5 循环

```text
best = eval(rules_0)                        # 全量
for round in 1..N:
  parent = ParetoSelect(pool)               # 12.3
  traces = 最近一轮的会话日志 + 失败明细        # 12.2 μ_f
  delta  = Reflector(parent.rules, traces)  # LLM 只产增量
  cand   = Curator(parent.rules, delta)     # 程序确定性合并
  mini   = eval(cand.rules, minibatch)      # 12.4
  if mini <= parent.mini: continue
  full   = eval(cand.rules)                 # 全量
  if accept(full, best): best = cand; pool.add(cand)
  history.append({round, delta, full, accepted})
  if 连续 K 轮无提升: break
# 需 --apply 才写回 rules.md（L1 人工闸门），否则只写 data/evals/evolve/
```

### 12.6 接受条件（程序判，护栏）

```ts
accept(cand, best) =
  fitness(cand) > fitness(best) + minDelta     // 涨了（带容差防抖）
  && cand.accuracy >= best.accuracy            // 正确率不退
  && noRegression(best, cand)                  // 不牺牲"原来对的 case"
```

`fitness` 自定义（如 `0.5*accuracy + 0.3*recall + 0.2*precision`）。

### 12.7 自动化程度分级

| 级别 | 谁写规则 | 谁决定接受 | 风险 |
|---|---|---|---|
| L0 人肉 | 人 | 人 | 无（M1） |
| **L1 建议** | LLM | **人批准（--apply）** | 低（推荐先到这） |
| L2 自动接受 | LLM | 程序 | 中 |
| L3 自主搜索 | LLM 多轮 | 程序 + 护栏 | 高 |

### 12.8 AI 操控 vs 写成程序

- **操控搜索**（读轨迹、想假设、产 delta、跑评测）→ 适合 AI/agent，灵活、能用会话日志。
- **判定与采纳**（算分、比 best、回滚、护栏）→ 必须程序/冻结基准，否则自评自过。
- 落地：**一份协议**（`docs/evolve-protocol.md`）+ 现有命令（`npm run eval`、`edit rules`、`read 会话日志`）；等规则稳定再固化成 `evolve.ts` 跑 CI。

### 12.9 风险

- 样本太小 → 假提升：候选**重复采样取中位数**，样本扩到 20+ 再自动化。
- 过拟合 benchmark：Proposer **禁写 case id** + 独立 test 集。
- Proposer 质量：输出**增量 delta** + diff 人工过目（L1）。
- 成本：minibatch + 轮数上限 + CI 用 fake。

## 13. 参考与借鉴（GEPA / ACE）

两篇 2025 年「冻结权重、只改文本」的工作，本设计直接对齐它们（已读原文）：

- **GEPA**：arXiv **2507.19457**，《GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning》（Genetic-Pareto），代码 `github.com/gepa-ai/gepa`。
  - 借鉴：① 对**执行轨迹 + 评估轨迹**做自然语言反思来改提示；② **Pareto 候选选择**（每任务最优、剪支配、按领跑数采样）防局部最优；③ **minibatch 先试、全量再评**省成本；④ 反馈函数 `μ_f` 返回**分数 + 文字**。
  - 结论：比 GRPO 平均高 6%、最高 +20%，rollout 少至 1/35；比 MIPROv2 高 >10%，提示短至 1/9.2。
- **ACE**：arXiv **2510.04618**，《Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models》。
  - 借鉴：① 把上下文当**条目化 playbook**（bullet = id + helpful/harmful 计数 + 内容）；② **增量 delta 更新 + 非 LLM 确定性合并**，防 **context collapse / brevity bias**；③ **grow-and-refine**（追加 + 原地更新 + 去重剪枝）；④ 可不依赖标注、只用执行反馈。
  - 结论：agent +10.6%、金融 +8.6%；AppWorld 上用小模型追平榜首生产级 agent。
- **共同底线**：**权重冻结、只改文本、外部指标当裁判、LLM 不自评自过**——与我们 OQ-30「审计 Agent 剥离自查自证」一致。

**我们已对齐 / 待对齐**：
- 已对齐：冻结引擎、只改规则、外部评测裁判、先落盘（轨迹=学习信号）。
- 待对齐（M2）：`rules.md` 条目化 + 增量 delta + 程序合并（ACE）；候选选择用 Pareto + μ_f（GEPA）。

## 14. 一句话总结

> 冻结引擎与主链路，用带 gold / 干扰证据标注的 benchmark 打「证据召回率 + 决策正确率」；
> 规则条目化、只增量更新、由程序合并；自动迭代时 LLM 提案、Pareto 选候选、程序按分采纳；
> 评测门控、历史可查、退化回滚。
