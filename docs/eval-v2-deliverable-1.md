# 评测 v2 交付一：运行与评分可信度加固（A0–A3）

> 分支 `eval/v2-migrate`；被审查基线 `origin/eval/v2-migrate@8be3cde`。
> 本交付对应审查方案的阶段 A（A0–A3），只用确定性引擎（scripted）验收，不涉及 Langfuse。
> 后续交付：二（B1–B2 Langfuse 闭环）→ 三（C1–C2 案例准入与基线）→ 四（D 每轮自动评分）。

## 1. A0：可复现工程基线

**环境问题（非代码缺陷，已修复并记录）**

| 问题 | 根因 | 处置 |
|---|---|---|
| `npm ci` 失败（EACCES unlink fzstd） | `node_modules` 内 5 个包为 root 所有（历史上以 root 执行过安装） | 以 sudo 清理后 `npm ci` 重装；已全仓 `chown ubuntu` |
| 5 个集成测试失败（`summary 缺少 case`/git dubious ownership） | `fixtures/evals/checkout-timeout` 为 root 所有，git 拒绝操作 → 依赖该仓库的工程 case 全部装载失败 | chown + 重跑 fixture 初始化后恢复 |
| runner-process 并发用例偶发 `cancelled` | 子进程冷启动（`--experimental-strip-types`）在并行负载下超 5s 默认诊断超时 | 测试配置 `timeoutMs` 5s→30s（仅测试，租约不变） |

**锁文件漂移（已修）**：`hyparquet`/`hyparquet-compressors` 在 M8a 进入 package.json，但提交的
package-lock.json 未同步——干净环境 `npm ci` 必然失败。已重新生成锁文件并验证 `npm ci` + typecheck + 全量测试通过。

**ESM 中的 require（已修）**：`tests/unit/eval-v2-links.test.ts` Windows junction 清理用例在 ESM
文件里调用 `require("node:fs")`，Windows 上会 ReferenceError（Linux 因 skip 未暴露）。改为顶部静态导入。

**跳过项清点（全部有原因 + 替代验证，无删测试换全绿）**：共 3 处，全部在
`tests/unit/eval-v2-links.test.ts`，且都是"先探测环境、构不出前置条件才跳过"的写法——
junction 需 Windows 管理员/开发者模式；不可读文件/目录两个用例需要非 root 用户。替代验证方式已写入 skip 消息。

**分支生产改动清点（纠偏"生产代码零改动"的说法）**：`git diff main...HEAD` 中非评测改动共 4 个源文件 +27/−8：

| 文件 | 改动 | 性质 |
|---|---|---|
| `src/intake/router.ts` | `extractService` 拒绝把日期当服务名（OQ-45） | **生产 bug 修复**（M1 顺带），影响正式入站解析 |
| `src/diagnosis/orchestrator.ts` | 恢复 `onPrepared` 观察钩参数（M0 恢复被删资产） | 生产接口恢复，缺省行为不变（评测侧注入） |
| `src/sources/code.ts` | 导出 `SEARCH_PAGE_SIZE/READ_PAGE_LINES/LIST_FILES_LIMIT` 常量供 manifest 记录 | 常量提取，行为不变 |
| `src/sources/logs.ts` | 导出 `LOG_PAGE_SIZE_DEFAULT` 常量 | 常量提取，行为不变 |

## 2. A1：审计、多次诊断与捕获绑定

确认并修复的缺陷（源码 + 评分实测）：

1. **捕获按轮指针取单条**（`runner.ts`）：审计补证让一次 run 产生多次引擎调用，
   `capture.captured[ptr]` 会把上一轮的补证稿错挂到下一轮。修复：按"本轮 executeRun 期间
   实际发生的调用"切片；`rawDraft` 固定取**初稿**（初稿错误不因审计纠正而抹去），
   outcome/replyText/toolCalls 取**最后一次调用**（与 finalize 落库一致）。
