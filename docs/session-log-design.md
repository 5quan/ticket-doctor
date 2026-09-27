# 会话日志（JSONL）设计：对齐 pi durable storage

> 状态：待探讨（设计稿）。本文件只定义目标、契约与落地阶段，不代表已实现。
> 相关：`docs/interface.md §7/§8.7`（接口约束）、`docs/handover.md`（实现现状）、
> `backlog.md P1/A7/A9`、`open-questions.md`（决策记录）。
> 参考源码：`/opt/pi/packages/agent/src/harness/session/**`、`runtime/**`；
> `/opt/deepseek-harness/packages/core/session/**`、`packages/session/session-persistence-jsonl/**`。

## 0. 背景与问题

会话 JSONL 现在是 ticket-doctor 的**模型层真相源**：工具入参/结果、模型消息、usage、compaction
都写在这里，`runs`/`attempts` 只存指针与汇总。当前实现（`src/diagnosis/session-log.ts`）是
"`{seq,type,id,parentId,time,data}` 自由事件 + `appendFileSync`"，存在三个结构性问题：

1. **不类型化**：事件是 `type + data: Record<string, unknown>`，没有编译期/运行期契约，
   加字段靠约定；`readSessionLog` 只能做 JSON 级校验。
2. **尝试不自洽**：崩溃/超时可能留下"有 `tool_started`、无 `tool_completed`"的悬空记录，
   事后审计分不清"没查到"和"没查过"。
3. **无持久屏障**：`appendFileSync` 不 fsync，指针更新与内容落盘没有"提交点"语义。

## 1. 借鉴来源与取舍

| 来源 | 核心思路 | 我们借鉴 | 我们不借鉴 |
|---|---|---|---|
| **pi agent-core durable**（主参考） | 会话是**类型化事务写日志**：`entry / usage / value / list`；monotonic seq；提交前校验（id 唯一、parent 存在）；`value/list` 存非消息状态；pending 帧作为有界已提交前缀；恢复时从已提交帧 settle 孤儿 assistant；`publishFileAtomically`（tmp+rename） | **存储契约**：事务信封、写类型、校验、`value/list` 槽、flush 屏障、崩溃恢复不重调 provider | 它的 **lane / operation 状态机**（等于重写 agent loop）、**`parentId` 树 + fork/branch**、**InMemoryStorageState 全量物化** |
| **pi coding-agent SessionManager** | 单文件 JSONL 会话树，`buildSessionContext` 按 `parentId` 重建；torn tail 补换行 + 跳畸形行 | **torn-write 恢复**、**header 校验**、**重放=重建** 的直觉 | 树/`/tree`/`/fork`/`/clone`（调查是线性多轮，不需要分支）；`context_edit` 机制 |
| **dsh** | append-only typed event；surface vs log-only；不可变 generation + 格式迁移链；内核 `flock` 写租约；崩溃不截断，恢复时追加 synthetic closers 平衡 turn | **格式版本 + 迁移**、**surface/log-only 分类**、**崩溃后补收尾、tool 结果标 outcome unknown** | 不可变 generation 文件 / zstd / 内核锁（我们是单机多 worker + 租约代次，见 §6） |

**一句话**：借用 pi 的**存储契约**与 dsh 的**恢复语义**，保留 ticket-doctor 自己的
**SQLite 业务状态机 + run 租约/代次**。

## 2. 目标与非目标

### 目标
- **G1 契约化**：JSONL 成为类型化写日志，写类型集中在端口，编译期 + 运行期都可校验。
- **G2 尝试自洽**：任意时刻中断，日志都能被补成一个语义完整（balanced）的 attempt：
  未决工具结果标 `outcome: unknown`，attempt 有明确终态。
- **G3 持久屏障**：`flush()` 是唯一"承诺崩溃存活"的点；SQLite 指针只在 flush 成功后更新。
- **G4 状态与内容分离**：当前阶段、待决工具、已确认调查事实等作为 `value/list` 槽落盘，
  不再只活在内存或 `context_summary` 字符串里。
- **G5 真相源与读模型分离**：JSONL = append-only 真相源；SQLite 表 = 可查询投影（对齐 pi 的
  SQLite backend / dsh 的 `session-query`），投影可从日志重建。
- **G6 版本化迁移**：log format 有版本号与迁移函数，旧日志能读。

