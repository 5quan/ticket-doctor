# Langfuse 原生离线评测实施方案与交付记录

> 面向执行者：本文是 `codex/langfuse-eval` 分支的唯一事实源。开工前先读 `docs/session-handover.md`，
> 再读本文；总交接见 `docs/handover.md`。范围与验收以本文为准。
> 状态：**第一阶段已完成（phase1_done）**；真实实验已在部署的 Langfuse 4.50.0 上跑通（见 §5 链接）。
> 合成案例结果**不代表真实工单质量提升**。

---

## 0. 一句话

把 ticket-doctor 的诊断链路接入 **Langfuse 原生离线评测**：Dataset 版本 + 提示词版本 → 运行真实 Agent（多轮补证）→
捕获完整调查过程与最终回写 → 确定性 P0 评分 → Langfuse 人工复核 → 比较提示词版本。

---

## 1. 目标与非目标

**目标**：能在已部署 Langfuse 的服务器上，真实运行、评分、复核并比较两个提示词版本。

**本期不含**：自动生成提示词、自动选版本、自动上线、生产提示词热加载。生产诊断策略、审计器、工具权限、
输出格式保持现状。

**复用来源**：从 `origin/eval/v2-migrate` **按需提取**（不整分支合并）：单案例多轮执行核心、案例加载与材料隔离、
输出捕获、证据与可见性检查。**未迁入**旧自建实验管理、上传协议、对比平台、在线评分、整个 CLI。

---

## 2. 实施前预检（已记录）

| 项 | 值（只记录存在状态，不打印秘密） |
|---|---|
| Langfuse 服务器 | ✅ 可达 `4.50.0`（`eval:lf:preflight`） |
| 鉴权 / Dataset API / scores POST | ✅ / ✅ / ✅ |
| observations v2 读 / experiments 读 | ✅ / ✅ |
| 项目凭据 | `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` 均存在 |
| Agent provider / model | `deepseek` / `deepseek-v4-flash`（沿用项目配置，未猜测） |
| 调查预算 | `maxToolCalls=12`，`maxModelTurns=10`，单轮 `timeoutMs=180000`；审计默认关 |
| 依赖版本 | `@langfuse/client` `@langfuse/core` `@langfuse/otel` `@langfuse/tracing` 均锁 `5.13.1`；`LangfuseOtelSpanAttributes` 显式改从 `@langfuse/core` 导入 |

**运行预算闸门**：`eval:lf:run --engine pi` 必须显式提供 `--budget`，否则拒绝发起真实模型调用；
额外有 `--max-cases` / `--max-rounds` / `--cases` 守卫。首期默认并发 1、每案例 ≤3 轮。

---

## 3. 数据集（`ticket-doctor-smoke-v1`）

5 条 `synthetic_engineering` 案例，覆盖 5 个场景；Dataset Item = 一次完整调查（含全部轮次）：

| caseId | 场景 | 轮次 |
|---|---|---|
| `eng-clarify` | 首轮缺材料，追问后获得补充材料 | r1/r2 |
| `eng-counter-evidence` | 出现反证，更新或撤回先前判断 | r1/r2 |
| `eng-truncation` | 存在相似干扰，避免无依据归因 | r1 |
| `eng-version-drift` | 版本与证据约束（预期阻断路径） | r1 |
| `eng-audit-loop` | 材料充分，输出有依据的预诊断 | r1/r2 |

Item 职责划分：

- `input`：首轮用户问题 + 公开业务字段（**不含**后续轮文本/私有答案）。
- `expectedOutput`：每轮允许结果、必需事实、禁止断言、补问目标、证据要求。
- `metadata`：case ID、来源类型、故障族、轮次脚本与材料索引、SHA、caseHash、协议版本、itemId。

日志与源码保留为**服务器冻结工件**（`data/eval-v2/`，gitignore），Langfuse 只存索引与校验信息。
`task` 侧在装载时核对**材料 hash**：`metadata.caseHash` 与本地冻结材料不一致 → 结构化失败（fail-closed）。
Dataset 版本只冻结 item 内容，**不冻结服务器文件**，故必须做这一步。

案例草稿：`npm run eval:lf:seed`（默认仅预览，`--sync` 才写入 Langfuse）。草稿生成器在
`src/eval/lf/internals/engcases.ts`（可重建、可复现）。

