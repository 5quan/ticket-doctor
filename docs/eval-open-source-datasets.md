# 评测开源材料调研与采纳方案

> 目的：在没有人工真实工单的情况下，用**开源真实故障数据**先把评测基线从"合成工程用例"升级到"真实故障 material + 根因 gold"。
> 结论先说：**首选 RCAEval（RE2/RE3），Loghub 做日志真实性补强；AIOpsLab 暂不引入（需 K8s 活环境）。**

---

## 1. 候选对比

| 项目 | 提供什么 | 根因 gold | 对应代码 | 与我们评测的适配 |
|---|---|---|---|---|
| **RCAEval** (`phamquiluan/RCAEval`) | 9 数据集 / **735 真实故障** / 3 微服务系统（Online Boutique、Sock Shop、Train Ticket）/ 11 故障类型；每例 `metrics.json` + `logs.csv` + `traces.csv`；`cases.parquet` 索引**根因服务 + 故障类型** | ✅ | ✅ 系统均开源、可钉版本 | **高**：RE2/RE3 有日志；RE3 是**代码级故障 F1–F5**（栈/响应码线索），最贴合我们"日志+代码"定位 |
| **Loghub** (`logpai/loghub`) | 真实系统日志（HDFS/Hadoop/Spark/ZooKeeper/OpenStack/BGL/HPC/Thunderbird…），部分带异常标注 | 部分（异常标注） | ❌ | 中：做**日志真实性与噪声**材料，无代码绑定 |
| **AIOpsLab** (`microsoft/AIOpsLab`) | 部署微服务 + 注入故障 + 导出遥测 + **agent 评测编排**（内置 problem 集） | ✅ | ✅ | 低/重：是"活环境"，要 K8s/Helm 部署，作为**方法论参考** |
| **ITBench** (IBM) | IT 自动化/运维基准，场景化问题集 | ✅ | 部分 | 参考（场景口径） |
| **HolmesGPT** (`robusta-dev/holmesgpt`) | 诊断 agent + 测试数据 | 部分 | 部分 | 参考（检索层设计，见前文调研） |
| **Defects4J / BugsInPy** | 代码缺陷 + 复现测试 | ✅ | ✅ | 低：是"代码 bug 修复"，不是"日志→根因"诊断 |

来源链接：RCAEval `https://huggingface.co/datasets/phamquiluan/RCAEval`（Parquet，3.4GB，可按 suite/case 下载）；Loghub `https://github.com/logpai/loghub`。

---

## 2. 为什么选 RCAEval 作首个真实数据集

1. **有根因 gold**：`cases.parquet` 直接给 `root_cause_service` 与 `fault`，正是我们 `gold.answer`/`gold.evidence` 需要的真值。
2. **有日志**：RE2/RE3 含 `logs.csv`；RE3 的 F1–F5 是**代码级故障**，日志里有栈/错误码，能驱动"先日志后代码"的检索路径。
3. **代码可绑版本**：Online Boutique / Sock Shop / Train Ticket 都是开源应用，可对每个案例钉到具体提交（我们的 `repoId@sha`）。
4. **规模合适**：RE1 375 / RE2 270 / RE3 90 例；先取 **RE3 的一小批**（如 5–10 个）跑通，再扩。

---

## 3. 转换方案（RCAEval case → 我们的 `benchmark.json`）

一个 RCAEval 目录 `{benchmark}_{service}_{fault}_{instance}` 转成一个 scenario 或一个 case：

| 我们的字段 | 来源 | 说明 |
|---|---|---|
| `service` | `cases.parquet.root_cause_service` | 直接映射 |
| `occurredAt` | 故障注入时间段（从 metrics/logs 时间戳推导） | 决定时间窗与代码钉版本 |
| `question` | **合成**（由故障类型+现象生成），并标 `sourceTier: open_source_derived` | ⚠️ 是注入故障的题面，**不是人工工单**，不得与人工案例同表比 |
| `logs/<service>.log` | `logs.csv`（按服务拆分 + 转我们 `time\tlevel\tmessage` 行格式） | 做必要的脱敏 |
| `repoDir` + `repoRev` | 对应开源应用的提交 | 需为该应用建立 fixture 仓库（含故障版本与修复版本） |
| `gold.evidence`（log） | 从 logs.csv 里定位错误行（level+substring） | 可自动 |
| `gold.evidence`（code） | 由 `fault` 类型 + 注入点/栈线索推导 | **需人工/半自动**；缺则标 `logOnly: true`（我们已有该字段，只评日志定位） |
| `labels` | `fault`（cpu/mem/disk/delay/loss/socket/f1..f5） | 分类维度 |

