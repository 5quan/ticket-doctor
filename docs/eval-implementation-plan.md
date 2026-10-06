# 离线评测实施方案（MVP → 基线 → 优化）

> 面向执行者（zcode）：**一次只做一项**，做完跑 `npm run typecheck && npm test && npm run docs:check`，
> 更新本文件状态与 `docs/status.json`，再 commit/push。本文是唯一事实源；`docs/eval-design.md` 为历史设计，仅作参考。
> 版本铁律：`EVAL_SCORER_VERSION`（`src/eval/benchmark.ts`）与 `AUDIT_POLICY_VERSION` 改动即递增；
> **不同 scorerVersion / 材料指纹 / 场景禁止同表比较。**

---

## 0. 目标与非目标

**目标**：建立**可比较、可复现**的离线质量基线——用固定案例、固定材料、固定配置跑正式诊断链路，
度量「证据是否支持结论 / 材料不足是否合理追问 / 反证出现是否修正 / 耗时与成本」，再按失败类型单项优化。

**非目标 / 禁区**：
- 评测**不改生产编排**；只复用 `prepareDiagnosis → runDiagnosisLoop → validateDraft → applyAudit`，替换材料来源。
- **禁止自查自证**：优化期间 `benchmark.json`、`scorer.ts`、`src/eval/` 的判定口径是**禁区**，唯一迭代对象是 `rules.md`（或提示词）。
- **禁止把"命中 gold"冒充"诊断正确"**：语义正确性未人工复核即 `unscored`。
- **禁止笼统宣称覆盖完整生产链路**：内存运行器只测诊断核心（工具/证据/引擎/审计/校验）；
  持久化、调查隔离、正式回写/投递/代次守卫须**另行验证**（用集成测试或真实环境）。

---

## 1. 当前 MVP 状态（E0，已完成）

| 能力 | 文件 | 说明 |
|---|---|---|
| 数据集契约 + 加载 | `src/eval/benchmark.ts` | `benchmark.json`：`scenario/engine/rulesFile/logsDir/repoDir/repoRev/repoId/cases[]`；gold 用**源级定位**（log=level+substring，code=path+行区间+可选 sha） |
| 版本指纹 | `src/eval/fingerprint.ts` | gitRev(+dirty)、engine/model、systemPromptHash、rulesHash、materialHash(+repoHead)、budget、scorerVersion、audit 策略 |
| 运行器 | `src/eval/runner.ts` | 复用正式链路；内存 session（含 usage 统计）；产出**模型原输出 draft / 程序校验 validated / 审计后 report** 三层 + `audit` + `validationIssues` |
| 打分器 | `src/eval/scorer.ts` | 材料命中（recall/precision，干扰项计分母）+ 引用有效性；语义 `unscored`（`reviews.json` 才 graded） |
| 结果记录 | `src/eval/report.ts` | JSONL：每次运行一段 header 指纹 + 逐 case 记录；`summarize`、`readJsonl`、`loadReviews` |
| 对比 | `src/eval/compare.ts` | 按 `engine/model/rules/scorer/audit` 分组汇总（审计关/开、rules 前后） |
| CLI | `scripts/eval.ts`、`scripts/eval-compare.ts` | `npm run eval -- --scenario X [--runs N] [--engine fake\|pi] [--audit on\|off]`；`npm run eval:compare -- --scenario X` |
| 首个 fixture | `fixtures/evals/demo-checkout/` | 复用 `fixtures/samples` + `fixtures/demo-repo`；1 case |
| 单测 | `tests/unit/eval-scorer.test.ts` | locator 匹配 / recall+precision / unscored / 无效引用 / 加载 |

**已验证命令**（离线、零模型成本）：
```bash
npm run eval -- --scenario demo-checkout --runs 3
npm run eval -- --scenario demo-checkout --runs 3 --audit on
npm run eval:compare -- --scenario demo-checkout
```
输出：`data/evals/<scenario>.jsonl`（`data/` 已 gitignore）。

---

## 2. 验收口径（评审修正，必须遵守）