---

## 4. 提示词版本（`ticket-doctor-diagnosis`）

- **基线 v1**：完整保存当前生产内置诊断提示词（`buildSystemPrompt()`）。
- **候选 v2**：人工准备的明确小修改——新增「反证优先于既有结论」规则；文件见
  `fixtures/evals/prompts/diagnosis-candidate-v2.txt`。

每次实验按**数字版本**读取、编译并固定；一个案例所有轮次同版本。编译后 hash 记录在 manifest 与实验 metadata。
**注入验证**：pi 引擎回报实际生效的系统提示词（`PiDiagnosisEngine.getSystemPrompt()`），
`prompt_injection` evaluator 对基线/候选两次均为 `true`（候选内容确实进入模型请求，不只是记录计划版本）。
诊断 generation 使用 Langfuse 原生 prompt 关联字段；审计/压缩调用（`callPurpose=compaction` 或父节点为 audit agent）
不关联，避免错误归到诊断提示词。

---

## 5. 真实运行结果与链接（服务器 `4.50.0`）

Dataset：`ticket-doctor-smoke-v1`（id `cmuy48nfd0015oa07ce93ir2t`），冻结版本 `2026-10-07T13:05:00.000Z`。

| 对象 | 链接 / 标识 |
|---|---|
| Dataset | `http://127.0.0.1:3001/project/ticket-doctor/datasets/cmuy48nfd0015oa07ce93ir2t` |
| 基线实验 run | `baseline-v1` → `http://127.0.0.1:3001/project/ticket-doctor/datasets/cmuy48nfd0015oa07ce93ir2t/runs/1b0f8ad66f8324f3` |
| 候选实验 run | `candidate-v2` → `http://127.0.0.1:3001/project/ticket-doctor/datasets/cmuy48nfd0015oa07ce93ir2t/runs/bfbe97d437b1fdf7` |
| 提示词 | `ticket-doctor-diagnosis` v1（production）/ v2（candidate） |
| 标注队列 | `http://127.0.0.1:3001/project/ticket-doctor/annotation-queues/cmuy4y865001goa071tsu42bq` |

平均分（各 5 案例；`eng-version-drift` 为预期阻断，拉低完整性/版本分）：

| 指标 | 基线 v1 | 候选 v2 |
|---|---|---|
| run_integrity | 0.800 | 0.800 |
| citation_validity | 1.000 | 1.000 |
| version_visibility | 0.800 | 0.800 |
| visibility_bc1d（辅助） | 0.400 | 0.400 |
| prompt_injection | 1.000 | 1.000 |
| tool_calls | 10.2 | 10.6 |
| wall_ms | 27260.4 | 30410.0 |
| total_tokens | 35757.2 | 43944.4 |

逐案例确定性指标两版一致；候选在 `eng-counter-evidence` 上工具调用/耗时/token 更高（16→17 调用、42922→53494 ms、
54587→83037 tokens），**未见确定性指标退化**。语义质量差异需人工复核（§6）后才能判断，合成样例不作质量结论。

读回验证（`eval:lf:verify`）：实验找到、5/5 experiment-items、预期 trace 全部关联、样本观测 28–33 条子节点、
分数值/来源/关联对象可读回。`eng-version-drift` 的 `run_integrity=0` 为**预期阻断**（取证前版本一致性 fail-closed），
不是被丢弃的失败。

---

## 6. 评分标准

| 优先级 | 指标 | 依据 | 检查方式 |
|---|---|---|---|
| P0 | 运行完整性 `run_integrity` | 计划轮次、终态、捕获产物 | 程序 |
| P0 | 引用有效性 `citation_validity` | 引用解析、证据实体、`wrongSha` | 程序 |
| P0 | 版本与可见性 `version_visibility` | 故障 SHA、当轮展示范围（B∧C1∧D 辅助分） | 程序 |
| P0 | 提示词注入 `prompt_injection` | 引擎实际系统提示词 | 程序 |
| P1 | 预诊断质量 `prediagnosis_quality` | 当轮标准与调查输出 | **Langfuse 原生人工标注** |
| P2 | 调查成本 `tool_calls` / `wall_ms` / `total_tokens` | Token、耗时、工具调用 | 自动记录 |

