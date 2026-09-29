# 证据持久化与稳定 UID 设计（Evidence Durability + Stable UID）

> 状态：**设计定稿，待实现**。取代 `docs/evidence-scope-design.md`（那份的"选项 B：部分唯一索引 + seed 续号"不再单独实施，
> 其"调查内短号续签"思想被本文 §3 吸收）。
> 实现会话请按本文 §11 的顺序做，一次一件事，遵守 `docs/handover.md §7` 的 DoD。
> 本文所有接口名/表名/常量为**建议实现细节**，以本文为准；偏离前先在 `docs/open-questions.md` 登记。

---

## 0. 背景（代码事实，已核对）

| 事实 | 位置 |
|---|---|
| 证据只在**报告提交**时落库：`Store.finalizeSuccess` 内 `INSERT OR IGNORE INTO evidence` | `src/storage/store.ts:670+` |
| `Store.insertEvidence()` 是**死代码**（无调用者） | `src/storage/store.ts:1074` |
| 证据在内存里攒：`EvidenceRegistry`（run 内 `E1..`，同内容复用同号） | `src/diagnosis/evidence.ts` |
| 工具在执行时注册证据并把 `[E#]` 文本返回给模型 | `src/agent/toolbox.ts` |
| Host↔Runner 只有单向业务消息（Runner→Host），Host→Runner 仅 `cancel` | `src/runner/protocol.ts`、`src/host/runner-executor.ts` |
| 恢复是**纯函数**，不查库 | `src/agent/session-recovery.ts` |
| 评测**不写库**：直接 `prepareDiagnosis → engine.run → validateDraft` | `src/evals/runner.ts` |

**缺陷**：模型看到 `[E#]` 时材料尚未入库；崩溃/超时/取消后该批材料丢失，重试可能重查出不同内容/版本，
"引用"与"材料"不是同一时刻的事实 → 无法保证模型引用的材料一定可回放。本设计修此缺陷。

---

## 1. 可验证目标（验收）

1. 同一调查跨轮引用不混淆；历史两轮的各自 `E1` 仍能按原报告解析（v1）。
2. 模型拿到证据引用时，对应材料**已持久化**（两条路径：内联 Host 与独立 Runner 均然）。
3. 重复提交、中断恢复不覆盖材料、不制造悬空引用。
4. 旧报告、旧会话原文**零改写**，新旧报告都能展示。
5. 保存确认失败时**不把未确认材料交给模型**（fail-closed）。

---

## 2. 关键决策（评审结论，实现时不得擅改）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 身份 = `evidence_uid`（全局唯一，Host 事务内分配）。全局唯一索引。 | 身份与展示编号解耦 |
| D2 | 展示短号 = `evidence_id`，**调查内**递增 `E{n}`，Host 在 commit 事务内按调查内最大 `n` +1 分配。历史 run 级 `E#` 原样保留。 | 模型/报告/展示继续用 `[E#]`，无需大改；新号 > 历史最大 → 不与历史冲突 |
| D3 | `batch_id` 由**工具**生成（`randomUUID()`，每个工具结果一个批次）。 | 幂等键稳定、重投同批次 |
| D4 | `evidence_uid` 与 `evidence_id` 由 **Host** 在事务内分配，随 ACK 返回；工具不预生成身份。 | 编号连续性/唯一性必须原子；不信任 Runner 身份字段 |
| D5 | 恢复查找键 = `evidence_batches (run_id, tool_call_id)` 唯一。 | 崩溃后新进程能按 toolCallId 找回批次，§8 才能成立 |
| D6 | 取消"跨调用同内容去重"：每次工具调用各签一批（同批内 `item_index` 唯一）。 | 按原提案；**注意这改变现有 `EvidenceRegistry` 去重行为，评测引用精确率口径会变，M2 重跑基线** |
| D7 | 报告引用：v1 = `(run_id, E#)`；v2 = `evidence_uid`。新增 `reports.reference_format_version`（旧报告默认 1），报告 JSON 内也带同名字段。 | 新旧共存，可分别解析 |
| D8 | `finalizeSuccess` **不再写 evidence**；只写 report + 终态 + 投递。证据已在工具 commit 时写入。 | 单次写入、可回放 |
| D9 | commit 失败 = **终止本轮**（fail-closed）。工具内有限重试（默认 3 次，指数退避）后仍失败 → 抛错 → 本轮按可重试错误失败。 | 见 §5.4 |
| D10 | 历史证据 sha 与本轮 scope sha 不同时：**允许引用**，但若某假设的**全部**支撑证据 sha 都 ≠ 本轮 scope sha → 强制 `supported → candidate` 并记 correction。 | 不拿旧版本冒充本轮验证通过 |
| D11 | 失败/取消轮次已 commit 的证据**保留**（审计事实）；hydrate/展示按 `run_id/attempt` 分组；报告只要求"被引用的证据存在"。 | 逐次可回放 |
| D12 | 协议加 `protocolVersion`（常量 `EVIDENCE_PROTOCOL_VERSION = 2`）。Host/Runner 不匹配 → 硬失败（拒绝本轮），不做双向协商。 | Runner 由 Host 同仓库 spawn，协商是过度设计 |
| D13 | 评测走**同款 Store sink**（`:memory:` 库 + 合成 `running` run），不用内存 sink 绕过；`MemoryEvidenceSink` 仅供单测。 | 评测必须测线上行为 |

