# Worker 并发模型与并发漏洞清单（待专项梳理）

> 用途：固定当前并发模型的事实，登记已知/疑似的并发漏洞，作为后续专项审计的清单。
> 状态：待探讨。相关：`open-questions.md` OQ-33 / OQ-34、`backlog.md` P4、
> `docs/session-log-design.md`、`docs/interface.md §8.7`。

## 1. 当前并发模型（事实）

- **单进程 + N 个异步循环**（`workerCount` 默认 4，`src/scheduling/worker-pool.ts`）——**不是 4 个进程**。
  4 个 worker 只在 `await` 处并发；**任何同步调用冻结全部 4 个**。
- 每个循环：`recoverExpiredLeases()` → `claimNextRun()` → `executeRun()`。
- `claimNextRun` 在 `BEGIN IMMEDIATE` 内完成"选任务 + 占租约 + 建 attempt"；SQL 保证
  **同一调查最多一个 `running`**，不同调查可并行。
- `node:sqlite`（`DatabaseSync`）是**同步 API**：所有 DB 操作阻塞事件循环；`busy_timeout=5000`。
- 会话日志 `appendFileSync`（同步）；`log` 源用 `readFile`（异步）；git 走子进程。
- 调度：`runs` 租约 + `generation`；投递：`deliveries` 租约 + `uncertain` 态。

## 2. 失败与中断语义

- 超时 `timeoutMs`（默认 180s）通过 `AbortController` **协作式**中止；`heartbeatMs=10s`，`leaseMs=60s`。
- `recoverExpiredLeases()` 目前被**每个 worker 每轮**调用 → **持续接管**。
- 代次（generation）守卫只覆盖**提交**（finalize），**不覆盖文件追加 / 部分事件写入**。
- 同步阻塞、库不响应 signal 的调用，超时**无法强行中止**（只能重启进程）。

## 3. 并发漏洞 / 风险清单（待逐条梳理）

| ID | 风险 | 现状 | 待办 |
|---|---|---|---|
| W1 | 同步阻塞冻结全局：`node:sqlite` 同步查询 + `busy_timeout` 争用，卡住 4 个 worker | 已知 | 热路径盘点；必要时把 DB 移 worker_thread |
| W2 | `recoverExpiredLeases` 每轮每 worker 调用 = 持续接管 | 已知 | 若取消接管 → 改为**启动时一次** |
| W3 | 活着但卡死的 worker 被新 worker 接管 → 两个执行者碰同一 run/会话 | JSONL 靠"每 attempt 一文件"避免字节损坏；`generation` 只挡提交 | 取消接管 or 文件/行级锁（单库后由 SQLite 串行化） |
| W4 | `appendRunEvent` **无代次守卫**（`MAX(sequence)+1` + INSERT） | 迟到/僵尸执行者仍可写 `run_events` | 加 `run` 终态/代次校验 |
| W5 | `run_events` 的 `sequence = MAX+1` 跨进程可能撞 `UNIQUE(run_id,sequence)` | 单进程默认安全 | 若多进程 → 冲突重试或改自增 |
| W6 | `markDeliverySent / markDeliveryUncertain ...` 按 `id` 更新，**无租约/attempt 守卫** | 过期发送者仍可改状态 | 加 `status='sending' AND lease` 守卫 |
| W7 | 投递"发没发出去不知道" → `uncertain` 后的收敛 | 有 uncertain 态 | 平台幂等 + 人工兜底 |
| W8 | `claimNextRun` 与 `recoverExpiredLeases` 是两个事务，存在时序窗口 | `BEGIN IMMEDIATE` 串行 | 审计窗口是否可导致双领 |
| W9 | `recordSessionLog` 的 attempt 维度更新按 `id + run + generation`；迟到写入语义 | 已加守卫 | 确认 abort 后迟到写入不会污染 |
| W10 | `evidence` 主键 `(run_id, evidence_id)`；跨 attempt 复用 / 调查作用域改造 | run 内 E# 重开 | 见 OQ-33 证据作用域 |
| W11 | 会话文件无锁（若维持 JSONL + 共享会话） | 现为每 attempt 独立文件 | 单库后消失 |
| W12 | `investigations.context_summary / total_rounds` 无代次守卫（终态同事务更新） | finalize 事务内 | 审计是否可被迟到写入覆盖 |

## 4. 相关决定方向（待定）

- **取消运行中接管**，改为**启动时自愈**（重启证明旧进程已死）；配单实例启动锁。
- **存储收敛为单库（SQLite）**（见 `docs/session-log-design.md` 存储收敛节）：收敛后
  W3 / W11 等并发写撕裂类问题由 SQLite 事务串行化天然消除。

## 5. 梳理方法

每个写路径统一问三件事：
1. **是否同步阻塞事件循环？**
2. **是否带租约 / 代次 / 状态守卫？**
3. **中断或接管后，重复执行是否幂等？**

并用**真实强杀测试**覆盖：首条回复生成中、工具执行中、结果入库后 pi 未记前、恢复补记中、
报告提交后发送前、旧执行者仍存活、会话/库损坏。
