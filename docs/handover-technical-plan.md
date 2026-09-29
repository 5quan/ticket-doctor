# 技术交接方案（Handover Technical Plan）

> 本文面向**下一个接手会话/工程师**。目标：不改方向、不重复讨论，直接按既定目标推进。
> 配套阅读：`docs/handover.md`（总交接，含阅读顺序）、`docs/contributor-onboarding.md`（十分钟上手）、
> `docs/host-runner-design.md`（架构差异与验收）、`docs/interface.md`（接口约束）、
> `docs/roadmap.md` / `docs/backlog.md` / `docs/open-questions.md`。

---

## 0. 一句话目标

把 ticket-doctor 从「飞书单体 Agent」演进为 **Go 接入适配器 → Node Host → 独立 Agent Runner** 的三段式，
**保留**既有诊断工具、证据校验、SQLite 会话恢复、可靠投递；生产只读、单机 SQLite、无权限体系。

架构主干（阶段 1/2/4 与阶段 3 的 Webhook 部分）**已完成**；剩余为**阶段三扩展**与**阶段二效果优化**。

---

## 1. 硬边界（任何改动不得违反）

1. 生产只读：不复现、不自动修复、不写业务系统；工具无 shell、无写文件、无可访问 `.env`。
2. 单机 SQLite（WAL）+ `node:sqlite`；**不引入** PG / Redis / MQ / 前端框架 / 第二模型压缩层（除非 backlog 写明触发条件）。
3. 队列隔离单位 = **调查（Bug 会话）**；全局并发 ≤ `TD_WORKER_COUNT`（默认 4）。
4. 不做运行中消息注入：新消息进入**下一轮**。
5. 回复按**每轮来源**路由：Web 轮次只进 SSE，不回 IM。
6. 报告给根因**假设**，最终根因由开发确认。
7. 用户已明确**暂缓**：落盘前脱敏（S1）；**不做**用户权限/身份限制。
8. 不引入 Claude CLI、定时任务、插件安装、审批回写。

---

## 2. 当前基线与事实

| 项 | 值 |
|---|---|
| 仓库 / 分支 | `github.com/5quan/ticket-doctor` / `main` |
| 基线提交 | `81f260f`（本地 = origin/main） |
| 版本 | `package.json` 0.2.0，tag `v0.2.0`（更早里程碑；后续提交在其之上） |
| 测试 | TS **90** 个（`npm test`）+ Go adapter（`npm run test:go`）全绿 |
| 迁移 | `001_init` … `005_host_queue`（**新增迁移从 `006_` 起，禁止改历史迁移**） |
| 运行 | `npm run host`（生产）/ `npm run gateway`（旧链路）/ `npm run demo`（离线）/ `npm run eval` |
| 部署 | `Dockerfile` + `adapters/go/Dockerfile` + `docker-compose.yml`，已构建并冒烟通过 |
| 已知坑 | 本机到 Debian 源/镜像仓库很慢，docker 首次构建约 30 分钟；Go 用 apt 装的 1.22 |

**关键提交（近期）**：

- `9d5f52f` Host 统一入口 + 原子入队 + 按会话严格轮次 + 取消 + 来源路由
- `5de4a0e` 独立 Agent Runner 子进程 + Host 监管 + NDJSON 回写
- `d038969` Go 接入适配器 + 投递 claim/result
- `c65f028` Web 会话页（无框架）
- `584c16d` 飞书签名校验 + Encrypt Key 解密
- `2bedfd5` p2p 免 @ 修复 + 外部投递重试封顶
- `1e3c2a5` Host 强杀重启进程级验证
- `2fc96a7` 路径层工具 `list_files`

---

## 3. 架构与必须保持的不变量

```text
飞书/钉钉/Slack 事件 ─► Go 接入适配器 ─POST /api/agent/message─► Host
Web 前端 ─HTTP/SSE───────────────────────────────────────────► Host
Host：原子入队 → 按会话严格轮次调度（≤4）→ spawn 独立 Runner 子进程
Runner：pi 引擎 + 只读工具（query_logs/list_files/search_code/read_code）+ 证据签发；不碰 DB
Host：校验 generation 后代为落库 → finalize（证据+报告+终态+投递 同事务）
IM 来源 → deliveries → Go 适配器发送；Web 来源 → EventStore(events) → SSE
```

