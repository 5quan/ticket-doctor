# Host / Runner / 接入适配器 架构与落地

> 平台参考：`/opt/locatebug/研发Agent平台项目文档` 03/04/05。本文只记录**本仓库的实际落地方式**与差异。
> 状态：阶段一、二、四已完成；阶段三 Go 适配器骨架完成（飞书 Webhook）；阶段五部分覆盖。

## 1. 目标结构

```text
企业 IM / Webhook                        Web 前端
      │                                      │ HTTP 操作 / SSE 订阅
      ▼                                      │
Go 接入适配器（adapters/go）                  │
解析、token 校验、mention 门控、归一化         │
      │ POST /api/agent/message              │
      └───────────────┬──────────────────────┘
                      ▼
            Host（src/entrypoints/host.ts + src/host/*）
  ┌──────────────────────────────────────────────────────┐
  │ Channels：统一入口（HTTP / 飞书过渡直连）              │
  │ SessionQueue：会话内严格轮次串行 + 会话间公平 + 全局≤4 │
  │ RunnerManager：spawn/监管/超时/取消（每轮独立子进程）   │
  │ EventStore：events 表持久化 + 订阅 + Last-Event-ID replay │
  │ SQLite：investigation/message/run/evidence/report/delivery │
  └───────────────────────┬──────────────────────────────┘
                          │ NDJSON over stdio
                ┌─────────┼─────────┐
                ▼         ▼         ▼
             Runner A  Runner B  Runner C …（≤ workerCount）
                │  pi + 只读工具（不碰数据库）
```

## 2. 与参考文档的差异（按需求确认）

| 文档 | 落地差异 |
|---|---|
| 04 GroupQueue | 队列隔离单位从用户/group 改为**调查（Bug 会话）**；最大并发 4 |
| 04 消息注入 | 不做运行中注入；新消息进入下一轮 |
| 04 TaskScheduler | 不引入定时任务 |
| 04 文件 IPC | 改用 **NDJSON stdio**（无需运行中注入与定时命令） |
| 05 Claude CLI | 保留 pi 引擎（`src/agent/pi-engine.ts`）与 ticket 诊断工具 |
| 05 确认/回写 | 不引入外部系统写回与审批 |
| 03 多租户 | 不做用户权限与身份限制 |

保留的既有能力：诊断工具、证据签发与校验、SQLite 会话恢复、可靠投递（重试/不确定态/租约/代次）。

## 3. 数据库迁移

| 迁移 | 内容 |
|---|---|
| `005_host_queue.sql` | `runs.round`（调查内单调轮次）、`runs.source`、`runs.cancel_requested`；`events`（SSE 事件流，自增 ID=Last-Event-ID） |

既有表复用：`inbound_events` 去重、`investigations`/`messages`/`runs`/`attempts`、`evidence`/`reports`/`deliveries`、`session_entries`/`tool_executions`。

## 4. 接口

### 4.1 Host Web API（src/host/server.ts）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/agent/message` | 统一入站（Web / Go 适配器）；同事务去重+关联+存消息+建轮次 |
| GET | `/api/agent/investigations` | 调查列表（含最新轮次状态） |
| GET | `/api/agent/investigations/:id` | 详情：消息时间线 / 轮次 / 最新报告 |
| GET | `/api/agent/investigations/:id/events?lastEventId=` | SSE；支持 `Last-Event-ID` 头 replay |
| POST | `/api/agent/runs/:id/cancel` | 取消：queued 直接取消，running 置标志 |
| POST | `/api/agent/runs/:id/retry` | 人工重试失败/取消轮次 |
| POST | `/api/agent/deliveries/claim` | 外部适配器领取待发送记录 |
| POST | `/api/agent/deliveries/:id/result` | 上交发送结果（带 attempt 守卫） |
| GET | `/api/agent/capabilities` | 引擎/工具/并发能力 |

### 4.2 Host ↔ Runner 协议（src/runner/protocol.ts）

- stdin：一行 `RunnerTask` JSON；之后可下发 `{"type":"cancel"}`。
- stdout：NDJSON `ready | session_entry | tool_execution | progress | result | error`。
- stderr：运行日志，不作为业务结果。
- Runner **不碰数据库**；Host 校验代次后代为落库 `session_entries` / `tool_executions` / 报告。

## 5. 调度语义

1. **原子入队**：`Store.acceptInbound` 在一个 `BEGIN IMMEDIATE` 内完成去重、路由、建调查/消息/轮次。
2. **严格轮次顺序**：只允许领取调查内最小未终态轮次；前一轮待重试时后一轮不越过。
3. **会话间公平**：按各调查队首进入顺序 FIFO。
4. **全局 ≤4**：由 `workerCount`（默认 4）约束，所有入口共用。
5. **取消**：`cancel_requested` 置位后执行者失租/中止；取消是终态，不自动重试，也不阻塞后续轮次。
6. **来源路由**：每轮保存 `source`；IM 来源才产生投递，Web 来源只进 EventStore/SSE。

## 6. 交付分期与验收

| 阶段 | 状态 | 验收 |
|---|---|---|
| 1 Host 统一入口 + 队列 | ✅ | 原子入队、严格轮次、会话间公平、取消、来源路由（`tests/unit/host-queue.test.ts`） |
| 2 独立 Runner + 监管 | ✅ | 真实 spawn、并发隔离、崩溃只判本轮（`tests/integration/runner-process.test.ts`） |
| 3 Go 飞书适配器 | ◐ | 事件归一化/fail-closed 门控/转发/投递（`adapters/go`，`go test ./...`） |
| 4 Web API + SSE Replay | ✅ | 入队/详情/取消/重试/投递 claim+result/SSE replay（`tests/integration/host-api.test.ts`） |
| 5 故障测试与部署 | ◐ | 已有取消/崩溃覆盖；Host 重启、强杀、投递不确定态待补 |

## 7. 后续待办

- Go 适配器：长连接（WSClient）模式、钉钉/Slack、真正签名校验（当前为 token 校验）。
- Web 会话页面（列表/时间线/报告）与登录（当前无权限限制）。
- 证据作用域从 run 内 `E#` 提升到调查作用域（OQ-33）。
- 阶段五故障注入测试与部署收口（docker-compose：host + adapter + 数据卷）。