2. **每个用户轮保存全部调用**：新增 `artifacts.rounds[].engineCalls`（index/phase/kind/draft），
   trace 新增逐调用 `engine_call` 事件（绑定 roundId/runId/attemptId/phase）；
   `engine_result_raw` 保留为终稿摘要（requiredTraceEvents 语义不变）。
3. **捕获装饰器丢 obs**：`CapturingEngine.run` 未透传第 5 个参数（观测范围），已透传。
4. **审计引擎随环境配置隐式回落真实模型**：eval 侧未注入 auditor 时生产编排按
   `buildAuditor(config)` 构建——环境 `TD_ENGINE=pi` 时工程自测开审计会隐式调用真实模型。
   修复：runner 显式注入——scripted/fake 强制确定性审计器（case 私有 `audit.json` 脚本审计
   `ScriptedAuditor` 优先，否则零成本 `FakeEvidenceAuditor`），仅 `--engine pi` 才构建真实审计器。
   实际审计引擎与 pi 审计提示词指纹入 manifest（`diagnosis.audit.engine/promptHash`）。
5. **新增工程 case `eng-audit-loop`**：初稿 → 审计要求补证 → 补证稿 → 终稿；轮 2 独立草稿。
   集成测试 `tests/integration/eval-v2-audit-loop.test.ts` 锁定：
   轮 1 两次调用归属正确、初稿/终稿分离、轮 2 不拿上一轮补证稿、manifest 记录
   `scripted-audit`、**真实模型调用为零**（含环境诊断为 pi 且存在假凭据的费用边界反例）、
   `ScriptedAuditor` 耗尽放行与 failure 注入语义。

## 3. A2：评分器与人工复核契约

`SCORER_VERSION 3.1.0 → 3.2.0`（口径变更，旧口径作废，禁止同表对比）：

1. **回写关键词代理改组间 AND**：原实现把概念组 flat 化后 any-of——"库存"出现即通过，
   哪怕"超时"缺失。改为与 requiredFacts 同语义（组间 AND、组内 any-of），并明确标注代理指标。
2. **claimSupport 缺测口径**：从 requiredFacts 代理计数改为**实际可判判断清单**
   （`listJudgableClaims`：validated 终稿的 summary/confirmedFacts/hypotheses/nextSteps 逐条）。
3. **反证按被推翻 claim 逐条计分**：一条假设正确降级不再掩盖同轮另一条固执假设。
4. **review 工件 v3（破坏性，v2 整份拒绝）**：
   - 绑定：suiteRunId/caseId/trialId + 文件级 `outputsHash`（被复核输出内容指纹，
     trial 重跑即失效）+ 逐条稳定 `claimId`（内容 hash）；
   - claims 只允许 validated 终稿的实际槽位；未知槽位/越界下标/重复记录/raw 跨阶段记录整份拒绝；
   - `reviewerType: human|model` 必填——模型裁判分不得伪装人工分；
   - 反证复核按 claim 逐条（claimId 须存在于该轮 truth）；
   - 分母来自实际判断清单，未复核部分保持缺测，`semanticReview.coverage` 显示覆盖率；
   - 硬失败不可被覆盖（原有边界保留并有测试）。
5. **复核结果进入汇总与推送**：`summary` 存在 `score.reviewed.json` 时追加复核聚合并写
   `summary.reviewed.json`；`push` 优先推送复核分并在 metadata 标注 `scoreSource`；
   rescore 把 review 工件按内容哈希归档（append-only），同一工件拒绝重复导入（exit 1）。

## 4. A3：完整性门禁、冻结与重放

1. **终态入账**：summary 新增 `planned`（cases/trials）、`counts`
   （scoredTrials/blockedExpectedTrials/admissionRejected/unscoredCases）、`caseStatuses[]`
   （phase：scored / admission_rejected / isolation_blocked / load_error / run_error）。
   blocked.json 改为结构化 `{planned, caseStatuses}`（仅在有非 scored 终态时写出）。