1. **不是"三次稳定"，是"三次完整保留"**：脚本自测（fake + 离线重评分）应可复现；真实模型如实记录波动，不要求答案相同。
2. **材料命中 ≠ 诊断正确**：`evidenceRecall/Precision` 只表示材料/引用；语义正确性第一版**人工复核**，未复核 `unscored`。
3. **假反证只用于工程自测**（E2），不得进质量成绩；正确响应可能是修改/撤回/降级，不一定变 `refuted`。
4. **内存运行器范围有限**：不代表生产持久化/投递已验证（见 §0）。
5. **"禁止比较"指口径，不是指优化前后**：固定案例/评分/其他条件，记录本次改变的变量；指纹须含材料、提示词、规则、模型参数、预算。

---

## 3. 工作项（按依赖排序，一次一项）

### E1 案例准入与真实数据集（P0，阻塞基线）
**目标/验收**：准入 ≥1 个**可信故障**跑通；再扩到 3 个独立故障族、6–10 条轨迹。
**案例目录**（沿用历史约定）：
```text
fixtures/evals/<scenario>/
├─ benchmark.json      # cases + gold + distractors + labels
├─ logs/<service>.log  # 已脱敏（评测案例先脱敏，即使生产 S1 暂缓）
├─ repo/               # 固定版本的 fixture 仓库（含 gold + 干扰代码 + 历史）
├─ rules.md            # 可选：场景规则（唯一迭代对象）
└─ reviews.json        # 人工复核：{ "<caseId>": { "correct": true, "note": "..." } }
```
**准入清单（缺一不可）**：① 有原始现象（用户描述/工单文本）；② 有可脱敏日志且能复现现象；③ 能绑定到**具体代码版本**（记录 SHA）；④ 人工确认的 gold 根因；⑤ 至少 1 条 gold 证据可用源级定位命中；⑥ `distractors` 与 gold **同时间窗/同仓库**（表面相关、实际无关）。
**技术方案**：无需改运行器；新增目录 + `benchmark.json`；`logOnly: true` 的案例在报告与打分里标注"不评代码根因"。
**交付**：新 scenario 目录 + 一条 `docs/status.json#eval_mvp.cases` 计数；cases 至少 1 个通过 `npm run eval -- --scenario <新>`。
**风险**：无真实数据 → 阻塞；替代方案：先用脱敏公开历史 Bug（按准入清单）。

### E2 反证工程自测（P1）
**目标/验收**：端到端验证"审计判 `contradicted` → 报告 `refuted`"的降级链路；与质量成绩隔离。
**技术方案**：审计器工厂支持注入"脚本化审计器"（`--audit-mode supported|contradicted|undecidable`，仅 `--engine fake` 或显式 `--self-test`）；
写入 `fingerprint.auditMode`；`compare` 分组键加入 `auditMode`，避免与真实质量混淆。
**涉及**：`src/agent/fake-auditor.ts`（或新 `src/eval/scripted-auditor.ts`）、`src/eval/fingerprint.ts`、`scripts/eval.ts`、`tests/`。
**验收**：`npm run eval -- --scenario demo-checkout --self-test --audit on` 产出记录中 `report.hypotheses[0].status === "refuted"` 且 `completeness === "partial"`。

### E3 多轮 / 追问用例（P1）
**目标/验收**：测「材料不足是否合理追问」与「补材料后是否修正」。
**技术方案**：`benchmark.json` 的 case 增 `turns: [{ text, service? }]`（默认单轮）；
运行器用**同一调查**跑多条轮次（`MemorySessionSink.appendUserMessage` 已就绪），每轮记录 draft/validated/report；
打分增 `clarifyReasonableness`（`request_info` 的追问是否命中 `gold.missing` 定义的缺项）与多轮状态。
**涉及**：`src/eval/benchmark.ts`、`runner.ts`、`scorer.ts`、`scripts/eval.ts`。
**依赖**：E1（需要多轮真实案例）。
**风险**：轮次语义与生产 `runs.round` 一致性——只复用会话语义，不引入 DB。

