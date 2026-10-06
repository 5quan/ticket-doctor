# 交接文档

> 仓库：https://github.com/5quan/ticket-doctor （private）
> 代码根目录：`/opt/ticket-doctor`
> **开工前先读「七、交接规程」**：会话开始读什么、按什么推进、如何收尾。

## 一、我们要实现的目标

**产品目标**
测试提交 Bug 后自动触发诊断 Agent，结合日志、源码检索与飞书群补证，前置完成 Bug 预诊断，
缩短开发接手后的排查准备时间；生产环境只读诊断，辅助定位线上异常。
具体形态：在飞书群里提交 Bug 后，利用“开发接手前”的空窗期，自动查询日志、读取指定版本源码，
生成**每条结论都可追溯到证据编号**的预检报告，并支持在同一调查内多轮补充材料。
报告给的是**根因假设**，最终根因由开发确认。

**能力全景（对外简介口径）**

| # | 能力 | 要点 | 状态 |
|---|---|---|---|
| 1 | 能力与材料接入 | 日志检索 / 代码检索 / 飞书群补证统一注册为 Agent 工具；按候选假设定向取证；证据不足时在飞书话题 @ 相关人员补背景；生产只读 | 工具已就绪；@ 相关人员补证待做 |
| 2 | 独立审计 Agent | 把“证据是否充分”剥离到独立上下文，结构化输出已确认事实/疑似原因/补证请求，程序按预算收敛 | 设计已定（OQ-30），阶段二实现 |
| 3 | 评测与记忆规则迭代 | RSI 思路：Benchmark（标准答案+支撑证据+干扰证据），以证据召回率/决策正确率评估，迭代场景记忆规则 | 评测 harness（v1/v2）已移除、另行立项；审计 Agent 与规则迭代不受影响 |
| 4 | 生产诊断 MCP Server | 结构化参数限定服务/时间窗/范围，只读凭据 + 超时 + 结果规模控制，返回带来源与版本证据 | 阶段三实现 |
| 5 | 可靠执行与可观测内核 | 持久化状态机 + 租约/代次守卫 + 投递不确定态；逐次工具/对话/token append-only 落盘，可回放可审计 | ✅ 已实现（含 Langfuse OTel 观测；面试口述见 `docs/interview-reliability.md`） |

**工程目标（为什么要自己做，而不是“接一个现成 Agent”）**
1. 把“通用 Agent 循环”变成**有保证的产品**：接入可靠、状态可恢复、证据可核验、权限可控。
2. 明确边界：只读、不自动修复、不写业务系统；单机、SQLite、无 Redis/向量库。
3. 作为可展示的个人项目：体现的是**Agent 系统工程的 harness（工具/权限/证据/状态/投递）**，
   而不仅是“调了一次大模型”。

**推进优先级（已确立）**
1. 第一阶段（当前）：完成「外部触发 → 只读功能 → 结论写回」的闭环；保证会话管理、对话记录保存合理，满足治理与观测需求。
2. 第二阶段：评测与效果优化——Benchmark 评测（RSI）、独立审计 Agent、提示词、skill/经验案例。
3. 第三阶段：扩展——生产诊断 MCP Server、真实日志平台、图片等。

## 二、当前实现情况

**已实现（可运行、有测试）**