2. **准入拒绝一等状态**：非 engineering 且未 admitted 的 case（如历史遗留 fp07-clarify）
   记 `admission_rejected`，不入评测总体、不进计划口径、单独计数——实测门禁曾因它
   静默跳过而误报全绿，现已显式暴露。
3. **门禁完整性**：`--gate on` 除硬失败外，任何遗漏（装载/隔离/运行错误）或 trial 缺额都
   失败退出；空 suite/未知 case/非法 `--engine`/非法 `--repeat` 显式报错（exit 2）。
4. **冻结语义**：逐 case 材料/脚本/审计脚本指纹在 trial 运行**前**冻结（manifest 记录运行
   开始时的口径），结束后重取快照对比，漂移写 `manifest.freezeCheck` 并 stderr 警告；
   非干净提交时归档 `project.dirtyFiles` + `diffHash`（完整修改内容指纹）。
5. **replay 严格化**：缺 manifest/summary 直接失败；trial 缺 outputs/score/trace 记为不一致
   （不再静默跳过）；版本不匹配在 detail 注明。

## 5. 验收证据（2026-10-07 实测）

| 项 | 结果 |
|---|---|
| 干净安装 | `npm ci` 成功（锁文件修复后）；typecheck 绿 |
| 全量测试 | **262 tests：260 通过 / 1 跳过（Windows junction，平台限制）/ docs:check 状态同步** |
| 端到端（scripted + `--audit on` + `--gate on`） | `gate: planned=17 trials=17/17 hardFailures=0 blockedExpected=2 admissionRejected=1 omissions=0` 通过 |
| replay | 全部 trial 逐字段一致 |
| rescore（v3 review，覆盖 4/4） | claimSupport=100%，来源 human，硬失败不变；重复导入 exit 1 拒绝 |
| summary | 基础聚合 + 复核聚合分离；`summary.reviewed.json` 落盘 |
| 未评分/未复核/未同步计数 | claimSupport 除 1 个复核 trial 外 33 判断缺测（如实呈现）；未同步（Langfuse）属交付二范围 |

**暂缓（按方案边界）**：模型裁判、Langfuse 全文内容推送（B1）、UI 触发实验、案例扩充。
**遗留**：`docs:check` 的用例计数已随本交付更新（258→262）。

---

# 交付 1.1：七项可信度补强（2026-10-07，基于 a3ebbf3）

> 逐项先在 a3ebbf3 上确认缺陷存在（源码 + 反例），再修复并加确定性反例测试。
> 反例测试集中在一个文件：`tests/integration/eval-v2-deliverable11.test.ts`（8 例）+ 既有
> review 测试新增 1 例。修改前确认结论见各项"确认"小注。