**不变量（改代码前对照）**：

| 不变量 | 保障点 |
|---|---|
| 同一平台消息只处理一次 | `inbound_events` UNIQUE + `acceptInbound` 同事务 |
| 同一调查严格轮次串行 | `runs.round` + 队首约束 + `NOT EXISTS running` |
| 会话间公平、全局 ≤4 | 队首 FIFO + `workerCount` |
| 过期执行者写不进 | `generation` 守卫（session_entries / finalize / usage） |
| 报告提交与投递同事务 | `finalizeSuccess` |
| 证据可核验 | 程序签发 `E#` + `validateDraft`（引用/版本/无证据降级） |
| 投递结果不重复消费 | `deliveries` 状态机 + `attempt` 守卫 + `uncertain` |

---

## 4. 已完成清单

- **阶段 1**：Host 统一入口、原子入队、按会话严格轮次、会话间公平、显式取消、来源路由。
- **阶段 2**：独立 Agent Runner 子进程（`TD_RUNNER_MODE=process`）、Host 监管、NDJSON 协议。
- **阶段 4**：Host Web API + EventStore/SSE replay；Web 会话页（列表/时间线/进度/证据报告）。
- **阶段 3（部分）**：Go 适配器 Webhook + fail-closed mention 门控 + 签名校验/Encrypt Key 解密 + 投递轮询；
  多平台抽象就位（`internal/platform.Platform` 接口 + 飞书实现迁入 + 钉钉/Slack 骨架，`ADAPTER_PLATFORMS`，见 OQ-37）。
- **阶段 5**：故障注入（超时/取消/租约恢复/僵尸提交）+ Host 强杀重启进程级验证 + compose 部署冒烟。
- 工具：`list_files` 路径层与 `search_code` 有界预览 + 路径清单均完成（见 OQ-36）。

---

## 5. 剩余工作（技术方案）

> 每项含：目标/验收、技术方案、涉及文件/接口/迁移、依赖与风险。**一次只做一项。**

### 5.1 [阶段三] Go 适配器长连接模式（T3）

**目标/验收**：不暴露公网回调地址，Adapter 通过飞书长连接收事件；`@bot` 后 Host 能建调查，
行为与 Webhook 一致；`ADAPTER_MODE=webhook|ws` 可切换。

**技术方案**：
- Feishu 长连接是**自有 WS 协议**（`POST /callback/ws/endpoint` 换 wss 地址，帧含 ping/pong、ack、分片）。
  从零实现风险高，**推荐引入官方 Go SDK**：`github.com/larksuite/oapi-sdk-go/v3`（`larkws.NewClient` + `dispatcher`）。
- 在 Adapter 内抽象**事件源**接口，Webhook 与长连接都产同一种原始事件，复用现有 `feishu.Normalize`：

```go
// adapters/go/internal/eventsource/source.go
type Source interface {
    Name() string
    // Start 持续投递原始事件；ctx 取消即停止。raw 为平台原始 JSON。
    Start(ctx context.Context, onEvent func(raw []byte) error) error
    Stop()
}
// 实现：WebhookSource（把 http request body 交给回调）、LongConnSource（飞书 larkws）
```

- `main.go` 按 `ADAPTER_MODE` 选择 source；Webhook 仍由 `internal/adapter/server.go` 承接。
- 依赖变更需 `go.mod` 更新并在 Dockerfile 中 `go mod download`（构建缓存会失效一次）。

**涉及**：`adapters/go/internal/feishu/`、新增 `internal/eventsource/`、`internal/adapter/server.go`、`main.go`、`go.mod`。
**风险**：SDK 版本与飞书协议兼容；无真实凭据时无法端到端验证（用单测覆盖 Normalize 与路由，长连接本身留人工验证）。

---

### 5.2 [阶段三] 多平台抽象：钉钉 / Slack（T4）

**目标/验收**：把飞书下沉为一个 `Platform` 实现；新增第二个平台只需实现该接口，**不改 Host**。

**技术方案**：定义平台接口，Webhook 路由与投递循环都按平台分发。