| 模块 | 内容 | 状态 |
|---|---|---|
| 飞书接入（经 Go 适配器） | Webhook：事件归一化、签名/Encrypt Key 解密、去重；@ 门控单点在 Host（群聊新会话必须 @）；`-help` 机械回复 | ✅ 长连接已实现（`ADAPTER_MODE=ws`，OQ-40；真机验证待执行） |
| 会话路由 | 标号 `[TD-xxxxxxxx]` / root / thread / parent；不同群不合并 | ✅ 真机跑通 |
| 持久化 | SQLite(`node:sqlite`) schema：inbound/investigation/messages/runs/attempts/run_events/**session_entries/tool_executions**/evidence/reports/deliveries | ✅ |
| 调度 | worker 池、同调查串行 / 不同调查并行、租约 + 代次守卫、过期回收 | ✅ |
| 诊断引擎 | 端口 + 假引擎（离线）+ pi 引擎（真实，SDK 隔离在单文件） | ✅ 真机两轮跑通 |
| 交互回复 | 闲聊直接回复、必要时 `request_info` 反问追问；`submit_report` 提交即结束（`terminate`） | ✅ 新增 |
| 机械回复 | 仅 `-help` 走程序固定回复（不建调查、不走模型）；其余消息一律交 LLM | ✅ 新增 |
| 工具 | `query_logs / list_files / search_code / read_code / request_info / submit_report`，限次/限长/白名单；`search_code` 输出为「路径清单（≤20 文件）+ 前 8 处预览」（OQ-36） | ✅ |
| 上下文防护 | 单条证据 + 单次工具结果双重截断，pi compaction 兜底 | ✅ |
| 时间区分 | 上报时间（平台）+ 故障发生时间（从输入提取，宁漏勿错）；时间窗依据如实标注 | ✅ |
| 版本钉死 | 有发生时间时按 `git rev-list --before` 钉当时 SHA（显式 rev 优先；钉不到记为缺失，不回退 HEAD） | ✅ |
| 证据 | 两阶段提交（工具 commit 时落库，fail-closed）+ `evidence_uid` 全局唯一 + 调查内短号 `E{n}` 续签；报告只引用 ID（v2=uid，v1=run 级 E#）、校验引用与版本（D10 历史版本降级）、无证据强制降级；批次表支撑幂等与崩溃恢复（OQ-38） | ✅ |
| 投递 | 待发送记录、退避重试、**不确定态**、平台消息 ID | ✅ 真机回复成功 |
| 会话持久化（单存储） | pi 会话条目原样落 `session_entries`（按调查单调 `seq`）；引擎读回写 seed 文件给 pi 重建、崩溃时 `reconcileSession` 补未决工具结果并 `Agent.continue()`；JSONL 已移除 | ✅ |
| 评测 harness（v1/v2，离线） | `npm run eval` 等入口与 `src/evals/` 已随观测接入方案整体移除、另行立项；历史设计见 `docs/eval-design.md`，冻结基线见 `docs/status.json#eval` | ⛔ 已移除 |
| Host 统一入口 + 队列 | 原子入队（去重+关联+消息+轮次同事务）、按会话严格轮次串行、会话间公平、显式取消、来源路由 | ✅ 阶段1 |
| 独立 Agent Runner | Host 每轮 spawn Node 子进程；NDJSON 协议；Host 校验代次后代为落库；单进程崩溃只判本轮 | ✅ 阶段2 |
| Host Web API + SSE | `/api/agent/*`：message/investigations/events(SSE replay)/runs cancel·retry/deliveries claim·result | ✅ 阶段4 |
| Web 会话页面 | Host 托管静态页（`src/host/web/`）：列表/时间线/轮次状态与取消重试/证据报告，SSE 自动重连 | ✅ 阶段4 |
| Go 接入适配器 | `adapters/go`：`Platform` 多平台接口（OQ-37）+ 飞书实现（事件归一化、fail-closed mention 门控、签名校验/Encrypt Key 解密、转发 Host、投递轮询发送）；钉钉/Slack 骨架；回调路由 `/{platform}/events`，投递按 provider 路由 | ✅ 阶段3（Webhook + 长连接 `ADAPTER_MODE=ws` + 多平台抽象就位，OQ-40） |
| 故障与部署 | Host 强杀重启恢复（进程级测试）；Dockerfile + docker-compose（host/adapter + 数据卷 + 只读挂载），compose 整链路冒烟通过 | ✅ 阶段5 |
| 测试 | `npm test`（TS）+ `npm run test:go`（Go adapter）+ `typecheck` 全绿；数量见 `docs/status.json#tests` | ✅ |

**未实现 / 明确边界**

