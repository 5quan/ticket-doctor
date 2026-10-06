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