### E4 人工复核工作流（P0，基线的必要条件）
**目标/验收**：`reviews.json` 落地；未复核 `unscored`，复核后 `calibrated=true` 且汇总给 `reviewedCorrect`。
**技术方案**：新增 `scripts/eval-review.ts`：读 JSONL，逐 case 打印 draft/report/证据，写回 `reviews.json`（`--case <id> --correct/--wrong --note`）。
**涉及**：`scripts/eval-review.ts`、`src/eval/report.ts`、`docs`。
**验收**：同一 scenario 复核后 `npm run eval:compare` 显示 `reviewedCorrect`。

### E5 冻结第一版质量基线（P0）
**目标/验收**：固定案例/材料/配置跑真实模型（`--engine pi`），保存全部结果 + 人工复核；写入 `docs/status.json#eval_mvp`。
**技术方案**：不加代码（用 E1–E4 的产物）；基线文件记 `gitRev/scorerVersion/materialHash/model/budget` 与逐 case 结果；明确标注 `unscored` 部分。
**验收**：`docs/status.json#eval_mvp` 有 baseline 块；文档声明"旧 v1/v2 基线不可复现、不可同表"。
**风险**：真实模型波动 → 记录多次与分布，不做稳定性断言。

### E6 单项优化循环（P1）
**目标/验收**：每次只改一个变量（rules / 提示词 / 审计开关），同一批 case 比较收益、成本、退化。
**技术方案**：`rules.md` 条目化（对齐 backlog A3），经 `buildSystemPrompt` 注入（已支持 `rulesFile`）；
`npm run eval -- --scenario <s> [--rules <file>]`；用 `eval:compare` 比较 `rules=` 分组。
**禁区**：不改 `benchmark.json`/`scorer.ts`。
**验收**：一次优化前后各一份 JSONL，compare 输出差异；结论写 `docs/evolve-protocol.md`（历史）或本文件附录。

### E7 CI 门禁（P2）
**目标/验收**：PR 跑 smoke scenario，工程级失败（run failed / 无报告 / 无效引用超阈值）即 fail；**不用未复核的语义正确率卡门禁**。
**技术方案**：`--threshold recall=.. --max-failed=..` → 非零退出码；`npm run eval:accept`。
**涉及**：`scripts/eval.ts`、CI 配置、roadmap。

### E8 Langfuse 数据集/评审集成（P2，可选）
**目标**：把 eval records 导出为 Langfuse dataset 供 UI 复核；本地 `reviews.json` 仍是真相源。
**依赖**：观测配置（`TD_OBSERVABILITY_*`）；不阻塞基线。

### E9 评测口径守卫（P1）
**目标**：防止优化过程刷分；防止跨口径比较。
**技术方案**：`compare` 已带版本；新增测试：`scorerVersion` 常量、字段语义、`benchmark.json` 校验；`docs:check` 增加"评测基线数字必须标 scorerVersion"的检查（可选）。
**涉及**：`tests/unit/eval-*.test.ts`、`scripts/check-docs.mjs`（可选）。

---

## 4. 执行规程（zcode 每次会话）

1. 先 `npm run typecheck && npm test && npm run docs:check`，全绿再动。
2. 认领一个工作项（E1…E9），在本文把状态改为「进行中」。
3. 实现 → `typecheck` → `test` → `npm run eval -- --scenario demo-checkout --runs 3`（离线自测）→ 更新本文状态/`status.json`/`session-handover.md`。
4. `commit`（信息写清"改了什么/为什么/口径版本"）+ `push`。
5. 新迁移从 `007_` 起（本方案预期**无迁移**）；改判定口径必须递增 `EVAL_SCORER_VERSION` 并在提交信息注明。

---

## 5. 已知限制（不要越界宣称）

- 内存运行器**不覆盖**：SQLite 持久化、调查隔离、Host finalize/投递/代次守卫、多进程恢复。
- `MemoryEvidenceSink` 明确是**测试/评测过渡**用途（见其文件头），不做去重、不落库。
- fake 引擎 token=0；真实模型 token 依赖会话条目 usage，需 E5 实测确认非零。
- 语义正确性在 E4 完成前一律 `unscored`；未复核数据不得用于"质量提升"结论。
- 日志证据无独立 traceId 字段，gold 用唯一子串定位；若后续 `LogQueryIntent` 加 `requestId`（backlog M2），gold 格式同步升级。