人工评分（0–2）已在 Langfuse 建立评分配置 `prediagnosis_quality`（NUMERIC，范围 0–2）：

- **2 分**：结论或补问符合当轮标准，重要判断有依据。
- **1 分**：部分成立，但遗漏重要事实、边界或补问。
- **0 分**：存在重要错误、无依据断言，或未处理明确反证。
- **未复核 = unscored**（不当作 0 分或通过）。关键词命中只作辅助，不命名「语义正确率」。

分别记录原始输出与最终输出的问题（`prompt` 的 `injectedVerified` + raw/validated 引用分列），
避免程序修正或审计掩盖提示词缺陷；首期不合成笼统总分。

**复核操作**：

1. 打开标注队列（§5 链接），逐条 trace 查看输入/各轮工具与 generation/最终回写。
2. 用 `prediagnosis_quality` 打分（0/1/2），在评论里写依据。
3. 读回验证：`npm run eval:lf:verify -- --manifest data/lf-eval/baseline-v1.manifest.json`
   会列出读回的分数值/来源/理由；人工分的 `source` 为标注来源。

---

## 7. 命令与代码组织

| 命令 | 作用 |
|---|---|
| `npm run eval:lf:preflight` | 环境与部署能力检查（不发评测请求） |
| `npm run eval:lf:seed` | 预览/同步工程数据集；`--sync` 写入；`--register-baseline` / `--register-candidate <file>` 登记提示词 |
| `npm run eval:lf:run` | 指定 Dataset 版本 + 提示词版本运行一次原生实验 |
| `npm run eval:lf:verify` | 读回实验、案例过程与分数 |
| `npm run eval:lf:review` | 建立/复用原生评分配置与标注队列，把实验 trace 加入队列 |

`eval:lf:run` 关键参数：`--dataset` `--dataset-version` `--prompt` `--prompt-version` `--experiment` `--run-name`
`--concurrency`（默认 1）`--engine pi|fake|scripted` `--audit on|off` `--cases <ids>` `--max-cases` `--max-rounds`
`--budget <说明>`（pi 必填）`--eval-root` `--out` `--dry-run`。

代码组织（`src/eval/lf/`）：

| 文件 | 职责 |
|---|---|
| `client.ts` | 客户端与预检（只记录存在状态） |
| `seed.ts` | Dataset Item 组装与同步 |
| `prompt.ts` | 提示词版本读取/登记/编译 hash |
| `task.ts` | 单案例多轮 task（Dataset Item → 完整调查） |
| `run-case.ts` | 多轮执行核心（复用生产 `routeInbound → claim → executeRun → 投递捕获`） |
| `evaluators.ts` | 官方 SDK evaluator 适配 |
| `verify.ts` | 服务器读回验证 |
| `review.ts` | 原生人工评分配置与标注入口 |
| `otel.ts` | 实验级全局 OTel provider + context manager |
| `internals/` | 从 `eval/v2-migrate` 按需提取的材料隔离/可见性/脚本引擎等 |

---

## 8. 关键改动与必要配套

1. **观测接入实验 trace**（`src/observability/langfuse.ts`）：`createLangfuseRecorder` 新增
   `joinActiveContext` / `prompt` 选项。评测模式下 attempt 根 span 挂到 SDK task 的 active context，
   整条调查成为实验 item 子节点；不再在子节点写 `langfuse.trace.name/input/metadata`，避免多轮互相覆盖实验根
   （plan §6）。生产缺省行为不变。
2. **全局 OTel context manager**（`src/eval/lf/otel.ts`）：`startActiveObservation` 依赖全局 context manager；
   仅注册 provider 不够，需 `AsyncLocalStorageContextManager` + 全局/isolated provider，否则业务 recorder 另起 trace。
   记录器 provider 与实验 provider 资源所有权分离，只在实验边界 flush/shutdown。
3. **`extractService` 修复**（`src/intake/router.ts`）：服务标注为日期（如 `服务: 2026-09-06`）时不得把日期当服务名，
   否则污染 `scope.services` 被 `query_logs` 范围约束拒绝（从 `eval/v2-migrate` 按需提取）。