### 非目标
- 不引入 PG/Redis/MQ/前端；不改 SQLite 单机定位。
- 不重写 agent loop / 不搬 pi 的 lane 状态机（我们委托 pi 引擎）。
- 不做会话树/分支/fork。
- 不在尝试内"断点续跑"模型（重试仍是整轮重跑 + `contextSummary`）；本设计只保证
  **日志语义完整**，不承诺**推理状态续接**。

## 3. 存储契约

### 3.1 文件与 header
一个 attempt 一个文件：`data/sessions/<runId>-<attemptId>.jsonl`（现状不变）。
首行 header：

```jsonc
{ "kind": "header", "version": 3, "runId": "...", "attemptId": "...",
  "investigationId": "...", "cwd": "...", "createdAt": 0 }
```

### 3.2 事务行
从 header 之后每行是一笔**提交**：一个 `CommittedWrite` 或 `CommittedWrite[]`（照 pi `serializeJsonlTransaction`）。
每笔写带全局单调 `seq`（从 1 开始，跨写类型共享）。

```ts
type SessionWrite =
  | { kind: "entry";  type: "message" | "tool_call" | "tool_result" | "compaction" | "custom";
      id: string; parentId: string | null; timestamp: number; data: ... }
  | { kind: "usage";  id: string; data: UsageRow }
  | { kind: "value";  op: "set" | "delete"; namespace: string; key: string; value?: unknown }
  | { kind: "list";   op: "append" | "delete"; namespace: string; key: string; value?: unknown };
```

- `entry`：模型可见/因果链内容，带 `id`/`parentId`（parent 指向上一条相关 entry 或 `null`）。
- `usage`：token 记账，独立于 message（照 pi，一个 assistant message 的 usage 不再是 message 的一部分）。
- `value`：可覆盖的标量槽（当前阶段、已确认发生时间、待决工具指针…）。
- `list`：只追加的槽（pending 帧、检索过的范围…）。

### 3.3 校验（提交前，照 pi `validateCommittedWrites`）
- `seq` 严格递增；
- `entry`/`usage` 的 `id` 全局唯一（内存 + 本次事务内）；
- `entry.parentId` 必须已存在或在本次事务内；
- `tool_result.callId` 必须能关联到本 attempt 内的 `tool_call`；
- `value/list` 的 `namespace` 非空、不含 `\u0000`。

## 4. ticket-doctor 事件映射（现状 → 契约）

| 现事件 | 新写类型 | 说明 |
|---|---|---|
| header | `header`（`kind:"header"`） | 升 `version:3`，字段不变 |
| `message`（user/assistant） | `entry` type `message` | usage 从消息里拆出为独立 `usage` 写 |
| `tool_started` | `entry` type `tool_call` | `data: {callId, tool, input}` |
| `tool_completed` | `entry` type `tool_result` | `data: {callId, ok, durationMs, outputChars, output/error}` |
| `usage` | `usage` | `id` 用调用标识；聚合口径不变 |
| `compaction` / `branch_summary` / `model_change` / `entry` | `entry` type `compaction` / `custom` | 保留，作为 `custom`/结构化 entry |
| —（新增） | `value` `td.lane.state` | 当前阶段：preparing / retrieving / drafting |
| —（新增） | `value` `td.scope.occurredAt` / `td.scope.service` / `td.scope.rev` | 本轮锁定的调查事实（对齐"跨轮事实保留"） |
| —（新增） | `list` `td.pending.tool` | 已发出未回结果的 tool_call（恢复用） |
| —（新增） | `list` `td.retrieval.range` | 检索过的服务/时间窗/关键词，供审计判断"没查到 vs 没查过" |

> 命名空间前缀 `td.` 与 pi 的 `pi.` 对齐，避免未来同文件混用。

## 5. 恢复语义（照 dsh，最关键的借鉴）

### 5.1 平衡一个被中断的 attempt
在 `executeRun` 的任何失败/超时/失租路径上，**先把当前 attempt 的日志补平**，再走 `failRun`：

1. 读出本 attempt 已提交的 `entry`/`list`；
2. 对每个在 `td.pending.tool` 里、没有对应 `tool_result` 的 `tool_call`：
   追加一笔 `tool_result`，`error: { code: "TOOL_OUTCOME_UNKNOWN", reason: "..." }`，
   模型可见文案明确"结果未知；只读/幂等可重试，有副作用的先核对外部状态"（照 dsh `CLOSER_TEXT`）；
