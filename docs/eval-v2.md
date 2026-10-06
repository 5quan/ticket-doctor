# 评测 v2 使用说明（预诊断多轮闭环）

> 状态：本期新增能力，实施记录见 `docs/status.json`。方案全文由需求方持有；本文只写
> 准备、运行、复核、重评分、比较与失败处理。旧入口 `npm run eval` 保持不变，两者结果
> 目录互不影响。

## 0. 它测什么

预诊断 Agent 的五件事：材料范围是否正确、结论是否有证据支持、缺料是否补问、反证是否
调整、回写是否可核验。工程验收标准是"评测能正确揭示失败"，不是诊断分数高。

## 1. 目录与数据协议

工作目录在 `data/eval-v2/`（不入版本库，可随时重建）：

```text
catalog/catalog.json        # case 清单（工程条目自动 upsert，手工条目保留）
public/<case>/              # 公开材料：case.json + 各轮消息文本 + 各轮材料视图
private/<case>/             # truth.private.json（逐轮标准）+ script.json（脚本引擎）
candidates.json             # 外部历史候选资格记录（FastAPI 7/12/5）
candidates/<case>/          # 资格报告
runs/<suite-id>/            # 每次运行：manifest.json + summary.json + 逐 trial trace/outputs/score
```

工程自测 case 由生成器落盘（合成材料，只验 harness，不声称真实诊断质量）。

## 2. 运行

> **2026-10-05 更新（迁移分支）**：新增 `--audit on|off`（默认 off，与 `TD_AUDIT_ENABLED` 解耦）、
> `--gate on [--max-hard-failures N]`（CI 门禁）、`push`（把 trial trace+分数推 Langfuse，
> v4 下轨迹走 OTLP、分数走 ingestion）、以及 `sourceTier=reproduced_history` 的 log-only 案例。
>
> **2026-10-07 更新（交付一，A0–A3 可信度加固）**：
> - `--audit on` + `scripted/fake` → **确定性审计器**（case 私有 `audit.json` 脚本审计优先，
>   否则零成本假审计）；**环境配置为 pi 也不会回落真实模型审计器**（费用边界）。`engine=pi`
>   才构建真实审计器。实际引擎与审计提示词指纹入 manifest（`diagnosis.audit.engine/promptHash`）。
> - `--gate on` 除硬失败外还查**完整性**：装载/隔离/运行错误（omissions）、trial 数不足都会
>   失败退出；预期阻断（`blocked`）与准入拒绝（非 engineering 且未 admitted）单独计数不算失败。
> - 每个用户轮保存**全部**引擎调用（`artifacts.rounds[].engineCalls`，initial/supplement），
>   初稿错误保留在 `rawDraft`，终稿单独评价（`report`）；trace 增加逐调用 `engine_call` 事件。
> - manifest 冻结于运行前，结束时复核材料指纹漂移（`freezeCheck`）；`project.dirtyFiles/diffHash`
>   归档非干净提交的修改指纹；脚本/审计脚本 hash 入账（`cases[].scriptHash/auditScriptHash`）。
>
> **2026-10-07 更新（交付 1.1，七项可信度补强；`SCORER_VERSION=3.3.0`）**：
> 1. **outcome 以持久化终态为准**：run 未 `succeeded`（审计 failBlocks=true 失败、补证引擎
>    预算耗尽、超时、提交被拒）一律记 `error` 并产生越界硬失败——不得因已有成功草稿记
>    report 或通过门禁；`failBlocks=false` 的合法降级仍正常发布。
> 2. **replay 按冻结身份对账**：运行前落盘 `runs/<suite>/trials.json`
>    （`prediagnosis-trials-v1`）；缺 trial 产物、缺整个 trial、混入清单外目录都失败。
> 3. **selected/planned/excluded 分离**：summary 记 `selected`（显式选题数）与 `planned`
>    （可评数）；**显式选题中出现准入拒绝 → 运行即失败**（分母不得静默缩小）；全量运行的
>    准入拒绝单独计数。门禁阈值（`--max-hard-failures`）NaN/负数在运行前拒绝（exit 2）。
> 4. **冻结漂移阻断门禁**：`freezeCheck=false` 或 `project.gitState=unknown`（git 不可读）
>    门禁失败；项目身份运行前冻结/运行后复核（HEAD/diff/未跟踪文件指纹 `untrackedHash`）；
>    仓库指纹 git 不可读时回退内容指纹（`basis=content-fallback`），不再记 null。
> 5. **review 事实约束**：轮次无实际回写记录时不得复核为回写成功（校验拒绝 + applyReview
>    防御双层）；clarification/writeback 同轮重复或冲突记录整份拒绝。
> 6. **rescore 版本绑定**：`score.json` 版本 ≠ 当前评分器 → 拒绝（不允许混合口径）；
>    基础分必须可用当前代码逐字段复算；`score.reviewed.json` 携带 `reviewMeta`
>    （outputsHash/reviewHash/reviewArtifact/baseScorerVersion）；summary/push 消费前核验
>    绑定，失效回退程序分并告警。
> 7. **审计可回放**：`audit_event` derived 事件导出每轮的审计决定/失败/最终应用（含真实
>    `occurredAt`）；`artifacts.auditEngine` 记录逐 trial 实际审计器，`auditScript` 记录
>    提供/消费/耗尽步数；**脚本审计耗尽 = 硬失败 `audit_script_exhausted`**（默认放行必须暴露）。

