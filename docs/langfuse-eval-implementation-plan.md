# Langfuse 原生离线评测实施方案与交付记录

> 面向执行者：本文是 `codex/langfuse-eval` 分支的唯一事实源。开工前先读 `docs/session-handover.md`，
> 再读本文；总交接见 `docs/handover.md`。范围与验收以本文为准。
> 状态：**第一阶段完成（phase1_done）**；真实实验已在部署的 Langfuse 4.50.0 上跑通并逐案例读回（见 §5）。
> 已安装 **Langfuse agent skill**（`/root/.agents/skills/langfuse`，源 `github.com/langfuse/skills`）并按其指南校准读回与评分口径。
> 合成案例结果**不代表真实工单质量提升**；语义质量仅 1 条已标注，其余 unscored。

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
| Langfuse agent skill | ✅ 已安装 `langfuse`（+ `migrate-to-langfuse`）到 `~/.agents/skills/`；用其 `cli.md`/`setting-up-evals.md`/`create-dataset.md` 校准（现代 v3 scores + fields 读回、指标命名、数据集职责分离） |

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
材料 hash **覆盖 `case.json` + 每轮问题文本 + 每轮 `materialView` 目录下全部材料文件（日志等）**；仓库另由 `expectedSha` 在运行时
取证前核对。Dataset 版本只冻结 item 内容，**不冻结服务器文件**，故必须做这一步。

**`input` 是权威首轮问题**：`task` 用 Dataset 的 `input.question` 驱动首轮，在 Langfuse 修改它会实际改变 Agent 收到的问题
（本轮已用单测 + 真实 run 验证）。后续轮文本仍由控制器读取轮次脚本，Agent 只看到当前轮允许的材料。

案例草稿：`npm run eval:lf:seed`（默认仅预览，`--sync` 才写入 Langfuse）。草稿生成器在
`src/eval/lf/internals/engcases.ts`（可重建、可复现）。

---

## 4. 提示词版本（`ticket-doctor-diagnosis`）

- **基线 v1**：完整保存当前生产内置诊断提示词（`buildSystemPrompt()`）。
- **候选 v2**：人工准备的明确小修改——新增「反证优先于既有结论」规则；文件见
  `fixtures/evals/prompts/diagnosis-candidate-v2.txt`。

每次实验按**数字版本**读取、编译并固定；一个案例所有轮次同版本。编译后 hash 记录在 manifest 与实验 metadata。
**注入验证（实证）**：除引擎自报外，评测记录器包装 `model_start` 事件，从**实际模型请求的 effective context**
取出 `systemPrompt`，比对目标编译提示词；`prompt_injection` evaluator 优先用这一实证结果（本轮两版均为 `true`），
引擎自报仅作回退。诊断 generation 使用 Langfuse 原生 prompt 关联字段（`langfuse.observation.prompt.name/version`）；
审计（父节点为 audit agent）与压缩（`callPurpose=compaction`）不关联，避免错误归到诊断提示词（已有单测）。

---

## 5. 真实运行结果与链接（服务器 `4.50.0`）

Dataset：`ticket-doctor-smoke-v1`（id `cmuy48nfd0015oa07ce93ir2t`），冻结版本 `2026-10-07T14:35:00.000Z`。

> 注：早期 `baseline-v1` / `candidate-v2` 为修复前的一轮（input 未驱动、hash 未覆盖日志、预期阻断被计入失败），
> 保留作历史，不作为验收依据。下表为复验（r2）结果。

| 对象 | 链接 / 标识 |
|---|---|
| Dataset | `http://127.0.0.1:3001/project/ticket-doctor/datasets/cmuy48nfd0015oa07ce93ir2t` |
| 基线实验 run `baseline-v1-r2` | `http://127.0.0.1:3001/project/ticket-doctor/datasets/cmuy48nfd0015oa07ce93ir2t/runs/2d170dac48fb3a02` |
| 候选实验 run `candidate-v2-r2` | `http://127.0.0.1:3001/project/ticket-doctor/datasets/cmuy48nfd0015oa07ce93ir2t/runs/3238be004a21af1f` |
| 提示词 | `ticket-doctor-diagnosis` v1（production）/ v2（candidate） |
| 标注队列 | `http://127.0.0.1:3001/project/ticket-doctor/annotation-queues/cmuy4y865001goa071tsu42bq` |