---

## 3. 数据模型

### 3.1 迁移 `migrations/006_evidence_uid.sql`

```sql
-- 证据持久化与稳定 UID（docs/evidence-uid-design.md §3）。
-- 历史行零改写：只回填 UID（不动作业内容、不改主键、不改 evidence_id）。

ALTER TABLE evidence ADD COLUMN evidence_uid TEXT;
ALTER TABLE evidence ADD COLUMN batch_id TEXT;
ALTER TABLE evidence ADD COLUMN item_index INTEGER;

-- 回填历史行 UID（不透明字符串即可；新行由代码用 randomUUID）
UPDATE evidence SET evidence_uid = lower(hex(randomblob(16))) WHERE evidence_uid IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_evidence_uid ON evidence(evidence_uid);
CREATE INDEX IF NOT EXISTS idx_evidence_batch ON evidence(batch_id, item_index);
CREATE INDEX IF NOT EXISTS idx_evidence_investigation ON evidence(investigation_id, created_at);

CREATE TABLE IF NOT EXISTS evidence_batches (
  batch_id         TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  run_id           TEXT NOT NULL,
  attempt_id       TEXT NOT NULL,
  generation       INTEGER NOT NULL,
  tool             TEXT NOT NULL,
  tool_call_id     TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  result_json      TEXT NOT NULL,      -- 结构化工具结果（pre-ID），用于恢复重建与内容一致性校验
  created_at       INTEGER NOT NULL,
  UNIQUE (run_id, tool_call_id)
);
CREATE INDEX IF NOT EXISTS idx_evidence_batches_investigation
  ON evidence_batches(investigation_id, created_at);

ALTER TABLE reports ADD COLUMN reference_format_version INTEGER NOT NULL DEFAULT 1;
```

**约束与不变量**

- `evidence` 主键仍为 `(run_id, evidence_id)`；新增 `evidence_uid` 全局唯一。
- 同一 `(batch_id, item_index)` 唯一。
- 同一 `evidence_uid` 不允许对应不同内容（插入前查冲突则 reject）。
- 相同批次、相同 `payload_hash` 重发 → 返回原映射（幂等）。
- 相同批次、不同 `payload_hash` 重发 → `evidence_reject`（conflict），**禁止静默忽略**。
- 回滚：见 §10。`ALTER ... DROP COLUMN` 在 SQLite ≥3.35 可用；不可用则保留列无害。

### 3.2 语义

- `evidence.evidence_id`：调查内短号 `E{n}`，Host 分配；**新号从调查内历史最大 n 续起**（`SELECT MAX(CAST(SUBSTR(evidence_id,2) AS INTEGER)) WHERE investigation_id=? AND evidence_id GLOB 'E[0-9]*'`）。
- `evidence.evidence_uid`：身份，报告 v2 引用它。
- `evidence.batch_id/item_index`：溯源到采集批次与批次内位置。
- `evidence_batches.result_json`：结构化 items（**尚未分配 ID** 时的形态）；恢复时结合 evidence 行重建模型可见文本（§8）。

---

## 4. 模块与接口（TS）

新增 `src/evidence/`：