```bash
npm run eval:v2 -- run --suite daily-1 --engine scripted [--repeat 3] [--cases eng-clarify]
```

- 引擎三选一：`scripted`（默认，确定性工程自测）/ `fake` / `pi`。`pi` 必须显式选择且
  `DEEPSEEK_API_KEY` 预检通过，CLI 不代填凭据；真实模型每套配置完整跑三次并保留全部结果。
- 每次 trial：全新 Store 与调查 → 生产编排（`executeRun`）逐轮执行 → 捕获发送端记录回写 →
  持久化导出 trace → 逐轮标准打分。
- 产物：`runs/<suite>/manifest.json`（完整 HEAD、材料/标准/提示词/预算/脚本/审计 hash、
  freezeCheck）、`summary.json`（含 planned/counts/caseStatuses 终态）、逐 trial
  `trace.jsonl / outputs.json / score.json`。

## 3. 复核与重评分

```bash
npm run eval:v2 -- replay --suite daily-1    # 重算评分并与 score.json 逐字段比对（缺产物即失败）
npm run eval:v2 -- summary --suite daily-1   # 汇总视图（有复核工件时追加复核聚合）
npm run eval:v2 -- rescore --suite daily-1 --case <id> --trial t1 --review review.json
```

**review 工件 v3（`prediagnosis-review-v3`，2026-10-07，破坏性升级）**：

- 绑定五元组 + 输出内容：`suiteRunId/caseId/trialId` 必须匹配，`outputsHash`（文件级，
  由被复核输出内容计算）不匹配即拒绝——trial 重跑后旧工件不会误导入。
- claims 只允许指向 **validated 终稿**的实际判断槽位（summary/confirmedFacts/hypotheses/
  nextSteps 逐条枚举），必须携带稳定 `claimId`（内容 hash）；未知槽位、越界下标、重复记录、
  raw 跨阶段记录整份拒绝。
- `review.reviewerType` 必填 `human|model`——模型裁判分不得伪装人工分。
- 反证复核按**被推翻 claim 逐条**（`roundId+claimId`，claimId 须存在于该轮 truth）。
- 分母来自实际判断清单（不是提交的 review 条数）；未复核部分保持缺测，
  `semanticReview.coverage` 显示覆盖率；硬失败不可被覆盖。
- rescore 追加产物：review 工件按内容哈希归档到 `reviews/<hash>.review.json`，同一工件
  拒绝重复导入；基础 `score.json` 保持不可变，复核分写 `score.reviewed.json`。
- `summary` 在存在 `score.reviewed.json` 时追加复核聚合并写 `summary.reviewed.json`；
  `push` 优先推送复核分并在 metadata 标注 `scoreSource`。