| # | 要求 | 确认的缺陷（a3ebbf3） | 修复 | 反例结果 |
|---|---|---|---|---|
| 1 | outcome 以持久化终态+成功提交为准 | 预算耗尽/审计 failBlocks=true 失败时 `executeRun` 内部 `failRun` 后**正常返回**，runner 的 `runError` 不置位 → `outcomeOf(最后捕获)=report`；失败轮无硬失败可通过门禁 | outcome 判定改为 `preReadBlock→blocked；runRow.status==="succeeded" 且无 runError→outcomeOf(finalCall)；否则 error` | 反例 #1a/#1b：审计失败、补证预算耗尽 → outcome=error + `outcome_out_of_policy` 硬失败；反例 #1c：failBlocks=false 合法降级仍 report 且无硬失败 |
| 2 | replay 按冻结身份对账 | replay 按目录遍历——trial 目录整个缺失/产物不全时不可见（"目录里有什么就对什么账"） | 运行前落盘 `trials.json`（`prediagnosis-trials-v1`，admissible×repeat）；replay 逐身份核对目录+三产物；清单外目录也报不一致；缺清单本身拒绝 | 反例 #2：删 outputs.json → 失败；删整个 trial → 失败；混入 t9 目录 → 失败；完整 → 通过（对账 17 身份） |
| 3 | selected/planned/excluded + 阈值校验 | 显式选题全被准入拒绝时 planned=0/0、门禁照常通过；`--max-hard-failures=NaN` 时 `hard > NaN` 恒 false 静默放行 | summary 增 `selected`；显式选题含准入拒绝 → 运行即抛错（分母不得静默缩小）；阈值在运行前校验（非 ≥0 整数 → exit 2） | 反例 #3：显式选题未准入 case → 抛"准入拒绝"；全量运行 admissionRejected=1 正常计数；NaN/负数阈值 exit 2 |
| 4 | freezeCheck 阻断门禁 + 项目身份/未跟踪指纹/unknown | 门禁不读 manifest（freezeCheck 形同虚设）；git 不可读时 repoFingerprint 返回 `{}`（漂移检测失效）；项目身份只在结束时取一次；untracked 内容不入指纹 | 门禁判定抽为纯函数 `gate.ts`：freezeCheck=false / gitState=unknown / manifest 缺失都失败；`projectIdentity` 运行前冻结+运行后复核（head/diffHash/untrackedHash/gitState）；repoFingerprint git 失败回退内容指纹（`basis=content-fallback`） | 反例 #4：正常 manifest 通过；篡改 freezeCheck=false → "冻结复核失败"；git unknown → 失败；manifest 缺失 → 失败 |
| 5 | review 不得无中生有改判回写成功 + 同轮重复/冲突拒绝 | applyReview 的 writeback ok 覆盖不检查该轮是否真有回写记录；clarifications/writeback 数组无重复检测 | validateReview 增 `writebackPresentByRound` 事实绑定（无回写记录判 ok → 整份拒绝）+ 两个数组的同轮重复检测；applyReview 增防御（无 writebackText 的 ok 按 fail 计） | 反例（eval-v2-audit）：无回写判 ok → 拒绝；判 fail → 允许；同轮两条 clarification/writeback（含冲突）→ 整份拒绝；绕过校验直接 applyReview → 不得产出 100% |
| 6 | rescore 版本绑定 | rescore 不检查 saved 版本（新旧口径可混合出复核分）；score.reviewed.json 无绑定元数据 | rescore：saved.scorerVersion ≠ 当前 → 拒绝；基础分必须可用当前评分器逐字段复算；reviewed 增 `reviewMeta`（outputsHash/reviewHash/reviewArtifact/baseScorerVersion/rescoredAt）；summary/push 消费前 `reviewedBindingValid` 核验，失效回退程序分并告警 | 实测：对 3.2.0 旧 suite rescore → "拒绝混合口径重评分"；reviewMeta 四元组落盘；summary 消费通过 |
| 7 | 审计事件导出 + 逐 trial 审计器 + 耗尽暴露 | 审计决定/失败/应用只落 per-trial 内存 SQLite，trial 结束即丢（trace 无任何审计事件）；审计器名只有 suite 级；ScriptedAuditor 耗尽默认放行且无任何标记 | `exportAuditEvents`：每轮导出 `audit_event` derived 事件（audit_round/audit_failed/audit_applied + 真实 `occurredAt`）；`artifacts.auditEngine` + `auditScript`（provided/consumed/exhaustedCalls）；耗尽 → ScorerInput.auditScriptExhausted → 硬失败 `audit_script_exhausted`（SCORER_VERSION 3.3.0） | 反例 #7：2 轮只给 1 审计步 → 硬失败暴露 + 账目 {provided:1, consumed:1, exhaustedCalls:1}；≥3 条 audit_event 带 occurredAt 入 trace；eng-audit-loop 补足 3 步后正常 |

**测试统计**：271 tests，269 通过 + 1 平台跳过（Windows junction）+ docs:check 状态同步（计数 262→271）。
新增反例：`eval-v2-deliverable11.test.ts` 8 例 + `eval-v2-audit.test.ts` 1 例。