```ts
// src/evidence/types.ts
export interface EvidenceItem {
  kind: "log" | "code";
  source?: string;          // 未给则由 codeRef 生成
  excerpt: string;
  time?: number;
  level?: string;
  codeRef?: { repoId: string; sha: string; path: string; startLine: number; endLine: number };
}
export interface EvidenceRef extends EvidenceItem {
  evidenceUid: string;      // 身份
  evidenceId: string;       // 展示短号 E{n}
  truncated: boolean;
}
export interface EvidenceCommitRequest {
  batchId: string;
  tool: string;
  toolCallId: string;
  payloadHash: string;      // sha256(canonicalJson(items))
  items: EvidenceItem[];
  result: unknown;          // 结构化工具结果（pre-ID）
}
export interface EvidenceCommitResult {
  refs: EvidenceRef[];      // 与 items 同序
}
export interface EvidenceSink {
  /** 保存并等待确认；失败抛错（由工具让本轮失败）。 */
  commit(req: EvidenceCommitRequest): Promise<EvidenceCommitResult>;
}
// 校验/展示用：按 uid（v2）或 (runId, evidenceId)（v1）解析
export interface EvidenceResolver {
  byUid(investigationId: string, uid: string): EvidenceRef | undefined;
  byRunShortId(runId: string, evidenceId: string): EvidenceRef | undefined;
  listByInvestigation(investigationId: string): EvidenceRef[];
  readonly currentRunId: string;
}
```

实现：

| 实现 | 用途 |
|---|---|
| `MemoryEvidenceSink`（`src/evidence/memory-sink.ts`） | **仅单测**；内存分配 `E1..`，不做去重（D6），`commit` 立即返回 |
| `StoreEvidenceSink`（`src/evidence/store-sink.ts`） | Host 内联路径；调用 `Store.commitEvidenceBatch` |
| `IpcEvidenceSink`（`src/evidence/ipc-sink.ts`） | Runner 路径；把 `evidence_commit` 写 stdout，等待 Host 的 `evidence_ack`/`evidence_reject` |

共享渲染器 `src/evidence/render.ts`：`renderEvidenceResult(tool, items, refs): string`，工具返回文本与恢复重建**共用同一函数**，保证一致。

`prepareDiagnosis` 增加 `sink: EvidenceSink` 入参（默认 `MemoryEvidenceSink`，评测/生产显式传入），返回 `{ input, scope, sink, resolvedEvidence?, missingMaterial }`；
`DiagnosisToolbox` 依赖从 `EvidenceRegistry` 改为 `EvidenceSink` + `EvidenceResolver`（校验时用）。

> `EvidenceRegistry` 与 `src/diagnosis/evidence.ts`：要么删除，要么降级为 `MemoryEvidenceSink` 的内部实现；不得保留第二套编号语义。

---

## 5. 写入路径（两阶段提交）

### 5.1 时序

```text
pi 发出 tool_call（assistant 的 toolCall 条目已先落 session）
  → 工具查询日志/源码，构造 items + result（无 ID）
  → 生成 batchId = randomUUID()，payloadHash = sha256(canonical(items))
  → sink.commit(...)
      ├─ 内联：Store.commitEvidenceBatch(...)
      └─ Runner：stdout evidence_commit ─→ Host 处理 ─→ stdin evidence_ack/reject
  → Host 事务内：校验资格 → 幂等判定 → 分配 uid/E# → 写 batch+evidence → COMMIT
  → ACK 返回 refs（uid + E#）
  → 工具用 refs 渲染文本（含 [E#]），返回给 pi
  → pi 落 tool_result 条目，继续推理
```

**关键**：工具 `execute` 必须 `await commit` 成功后才返回；`timedTool`（`src/agent/pi-engine.ts:141`）自然把 commit 失败记为 `ok:false` 并上抛。

### 5.2 Host 事务：`Store.commitEvidenceBatch`

入参与守卫（身份**由调用方从实际派发任务注入**，不读消息字段）：

```ts
commitEvidenceBatch(input: {
  batchId: string; tool: string; toolCallId: string; payloadHash: string;
  items: EvidenceItem[]; result: unknown;
  investigationId: string; runId: string; attemptId: string; generation: number;
}): { ok: true; refs: EvidenceRef[] } | { ok: false; code: "lease_lost" | "conflict" | "content_conflict"; message: string }
```