- 真实日志平台（SLS/ELK）适配器；当前为本地文件日志源。
- 脱敏。
- 环境部署记录推断版本（当前按发生时间/HEAD 推断）。
- 图片/截图处理（当前只处理 `text`）。
- 独立上下文审计 Agent（证据充分性审查，见 `open-questions.md` OQ-30）。
- 仓库同步器（本地只读镜像由外部更新）。
- 出站消息映射（已决定暂缓）；上下文跨轮复用待设计（证据跨轮已完成，OQ-38）。
- 证据已升级为持久化 + 稳定 UID（OQ-38）：工具 commit 时入库、`evidence_uid` 全局唯一、调查内短号续签跨轮可引用；详见 `docs/evidence-uid-design.md`。

**运行方式**

```bash
npm install
npm test                 # 全量测试（数量见 docs/status.json#tests）
npm run demo             # 离线端到端（假引擎）
TD_ENGINE=pi npm run demo
npm run gateway          # 旧链路：飞书接入 + 投递 + 内嵌 4 worker（常驻；过渡期保留）
npm run worker           # 只跑 worker
```

配置见 `.env.example`；真实飞书需 `FEISHU_APP_ID/SECRET`，真实模型需 `TD_ENGINE=pi` + key。

## 三、问题与讨论

- 所有提出过的问题、结论与状态，统一记录在 `docs/open-questions.md`（OQ-1 ~ OQ-44）。
- 本轮已解决（示例）：只读价值定位、并发能力、pi 会话持久化含义、信息爆炸处理、路径压缩、
  工具分层照搬、交互/机械回复、发生时间与版本按输入锚定。
- 仍待探讨：独立上下文审计 Agent（OQ-30）、图片处理（OQ-27）、上下文跨轮复用（证据跨轮已完成，OQ-38）。

## 四、关键决策记录

| 决策 | 结论 |
|---|---|
| commit 是否强制 | 不强制。有发生时间则按 `git rev-list --before` 钉事件当时的版本；显式 rev 优先；钉不到记为缺失（不回退 HEAD），并如实标注依据 |
| 时间锚点 | 区分**上报时间**（平台）与**故障发生时间**（从输入提取，宁漏勿错）；提取不到按上报时间回溯宽窗并标注 |
| 工具语义不为预算让路 | 照搬 pi 分层（路径→定位→内容）；预算在编排层管，不合并/裁剪工具 |
| 标号 vs 引用 id 冲突 | **以标号为主**（当前实现即如此） |
| 出站消息映射 | 暂缓，不做 |
| pi 会话持久化 | 已启用：pi 会话条目进 SQLite `session_entries`（单存储）；引擎读回重建、崩溃补未决工具结果后续跑；不再用 JSONL / `contextSummary` |
| 飞书交互 | 最小权限 `im:message.group_at_msg:readonly`，**每次回复 @机器人** |
| 存储 | 单机 SQLite(WAL) + `node:sqlite`，暂不引入 PostgreSQL |
| 引擎 | 默认 `fake`（离线）；真实模型切 `TD_ENGINE=pi` |
| 里程碑优先级 | 先完成「外部触发→只读取证→结论写回」闭环 + 会话/对话记录满足治理观测；再优化效果（提示词/工具/skill 描述/经验案例） |
| 闲聊/追问 | 一律走 LLM；闲聊直接回复；必要时 `request_info` 向用户追问后结束本轮；仅 `-help` 由程序机械回复（不建调查） |
| 工具结果上限 | 单条证据按 `maxResultChars` 截断 + 单次工具调用总量按 `maxToolResultChars` 截断并提示 |
| 上下文兜底 | 开启 pi compaction 作为总量兜底（`TD_COMPACTION_ENABLED`，默认 true）；单次工具结果仍有界 |
| 会话日志存储 | 单库：`session_entries`（pi 条目 JSON + 调查内 `seq`）+ `tool_executions`（工具可观测）；不再存 JSONL 文件 |
| 记忆规则形态 | 条目化 bullet（id + helpful/harmful + 标签），**增量 delta 更新、程序确定性合并**（照 ACE，防 context collapse） |
| 自动迭代机制 | LLM 按**执行轨迹+评估轨迹**反思产 delta；**Pareto 选候选** + 带文字的反馈函数 μ_f（照 GEPA）；AI 提案、程序/基准裁判；L0→L1→L2 分阶段 |
| 评测题源 | 合成 fixture 仅用于 harness 自测；真实质量必须以**历史真实 bug + 人工标注 gold** 为准（`docs/eval-design.md`） |

