# 评测与记忆规则迭代（RSI）设计方案

> 针对「Bug 预诊断」场景的评测闭环设计。目标：用证据召回率 + 决策正确率两个指标，
> 冻结记忆引擎与诊断主链路，只迭代「该场景下什么该记 / 什么不该记」的规则文件。
> 对应 backlog Q6、路线图阶段二第一项。

## 实施状态

- **M1 已完成**：离线 harness（`npm run eval`）+ `fixtures/evals/checkout-timeout`（5 case + fixture 日志/仓库 + `rules.md`）+ 打分器（召回率 / 引用精确率 / 决策正确率）+ 结果 JSONL。
- **真实模型基线**（`TD_ENGINE=pi`，5 case）：证据召回率 **90%** / 引用精确率 **30.7%** / 决策正确率 **80%**。
- **待迭代**：`rules.md` 修掉「材料不足仍给 supported 结论」（ct-005）与「引用干扰证据」（ct-003 精确率低）。
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

**非目标（第一版）**
- 不做规则自动生成、候选规则自动筛选（截图也未展开）。
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
          { "kind": "code", "repoId": "app", "path": "src/main/java/com/example/order/OrderService.java", "line": 88 }
        ]
      },
      "distractors": [
        { "kind": "log", "level": "WARN", "substring": "RedisPool 连接池使用率 92%" },
        { "kind": "code", "repoId": "app", "path": "src/main/java/com/example/payment/Unrelated.java", "line": 3 }
      ],
      "labels": ["timeout", "cross-service", "log+code"]
    }
  ]
}
```

要点：
- **证据用"源级定位"表达，不用 `E#`**（`E#` 是 run 局部、每轮从 E1 重开，跨 case 无意义）。
- 日志定位 = `level + substring`（当前日志证据没有独立 traceId 字段，traceId 在 message 里，用唯一子串定位）。
- 代码定位 = `repoId + path + line`（映射到证据 `codeRef` 的 `startLine~endLine` 区间）。
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
取报告 top 假设（confidence 最高者，并列取第一条），判定为"正确"需同时满足：
1. 该假设 `evidenceIds` 至少命中 1 条 gold 证据（回答必须建立在正确证据上，而不是干扰/编造）；
2. 假设 `cause` 与 `gold.answer` 的规范化文本共享关键实体（服务名 + 故障词，如 `InventoryClient`/`timeout`/`库存`）。

每 case 输出：`{ id, recall, precision, correct, missedGold:[...], citedDistractor:[...] }`。

## 6. fixture 注入（不动生产代码）

- **日志**：`FileLogSource` 读 `dir/<service>.log`（tab 分隔 `ISO时间\tLEVEL\tmessage`，时间窗内，关键词过滤）。fixture 日志文件按此格式埋入 gold 行、干扰行、噪音行。
- **代码**：`GitCodeSource` 按 `occurredAt` 用 `git rev-list -1 --before` 钉 SHA。fixture 仓库必须有历史，使"发生时间对应的提交"里恰好包含 gold 代码行（buggy 版本）与干扰代码。
- 两者都是现成实现，eval 只换 `dir` / `repoDir` 指向，零侵入。

## 7. 记忆规则（唯一的迭代对象）

`rules.md` 是声明式文本，只回答三个问题：

```markdown
# 场景：checkout-timeout
## 该记住
- 跨服务调用失败的 ERROR 日志（含 traceId）→ 必查
- 相同 traceId 的日志链 → 归并为同一故障
## 不该记住
- 与发生时间无关的 INFO 成功日志
- RedisPool 连接池使用率类指标（除非伴随超时/等待队列）
## 检索顺序
- 先按 service+时间窗查 ERROR → 按 traceId 下钻 → 读源码定位调用点
```

- 注入点：`SYSTEM_PROMPT + rules.md`（引擎 `systemPrompt` 选项已存在，只做 prompt 组装）。
- 规则是**场景作用域**、**版本化**（git 跟踪）、**可回滚**的文本；引擎与打分器跨场景复用。

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
- **M2 扩充**：加引用精确率 / 干扰抗性，20~30 case，judge 版正确率，CI 门禁，独立 dev/test 集。
- **M3 探索**：规则候选自动生成（LLM 提议、人工批准）、场景迁移验证。

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

## 12. 自行迭代（可选进阶）

第 8 节是「人肉迭代」（人改 `rules.md`）。**自行迭代 = 把「改 rules.md」这一步从人换成 LLM 自动写**，其余（引擎/工具/benchmark/打分）完全不变。生产系统仍不会运行时自我修改——自迭代也是离线批处理，产出的还是一个 `rules.md`。

**执行流程（生成—验证搜索，eval 即适应度函数）**

```text
基线 = eval(rules.md)
循环 N 轮：
  1. Proposer(LLM)：输入 = 当前 rules.md + 失败明细（漏了哪些 gold / 被哪些干扰带偏 / 哪些结论错）
                    输出 = 候选 rules'.md（diff）
  2. score' = eval(rules')          # 真实模型重跑，算召回率/正确率
  3. Selector(程序)：score' > best ? 接受并记历史 : 丢弃
最终：一个 rules.md + 每轮 diff + 分数曲线
```

**自动化程度分级（建议分阶段）**

| 级别 | 谁写规则 | 谁决定接受 | 风险 |
|---|---|---|---|
| L0 人肉 | 人 | 人看分数 | 无（M1 先到这） |
| L1 建议 | LLM | 人批准 | 低（推荐第二个做） |
| L2 自动接受 | LLM | 程序（涨了就收） | 中 |
| L3 自主搜索 | LLM 多轮 | 程序 + 护栏 | 高 |

**护栏（为什么敢自动）**
- 引擎冻结：唯一变量是 rules 文本。
- 固定 benchmark 作适应度 + 独立 test 集防过拟合。
- 只接受分数提升，退化自动回滚。
- 轮数 / 预算上限；全历史留档（每轮 diff + 分数）。
- （可选）应用到生产前设人工批准闸门。

**截图没展开、需我们补的三点**
1. 候选规则怎么生成：喂失败明细，让 Proposer 产出 diff，而非自由发挥。
2. 候选怎么筛选：逐个跑 eval 按分选，或设阈值增量接受。
3. 退化怎么处理：单调接受 + 回滚 + 保留历史最佳（hall of fame）。

**风险**：过拟合 benchmark → 独立 test 集；同模型盲区 → 换模型 / Proposer 只看失败明细；成本爆炸 → 轮数/case 数/候选数设上限。

## 13. 一句话总结

> 冻结引擎与主链路，用带 gold / 干扰证据标注的 benchmark 打「证据召回率 + 决策正确率」，
> 只迭代场景级 `rules.md`（什么该记 / 什么不该记），评测门控、历史可查、退化回滚。
