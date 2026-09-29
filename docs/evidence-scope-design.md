# 证据作用域提升为调查级 —— 迁移与回滚方案

> 对应技术交接方案 §5.5（S5）。本文是实施前的设计定稿：先评审，再在**独立会话**中实现。
> 注意：旧文档把这项工作标为「OQ-33」——实际 `open-questions.md` 的 OQ-33 是已被 OQ-34 取代的
> JSONL 问题，属于误标；实现落地时把结论登记为 **OQ-38**。

---

## 1. 目标 / 验收

`E#` 从「run 内唯一」提升为「**调查内唯一**」：

1. 同一调查的第 2 轮从第 1 轮的最大编号**续签**（不重置为 E1）。
2. 报告可以引用**上一轮**的 `E#`；`validateDraft` 按调查内证据校验引用。
3. `validateDraft` 按调查校验引用与版本：引用不存在于本调查 → `evidence_not_found`；本轮证据 sha 与本轮钉的版本不符 → `version_mismatch`（语义见 §6.3）。
4. 报告证据列表按 `investigation_id` 查；Web 页展示不再局限本轮，跨轮引用的 chip 能渲染出处。
5. **历史数据不改写**：旧报告、旧证据行、session_entries 转录原样保留。

## 2. 现状（代码事实）

| 项 | 现状 |
|---|---|
| evidence 表 | `PRIMARY KEY (run_id, evidence_id)`（`migrations/001_init.sql:125`）；已有 `investigation_id` 冗余列与扁平 codeRef 列（repo_id/sha/path/start_line/end_line）；无调查级唯一约束 |
| 写入 | `Store.finalizeSuccess`（`store.ts:670`）与 `saveEvidence`（`store.ts:1072`）`INSERT OR IGNORE`，幂等 |
| 签发 | `prepare.ts:106` 每个 run `new EvidenceRegistry(runId, maxChars)`，counter 从 0 起 → 每轮都从 E1 重来 |
| 计数恢复 | `EvidenceRegistry.load(records)` 会把 counter 推进到已恢复记录的最大编号（`evidence.ts:59`） |
| process 路径 | Runner 不碰 DB；Host 在 `runner-executor.ts:39` 构造 `RunnerTask`（无证据信息），Runner 上报 `RunnerResult.evidence`，finalize `registry.load(args.evidence)` 后 `registry.all()` 全量落库 |
| 校验 | `finalize.ts:101` registry 只 hydrate **本轮**上报证据；`validateDraft` 用**本轮** `scope.repos` 校验 codeRef.sha |
| 展示 | `server.ts:181` 只返回 `listEvidence(最新报告.run_id)`；`web/app.js:167` 按 evidence_id 建 Map 渲染引用 chip |
| 评测 | `evals/score.ts` 按 locator（repo/path/line）对 gold 打分，不依赖 E# 数值；`evals/runner.ts` 单轮运行 |
| 调度不变量 | 同一调查严格轮次串行（队首约束 + `NOT EXISTS running`）→ 同一调查同一时刻只有一个 run 在签发证据 |

**冲突根源**：同一调查的第 1 轮与第 2 轮各自从 E1 签发 → 历史数据中 `(investigation_id, evidence_id)` **必然可能重复**。这排除了「直接加 `UNIQUE(investigation_id, evidence_id)`」的朴素迁移（会迁移失败或逼出数据重算）。

## 3. 方案选型

| 选项 | 做法 | 结论 |
|---|---|---|
| C. 整体重算 | 历史证据按调查重编号 + 改写 `reports.content` 里的 evidenceIds | **否**。session_entries 里的 pi 条目含带 `[E#]` 的工具输出原文，重编号等于篡改审计轨迹，违背「逐次落盘可回放可审计」；报告 JSON 改写风险高、收益只在历史数据的美观 |
| A. 新建调查级证据表 | 旧 `evidence` 冻结为遗留只读，新写 `investigation_evidence` | 可行但所有读路径永远要合并两表，复杂度长期化 |
| **B. 单表 + 部分唯一索引（选定）** | `evidence` 加列 `investigation_unique`（默认 0），只对新行置 1，并对新行建部分唯一索引 | 历史行零改动、读路径单表、新旧代码可共存 |

**选项 B 的关键点**：新行编号从「调查内历史最大编号」续起（> 所有历史行），因此新行与历史行、新行与新行之间在 `(investigation_id, evidence_id)` 上都无冲突——部分唯一索引只约束新行即可成立。同一调查轮次严格串行保证编号分配无竞争；单机单 Host 写入无并发竞争。

