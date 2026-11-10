# 新接手 Agent 上手指南（Contributor Onboarding）

> 面向第一次接手本仓库的 AI/工程师。先核对暂停状态与本机环境，再恢复运行和开发。
> 完整入口见 [文档索引](README.md)；易变事实见 [状态源](status.json)，开发清单见 [路线图](roadmap.md) / [待办](backlog.md)。
> 架构读 `docs/host-runner-design.md`，接口约束读 `docs/interface.md`，已结论问题读 `docs/open-questions.md`。

---

## 0. 暂停后恢复与快速上手

当前开发暂停，状态见 `docs/status.json#development`。恢复时先读
[最新会话交接](session-handover.md)；继续自改进则再读 [自改进交接](self-improvement-handover.md) 与
[原实施方案](self-improvement-implementation-plan.md)。无需重写已有 GEPAAdapter，也不要把适配器完成当作真实搜索已完成。

在仓库根目录执行；运行 demo 前确认 `TD_ENGINE=fake`，避免沿用本地真实模型配置：

```bash
npm ci                  # 按锁文件恢复依赖
npm run typecheck        # tsc --noEmit
npm test                 # TS 单元 + 集成（数量见 docs/status.json#tests）
npm run test:go          # Go 接入适配器测试（需要 go 1.22+）
npm run demo             # 离线端到端：不接飞书、不调模型，跑通 消息→诊断→报告→投递
npm run host             # 启动 Host：Web API + SSE + 调度 + Runner（默认 3000 端口）
```

当前 Windows 接手环境的类型检查缺 Langfuse/OTel 依赖，自改进配置校验受派生案例缺失与 CRLF 源码指纹影响。
原始材料校验已通过；完整核验结果见 `docs/status.json#self_improvement`。历史测试通过记录不代表本轮已通过。

自改进恢复时，按 [专项交接](self-improvement-handover.md) 重建转换材料与派生案例，再复验准入及冻结配置；
不要通过重写冻结指纹或跳过校验来绕过环境差异。`data/` 下本地产物需另行恢复，GitHub 源码保存不包含这些产物。

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
                                                                   │ NDJSON（session_entry/tool_execution/observation/progress/result/error）
                                        Host 校验 generation 后代为落库 → finalize（证据+报告+终态+投递 同事务）
                                                                   │
                             ┌─────────────────────────────────────┴──────────────────────┐
                             ▼                                                             ▼
                 IM 来源：deliveries ─► Go 适配器 ─► 飞书              EventStore(events 表) ─► SSE ─► Web

Runner 内：fake/pi 诊断引擎 + 只读工具 + 独立审计/有界补证；证据经 Host 落库后签发 UID 与调查内短号 E#，Runner 不碰数据库。
```

关键设计（改代码前必读）：

- **证据 ID 化**：工具执行时程序签发 `E1/E2…`，模型只能用 `evidenceIds` 引用，来源/版本/行号程序回填。
- **代次守卫**：每次尝试有 `generation`；租约过期回收后，旧执行者的提交一律被拒。
- **投递与诊断解耦**：报告、终态、待发送记录同事务提交；发送失败只重试投递，不重跑模型。
- **来源路由**：每轮存 `runs.source`；只有 IM 来源产生投递，Web 来源只进 EventStore/SSE。
- **会话单存储**：pi 条目原样进 `session_entries`（按调查单调 `seq`），恢复时读回重建。
- **范围与覆盖信息**：日志工具执行本轮服务/时间窗约束，源码仓库受 `TD_ALLOWED_REPOS` 硬白名单约束；材料源支持覆盖信息与游标续查。
- **独立审计**：独立上下文检查证据，程序应用判定；补证与诊断共享工具和总超时预算，轮次由 `TD_AUDIT_MAX_ROUNDS` 限制，默认不开启审计。

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
│  ├─ diagnosis-loop.ts  诊断 → 独立审计 → 有界补证
│  ├─ audit.ts        审计输入与程序应用判定
│  └─ validate.ts     报告校验：引用存在、版本一致、无证据强制降级
├─ domain/            报告、证据、会话等领域类型
├─ evidence/          证据两阶段提交：sink / resolver / 崩溃恢复 / 渲染
├─ observability/     中立观测事件 + pi 请求边界 + Langfuse 官方 tracing SDK（门控）
├─ eval/              当前离线评测入口与共享协议；lf/ 为 Langfuse 原生实验
├─ evolve/            候选编译、确定性评分、预算账本、批量桥梁与冻结配置校验
│  └─ materials/      材料转换、案例装配、rubric、人工复核准入与数据集构建
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

adapters/go/          Go 接入适配器（飞书 Webhook/长连接；钉钉/Slack 骨架，含测试）
tools/evolve/         Python GEPAAdapter、反射 LM、搜索入口与单测
evolve/              config/ 冻结搜索配置；reviews/ 案例复核记录
scripts/             评测/自改进 CLI、样例初始化、环境安装与迁移脚本
deploy/              Langfuse 与 systemd 部署资产
migrations/           001_init … 006_evidence_uid
tests/unit/ tests/integration/
fixtures/             演示/评测材料、公开模拟故障原始材料
docs/                 README.md 文档索引、交接、开发清单与专项方案
data/                 本地数据库、派生案例、运行与实验产物（Git 忽略）
```