**打分**：`recall` 用 log locator；代码 locator 缺失时该案例只评日志（`logOnly`），不声称验证了代码根因。

---

## 4. 采纳步骤（建议作为 M8 的真实案例来源）

1. **M8a**：新增导入脚本（拟建 `import-rcaeval.mjs`，放 scripts/ 下）——读 `cases.parquet` 索引 + 选定的 RE3 案例，产出场景目录（拟建 `rcaeval-<case>/`，放 fixtures/evals 下：`benchmark.json` + `logs/` + 可选的 `repo/`）。
2. **M8b**：先转 **5 个 RE3 案例**跑 `eval:v2 --engine pi`，人工复核语义分（把 `review.json` 标上），冻结"开源派生基线"。
3. **M8c**：需要代码级 gold 时，为对应应用建 fixture 仓库（故障/修复双提交），把 code locator 补全，升级为 `log+code` 案例。
4. **口径**：新增 `sourceTier`（`human_ticket` / `open_source_derived` / `synthetic_engineering`），**不同 tier 禁止同表比较**；manifest 记录 tier。

---

## 5. 注意与风险

- **许可/合规**：RCAEval/Loghub 面向研究；日志可能含 PII/主机名，**先脱敏再入库**（对应 backlog S1 的原则，评测案例先行）。
- **题面是合成的**：注入故障的 `question` 不能代表真实用户表达；只能评"日志定位 + 根因服务/指标 +（若有）代码定位"，不能宣称评了"工单理解"。
- **体量**：HF 3.4GB；按 suite/案例按需下载，不要整包拉。
- **时间戳/时区**：RCAEval 用注入时刻，注意与我们 `occurredAt`/时区一致（backlog E2）。
- **代码版本**：应用版本必须钉 SHA；没有对应代码时标 `logOnly`，别硬凑 code gold。

---

## 6. 实施状态（M8a，已落地）

- 新增导入器 `scripts/import-rcaeval.mjs`（`npm run import:rcaeval -- --dataset RE3-OB --limit N`）：用 `hyparquet` 读 `cases.parquet`/`logs.parquet`，下载缓存到 `data/rcaeval/`，产出 **v2 布局**（`public/<case>/{case.json,r1-message.txt,round-1/<service>.log}` + `private/<case>/truth.private.json`），并**合并**写入 `catalog/catalog.json`（不覆盖工程条目）。
- v2 schema 放宽：允许 `sourceTier=reproduced_history` 的 **log-only** 案例 `repos: []`（原先强制"至少一个仓库"）；其余拆分不变。
- **已实测**（RE3-OB，Online Boutique adservice f3）：
  - `--engine fake`：加载/执行/打分跑通（`executionSuccess 100%`）；
  - `--engine pi`（真实模型，1 次）：`recall.A/B/C1=100%`、`citationValidity 19/19`、`executionSuccess 100%`，但 **`recall.D=0%`**——**模型读到了 gold 材料（C1 命中），报告却没引用它（D 未命中）**。这正是四层可见性要暴露的"入库/可见 ≠ 报告引用"。
- **发现**：RCAEval **RE3-OB 的代码级故障（F1–F5）在根因服务自身日志里往往没有 error 行**（adservice 全为 INFO）——所以自动 gold 只能退化为"该服务出现频次最高的日志"（度量"是否读到根因服务日志"，不是故障签名）。要进一步，需要 **M8c**：为对应应用建带故障/修复双提交的 fixture 仓库，补 code gold。
- 口径：导入案例 `split=development`、`sourceTier=reproduced_history`、`admission=admitted`（材料准入）、`review.provisional=true`（**语义待人工复核**）；题面为**合成**；**不同 sourceTier / split 禁止同表比**。
- 待办：**M8b** 多导几例跑 pi + 人工复核（`rescore --review`）；**M8c** 代码级 gold。