事务内步骤：

1. `SELECT id FROM runs WHERE id=? AND generation=? AND status='running'`；不在 → `lease_lost`。
2. 查 `evidence_batches WHERE batch_id=?`：
   - 存在且 `payload_hash` 相同 → 按 `batch_id` 读 evidence，返回原 refs（幂等，不重复写）。
   - 存在且 `payload_hash` 不同 → `conflict`。
3. 查 `evidence_batches WHERE run_id=? AND tool_call_id=?`：
   - 存在且 `batch_id` 不同 → `conflict`（同一 tool_call 只能一个批次）。
4. `INSERT evidence_batches`。
5. 逐条 `item`：`n = max+1`（调查内）；`uid = randomUUID()`；`INSERT evidence(... evidence_id=E{n}, evidence_uid=uid, batch_id, item_index=i ...)`；若 uid 冲突（理论不会）→ `content_conflict`。
6. `COMMIT`，返回 refs。

`payload_hash`：Host 用收到的 `items` 重算并比对，防止传输损坏/篡改。

### 5.3 内联路径

- `orchestrator.ts`：`prepareDiagnosis(config, { ..., sink: new StoreEvidenceSink(store, runCtx) })`，`runCtx = { investigationId, runId, attemptId, generation }`。
- `finalize.ts`：不再写 evidence（D8）；校验走 resolver。

### 5.4 保存失败策略（D9）

- `IpcEvidenceSink`：每次 commit 最多重试 `EVIDENCE_COMMIT_MAX_ATTEMPTS`（默认 3，指数退避 200ms 起），**重发必须同 `batchId` + 同 payload**。
- 仍失败 → 抛 `EvidenceCommitError` → 工具失败 → 本轮失败（可重试错误码，走现有 `failRun`）。
- 绝不返回未确认材料给模型。

---

## 6. Host／Runner 协议

`src/runner/protocol.ts` 增加：

```ts
export const EVIDENCE_PROTOCOL_VERSION = 2;

// RunnerTask 增加（向后不兼容，故用 protocolVersion 硬校验）
protocolVersion: number;
// 恢复用：Host 建任务时按 (runId, toolCallId) 查已提交批次，重建为可直接补记的结果
savedToolResults?: Array<{ toolCallId: string; toolName: string; text: string; isError: boolean }>;

// Runner → Host
| { type: "evidence_commit"; batchId: string; tool: string; toolCallId: string; payloadHash: string; items: EvidenceItem[]; result: unknown }
// Host → Runner
| { type: "evidence_ack"; batchId: string; refs: EvidenceRef[] }
| { type: "evidence_reject"; batchId: string; code: "lease_lost" | "conflict" | "content_conflict" | "internal"; message: string }
```

Host 处理（`src/host/runner-executor.ts`）：

- 收到 `evidence_commit`：用 `claimed`（`run.id/attemptId/generation/investigationId`）注入身份调用 `commitEvidenceBatch`；成功写 `evidence_ack`，失败写 `evidence_reject`。
- Host→Runner 写 stdin 要与现有 `cancel` 共用一条通道；Runner 的 stdin 读取循环（`src/entrypoints/runner.ts`）增加对 `ack/reject` 的分发。
- **发送前**校验 `task.protocolVersion === EVIDENCE_PROTOCOL_VERSION`，否则不派发（判本轮失败）——Runner 侧也在 `ready` 里回 `protocolVersion`，Host 校验后再接受其消息。

**输出解析要区分错误**（原提案要求，实现必须做到）：

- `child.stdout` 某行 `JSON.parse` 失败 → 协议错误 → 终止本轮（`runtime_error`），不再"忽略非法行"。
- `commitEvidenceBatch` 抛异常（DB 故障）→ `evidence_reject{code:"internal"}`；Runner 视为可重试 commit；超限则本轮失败。

---

## 7. 工具层接入

- `DiagnosisToolbox` 的 `queryLogs / listFiles / searchCode / readCode`：
  1. 采集材料 → 组 `EvidenceItem[]`；
  2. `const { refs } = await this.deps.sink.commit({ batchId: randomUUID(), tool, toolCallId, payloadHash, items, result })`；
  3. 用 `renderEvidenceResult(tool, items, refs)` 生成返回文本（含 `[E{n}]`）；
  4. 计入 `maxToolCalls` 预算与 `maxToolResultChars` 截断（逻辑不变，只是"先 commit 再截断渲染"）。