---

## 4. 开发闭环（每个改动都走一遍）

1. **先复验环境**：`npm run typecheck && npm test`；有失败先区分依赖/本地产物缺失与代码问题，说明阻塞和替代验证。
2. 改代码 → `npm run typecheck` → `npm test`（改 Go 还要 `npm run test:go`）。
3. 同步文档：易变事实先更新 `docs/status.json`，设计决策进 `docs/open-questions.md`，
   状态进 `roadmap.md` / `backlog.md`，本次进度进 `docs/session-handover.md` 与相关专项交接，再跑 `npm run docs:check`。
4. 在独立分支提交，推送并按项目约定通过 PR 合入 `main`；确认 GitHub 已保存，记录仍未完成的检查。
5. **一次只做一件**；拿不准先记 backlog「待探讨」，不要闷头改主链路。

---

## 5. 环境与坑

- Node：用 `node --experimental-strip-types` 直接跑 `.ts`（无需构建）。**Node 22.23+**。
- 数据库：`node:sqlite`（Node 22 内置），同步 API；事务铁律：**外部 IO（模型/日志/发送）一律在事务外**。
- Go：`go1.22+`；根目录可执行 `npm run test:go`。
- Docker：`Dockerfile` + `docker-compose.yml` 已就绪；历史构建记录不代表当前机器已安装 Docker 或完成构建。
- 配置：开发时复制 `.env.example` 为 `.env`。关键项：`TD_ENGINE=fake|pi`、`TD_RUNNER_MODE=inprocess|process`、
  `TD_FEISHU_DIRECT=true|false`、`TD_HOST_PORT`、`TD_REPOS`、`TD_LOG_DIR`、`FEISHU_*` / `LARK_*`。
- 改动迁移：**新增迁移用 `007_` 前缀**，不要改历史迁移（当前头：`006_evidence_uid.sql`）。
- GEPA 环境：`scripts/evolve-env-setup.sh` 为 Linux 独立安装脚本，路径与要求见 [适配器说明](../tools/evolve/README.md)；
  `evolve:gepa` / `evolve:gepa:test` 脚本采用 POSIX 环境变量语法，Windows 需先核对 shell、Python 与 Node 路径。
- Linux 历史参考源码位于 `/opt/pi`、`/opt/miniclaw`、`/opt/deepseek-harness`；这些路径不属于仓库，也不保证接手机器存在。
- 云主机、Langfuse 数据与凭据迁移按 [资源与迁移清单](deployment-inventory.md) 操作；凭据不写入 Git，线上状态恢复时另行核验。

---

## 6. 当前状态

- 已实现：飞书接入（Webhook + 长连接）、会话路由、SQLite 持久化与状态机、租约/代次、可靠投递、只读工具与证据校验、
  Host 统一入口 + 原子入队 + 按会话严格轮次、独立 Runner 子进程、Host Web API + SSE、
  Web 会话页、Go 接入适配器（含签名校验/解密）、Langfuse 官方 SDK 观测、独立审计与有界补证、检索范围约束与分页覆盖信息。
- 评测：旧 v1/v2 harness（`src/evals/`）已移除；当前 `src/eval/` 的 `npm run eval` 入口有效，Langfuse 原生离线评测第一阶段已完成，语义人工复核仍待完成。
- 自改进：材料与准入、固定 TS 桥梁、公开模拟材料冻结基线与配置、Python C 适配器已实现；真实 GEPA 搜索未跑，D 目前只有初步报告与采用建议。
- 搜索边界：只优化 `diagnosis_rules`；基础提示词、工具、案例、评分器冻结；holdout 不参与搜索；预算为 `monitor`，请求前硬限待统一 gateway。
- 未完成：真实搜索、完整 D 审核/发布/回滚、语义裁判人工校准、E 真实案例扩展、候选固定后独立 holdout 验收；F 有限回放延后。
- 核验：历史记录与本机结果分开保存，最新见 `docs/status.json#self_improvement`；版本与测试静态统计见状态源，不将历史通过记录当作本轮结果。
- 阶段进度与开发清单：[路线图](roadmap.md)、[待办清单](backlog.md)；自改进从 [专项交接](self-improvement-handover.md) 继续。