## 五、待办

- `docs/roadmap.md`：路线图与阶段目标。
- `docs/backlog.md`：可优化清单（F 飞书、T 工具、O 可观测、P 持久化、S 安全、M 材料、R 可靠性、E 工程、Q 专项、N 输入与版本、D 部署）。
- `docs/open-questions.md`：问题与讨论记录（OQ）。
- `docs/interface.md`：接口与格式约束（业务场景、部署、输入输出、数据交互、**触发后流程与可调用清单**）。
- `docs/session-log-design.md`：会话持久化设计稿（对齐 pi durable storage；含 §0.5 单库收敛方向；待探讨）。
- `docs/concurrency.md`：worker 并发模型与并发漏洞清单（W1~W12；待专项梳理）。
- `docs/usage.md` / `docs/feishu-channel.md`：产品用法与飞书渠道设计。
- `docs/status.json`：易变事实唯一源；`docs/session-handover.md`：最新会话概要；`docs/contributor-onboarding.md`：十分钟上手。
- `docs/langfuse-observability-implementation-plan.md` / `docs/self-host-langfuse-runbook.md`：观测接入方案与自托管部署避坑。

## 六、当前进度与下一步

> **最新会话概要见 `docs/session-handover.md`（先读那个）**。本节只留长期口径。

**已完成（主干闭环：外部触发 → 会话创建 → 执行 → 结果返回）**

- 阶段 1：Host 统一入口 + 原子入队 + 按会话严格轮次 + 会话间公平 + 取消 + 来源路由。
- 阶段 2：独立 Agent Runner 子进程 + Host 监管 + NDJSON 回写（`TD_RUNNER_MODE=process`）。
- 阶段 4：Host Web API + EventStore/SSE replay + Web 会话页 + 投递 claim/result。
- 阶段 3：Go 接入适配器（飞书 Webhook + 签名/解密 + 门控单点化 + `-help`；多平台接口 OQ-37）；**长连接 S3 已实现**（官方 Go SDK 锁 v3.12.0，`ADAPTER_MODE=ws`；真机人工验证待有凭据，OQ-40）。
- 阶段 5：故障注入 + Host 强杀重启 + docker-compose 整链路验证。
- 证据：两阶段提交 + 稳定 UID + 报告 v1/v2（OQ-38）；工具 6 个（含 `list_files`、`search_code` 有界预览）。
- 检索范围：`query_logs` 在工具入口强制本轮 `service` + 时间窗；`TD_ALLOWED_REPOS` 成硬白名单（OQ-44）。
- 检索覆盖：工具返回带覆盖信息（总数 / 是否截断 / 是否还有 / 续查 cursor），数量上限不再静默切片；空结果与失败/越权分开（backlog T7）。
- 独立审计（OQ-30）：同一 Runner 内诊断 → 独立审计会话 → 程序逐结论降级；不主动检索、失败显式降级不阻断；有界补证循环由 `TD_AUDIT_MAX_ROUNDS` 封顶；`AUDIT_POLICY_VERSION` 随结果落库。
- 评测：旧 v1/v2 harness 已移除、另行立项（历史口径见 `docs/eval-design.md`；冻结基线见 `docs/status.json#eval`）。

**最高优先**：S4 弃用 Host 内直连 → 独立审计 Agent（OQ-30）→ 评测 M2/M3；S3 真机人工验证待有飞书凭据时执行。

**暂缓/边界**：脱敏（S1）、出站消息映射；不做权限体系；不复现、不写业务系统、不自动修复；生产只读。

## 七、交接规程

> 会话开始照此执行；推进时照此排队；收尾照此更新。目标：**任何一次新会话都能很快进入状态，且不跑偏。**

