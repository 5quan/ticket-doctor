# ticket-doctor

测试提交 Bug 后自动触发诊断 Agent，结合日志、源码检索与飞书群补证，前置完成 Bug 预诊断，
缩短开发接手后的排查准备时间；生产环境只读诊断，辅助定位线上异常。
在飞书群里提交 Bug 后，自动查询日志、读取指定版本源码，生成**带证据编号**的预检报告，
并支持在同一线程内继续补材料、追问。

边界：只读诊断，不自动修复、不写业务系统；根因假设由开发最终确认。
规划（独立审计 Agent / 评测 Benchmark / 生产诊断 MCP Server）见 `docs/roadmap.md`。

## 快速开始

```bash
npm install
npm run demo        # 离线端到端：不接飞书、不调模型，跑通 消息→调查→诊断→报告→投递
npm test            # 单元 + 集成测试
npm run typecheck
```

接真实飞书（新架构：Host + 独立 Runner + Go 接入适配器）：

```bash
cp .env.example .env        # 填 LARK_* / FEISHU_* / DEEPSEEK_API_KEY
TD_RUNNER_MODE=process TD_FEISHU_DIRECT=false npm run host   # Host：Web API + SSE + 调度 + Runner
cd adapters/go && go run .  # Go 接入适配器：飞书事件 → Host；Host 待发送 → 飞书
```

迁移期仍可用旧单进程链路（Host 内直连飞书、worker 内联执行）：`npm run gateway`。

Web 会话页：Host 启动后访问 `http://<host>:3000/`（无需构建，无框架）。

### Docker Compose 部署

```bash
cp .env.example .env          # 填 LARK_* / DEEPSEEK_API_KEY
# 可选：TD_REPOS_DIR / TD_LOG_DIR_HOST 指定要挂载的源码仓库与日志目录
docker compose up -d --build   # host(3000) + adapter(3002)
```

- `host`：Web API/SSE + 调度 + Runner（`TD_RUNNER_MODE=process`、`TD_FEISHU_DIRECT=false`）。
- `adapter`：Go 接入适配器；飞书事件回调指向 `http://<adapter>:3002/feishu/events`。
- 源码与日志**只读挂载**（`:ro`），数据卷 `ticket-data:/data` 持久化 SQLite。

## 架构

```text
飞书事件 ──► Go 接入适配器 ──HTTP──► Host Web Channel（POST /api/agent/message）
Web 前端 ──HTTP/SSE──────────────► Host
                                        │  原子入队（去重+关联+消息+轮次同事务）
                                        ▼
                              SQLite：investigations / messages / runs(round) / events …
                                        │
                     SessionQueue：会话内严格轮次串行、会话间公平、全局 ≤4
                                        │
                         RunnerManager：spawn 独立 Node 子进程（每轮一个）
                                        │  NDJSON（条目/工具/进度/结果）
                    Host 校验代次后代为落库 → finalize（证据+报告+终态+投递同事务）
                                        │
              ┌─────────────────────────┴─────────────────────────┐
              ▼                                                     ▼
   投递（IM 来源）：Host 待发送记录 ──► Go 适配器 ──► 飞书       EventStore ──► SSE ──► Web

Runner 内部：pi 引擎（fake/pi）+ 只读工具箱 query_logs / search_code / read_code
            + 证据签发（E#）+ 报告草稿；不碰数据库。
```

分层依赖方向：`domain ← storage / intake / scheduling / delivery / agent / sources / integrations / entrypoints`。
`domain` 是纯业务，不依赖任何 SDK / 数据库 / 网络。

## 目录

```text
src/
├─ entrypoints/     host.ts（Host 入口）/ runner.ts（子进程）/ gateway.ts / worker.ts / demo.ts / bootstrap.ts
├─ config/          环境变量集中解析
├─ domain/          类型、状态机、会话标号、报告渲染（纯函数）
├─ storage/         SQLite（node:sqlite）、迁移、Store（原子入队、按轮次调度、事件）
├─ intake/          路由计划 + 统一原子入队
├─ scheduling/      worker 池、租约、回收（可注入 Runner 执行器）
├─ host/            HTTP API + SSE、EventStore、RunnerManager（子进程监管）
├─ runner/          Host↔Runner NDJSON 协议
├─ diagnosis/       内联编排、证据登记、报告校验、提交边界（finalize）
├─ agent/           pi 引擎 / 假引擎 / 工具箱 / 工厂
├─ sources/         日志源、Git 源码源（端口 + 实现）
├─ delivery/        待发送记录、重试与不确定态
├─ integrations/
│  └─ feishu/       SDK 客户端、mention 门控、事件归一化、网关逻辑（过渡期）
adapters/go/        Go 接入适配器（协议解析 + 事件转发 + 平台发送）
migrations/         001…005
tests/              unit/ + integration/
fixtures/           样例日志与样例仓库（demo 用）
```

## 关键设计

- **执行状态与材料完整性正交**：`run.status = succeeded/failed/interrupted` 表示执行是否完成；
  报告 `completeness = complete/partial` 表示材料是否齐全。两者都不等于根因确认。
- **证据 ID 化**：工具执行时程序签发 `E1/E2…`，模型只能用 `evidenceIds` 引用；
  来源、版本、行号由程序回填。引用错位在结构上不可能发生。
- **代次守卫**：每次尝试对应一个 `generation`；租约过期后回收，过期执行者的提交一律被拒绝。
- **投递与诊断解耦**：报告、终态、待发送记录同事务提交；发送失败只重试投递，绝不重跑模型。
- **会话标号**：每条回复带 `[TD-xxxxxxxx]`，用户任意回复只要带标号即可精确路由回原调查。
- **commit 不强制**：工单可不给版本，缺省用仓库当前解析出的 SHA 并在报告中如实标注。

## 配置

见 `.env.example`。核心项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `TD_ENGINE` | `fake` | `fake` 离线确定性引擎 / `pi` 真实模型 |
| `TD_WORKER_COUNT` | `4` | 单机诊断并发上限 |
| `TD_LEASE_MS` / `TD_HEARTBEAT_MS` | `60000` / `10000` | 租约与心跳 |
| `TD_MAX_ATTEMPTS` | `2` | 中断/临时故障最多重试次数 |
| `FEISHU_REQUIRE_MENTION` | `true` | 群聊新会话是否必须 @机器人 |
| `TD_REPOS` | `app:<项目根>` | `repoId:路径`，逗号分隔 |

## 与现有 demo / miniclaw 的关系

- 诊断工具与证据模型参考 `/opt/locatebug/pi-demo`，但本项目是**从零搭建的独立框架**：
  持久化调度、租约代次、多轮会话、投递可靠性都按新边界实现。
- 飞书接入参考 `/opt/miniclaw` 的成熟做法：长连接、fail-closed mention 门控、
  结构化会话标号。详见 `docs/feishu-channel.md`。

## 当前边界

- 真实日志平台适配器（SLS/ELK）尚未实现，当前为本地文件日志源。
- 会话条目已进 SQLite（`session_entries`），pi 按 seq 读回重建；不再用 JSONL 持久化。
- Web 会话页已提供（`src/host/web/`：列表/时间线/进度/证据报告 + SSE 实时刷新）；无登录与权限限制。
- Go 适配器当前为飞书 Webhook 回调；长连接（WSClient）与多平台（钉钉/Slack）待扩展。