- `submit_report` / `request_info` 不 commit 证据（无材料）。
- `tool_call_id`：`defineTool.execute(id, params)` 的 `id` 即 pi 的 toolCallId，直接透传。
- `recordTool`（T3 可观测）保持不变；可选：把 `batch_id` 也写进 `tool_executions`（可后置）。

---

## 8. 恢复（崩溃/中断）

`reconcileSession` 改造（保持纯函数）：

```ts
reconcileSession(
  entries: SessionEntry[],
  savedResults?: Map<string, { toolName: string; text: string; isError: boolean }>,
): ReconcileResult
```

- 扫描"已发起但无结果"的 tool_call：
  - `savedResults` 命中 → 补一条**保存结果**的 `toolResult`（`isError:false`，`content` = 保存文本）。
  - 未命中 → 补现有 `TOOL_OUTCOME_UNKNOWN`（`isError:true`）。
- 顺序（D5）：Host 建 `RunnerTask` 时先按 `(runId, toolCallId)` 查 `evidence_batches` + evidence，调用共享 `renderEvidenceResult` 重建文本，填入 `savedToolResults`；Runner 在 `reconcileSession` 前拿到的就是它。
- 只修"未结束的会话尾部"；已结束历史不改。

| 恢复时状态 | 处理 |
|---|---|
| 有调用、无已保存批次 | 补 `outcome unknown`（不编造成功） |
| 批次已保存、会话无 tool_result | 用保存结果补记一次 |
| 会话已有 tool_result | 原样继续，禁止重复补记 |
| 报告已提交、进程未退出 | 以 DB 终态为准，不重生成/重复投递 |

---

## 9. 报告引用与校验

### 9.1 格式

- `reports.reference_format_version`：1（历史，默认）/ 2（新）。
- v1：`hypotheses[].evidenceIds` 为 `E#`，解析用**该报告的 `run_id`**。
- v2：`evidenceIds` 为 `evidence_uid`，解析用**当前调查**。
- `validateDraft` 的输入从 `EvidenceRegistry` 改为 `EvidenceResolver`。

### 9.2 提交新报告

1. 模型草稿里的引用可能是本轮 `E#`（工具返回）或历史 UID（证据目录）。解析规则：
   - 命中已知 `evidence_uid` → 用 uid；
   - 否则按 `(investigationId, E#)` 查（新行调查内唯一）；命中多条历史 → `evidence_not_found`（要求用 UID）。
2. 校验：引用属本调查 + 存在；从 DB 回填 `kind/source/excerpt/codeRef`。
3. 版本规则（D10）：本轮证据强校验 sha；历史证据不做 sha 强校验；若某假设**全部**支撑证据的 sha ≠ 本轮 scope sha → 降为 `candidate` 并记 `corrections`。
4. 报告 v2 的 `evidenceIds` 统一写成 **uid**；`renderReportText` 通过 `uid → E#` 映射展示（映射缺失时显示 uid 短前缀）。
5. `finalizeSuccess` 不再写 evidence（D8）。

### 9.3 展示

- `GET /api/agent/investigations/:id` 返回**调查级**证据列表（含 `evidence_uid`、`evidence_id`、`batch_id`、`run_id`、来源），并对报告 content 做 v1/v2 分派解析。
- Web（`src/host/web/app.js`）：证据 Map **按 uid** 建（v2），v1 用 `(run_id, evidence_id)`；不要把新旧裸 `E#` 混进同一 Map。
- 历史会话正文的 `E#` **不改写**；证据目录附带"原轮次 + UID"。

---

## 10. 迁移与回滚

**上线顺序**

1. 暂停领取新任务，等在跑的 Runner 结束或明确中断。
2. 备份 DB，在副本上验证迁移。
3. 应用 `006`（回填 UID），核对数量：`SELECT COUNT(*) FROM evidence WHERE evidence_uid IS NULL` 必须为 0；`ux_evidence_uid` 建立成功。
4. 部署支持新旧读取的新 Host+Runner（同仓库、同协议版本）。
5. 校验 `protocolVersion` 后开启新写入模式（可先用开关 `TD_EVIDENCE_MODE=legacy|uid`，默认 `legacy` 直到验证通过）。