**修改清单**：`runner.ts`（outcome/trials.json/selected/项目身份冻结/审计导出接线）、`gate.ts`（新增，纯函数门禁）、
`manifest.ts`（projectIdentity/projectIdentityDrift/仓库指纹回退）、`hash.ts`（repoFingerprint 回退）、`trace.ts`（exportAuditEvents）、
`scripted-engine.ts`（ScriptedAuditor 耗尽计数）、`scorer.ts`（3.3.0 + audit_script_exhausted）、`review.ts`（writeback 事实绑定/
重复拒绝/reviewedBindingValid）、`cli.ts`（阈值前置校验/eval-root 绝对路径/replay 对账/rescore 版本检查+reviewMeta/消费端核验/gate 接线）、
`engcases.ts`（eng-audit-loop 审计步补足）、`types.ts`、`status.json`、`eval-v2.md`。

**剩余限制**：
- 审计事件的真实时间来自 `run_events.created_at`（SQLite 写入时刻，毫秒），非 OTLP 时钟；B1 上报时以 trace 事件时间为准即可。
- `trials.json` 只在 1.1 之后的运行存在；旧 suite 的 replay 显式拒绝并提示重跑（不兼容静默降级）。
- 脚本审计耗尽的报告仍会发布（默认放行内容），但硬失败保证其无法通过 `--gate on`；是否改为阻断发布属审计策略（AUDIT_POLICY_VERSION）范畴，本交付不动业务策略。
- 仓库指纹的 content-fallback 不含历史提交（只有当前工作树内容），对非 git 目录已够用；git 仓库始终走 git-tree 指纹。


---

# 交付二：Langfuse 实验与复核闭环（B1–B2，2026-10-07）

## B1 实验（experiment.ts + langfuse.ts pushExperimentTrial）
- 一个 experiment item = 一次完整 case trial；根 span `eval/<case>`（确定性 traceId），每个用户轮
  一个子 span `round/<roundId>`：正式报告全文 JSON、实际回写文本、初稿摘要对照、工具返回（头部）、
  审计决定/失败/应用事件（真实 occurredAt）。
- 白名单：input 只含公开题面；实验载荷**不携带** truth 侧标识（requirementId/ruleId/locatorId，
  反例测试锁定）；hardFailure 只上报 code（message 可能内嵌 ruleId）；C2 恒 null。
- 复核分以 `.reviewed` 后缀侧车上报，不与程序分混同；未复核为 null 的程序语义项不上报（不冒充）。

## B2 可靠同步
- 确定性幂等：traceId = `sha256("trial"|suite|case|trial)[:32]`；score id 同规则（8-4-4-4-12）。
  同一 trial 重复同步得到同一 trace 与分数（平台按 id 幂等），反例测试锁定。
- 同步状态 `runs/<suite>/langfuse-sync.json`（`prediagnosis-lf-sync-v1`）：confirmed（2xx 受理）/
  failed（原因留档）/attempts 累计；confirmed 跳过、failed 续传、`--force` 重推；失败 exit 1 但
  不改诊断结果、不丢本地产物。
- 复核闭环：Langfuse 标注队列（平台侧）→ 导出 review 工件 → `rescore --review` → `summary`
  复核聚合 → `push` 侧车；模型裁判分单列（reviewerType）。

## 实测
- `push --suite d11-e2e`：17/17 confirmed（含 2 轮子观测的 eng-audit-loop、eng-clarify/t1 附加复核分侧车）。
- 再跑一次：`confirmed=0 skipped=17`（幂等跳过）；`--force` 重推 17（同 traceId/score id）。
- `tests/unit/eval-v2-experiment.test.ts` 5 例全过（载荷结构/防泄漏/状态机/确定性 id/复核侧车）。
- 全量 276 tests：274 通过 + 1 平台跳过 + docs:check 同步（271→276）。

## 剩余限制
- v3 scores 读取接口实测恒空（events_only）：confirmed ≠ 已读回，平台可读性需 UI 核对；
  Dataset/Annotation API 需服务端能力验证后再接（`@langfuse/client` 实验接口暂缓，原因同）。
- 工具返回只上报头部 600 字符（控制体积）；完整返回在本地 trace.jsonl。