4. **`PiDiagnosisEngine.getSystemPrompt()`**：暴露实际生效系统提示词，供评测验证注入。
5. **编排观测钩子**（`src/diagnosis/orchestrator.ts`）：`onPrepared`（取证前版本核对，fail-closed）与
   `postFinalize`（轮终态，旁路评分用）；生产不传，行为不变。
6. **复用材料仓库自愈**（`src/eval/lf/internals/engcases.ts` + `scripts/init-eval-fixture.mjs`）：
   `fixtures/evals/checkout-timeout/repo` 的源文件随仓库提交，`.git` 运行时创建。
7. **依赖**：新增并锁 `@opentelemetry/context-async-hooks@2.0.1`；`@langfuse/*` 锁 `5.13.1`。

---

## 9. 验证顺序与验收

已完成：

1. 类型检查 + 单元/集成测试：`tests/unit/eval-lf.test.ts`（14 条）覆盖草稿不泄漏、evaluator 语义（含错误引用/
   错误 SHA/未展示证据反例）、prompt 版本、task 材料 hash 闸门、多轮脚本执行、`extractService` 回归、verify 读回、
   标注幂等。
2. fake/scripted 引擎：5 案例多轮、隔离、异常、输出捕获。
3. 真实 pi 引擎：单案例多轮冒烟 → 全量基线/候选各一次。
4. `eval:lf:verify` 从服务器读回：实验关联、过程归属、分数值/来源。
5. 标注入口：评分配置 + 队列（10 条 PENDING）。

验收清单：

- [x] 原生实验与 Dataset Item 关联（experiment-items 5/5）。
- [x] 模型、工具及各轮过程归属对应案例（同 trace 28–33 子节点）。
- [x] 两个提示词版本实际生效（`prompt_injection=1`），其他配置相同。
- [x] 每条案例有结果或明确失败（结构化失败不丢弃；`eng-version-drift` 为预期阻断）。
- [x] 合理追问不算运行失败（`clarify` 单独语义）。
- [x] 私有答案/未来轮材料/其他案例状态不泄漏（隔离预检 + 材料 hash）。
- [x] 引用检查有反例（单测覆盖 unresolved/wrongSha/未展示证据）。
- [x] 分数值、理由、来源、关联对象可读回。
- [x] 人工标注入口可用 + 复核后读回步骤（§6）。
- [x] 可在 Langfuse 查看逐案例差异、过程与成本。

---

## 10. 交付报告

### 10.1 本轮完成度

100%（代码、测试、命令、文档、真实两轮实验、读回验证、人工标注入口）。

### 10.2 第一阶段目标完成度

**达成**：能够可信地运行、评分、复核和比较两个提示词版本。诊断分数较低不影响评测功能验收
（本数据集为合成工程案例，确定性指标两版接近，无质量结论）。

### 10.3 已完成的关键改动

见 §8。配套：`package.json` 新增 5 个 `eval:lf:*` 脚本；`docs/status.json` 新增 `eval_langfuse`；
`tests/unit/eval-lf.test.ts`。

### 10.4 未完成 / 阻塞 / 未验证风险

- **语义质量未复核**：P1 人工评分尚未填写（队列 10 条 PENDING）；因此**不发布质量结论**。
- **合成数据**：5 案例均为 `synthetic_engineering`，不代表真实工单质量；真实案例准入仍待完成。
- **events_only v4 接口限制**：`dataset-runs` / `traces` 旧接口 404；`scores`/`experiments` 读回存在**索引延迟**，
  `verify` 已轮询，但初次读空不能判定丢失。
- **prompt 关联读回**：v2 observations 摘要视图不返回 prompt 字段，需在 UI 或详情接口确认；当前以
  `prompt_injection` evaluator 证明注入。
- **单进程/并发 1**：未验证多进程并发评测与资源隔离。
- **审计默认关**：本期实验 `audit=off`；审计路径的评测覆盖为脚本化已验证，真实审计待专项。

### 10.5 下一步建议

1. 完成 10 条 trace 的人工复核（0/1/2），读回后比较两版语义分。
2. 准入 ≥1 个真实（脱敏）案例，扩充到 3 个故障族，重复同口径对比。
3. 需要时开启 `--audit on` 做审计路径的真实对比，并记录成本。
4. 视需要把 `prompt_injection`/引用反例纳入 CI 门禁（不影响生产链路）。