```go
// adapters/go/internal/platform/platform.go
type Platform interface {
    Name() string // "feishu" | "dingtalk" | "slack"
    // Normalize 平台原始事件 → Host 入站消息；ok=false 表示忽略。
    Normalize(raw []byte, headers http.Header) (hostapi.Message, bool, error)
    // VerifyRequest 处理回调校验（challenge / signature / token）。
    VerifyRequest(r *http.Request, body []byte) (challenge string, err error)
    // Send 发送文本，返回平台消息 ID；错误用 *SendError 分类（retryable/uncertain/fatal）。
    Send(ctx context.Context, d hostapi.Delivery) (string, error)
    // EventSource 长连接实现；Webhook 平台返回 nil。
    LongConn() Source
}
```

- 目录重组：`internal/platform/feishu/`（迁出现有 normalize/client/security）、
  `internal/platform/dingtalk/`、`internal/platform/slack/`（骨架）。
- HTTP 路由 `POST /{platform}/events`；投递循环按 `delivery.Provider` 选 `Platform.Send`。
- 配置：`ADAPTER_PLATFORMS=feishu,dingtalk`，各平台独立凭据。

**涉及**：`adapters/go/internal/`；**不涉及** TS/Host 与数据库。
**风险**：不同平台的用户标识/线程语义差异，需在 `hostapi.Message` 的 `rootId/threadId` 上做映射约定。

---

### 5.3 [阶段三] 飞书接入迁移彻底化

**目标/验收**：当 5.1 完成且长连接稳定后，弃用 Host 内直连（`TD_FEISHU_DIRECT=true`）与
`src/integrations/feishu/` 的 SDK 接入路径，飞书**只经 Go 适配器**进入 Host。

**技术方案**：
- 保留 `normalize`/`mention-gate` 纯函数供 Adapter 与测试复用（或整体迁往 Adapter）。
- 删除 `src/integrations/feishu/client.ts` 的 WSClient 与 `src/entrypoints/gateway.ts` 的角色；
  投递改由 Adapter claim/result（已就绪）。
- 文档与 `.env.example` 去掉 `TD_FEISHU_DIRECT`。

**风险**：删除前需确认线上只有一条入口，避免双入口重复消费（`inbound_events` 去重已兜底）。

---

### 5.4 [阶段二] `search_code` 改「有界预览 + 路径清单」

**目标/验收**：`search_code` 命中很多时，不再回一堆片段，而是：**命中文件/路径清单（有界） + 少量上下文预览**，
减少无关上下文、提升模型定位效率。保持签发 `E#` 与总量截断。

**技术方案**：
- `GitCodeSource.search` 改为返回 `{ path, line, text }[]` 后，在 `DiagnosisToolbox.searchCode` 里聚合：
  1) 按文件分组 → 路径清单（`path: 命中 n 处`，有界）；2) 取前 K 处签名行做预览。
- 证据登记：每处命中仍签 `E#`（保留可追溯），或对预览整体签一条；二选一需在 `validate` 中确认引用语义不变。
- 保持 `glob` 过滤与 ≤50 条上限语义。

**涉及**：`src/sources/code.ts`、`src/agent/toolbox.ts`、`src/agent/pi-engine.ts`（描述）、`tests/unit/toolbox.test.ts`。

---

### 5.5 [证据] 证据作用域提升为调查级（S5）

> 迁移与回滚方案已定稿：**`docs/evidence-scope-design.md`**（方案选型、006 迁移 SQL、seed 传递、
> 跨轮校验语义、回滚、测试计划、实现清单）。实现时在独立会话按其 §8 清单执行；
> 结论登记为 OQ-38（本文档此前的「OQ-33」为误标，OQ-33 实际是已被取代的 JSONL 问题）。

**目标/验收**：`E#` 从「run 内唯一」提升为「调查内唯一」，跨轮可复用；报告可引用上一轮的 `E#`，
`validateDraft` 按调查校验引用与版本。

**技术方案**：
- 迁移 `006_evidence_scope.sql`：为 `evidence` 增加 `UNIQUE(investigation_id, evidence_id)`（或新建调查级证据表），
  保留 `run_id` 作为“产生于哪一轮”。
- 签发计数：新 run 开始时 `EvidenceRegistry` 以 `SELECT MAX(CAST(SUBSTR(evidence_id,2) AS INTEGER))` 作为起始，
  继续签发 `E{n+1}`（`src/diagnosis/evidence.ts` 增加 seed 参数）。