平均分（各 5 案例）：

| 指标 | 基线 v1-r2 | 候选 v2-r2 |
|---|---|---|
| run_integrity | 1.000 | 1.000 |
| citation_validity | 1.000 | 1.000 |
| version_visibility | 0.800 | 0.800 |
| expected_blocked | 1.000 | 1.000 |
| visibility_bc1d（辅助） | 0.400 | 0.400 |
| prompt_injection | 1.000 | 1.000 |
| tool_calls | 10.8 | 11.6 |
| wall_ms | 36246.4 | 35904.2 |
| total_tokens | 45591.2 | 45979.8 |

**解读**：`run_integrity=1.0` 表示 5 案例均完整执行（含预期阻断案例）；`version_visibility=0.8` 仅因
`eng-version-drift` 正确触发版本不一致（这是预期负例，不是缺陷），由 `expected_blocked=1.0` 单独确认。
**这两个数字都不是诊断正确率**；诊断质量需人工复核（§6）。

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
| P0 | 预期阻断负例 `expected_blocked` | 允许结果含 `blocked` 的轮次 | 程序（未调模型/未继续取证/原因指向版本·范围） |
| P0 | 提示词注入 `prompt_injection` | **实际模型请求**的 effective context | 程序 |
| P1 | 预诊断质量 `prediagnosis_quality` | 当轮标准与调查输出 | **Langfuse 原生人工标注** |
| P2 | 调查成本 `tool_calls` / `wall_ms` / `total_tokens` | Token、耗时、工具调用 | 自动记录 |

人工评分（0–2）已在 Langfuse 建立评分配置 `prediagnosis_quality`（NUMERIC，范围 0–2）：

- **2 分**：结论或补问符合当轮标准，重要判断有依据。
- **1 分**：部分成立，但遗漏重要事实、边界或补问。
- **0 分**：存在重要错误、无依据断言，或未处理明确反证。
- **未复核 = unscored**（不当作 0 分或通过）。关键词命中只作辅助，不命名「语义正确率」。

分别记录原始输出与最终输出的问题（`prompt` 的 `injectedVerified` + raw/validated 引用分列），
避免程序修正或审计掩盖提示词缺陷；首期不合成笼统总分。

**复核操作（已闭环一次）**：

1. 打开标注队列（§5 链接），逐条 trace 查看输入/各轮工具与 generation/最终回写。
2. 用 `prediagnosis_quality` 打分（0/1/2），在评论里写依据；也可用命令记录：
   `npm run eval:lf:review -- --manifest <file> --annotate-trace <traceId> --value 2 --comment "依据"`。
3. 读回验证：`npm run eval:lf:verify -- --manifest data/lf-eval/baseline-v1-r2.manifest.json`
   逐案例列出分数值/来源/理由/`configId`/`queueId`/`subject`（现代 `v3/scores` + `fields=details,subject,annotation`）。

本轮已对 `eng-clarify` 基线 trace 完成 1 条标注（`prediagnosis_quality=2`，source=`ANNOTATION`，绑定 queue 与 config），
队列状态 19 PENDING / 1 COMPLETED；该条已能从 `v3/scores` 带 `comment`/`queueId` 读回。
注意：该条为 API 按标注语义写入（`source=ANNOTATION`），存储/读回路径与 UI 相同，但不是 UI 点击产生。

---

## 7. 命令与代码组织

| 命令 | 作用 |
|---|---|
| `npm run eval:lf:preflight` | 环境与部署能力检查（不发评测请求） |
| `npm run eval:lf:seed` | 预览/同步工程数据集；`--sync` 写入；`--register-baseline` / `--register-candidate <file>` 登记提示词 |
| `npm run eval:lf:run` | 指定 Dataset 版本 + 提示词版本运行一次原生实验 |
| `npm run eval:lf:verify` | 读回实验、案例过程与分数（逐案例校验预期指标） |
| `npm run eval:lf:review` | 建立/复用原生评分配置与标注队列；加 trace；`--annotate-trace <id> --value 0|1|2 --comment <理由>` 记录并读回标注 |