> **2026-10-07 更新（交付二 B1–B2，Langfuse 实验闭环）**：
> - `push` 重构为**实验载荷同步**：一个 trial = 一个 experiment item（确定性 traceId），
>   每个用户轮一个子观测（正式报告全文/实际回写/工具返回/审计过程，保留原始时间）；
>   input 只含公开题面（白名单），truth 侧评价标准标识（requirementId/ruleId）不入上报，
>   C2 恒 null 不冒充。复核分以 `.reviewed` 后缀侧车并列（绑定核验通过才上报）。
> - **幂等**：traceId/score id 确定性派生（`sha256(suite|case|trial)`），重复同步得到同一
>   trace/分数；`langfuse-sync.json` 记录 confirmed/failed/attempts/lastError，confirmed
>   跳过、failed 续传、`--force` 重推；同步失败不改诊断结果、不丢本地产物（exit 1 提示续传）。
> - **兼容限制**（v4.50 events_only）：`/api/public/v3/scores` 实测对所有分数返回空——
>   `confirmed` 语义为"平台已确认受理（2xx 无逐条错误）"，**平台可读性仍需 UI 核对**；
>   Langfuse Dataset/Annotation 走 UI/后续 SDK（需服务端 dataset API 能力验证后接入）。
> - 人工复核闭环：复核在 Langfuse 标注队列完成后导出 review 工件 → `rescore --review`
>   → `summary`（复核聚合）/`push`（.reviewed 侧车）。

- 语义项（claimSupport 等）在人工 rubric 导入前保持 null；provisional 标准的结论只作参考。
- 评分器标识为独立版本（`SCORER_VERSION=3.2.0`），与旧口径禁止同表对比；改判定语义必须
  bump 并对旧 trace 重评分。3.2.0 变更：回写代理改组间 AND；claimSupport 缺测口径改为
  实际判断清单；反证更新按被推翻 claim 逐条计分。

## 4. 关键口径速查

- 召回按"需求"计（requirementId），分母=本轮适用需求；不可判记 unscored，不冒充 0/1。
- 可见性分四层：A 源返回 / B 入库 / C1 工具返回文本 / C2 请求上下文（未观测，恒 null）/
  D 报告引用。入库≠可见：预览上限与渲染预算都会造成 B、C1 差距，由指标直接暴露。
  C1 命中按调用身份绑定：该次调用返回文本含关键内容，且同一调用提交的批次证据匹配
  类型/仓库/SHA/路径/内容——错误版本的相同文本不命中。
- 版本核对分两层：runner 的 `onPrepared` 观察点在模型取证前记录 `scope_resolved`
  （expectedSha/resolvedSha/pinnedBy/依据），与期望不符即阻断；报告轮再由评分层补记
  scope 差值（事后核对，不得表述成"取证前检查"）。评测不注入 rev——生产按时间/HEAD
  钉版的真实路径被完整考验。
- 日志授权语义：`allowedServices` 未配置=不限（生产遗留默认）；显式空数组=全拒；
  非空=白名单。评测逐轮传 `round.services`，空授权轮不允许任何日志查询。
  路径核验用真实路径（realpath）：符号链接/目录别名/junction 逃逸同样被拒；
  Windows junction 回归用例在非 Windows 环境 skip（保留在 tests/unit/eval-v2-links.test.ts）。
  视图两两关系拒绝相等与**两个方向的父子包含**（真实路径判定）；跨轮硬链接（inode 重合）
  与**私有/禁止访问材料的 inode 重合**（合法授权日志链接答案文件）由预检识别——
  运行期路径规则发现不了，预检阻断是唯一防线。
- 读取前版本核对覆盖**全部期望仓库**：缺席（missing-in-scope）、无法解析（unresolved）、
  错配（mismatch）都阻断；正式 case 每轮仓库必须声明完整 expectedSha（schema 拒绝缺省）；
  工程场景允许缺期望，但仍核对实际可读版本（no-expected），不得跳过检查进入运行。
  对每个实际解析出的 SHA（含按时间选中的中间提交）再单独做隔离扫描
  （答案文件名/未来消息/完整性，`scope_resolved.resolvedScans`），失败即在取证前阻断并中止整个 trial。
- 隔离扫描完整性与"是否存在未来消息"是两项独立检查：每轮（单轮/末轮也算）对视图文件与
  仓库树（expectedSha 与 HEAD 两棵）扫描，超限或失败 → incomplete_scan，不判隔离通过。
- 硬失败单列不进均值：引用不可解析、版本错配、越界断言、反证后固执、空日志推健康等。
- 隔离预检失败的 case 直接 blocked，不进评测；私有标准/未来材料/补丁结构性不可达。

## 5. 失败处理

- 单 case 异常记 `execution_error` 并保留 trace，不影响其他 case；重试 attempt 全部留痕。
- 归因六层：engineering / material / reasoning / clarification / contradiction / scoring。
  评分器自身问题归 scoring，不算模型失败。
- FastAPI 7 等外部候选在复现通过前保持 `candidate`/`deferred`，见 `data/eval-v2/candidates/`；
  不用合成日志冒充历史事故材料。