---

## 7. 首次开源派生结果（RE3-OB，5 例，真实模型 pi，2026-10-05）

来源：RCAEval `RE3-OB`，`adservice` f3×3 + f4×2；`npm run import:rcaeval -- --dataset RE3-OB --limit 5` 导入为 log-only；
`npm run eval:v2 -- run --suite rcaeval-ob5-pi --engine pi` 各 1 次；`--gate on` 硬失败 0。

| 指标 | 结果 |
|---|---|
| recall.A / B / **C1** | 5/5 = **100%**（模型都读到了 gold 材料） |
| recall.D | 4/5 = **80%**（有 1 例“读到了但报告未引用”） |
| citationValidity | 109/109 = 100% |
| executionSuccess | 5/5 = 100% |
| unsupportedAssertionRate | 0/51 = 0% |
| hardFailures | 0 |
| claimSupport | **unscored**（语义待人工复核） |

- 口径：`scorerVersion=3.1.0`、`split=development`、`sourceTier=reproduced_history`。**这是工程/程序指标基线，不是质量结论**（语义未复核）。
- 已推 Langfuse（`npm run eval:v2 -- push --suite rcaeval-ob5-pi`）：5 条 trace + 每条 9 个分数（UI 核对）。
- gold 强弱不一：f3 是“根因服务最高频日志”（弱 locator，度量“是否读到根因服务日志”），f4 是真实 `NullPointerException`（强 locator，故障签名）。代码级 gold 仍属 **M8c**。
- 下一步：**M8b** 对这 5 例复核语义（`rescore --review`）→ 冻结首个“开源派生基线”（M9）；并扩到 3 族 6–10 轨迹。

### 7.1 语义复核（**AI 模型裁判，非人工**）

对这 5 例逐例判定并导入（`rescore --suite rcaeval-ob5-pi --case … --review review.json`）：

| case | 判定 | 理由（简） |
|---|---|---|
| f4_1 / f4_2 | `supported` | 精确定位 adservice 请求路径对 null 集合调 `Collection.toArray()` 触发 NPE，与 RCAEval f4 一致，有 SEVERE 栈证据 |
| f3_1 / f3_2 / f3_3 | `plausible_candidate` | 识别到 adservice 重启（JVM 优雅关闭→拉起）；服务级根因正确，但 F3 代码故障在日志不可见，机制属推断 |

- 结果：**claimSupport 5/5 = 100%**；`semanticReview.imported=true`；**硬失败不变**（review 不覆盖确定性失败）。
- **口径**：`reviewer=model-judge:pi`——这是 **AI 复核，不是人工裁决**。按权威源契约，模型分与人工分应**分来源记录**；发布正式质量基线（M9）仍建议至少补 1 次人工复核。

### 7.2 跨系统扩展（2026-10-05）

再导 RE3-TT（Train Ticket，Spring/45 服务）与 RE3-SS（Sock Shop）各 3 例；`--engine fake` 6/6 加载执行通过；
`--engine pi` 跨系统 2 例（`re3tt_ts-auth-service_f1_1`、`re3ss_carts_f1_1`）各 1 次：

| 指标 | 结果 |
|---|---|
| recall.A/B/C1/D | 2/2 = 100% |
| executionSuccess | 2/2 = 100% |
| hardFailures | 0 |

- **gold 质量警示**：TT/SS 的 `f1` 故障在根因服务窗口内**没有 ERROR 行**，自动 gold 落到了 INFO 样板行 → 此时 recall 只是“读到了该服务日志”，**不能当故障定位正确性**。
- 结论：自动派生 gold 仅适合“材料可达性”；**故障签名/代码级 gold 必须人工或 M8c 补全**。
