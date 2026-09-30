# 新接手 Agent 上手指南（Contributor Onboarding）

> 面向第一次接手本仓库的 AI/工程师。目标：**10 分钟内能跑起来，30 分钟内能独立改一处并提交。**
> 项目内既有文档：`docs/handover.md`（项目交接，含阅读顺序）、`docs/host-runner-design.md`（架构与差异）、
> `docs/interface.md`（接口约束）、`docs/roadmap.md` / `docs/backlog.md`（优先级）、`docs/open-questions.md`（已结论问题）。

---

## 0. 一分钟上手

```bash
cd /opt/ticket-doctor
npm install
npm run typecheck        # tsc --noEmit，必须先绿
npm test                 # TS 单元 + 集成（数量见 docs/status.json#tests）
npm run test:go          # Go 接入适配器测试（需要 go 1.22+）
npm run demo             # 离线端到端：不接飞书、不调模型，跑通 消息→诊断→报告→投递
npm run host             # 启动 Host：Web API + SSE + 调度 + Runner（默认 3000 端口）
```

`npm run demo` 全绿 = 你对项目有基本信心了。

---

## 1. 这个项目是什么

**ticket-doctor**：测试在飞书群提交 Bug 后，自动触发诊断 Agent，查日志 + 读指定版本源码，
生成**每条结论都可追溯到证据编号（E#）**的预检报告，缩短开发接手前的排查准备时间。

**硬边界（任何改动都不能违反）**：

- 只读诊断：不复现、不自动修复、不写业务系统。
- 生产只读凭据；工具无 shell、无写文件、无可访问 `.env`。
- 单机 SQLite（WAL）+ `node:sqlite`；**不引入** PG / Redis / MQ / 前端框架 / 第二模型压缩层（除非 backlog 写明触发条件）。
- 报告给的是**根因假设**，最终根因由开发确认。

---

## 2. 架构一页纸

```text
飞书事件 ─► Go 接入适配器(adapters/go) ─POST /api/agent/message─► Host(src/entrypoints/host.ts)
Web 前端 ─HTTP/SSE────────────────────────────────────────────► Host
                                                                   │ 原子入队（去重+关联+消息+轮次 同事务）
                                                                   ▼
                                                     SQLite：investigations/messages/runs(round)/events…
                                                                   │
                                        SessionQueue：会话内严格轮次串行、会话间公平、全局≤4
                                                                   │
                                        RunnerManager：每轮 spawn 独立 Node 子进程
                                                                   │ NDJSON（session_entry/tool_execution/progress/result/error）
                                        Host 校验 generation 后代为落库 → finalize（证据+报告+终态+投递 同事务）
                                                                   │
                             ┌─────────────────────────────────────┴──────────────────────┐
                             ▼                                                             ▼
                 IM 来源：deliveries ─► Go 适配器 ─► 飞书              EventStore(events 表) ─► SSE ─► Web

Runner 内：pi 引擎（fake/pi）+ 只读工具 query_logs/search_code/read_code + 证据签发 E#；不碰数据库。
```

关键设计（改代码前必读）：

- **证据 ID 化**：工具执行时程序签发 `E1/E2…`，模型只能用 `evidenceIds` 引用，来源/版本/行号程序回填。
- **代次守卫**：每次尝试有 `generation`；租约过期回收后，旧执行者的提交一律被拒。
- **投递与诊断解耦**：报告、终态、待发送记录同事务提交；发送失败只重试投递，不重跑模型。
- **来源路由**：每轮存 `runs.source`；只有 IM 来源产生投递，Web 来源只进 EventStore/SSE。
- **会话单存储**：pi 条目原样进 `session_entries`（按调查单调 `seq`），恢复时读回重建。

---

## 3. 代码地图