- 校验：`finalize` 用「调查内全部证据」hydrate registry（`registry.load`），跨轮引用即可通过。
- 回放/展示：报告证据列表按 `investigation_id` 查（`Store.listEvidence` 增调查级方法），Web 页展示不再局限本轮。

**风险**：与现有 `(run_id, evidence_id)` 主键冲突，需要数据迁移策略（历史数据按 run 保持，或整体重算）。
建议在独立会话中做，先写迁移与回滚方案。

---

### 5.6 [阶段二] 独立上下文审计 Agent（OQ-30）

**目标/验收**：把「证据是否充分」从主诊断剥离到**独立上下文**，结构化输出
`已确认事实 / 疑似原因 / 补证请求`，程序按预算收敛；修掉「材料不足仍给 supported」与「引用干扰证据」。

**技术方案**：
- 新增端口 `EvidenceAuditor { audit(req): Promise<AuditResult> }`（`src/agent/`）。
- `AuditResult = { verdict: "sufficient" | "insufficient"; confirmedFacts; suspectedCauses; missingEvidence[]; notes[] }`。
- 主诊断产出 `draft` 后，在 **Runner 内**再跑一次独立会话（新 session，不共享主上下文），输入 = draft + 证据集合 + scope；
  结果随 `result` 一起上报（`RunnerResult` 增加 `audit?`）。
- **Host 侧确定性应用**（`finalize.ts`）：`insufficient` → 强制 `completeness=partial` 并合并 `missingEvidence` 到
  `missingMaterial`；必要时触发 `request_info`（本轮结束）。规则集中在程序，模型不得直接改终态。

**涉及**：`src/agent/`（新 auditor）、`src/runner/protocol.ts`、`src/entrypoints/runner.ts`、
`src/diagnosis/finalize.ts`、提示词与 `docs/eval-design.md`。

---

### 5.7 [阶段二] 评测 M2 / M3（RSI）

**目标/验收**：`rules.md` 条目化 + 增量 delta + 程序合并（照 ACE）；Pareto + μ_f（照 GEPA）；
扩样本 20~30、judge 版正确率、独立 test 集、CI 门禁。

**技术方案**：见 `docs/eval-design.md` 与 `docs/evolve-protocol.md`；题源必须以**历史真实 bug + 人工 gold**为准。
新增 `src/evals/` 打分维度与 `fixtures/` 样本。**依赖**：5.5（跨轮证据）与 5.6（审计）能提升评测口径质量。

---

### 5.8 [阶段三] 生产诊断 MCP Server

**目标/验收**：把 `query_logs / list_files / search_code / read_code` 封装为 MCP tools，
结构化参数限定服务/时间窗/范围，只读凭据 + 超时 + 结果规模控制，返回带来源与版本证据。

**技术方案**：新增入口 `src/mcp/server.ts`（`@modelcontextprotocol/sdk`，stdio），复用 `DiagnosisToolbox` 与 `sources`；
`evidence` 用调查级或会话级 registry。触发条件：需要被其他 Agent 复用/工具外化。

---

### 5.9 [阶段三] 真实日志平台 `LogSource`

**目标/验收**：新增 `src/sources/sls.ts`（或 ELK）实现 `LogSource` 端口，`TD_LOG_SOURCE=file|sls` 可切；
结构化参数（service/timeWindow/keywords/limit）、只读凭据、超时、结果有界。

**技术方案**：`LogSource` 端口已存在（`src/sources/logs.ts`），新增实现即可，**不动编排**。

---

### 5.10 [可选 / gated] 其他

- **Web 登录与权限**：用户已明确不做身份限制；仅当有非工程人员访问需求时，用反代 Basic/网关 token 兜底，
  **不引入**完整账号体系。
- **图片 / 截图**：下载 → 视觉模型 → 登记为用户提供证据（注意 PII 与存储），见 OQ-27。
- **PostgreSQL**：仅多机部署/单机写瓶颈时引入，无触发不做。

---

## 6. 推荐执行顺序（会话粒度）