## 4. 详细设计

### 4.1 迁移 `006_evidence_scope.sql`

```sql
-- 证据作用域提升为调查级（docs/evidence-scope-design.md §4.1）。
-- 历史行保持原样（investigation_unique=0，不参与唯一索引）；
-- 新行由代码置 1，并从调查内最大编号续签（见 §4.2）。
ALTER TABLE evidence ADD COLUMN investigation_unique INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS ux_evidence_investigation
  ON evidence(investigation_id, evidence_id) WHERE investigation_unique = 1;

-- 调查级证据列表/校验 hydrate 的支撑索引
CREATE INDEX IF NOT EXISTS idx_evidence_investigation
  ON evidence(investigation_id, created_at);
```

- 不改历史行、不改主键；DDL 均可逆（见 §7）。
- SQLite 部分索引（3.8.0+）`node:sqlite` 完整支持。

### 4.2 签发：seed 续号

- `Store` 新增 `maxEvidenceNumber(investigationId): number`：
  `SELECT MAX(CAST(SUBSTR(evidence_id, 2) AS INTEGER)) FROM evidence WHERE investigation_id = ?`，空返回 0。
- `EvidenceRegistry` 构造函数增加可选 seed：`new EvidenceRegistry(runId, maxChars, seed?)`，`counter = seed`（缺省 0，行为与现在完全一致）。
- `prepare.ts` 的 `PrepareParams` 增加 `evidenceSeed?: number` 并透传给 registry；**缺省 0**，评测（单轮）与既有单测无需改动。
- seed 的来源（Host 查库，Runner 不碰 DB）：
  - 内联路径：`orchestrator.ts` 调 `store.maxEvidenceNumber(investigationId)` 后传入 `prepareDiagnosis`。
  - process 路径：`runner-executor.ts` 构造 `RunnerTask` 时查库，`protocol.ts` 的 `RunnerTask` 增加 `evidenceSeed?: number`（缺省 0，协议向后兼容）；`runner.ts` 透传。
  - 评测路径：`evals/runner.ts` 不传（每 case 独立）。

### 4.3 校验：finalize 按调查 hydrate

- `Store` 新增 `listEvidenceByInvestigation(investigationId)`：`WHERE investigation_id = ? ORDER BY created_at ASC, CAST(SUBSTR(evidence_id,2) AS INTEGER) ASC`。
- `finalize.ts`：
  1. `registry.load(store.listEvidenceByInvestigation(...))` —— 先恢复调查内历史证据；
  2. `registry.load(args.evidence)` —— 再覆盖本轮上报记录（同 ID 时以本轮原貌为准，恢复/reconcile 语义不变）；
  3. `validateDraft(draft, ...)` —— 引用存在性即按调查校验，跨轮引用自然通过。
- 结构性隔离保证：registry 只从**本调查**的行 hydrate，别的调查的证据在结构上进不来。

### 4.4 版本校验的跨轮语义（validateDraft）

现状：引用证据的 codeRef.sha 必须等于本轮 `scope.repos` 钉的 sha。跨轮引用上一轮证据时，sha 可能与本轮不同（仓库在两轮之间前进过），会误判 `version_mismatch`。

调整（最小改动、语义仍成立）：

- **本轮签发的证据**（`record.runId === registry.runId`）：维持原强校验（sha 必须等于本轮钉的 sha）——防的是模型拿非本轮材料充当本轮证据。
- **历史轮的证据**：不再与本轮 scope 强校验 sha。理由：该 sha 是签发时**程序回填**的事实，且 registry 已被结构性限定在本调查内；校验目标（不串材料、不引用未读版本）由 hydrate 范围保证。
- `EvidenceRegistry` 暴露 `get runId()` 供 `validateDraft` 判定；`validate.ts` 相应加一个分支与单测。

### 4.5 落库：只写本轮新签发，历史证据不重插

hydrate 之后 `registry.all()` 会包含历史证据，而 `finalizeSuccess` 写库时把所有记录都挂到**本轮** `run_id` 下 → 历史证据被重复插入（并触发部分唯一索引冲突）。修正：

- `EvidenceRegistry` 拆分读取语义：`all()`（全部，供校验）与 `issued()`（本轮签发 = `runId === registry.runId` 的记录，供落库/上报）。
- `finalize.ts` 落库改用 `registry.issued()`；`orchestrator.ts:122` 与 Runner 上报路径同步检查（它们本来就只含本轮签发，语义不变）。

