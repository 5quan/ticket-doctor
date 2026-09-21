# ticket-doctor

在飞书群里提交 Bug 后，利用开发接手前的空窗期，自动查询日志、读取指定版本源码，
生成**带证据编号**的预检报告，并支持在同一线程内继续补材料、追问。

第一版边界：只读诊断，不自动修复、不写业务系统；根因假设由开发最终确认。

## 快速开始

```bash
npm install
npm run demo        # 离线端到端：不接飞书、不调模型，跑通 消息→调查→诊断→报告→投递
npm test            # 单元 + 集成测试
npm run typecheck
```

接真实飞书（长连接，无需公网回调）：

```bash
cp .env.example .env        # 填 FEISHU_APP_ID / FEISHU_APP_SECRET / DEEPSEEK_API_KEY
npm run gateway             # 飞书接入 + 投递 + 内嵌 worker
# 或者分进程部署：
npm run worker
npm run gateway
```

## 架构

```text
飞书事件
  │  长连接（WSClient）
  ▼
Gateway ── mention 门控 ── 会话路由 ──► SQLite（inbound_events / investigations / messages / runs）
  │
  ▼
Worker 池（默认 4）：领取待执行轮次（同调查串行、不同调查并行、租约 + 代次守卫）
  │
  ├─ DiagnosisEngine（fake 离线 / pi 真实）
  ├─ 工具箱：query_logs / search_code / read_code（限长、限次、签发证据 ID）
  └─ 报告校验：引用存在性、版本一致性、无证据强制降级
  │
  ▼
SQLite（evidence / reports / deliveries，与终态同一事务提交）
  │
  ▼
投递模块：回复原消息 / 新建消息，失败分类重试，结果不确定记为 uncertain
```

分层依赖方向：`domain ← storage / intake / scheduling / delivery / agent / sources / integrations / entrypoints`。
`domain` 是纯业务，不依赖任何 SDK / 数据库 / 网络。

## 目录

```text
src/
├─ entrypoints/     gateway.ts / worker.ts / demo.ts / bootstrap.ts
├─ config/          环境变量集中解析
├─ domain/          类型、状态机、会话标号、报告渲染（纯函数）
├─ storage/         SQLite（node:sqlite）、迁移、Store
├─ intake/          事件去重 + 会话路由
├─ scheduling/      worker 池、租约、回收
├─ diagnosis/       编排、证据登记、报告校验
├─ agent/           pi 引擎 / 假引擎 / 工具箱 / 工厂
├─ sources/         日志源、Git 源码源（端口 + 实现）
├─ delivery/        待发送记录、重试与不确定态
├─ integrations/
│  └─ feishu/       SDK 客户端、mention 门控、事件归一化、网关逻辑
migrations/         001_init.sql
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
- pi 引擎每轮使用独立内存会话 + `contextSummary` 传递多轮上下文；pi 会话文件持久化未接入。
- 无管理前端；用 SQLite/事件表与日志排查。