```text
src/
├─ entrypoints/
│  ├─ host.ts         Host 入口：Web API + SSE + worker + Runner
│  ├─ runner.ts       Agent Runner 子进程入口（stdin 任务 / stdout NDJSON）
│  ├─ gateway.ts      过渡期旧链路：Host 内直连飞书 + 内联 worker
│  ├─ worker.ts       只跑 worker（内联执行）
│  ├─ demo.ts         离线端到端演示
│  └─ bootstrap.ts    打开 DB + 迁移 + 组装 store/engine
├─ host/
│  ├─ server.ts       HTTP API + SSE + Web 静态资源托管
│  ├─ event-store.ts  events 表持久化 + 订阅 + Last-Event-ID replay
│  ├─ runner-executor.ts  spawn/监管 Runner 子进程，代其落库
│  └─ web/            Web 会话页（index.html / app.js / styles.css，无框架）
├─ runner/protocol.ts Host↔Runner NDJSON 协议类型
├─ diagnosis/
│  ├─ orchestrator.ts 内联编排（prepare → engine → finalize）
│  ├─ finalize.ts     提交边界：reply / report 落库 + 事件发布（两条执行路径共用）
│  ├─ prepare.ts      时间窗 → 钉版本 → 工具箱（纯准备，不碰 DB）
│  ├─ run-session.ts  会话槽：pi 条目读写 SQLite
│  ├─ evidence.ts     证据登记表（E# 签发 + 从上报记录恢复）
│  └─ validate.ts     报告校验：引用存在、版本一致、无证据强制降级
├─ storage/
│  ├─ db.ts           打开 SQLite / 迁移 / 短事务
│  └─ store.ts        唯一读写入口：原子入队、按轮次调度、取消、事件、投递
├─ intake/router.ts   路由计划 + 统一原子入队（Store.acceptInbound）
├─ scheduling/worker-pool.ts  worker 池（可注入 Runner 执行器）
├─ agent/             pi 引擎 / 假引擎 / 工具箱 / 工厂 / pi 会话 seed&恢复
├─ sources/           日志源、Git 源码源（端口 + 实现）
├─ delivery/delivery.ts 待发送记录、重试、不确定态
├─ integrations/feishu/ 过渡期飞书 SDK 接入（mention 门控 / 归一化 / 网关）
└─ config/index.ts    环境变量集中解析（业务模块不得直接读 process.env）

adapters/go/          Go 接入适配器（config/feishu/hostapi/hostclient/adapter，含测试）
migrations/           001_init … 005_host_queue
tests/unit/ tests/integration/
fixtures/             样例日志与样例仓库（demo 用）
```

---

## 4. 开发闭环（每个改动都走一遍）

1. **先跑基线**：`npm run typecheck && npm test` 全绿再动。
2. 改代码 → `npm run typecheck` → `npm test`（改 Go 还要 `npm run test:go`）。
3. 同步文档：设计决策进 `docs/open-questions.md`，状态进 `roadmap.md` / `backlog.md`，
   本次进度进 `docs/handover.md` 六节。
4. `git commit`（说清"改了什么/为什么"）+ `git push`（保持 origin/main 同步）。
5. **一次只做一件**；拿不准先记 backlog「待探讨」，不要闷头改主链路。

---

## 5. 环境与坑

- Node：用 `node --experimental-strip-types` 直接跑 `.ts`（无需构建）。**Node 22.23+**。
- 数据库：`node:sqlite`（Node 22 内置），同步 API；事务铁律：**外部 IO（模型/日志/发送）一律在事务外**。
- Go：`go1.22+`；`cd adapters/go && go test ./...`。本机用 `apt-get install golang-go` 装的。
- Docker：`Dockerfile` + `docker-compose.yml` 已就绪；注意本机到 Debian 源/镜像仓库很慢，构建可能很久。
- 配置：开发时复制 `.env.example` 为 `.env`。关键项：`TD_ENGINE=fake|pi`、`TD_RUNNER_MODE=inprocess|process`、
  `TD_FEISHU_DIRECT=true|false`、`TD_HOST_PORT`、`TD_REPOS`、`TD_LOG_DIR`、`FEISHU_*` / `LARK_*`。
- 改动迁移：**新增 `migrations/006_*.sql`，不要改历史迁移**。
- 参考源码（本机）：`/opt/pi`、`/opt/miniclaw`、`/opt/deepseek-harness`；
  平台文档 `/opt/locatebug/研发Agent平台项目文档`。

---

## 6. 当前状态（截至最新提交）

- 已实现：飞书接入、会话路由、SQLite 持久化与状态机、租约/代次、可靠投递、只读工具与证据校验、
  评测 harness（M1）、Host 统一入口 + 原子入队 + 按会话严格轮次、独立 Runner 子进程、Host Web API + SSE、
  Web 会话页、Go 接入适配器（含签名校验/解密）、故障注入测试。
- 测试：`npm test`（TS）+ `npm run test:go`（Go adapter）全绿；数量见 `docs/status.json#tests`；`npm run demo` 离线可跑。
- 阶段进度：路线图见 `docs/roadmap.md`。