| 会话 | 任务 | 依赖 | 备注 |
|---|---|---|---|
| S1 | 5.4 `search_code` 有界预览 | 无 | ✅ 已完成 |
| S2 | 5.2 多平台抽象（先抽接口+飞书迁入） | 无 | ✅ 已完成 |
| S3 | 5.1 Go 长连接（SDK） | S2 | 需真实凭据人工验证 |
| S4 | 5.3 弃用 Host 内直连 | S3 | 一次性清理 |
| S5 | 5.5 证据作用域调查级 | 独立 | ✅ 迁移与回滚方案已定稿（`docs/evidence-scope-design.md`），待实现 |
| S6 | 5.6 独立审计 Agent | 5.5 | 效果向 |
| S7 | 5.7 评测 M2/M3 | 5.5/5.6 | 迭代 rules |
| S8 | 5.8 / 5.9 扩展 | 触发条件 | 按需 |

---

## 7. 每个会话的执行规程（DoD）

1. **先跑基线**：`npm run typecheck && npm test && npm run test:go`，全绿再动。
2. **一次只做一件**；拿不准先记 `docs/backlog.md`「待探讨」，不闷头改主链路。
3. 改代码 → `typecheck` → `test`（+ Go）→ 需要时 `npm run demo` 冒烟。
4. **同步文档**：设计决策进 `docs/open-questions.md`；状态进 `roadmap.md`/`backlog.md`；
   本会话进度进 `docs/handover.md` 六节；架构变化进 `docs/host-runner-design.md`。
5. **commit + push**（保持 origin/main 同步）；重大里程碑打 tag。
6. 新增迁移从 `006_` 起，禁止改历史迁移；DB 改动必须有迁移 + 测试。

---

## 8. 关键接口与配置速查

**Host API**（`src/host/server.ts`）：
`POST /api/agent/message`、`GET /api/agent/investigations`、`GET /api/agent/investigations/:id`、
`GET /api/agent/investigations/:id/events`（SSE）、`POST /api/agent/runs/:id/cancel|retry`、
`POST /api/agent/deliveries/claim`、`POST /api/agent/deliveries/:id/result`、
`GET /api/agent/capabilities`、`GET /`（Web 页）。

**Host↔Runner**（`src/runner/protocol.ts`）：stdin `RunnerTask` + `{"type":"cancel"}`；
stdout NDJSON `ready|session_entry|tool_execution|progress|result|error`。

**工具**：`query_logs / list_files / search_code / read_code / request_info / submit_report`。

**关键环境变量**：`TD_ENGINE`、`TD_RUNNER_MODE`、`TD_FEISHU_DIRECT`、`TD_HOST_PORT`、`TD_WORKER_COUNT`、
`TD_LEASE_MS`、`TD_HEARTBEAT_MS`、`TD_MAX_ATTEMPTS`、`TD_REPOS`、`TD_LOG_DIR`、
`FEISHU_*`、`LARK_*`（含 `LARK_ENCRYPT_KEY`）、`ADAPTER_*`。

**测试入口**：`tests/unit/*`、`tests/integration/*`（`pipeline` / `fault` / `host-restart` / `host-api` / `runner-process` / `eval`）。

---

## 9. 风险与已知坑

- **docker 首建慢**：本机到 Debian/镜像源慢，首建约 30 分钟；后续层缓存，改 `src` 只需重建 COPY 层。
- **Go 依赖**：引入官方 SDK 会改 `go.mod`，需更新 Dockerfile 的 `go mod download` 与构建缓存预期。
- **多进程 SQLite**：Runner 不碰 DB，只有 Host 写；若未来多 Host 实例，先解决写租约（见 `docs/concurrency.md`）。
- **证据作用域迁移**：会触碰主链路与历史数据，务必单独会话 + 回滚方案。
- **无真实凭据**：长连接/真实发送只能单测 + 人工验证，不要声称“已验证线上”。

---

## 10. 决策记录与暂缓项

- 已结论见 `docs/open-questions.md`（OQ-1…OQ-35）：单库 SQLite、队列按调查、并发 4、不做注入/定时/审批/权限、
  pi 会话进 `session_entries`、Web 轮次不回 IM 等。
- **暂缓**：脱敏（S1）、跨轮证据复用（由 5.5 承接）、图片处理、出站消息映射。
- **冲突处理**：文档与代码不一致时**以代码为准**，并顺手修正文档。