此外建议用 Langfuse CLI（`npx langfuse-cli api …`，见 langfuse.com 的 CLI 文档）做数据核查；
skill 已安装在 `~/.agents/skills/langfuse`（源 `github.com/langfuse/skills`）。

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
8. **Dataset `input` 权威驱动首轮**（`task.ts` / `run-case.ts`）：`input.question` 作为 r0 问题，
   缺省才读本地 `messageRef`；Langfuse 改 input 会实际改变 Agent 收到的问题（单测断言 `round_input` 文本）。
9. **材料 hash 覆盖日志**（`seed.ts::casePublicHash`）：纳入每轮 `materialView` 目录全部文件（SHA-256+字节数）；
   改日志内容即改 `caseHash`（单测）。仓库另由 `expectedSha` 取证前核对。
10. **预期阻断负例单列**（`evaluators.ts`）：`run_integrity` 不再把预期阻断计为缺失；新增 `expected_blocked`
    校验“真的阻断且未调模型/未继续取证/原因指向版本·范围”。
11. **注入实证**（`run-case.ts` + `observability/langfuse.ts`）：从实际 `model_start` effective context 取 `systemPrompt`
    与目标比对；prompt 关联只给主诊断 generation。
12. **逐案例分数读回**（`verify.ts`）：现代 `v3/scores` + `fields=details,subject,annotation`，
    核对预期指标名/值/归属；缺分数即判失败；带 comment/config/queue/subject。
13. **标注闭环命令**（`review.ts`）：`--annotate-trace/--value/--comment` 记录 `source=ANNOTATION` 并置队列项 COMPLETED、回读。

复验修正见 §11。

---

## 9. 验证顺序与验收

**已完成（含复验修正）**：

1. 类型检查 + 单元/集成测试：`tests/unit/eval-lf.test.ts`（17 条）覆盖草稿不泄漏、evaluator 语义（含错误引用/
   错误 SHA/未展示证据反例）、prompt 版本、材料 hash 覆盖日志、`input` 驱动首轮、预期阻断负例、实际请求注入、
   verify 逐案例读回与缺分数失败、标注幂等；`tests/unit/observability-langfuse-recorder.test.ts` 新增 prompt 关联
   与 `joinActiveContext` 两条。
2. fake/scripted 引擎：5 案例多轮、隔离、异常、输出捕获。
3. 真实 pi 引擎：单案例多轮冒烟 → 全量基线/候选各一次（复验 r2）。
4. `eval:lf:verify` 从服务器逐案例读回：实验关联、过程归属、分数值/理由/来源/归属（含 1 条人工标注）。
5. 标注入口：评分配置 + 队列（20 条：19 PENDING / 1 COMPLETED）。

验收清单：

- [x] 原生实验与 Dataset Item 关联（experiment-items 5/5）。
- [x] 模型、工具及各轮过程归属对应案例（同 trace 子观测）。
- [x] 两个提示词版本实际生效（`prompt_injection=1`，比对**实际请求**），其他配置相同。
- [x] 每条案例有结果或明确失败（结构化失败不丢弃）。
- [x] 合理追问不算运行失败（`clarify` 单独语义）。
- [x] 预期阻断负例单列校验（未调模型、未继续取证，`eng-version-drift`）。
- [x] 私有答案/未来轮材料/其他案例状态不泄漏（隔离预检 + 材料 hash 覆盖日志）。
- [x] 引用检查有反例（单测覆盖 unresolved/wrongSha/未展示证据）。
- [x] 分数值、理由、来源、关联对象逐案例可读回；缺分数判失败。
- [x] 人工标注入口可用 + 完成 1 条标注并读回（§6）。
- [x] 可在 Langfuse 查看逐案例差异、过程与成本。

---

## 10. 交付报告

### 10.1 本轮完成度

**Langfuse 接入 + 实验执行已实现**（Dataset/提示词版本/真实多轮 Agent/SDK 评分/过程关联/读回/标注入口）。
完整可信评测的收尾尚未全部完成：见 §10.4。修正复验闭环了上一轮提出的 5 个缺口。

### 10.2 第一阶段目标完成度

**基本达成**：运行、评分、复核、比较的**机制**已跑通并逐案例读回；还剩“把人工复核跑满 + 真实案例准入”的
评测内容工作（非平台能力缺口）。

### 10.3 已完成的关键改动