---

## 7. 任务菜单（挑一个做，从易到难）

> 每项都给了「目标 / 验收 / 主要文件」。T1/T2 已完成（见 `tests/integration/host-restart.test.ts` 与 docker compose）；
> 下一步建议从 T3 / T4 / T5 / T9 里挑。

| # | 任务 | 目标 / 验收 | 主要文件 | 难度 | token 友好 |
|---|---|---|---|---|---|
| ✅T1 | **Host 重启进程级验证（已完成）** | 见 `tests/integration/host-restart.test.ts`：SIGKILL → 重启 → 轮次恢复、不重复入队/追加输入 | — | — | — |
| ✅T2 | **docker 构建 + compose 冒烟（已完成）** | 两镜像构建通过；compose 起 host/adapter，Web/飞书事件/投递均跑通 | — | — | — |
| ✅T3 | **Go 适配器长连接模式（S3，已完成）** | 官方 Go SDK（`.../v3/ws`）实现 `eventsource.Source`，`ADAPTER_MODE=webhook|ws`；**方案见 `docs/adapter-longconn-design.md`**；真机验证步骤在 `adapters/go/README.md` | `adapters/go/internal/eventsource/`、`internal/platform/feishu/longconn.go`、`main.go`、`internal/adapter/` | 高 | 高 |
| ✅T4 | **多平台抽象（钉钉/Slack）（已完成）** | `Platform` 接口（归一化/校验/发送/长连接）已就位，飞书已迁入；新增第二个平台只需实现接口并在 `BuildPlatforms` 注册（OQ-37） | `adapters/go/internal/platform/` | 高 | 高 |
| T5 | **Web 页面增强** | 进度按轮次/阶段展示、证据与假设互跳、失败原因高亮、移动端可用；保持无框架 | `src/host/web/`、`src/host/server.ts` | 中 | 高 |
| ✅T6 | **证据持久化 + 稳定 UID（已完成，OQ-38）** | 工具返回前两阶段提交（材料先落盘再给模型）+ `evidence_uid`/调查内短号续签 + 崩溃恢复 + 报告 v1/v2；按 `docs/evidence-uid-design.md` §11 全部落地 | `src/evidence/`、`src/agent/toolbox.ts`、`src/diagnosis/*`、`src/host/runner-executor.ts`、`src/runner/protocol.ts`、`migrations/006` | 高 | 高 |
| ✅T7 | **`search_code` 有界预览 + 路径清单（已完成）** | 输出改为“按文件聚合的路径清单（≤20 文件）+ 前 8 处带 [E#] 的预览”；每处命中仍签 `E#`，validate 语义不变（OQ-36） | `src/agent/toolbox.ts`、`src/agent/pi-engine.ts` | 中 | 中 |
| T8 | **tool_executions 回放** | 按调查展示每次工具调用（入参/耗时/成败/结果规模），供审计与排查 | `src/storage/store.ts`、`src/host/server.ts`、`src/host/web/` | 中 | 中 |
| T9 | **独立审计 Agent（OQ-30）** | 把「证据是否充分」剥离到独立上下文，结构化输出已确认事实/疑似原因/补证请求 | `src/diagnosis/`、`src/agent/` | 高 | 高 |
| T10 | **评测样本扩充 / judge** | 补 20~30 个真实或合成 case、加 judge 版正确率、独立 test 集 | `src/evals/`、`fixtures/` | 中 | 高 |

---

## 8. 明确「暂缓 / 不做」（别自作主张）

- 落盘前脱敏（S1）：**用户已明确暂缓**。
- 不引入用户权限/身份限制（当前设计如此）。
- 不引入 Claude CLI、定时任务、插件安装、审批回写（已在方案中排除）。
- 不引入 PostgreSQL / Redis / MQ / 前端框架（除非触发条件成立，见 `docs/backlog.md`）。

---

## 9. 常用命令速查

```bash
npm run typecheck        # 类型检查（必过）
npm test                 # TS 全量测试
npm run test:go          # Go 适配器测试
npm run demo             # 离线端到端
npm run host             # Host（Web API + SSE + Runner）
npm run gateway          # 旧链路（Host 内直连飞书）
npm run worker           # 只跑 worker
npm run eval             # 离线评测（M1）

# 单文件调试（示例）
node --experimental-strip-types --test tests/integration/fault.test.ts
```