3. 追加 `entry` type `custom`（`td.attempt_end`）：`reason: "interrupted" | "timeout" | "failed"`；
4. `flush()` 后再 `failRun`。

### 5.2 为什么不用"截断尾巴"
照 dsh：长任务已经落盘的内容必须保留，**不截断、不重写**；只丢弃"未 resolve 的那次 append"
的物理半行（`readSessionLog` 现有行为）。语义上的不自洽由 §5.1 的合成收尾解决。

### 5.3 只读观察
审计/回放侧（backlog A9）对冷日志做**内存内平衡**，不写回（照 dsh `session-query`）。

## 6. 持久性、写所有权与并发

- **写路径**：创建/快照用 `publishFileAtomically`（写 `.tmp` → `rename`，照 pi `jsonl/io.ts`）；
  增量走批量 `append`。
- **flush 屏障**：`flush()` 内 `appendFileSync` + `fsync`（Node `fs.promises.fsync` 或 `fdatasync`）；
  `recordSessionLog` 只在 `flush()` 成功后调用（现状是 append 后立即记指针）。
- **写所有权**：保留现有 **run 租约 + generation**（适合单机多 worker + 崩溃重试），
  **不搬 dsh 的内核 flock**。但补一条 dsh 的教训：若未来出现"卡住但仍活着的写者"，
  代次守卫只保护**提交**，不保护**追加**——需评估是否给 attempt 文件加"单一写者"标记
  （例如 attempt 行上的 `writerId` + generation），防止僵尸继续追加撕裂日志。

## 7. 读模型与重放

- **SQLite 投影**：`runs/attempts/evidence/reports/deliveries` 视为读模型，可从 JSONL + 业务事务重建；
  投影表与日志的一致性由"同一事务 + flush 屏障"保证。
- **重放工具（A9）**：`td replay <runId>`：`runs → attempts` 拿到全部 attempt 日志 →
  `readSessionLog` → 内存内平衡 → 重建 `contextSummary`/报告 → 打印或复跑。
  对齐 pi `buildSessionContext` 的"重建"与 dsh 的"重放=重新派生"。

## 8. 版本与迁移

- header 里 `version` 单调递增；`migrateSessionLog(version, lines)` 逐级迁移（照 dsh 迁移链）。
- v2（当前）→ v3：把 `{type,data}` 事件映射为 §4 的写类型；`usage` 从 message 中拆出。
- 迁移必须幂等、可测；旧 v2 文件仍可读（只读降级）。

## 9. 落地阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0（设计冻结）** | 本文件评审通过，登记 `open-questions` / `backlog` | 决策记录在案 |
| **P1（契约化）** | 新增 `SessionWrite` 类型 + `commit(writes)` + 校验 + `flush()`；`RunSessionLog.append` 变薄封装；v2→v3 迁移 | `typecheck` + 单测：校验拒绝重复 id/缺 parent；flush 后可读；v2 旧文件可读 |
| **P2（自洽恢复）** | `td.pending.tool` 槽 + 失败路径追加合成 `tool_result` / `attempt_end` | 单测：模拟工具中途崩溃，日志被补平且含 `TOOL_OUTCOME_UNKNOWN` |
| **P3（读模型）** | `td replay` CLI + 审计只读平衡 | 集成测试：崩溃 attempt 可回放 |
| **P4（事实槽）** | `td.scope.*` / `td.retrieval.range` 落盘，跨轮读取 | 多轮测试：第二轮能读到第一轮锁定的时间/版本 |

## 10. 风险

| 风险 | 对策 |
|---|---|
| 过度工程（重蹈"评测太早"覆辙） | 分阶段、每阶段独立可用；非目标明确；不引入新依赖 |
| 迁移破坏历史日志 | 迁移只读降级 + 幂等 + 旧文件保留；先跑回归 |
| flush 成本 | 只在 attempt 终态/关键检查点 flush；增量仍批量 append |
| 与 pi 引擎的事件耦合 | 契约只在 ticket-doctor 侧；pi 的 `entry_appended` 仍映射为 `entry`，不依赖 pi 持久化 |
| `value/list` 滥用成"新数据库" | 只允许放"恢复与审计必需"的状态，不放大块内容 |