见 §8。配套：`package.json` 新增 5 个 `eval:lf:*` 脚本；`docs/status.json` 新增 `eval_langfuse`；
`tests/unit/eval-lf.test.ts`（17 条）与观测记录器新增 2 条。

### 10.4 未完成 / 阻塞 / 未验证风险

- **语义质量未复核完毕**：仅 1/20 条已标注（且为 API 以 `ANNOTATION` 语义写入，非 UI 点击）；其余 unscored，**不发布质量结论**。
- **合成数据**：5 案例均为 `synthetic_engineering`，不代表真实工单质量；真实案例准入仍待完成。
- **events_only v4**：`dataset-runs`/`traces` 旧接口 404；读回存在索引延迟（已轮询）。prompt 关联需开 `fields` 才能读回。
- **单进程/并发 1**：未验证多进程并发评测与资源隔离。
- **审计默认关**：本期 `audit=off`；审计路径的评测覆盖为脚本化已验证，真实审计待专项。
- **服务端 evaluator**：本期用官方 SDK evaluator + 人工标注；若改 LLM 裁判，skill 建议用 `v2/evaluators` 等 unstable 端点并先标定。

### 10.5 下一步建议

1. 按 §6 口径完成剩余 19 条 trace 的人工复核（0/1/2），读回后比较两版语义分。
2. 准入 ≥1 个真实（脱敏）案例，扩充到 3 个故障族，重复同口径对比。
3. 需要时开启 `--audit on` 做审计路径的真实对比，并记录成本。
4. 视需要把 `prompt_injection`/引用反例纳入 CI 门禁（不影响生产链路）。

---

## 11. 复验修正记录（对齐 Langfuse agent skill）

上一轮评审提出的 5 个缺口，本轮逐条修正并复验（真实 run `baseline-v1-r2` / `candidate-v2-r2`）：

| 缺口 | 修正 | 复验证据 |
|---|---|---|
| 验证放过缺失分数、只抽查第一条 | `verify` 改为逐案例请求预期指标名并校验；缺任一即 `problems`（退出码 1）；用现代 `v3/scores` + `fields=details,subject,annotation`；校验 `subject.traceId` 归属 | 两 run 各 5/5 trace 全部预期分数读回（各 45→46 条），单测含“分数为空必须失败” |
| Dataset input 未驱动执行 | `task` 从 `input.question` 取首轮问题并传入 `runCase`（缺省才读本地文件） | 单测断言 `round_input` 文本等于自定义 input；真实 run 用 Dataset input |
| 材料 hash 覆盖不完整 | `casePublicHash` 纳入每轮 `materialView` 全部文件（路径+SHA-256+字节数） | 单测：改日志内容 → hash 改变；已重新 seed |
| 人工复核未闭环 | 新增 `eval:lf:review --annotate-trace/--value/--comment`；记录 `source=ANNOTATION`、绑定 `queueId/configId`、置队列项 COMPLETED | 完成 1 条 `prediagnosis_quality=2`，`v3/scores` 带 `comment`/`queueId`/`configId` 读回；队列 19 PENDING / 1 COMPLETED |
| 提示词关联未实证 | recorder 包装 `model_start`，从**实际请求 effective context** 取 `systemPrompt` 比对；prompt 关联仅主诊断 generation | 两 run `prompt_injection=true（实际模型请求已包含目标提示词：v1/v2）`；单测验证关联只出现在诊断 generation |

**分数解读修正**：`eng-version-drift` 为预期阻断负例，`run_integrity` 不再把它计为缺失（现为 1.0），
并由 `expected_blocked=1.0` 单独确认“未调模型/未继续取证/原因指向版本范围”；`version_visibility=0.8` 正来自该负例，
**不是诊断正确率**。

**Skill 使用**：安装 `~/.agents/skills/langfuse`（源 `github.com/langfuse/skills`），据其 `cli.md` 改用现代 `scores`/`observations`
端点与 `fields` 组；据 `setting-up-evals.md` 明确指标表、不由 LLM 裁判、分数按“测量对象”命名；据 `create-dataset.md` 保持
`input`/`expectedOutput`/`metadata` 职责分离。构建于 `setting-up-evals.md` 的“服务端 evaluator 用 v2 evaluators 不稳定端点”
本轮未采用（计划要求确定性 SDK evaluator + 原生人工标注），留作 LLM 裁判阶段的选择。