---

## 7. 任务菜单（挑一个做，从易到难）

> 本表用于定位代码，任务状态与优先级以 [路线图](roadmap.md)、[待办清单](backlog.md) 和 [自改进交接](self-improvement-handover.md) 为准。
> 当前暂停；恢复后先修复本机环境与派生材料，再根据用户确定的目标继续自改进或产品接入工作。

| # | 任务 | 目标 / 验收 | 主要文件 | 难度 | token 友好 |
|---|---|---|---|---|---|
| ✅T1 | **Host 重启进程级验证（已完成）** | 见 `tests/integration/host-restart.test.ts`：SIGKILL → 重启 → 轮次恢复、不重复入队/追加输入 | — | — | — |
| ✅T2 | **docker 构建 + compose 冒烟（已完成）** | 两镜像构建通过；compose 起 host/adapter，Web/飞书事件/投递均跑通 | — | — | — |
| ✅T3 | **Go 适配器长连接模式（S3，已完成）** | 官方 Go SDK（`.../v3/ws`）实现 `eventsource.Source`，`ADAPTER_MODE=webhook|ws`；**方案见 `docs/adapter-longconn-design.md`**；真机验证步骤在 `adapters/go/README.md` | `adapters/go/internal/eventsource/`、`internal/platform/feishu/longconn.go`、`main.go`、`internal/adapter/` | 高 | 高 |
| ✅T4 | **多平台抽象（已完成）** | `Platform` 接口已就位，飞书已迁入；钉钉/Slack 尚为骨架，真实接入需实现并验证平台能力（OQ-37） | `adapters/go/internal/platform/` | 高 | 高 |
| T5 | **Web 页面增强** | 进度按轮次/阶段展示、证据与假设互跳、失败原因高亮、移动端可用；保持无框架 | `src/host/web/`、`src/host/server.ts` | 中 | 高 |
| ✅T6 | **证据持久化 + 稳定 UID（已完成，OQ-38）** | 工具返回前两阶段提交（材料先落盘再给模型）+ `evidence_uid`/调查内短号续签 + 崩溃恢复 + 报告 v1/v2；按 `docs/evidence-uid-design.md` §11 全部落地 | `src/evidence/`、`src/agent/toolbox.ts`、`src/diagnosis/*`、`src/host/runner-executor.ts`、`src/runner/protocol.ts`、`migrations/006` | 高 | 高 |
| ✅T7 | **`search_code` 有界预览 + 路径清单（已完成）** | 输出改为“按文件聚合的路径清单（≤20 文件）+ 前 8 处带 [E#] 的预览”；每处命中仍签 `E#`，validate 语义不变（OQ-36） | `src/agent/toolbox.ts`、`src/agent/pi-engine.ts` | 中 | 中 |
| T8 | **tool_executions 回放** | 按调查展示每次工具调用（入参/耗时/成败/结果规模），供审计与排查 | `src/storage/store.ts`、`src/host/server.ts`、`src/host/web/` | 中 | 中 |
| ✅T9 | **独立审计 + 有界补证（已完成，OQ-30）** | 独立会话逐结论判定、程序应用降级、共享预算补证；并行审计/主动检索仍待后续 | `src/diagnosis/diagnosis-loop.ts`、`src/diagnosis/audit.ts`、`src/agent/pi-auditor.ts` | 高 | 高 |
| T10 | **真实案例扩展 / 语义裁判** | 补真实历史故障并人工审定；模型裁判先以人工标注正反例校准 | `src/eval/`、`src/evolve/materials/` | 高 | 高 |
| T11 | **GEPA 搜索（C 剩余）** | 复验已有适配器，补请求前预算硬限，在冻结配置下执行真实搜索；不得混入 holdout | `tools/evolve/`、`src/evolve/` | 高 | 高 |
| T12 | **审核、发布与独立验收（D）** | 完善逐例差异/成本/采用建议，固定候选后独立验收，人工审核并具备发布回滚入口 | `tools/evolve/optimize.py`、`docs/self-improvement-implementation-plan.md` | 高 | 高 |

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
npm run docs:check       # 文档状态一致性检查（已并入 npm test）
node --experimental-strip-types scripts/evolve-materials.ts verify  # 原始材料完整性
npm run evolve:review:verify    # 派生案例与复核记录校验（先重建材料）
npm run evolve:config:verify    # 冻结搜索坐标校验

# 单文件调试（示例）
node --experimental-strip-types --test tests/integration/fault.test.ts
```

Langfuse 评测命令见 [原生评测方案](langfuse-eval-implementation-plan.md)，GEPA 命令见
[适配器说明](../tools/evolve/README.md)。真实模型实验需要凭据与预算，恢复环境校验不要求执行付费搜索。