**回滚**

- 关新写入：`TD_EVIDENCE_MODE=legacy`（回到"finalize 写 evidence、run 内 E#"路径）。
- 已写入的 UID/批次**保留**；不把新报告改回 E#；不承诺旧程序能读新报告（文档写明）。
- SQL 回滚：删索引/表与列（或保留列无害）。

---

## 11. 实施顺序与测试（一次一件）

| 阶段 | 范围 | 必须通过 |
|---|---|---|
| 1 | `006` 迁移 + `Store.commitEvidenceBatch` + `listEvidenceByInvestigation` + `getBatchByToolCall` | 失败事务无半批数据（无 batch、无 evidence）；幂等重发返回原 refs；同批不同 hash → conflict；同 tool_call 第二批 → conflict；历史行 UID 回填唯一 |
| 2 | `src/evidence/`（types/render/memory-store sink）+ `toolbox` 接入 + 内联（orchestrator）| **commit 成功前工具不返回**；工具返回文本含正确 `[E#]`；commit 失败 → 本轮失败；`prepare`/`finalize` 切换 |
| 3 | 协议 `protocolVersion` + `evidence_commit/ack/reject` + `runner-executor` + `runner.ts` | ACK 丢失重投同内容幂等；`evidence_reject` 超限 → 本轮失败；非法 stdout 行 → 本轮失败（不再忽略）；旧 generation → `lease_lost` |
| 4 | 恢复：`savedToolResults` + `reconcileSession(entries, saved)` | 五个崩溃点各强杀一次：commit 前 / commit 后 ACK 前 / ACK 后会话写入前 / 会话写入后 / 报告提交后；补记不重复 |
| 5 | 报告 v1/v2、`validateDraft` resolver、`finalize`、`server.ts`、`web/app.js` | 新旧报告都能展示；跨轮引用（uid）通过；跨调查引用拒绝；历史 sha 降级 corrections；证据列表调查级 |
| 6 | 评测走 Store sink（`:memory:` + 合成 run）；文档回填 | `npm run eval` 跑通；基线重跑并记录（D6 口径变化） |

**既有测试的兼容**：单测可继续用 `MemoryEvidenceSink`；`pipeline/fault/host-api/runner-process/host-restart` 需按新落库时机调整断言（证据在工具时已入库，而非 finalize 后）。

---

## 12. 文档更新清单（实现完成后）

- `docs/interface.md §8.7`：把"证据在 finalize 同事务写入"改为"工具 commit 时写入"。
- `docs/open-questions.md`：登记本设计结论（建议 OQ-38），并修正之前把证据作用域误标为 OQ-33 的地方。
- `docs/evidence-scope-design.md`：顶部标注"被 `evidence-uid-design.md` 取代"。
- `docs/handover.md §六`、`docs/host-runner-design.md`、`docs/handover-technical-plan.md §5.5`、`docs/roadmap.md`/`backlog.md`、`docs/contributor-onboarding.md T6`：同步状态。
- `docs/session-log-design.md`：补"证据批次与恢复"小节。

---

## 13. 开放风险

| 风险 | 缓解 |
|---|---|
| `legacy|uid` 双模式期，legacy 写入的 run 级 `E#` 与 UID 模式并存 | 迁移窗口内暂停新任务；`TD_EVIDENCE_MODE` 一次性切换；测试覆盖两模式读 |
| 同 tool_call 只允许一个批次，若 pi 内部重试同一 call 会 conflict | 正常不会；若发生，`conflict` 让本轮失败，便于暴露 |
| 批次 `result_json` 与 evidence 行重复 | `result_json` 只存结构化结果与批次元信息，材料正文以 evidence 行为准；有界（已按 maxResultChars 截断） |
| D6 去重取消导致证据数上涨、评测精确率口径变化 | 记录并在 M2 重跑基线；若明显劣化再评估"调查内同内容复用" |
| 历史 UID 回填用 `hex(randomblob(16))` 与 `randomUUID()` 格式不同 | UID 是不透明字符串，仅要求唯一；文档写明 |
| `reconcileSession` 重建文本与原始不完全一致 | 用共享 `renderEvidenceResult` 重建；仅用于"会话缺 tool_result"时补记，不改写已有正文 |