### 4.6 展示

- `server.ts` 调查详情：`evidence: store.listEvidenceByInvestigation(investigation.id)`。
- `web/app.js` 无需改动：`evidenceById` 按 ID 建映射，调查内 ID 唯一后，跨轮引用的 chip 自动能渲染 title（source）。
- 报告文本渲染（`renderReportText`）只引用 ID，不受影响。

### 4.7 评测与既有测试

- 评测打分按 locator，不依赖编号；每 case 独立 run，不传 seed，行为不变。
- 既有单测（toolbox/evidence/scheduler 等）不传 seed，行为不变。
- `tests/integration/host-api.test.ts`、`fault.test.ts` 里的证据断言：单轮场景编号仍从 E1 起，不受影响。

## 5. 测试计划

1. **单元**（`tests/unit/evidence.test.ts` 扩充）：seed 续号；`load()` 与 seed 交互（counter 取 max）；`issued()`/`all()` 拆分语义；`validateDraft` 历史证据 sha 分支（本轮 sha 强校验 + 历史 sha 信任）。
2. **迁移**：构造含同一调查两轮重复 `(investigation_id, evidence_id)` 历史数据的库 → `006` 迁移成功；唯一索引不拦历史行；新写入置 1 且续号成功。
3. **集成**（新 `tests/integration/evidence-scope.test.ts`）：同一调查两轮——第 1 轮签发 E1..E2；第 2 轮 seed=E2，签发 E3..，报告**引用 E1** → finalize 通过、evidence 表两轮齐全、`GET /investigations/:id` 返回调查级证据列表。
4. **故障注入补充**：租约回收后旧执行者按旧 seed 重复提交 → `generation` 守卫照常拒绝（机制不变，加断言）。

## 6. 风险与开放点

| 风险 | 缓解 |
|---|---|
| Host/Runner 版本漂移窗口内，旧 Runner（无 seed）上报 E1 与历史 E1 撞部分唯一索引 → `INSERT OR IGNORE` 静默丢证据 | 本项目 Runner 由 Host 同进程 spawn（同版本），无独立升级窗口；风险登记为理论项。真要防御可在 finalize 校验「本轮上报编号 > 调查历史最大编号」并告警 |
| 历史证据 hydrate 量级 | 单调查证据数十条量级，同步 SQLite 查询无压力 |
| `E10 < E2` 字符串排序 | 展示/查询一律 `created_at` 为主、`CAST(SUBSTR(evidence_id,2) AS INTEGER)` 为次，不做字典序展示 |
| 评测口径 | 打分按 locator，不受编号影响；跨轮引用会让「引用精确率」分母语义更真实（M2 评测时注意标注） |

## 7. 回滚方案

- **迁移回滚**（均可逆，历史数据零改动所以无数据回滚）：
  ```sql
  DROP INDEX IF EXISTS ux_evidence_investigation;
  DROP INDEX IF EXISTS idx_evidence_investigation;
  ALTER TABLE evidence DROP COLUMN investigation_unique;  -- node:sqlite 绑定的 SQLite ≥3.35 支持；
                                                          -- 若环境不支持，保留该列无害（旧代码不写、索引已删）
  ```
- **代码回滚**：`evidenceSeed` 缺省 0、`investigation_unique` 默认 0、索引只在置 1 的行上生效 → 任意一层先回滚，系统都回到 run 内编号语义；三层独立可退（先退 seed 传递，再退 finalize hydrate，最后删索引/列）。
- **上线顺序**：先迁 DB（向后兼容 DDL，旧代码照常跑）→ 再发代码。单机部署无灰度问题。

## 8. 实现会话的执行清单（一次只做一件，按序）

1. `006_evidence_scope.sql` + Store 三方法（`maxEvidenceNumber` / `listEvidenceByInvestigation` / `finalizeSuccess` 写列与 `issued()`）+ 迁移测试。
2. `EvidenceRegistry` seed + `issued()/all()` + `runId` getter + 单测。
3. `validateDraft` 历史证据分支 + 单测。
4. `prepare.ts` / `orchestrator.ts` / `protocol.ts` / `runner-executor.ts` / `runner.ts` 传 seed。
5. `finalize.ts` 调查级 hydrate + 集成测试 `evidence-scope.test.ts`。
6. `server.ts` 展示 + web 验证。
7. 文档：OQ-38 登记结论、修正 OQ-33 误标（onboarding T6 / handover 待办）、roadmap 勾选、handover §六。