### 7.1 会话开始（阅读顺序）

0. （新接手的 Agent）先读 `docs/session-handover.md` —— 最新会话概要；
   再读 `docs/contributor-onboarding.md` —— 十分钟上手 + 任务菜单；
   再读 `docs/handover-technical-plan.md` —— 剩余工作的技术方案与推荐执行顺序。
1. `docs/handover.md`（本文）—— 目标 / 实现 / 决策 / 进度 / 下一步。
2. `docs/roadmap.md` —— 当前阶段与优先级。
3. `docs/backlog.md` —— 只挑「进行中」+ 当前阶段的 P0/P1。
4. `docs/open-questions.md` —— 已结论的问题，避免重复讨论。
5. 改代码前必读 `docs/interface.md`（接口与格式约束）。
6. 按任务读专项：
   - 评测 / 规则迭代 → `docs/eval-design.md`、`docs/evolve-protocol.md`
   - 飞书 / 接入 → `docs/feishu-channel.md`、`docs/usage.md`
   - 会话 / 持久化 → `docs/session-log-design.md`、`docs/interface.md §8.7`
   - 并发 / worker → `docs/concurrency.md`
   - 简历 / 面试 → `docs/interview-reliability.md`
7. **先跑基线**：`npm run typecheck && npm test`，确认全绿再动。
8. 设计参考源码：`/opt/pi`、`/opt/miniclaw`、`/opt/deepseek-harness`；平台参考 `/opt/locatebug/研发Agent平台项目文档`。

### 7.2 推进规则

1. **先当前阶段 P0，再 P1**；一次只做一件（由 roadmap → backlog 决定顺序）。
2. 每个改动走完整闭环：**实现 → `typecheck` → `test` → 更新文档 → commit → push**。
3. **不引入无触发条件的架构**（PG / Redis / MQ / 前端 / 第二模型压缩层）；触发条件写在 backlog。
4. 设计决策记入 `open-questions.md`；结论一旦成立，不再反复讨论。
5. 硬边界不变：**只读、不复现、不自动修复、不写业务系统、单机 SQLite**。
6. 小步可验证；拿不准先记「待探讨」，不要闷头改主链路。

### 7.3 收尾（每次改动后）

1. 若改动了任何**易变事实**（版本/测试数/迁移头/基线分数/功能状态），**先改 `docs/status.json`**。
2. 跑 `npm run docs:check`（已并入 `npm test`，漂移会直接挂测试）。
3. 更新 `handover.md` 的「六、当前进度与下一步」；`backlog.md` 状态、`roadmap.md` 勾选。
   其他文档只许**引用** status.json，不许手写死数字。
4. `commit`（信息说清“改了什么 / 为什么”）+ `push`（保持 origin 同步）。

### 7.4 文档角色约定（易变事实单源化）

| 文档 | 角色 | 状态怎么维护 |
|---|---|---|
| `docs/status.json` | 易变事实唯一源 | 手改，`npm run docs:check` 校验 |
| `session-handover.md` §1–3 | 会话级快照 | 引用 status.json；数字行带 `<!-- status:volatile -->` 可豁免检查 |
| `handover.md` §2/§六 | 长期叙述 | 不写测试数/版本等数字，链接 status.json |
| `roadmap.md` / `backlog.md` | 逐项状态 | 状态用词统一，数字引用 status.json |
| `host-runner-design.md` / `evidence-uid-design.md` / `adapter-longconn-design.md` / `langfuse-observability-implementation-plan.md` | **时点设计/工作单记录** | 头部一行 `> 状态见 docs/status.json#features.<x>`，不再维护快照 |
| `open-questions.md` | 决策历史（append-only） | 新结论追加，旧结论标"已取代"，不改写历史 |

### 7.5 冲突与例外

- **文档与代码不一致时以代码为准**，并顺手修正文档（本项目已发生过多次）。
- 新想法先进 backlog「待探讨」，不直接改主链路。
- 用户明确说“暂缓”的项（如脱敏 S1）不要自作主张做。
