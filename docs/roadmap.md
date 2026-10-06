# 路线图（Roadmap）

> 目标与优先级：先完成闭环与治理观测，再优化效果，最后按触发条件扩展。
> 详细待办见 `backlog.md`；问题与结论见 `open-questions.md`；接口与格式约束见 `interface.md`。

## 总览

| 阶段 | 目标 | 状态 |
|---|---|---|
| 一、闭环与治理观测 | 外部触发 → 只读取证 → 结论写回；会话/对话记录满足治理与观测 | 接近完成（剩：时区统一；脱敏暂缓） |
| 二、评测与效果优化 | Benchmark 评测（RSI）、独立审计 Agent、提示词、skill/经验案例 | 已调整（2026-10-04）：评测 harness 整体移除、另行立项；审计 Agent 不受影响 |
| 三、扩展（按触发条件） | 生产诊断 MCP Server、真实日志平台、图片、多机/DB、前端、复现沙箱 | 未开始 |

---

## 阶段一：闭环与治理观测（进行中）

**已实现**

- 接入：Go 适配器（飞书 Webhook + 长连接 `ADAPTER_MODE=ws` + 签名/解密 + 门控单点化 + `-help`）、Host 统一入口、路由与去重。
- 持久化/调度：SQLite 单库（`session_entries`/`tool_executions`，**无 JSONL**）+ 租约/代次守卫 + 按会话严格轮次 + 投递（重试/不确定态）。
- 执行：独立 Runner 子进程；引擎端口（fake/pi）+ 6 个只读工具（`query_logs/list_files/search_code/read_code/request_info/submit_report`）。
- 证据：两阶段提交 + `evidence_uid` + 报告 v1/v2 + 崩溃恢复（OQ-38）。
- 交互：闲聊/追问 + `-help` 机械回复（Host 出文案、适配器发送）。
- 上下文防护：单条证据 + 单次工具结果双重截断 + pi compaction。
- 检索覆盖：工具返回带覆盖信息（总数 / 是否截断 / 是否还有 / 续查 cursor），数量上限不再静默切片；空结果与失败/越权分开（backlog T7）。
- 测试：`npm test`（TS）+ `npm run test:go`（Go adapter）+ `typecheck` 全绿；数量见 `docs/status.json#tests`。

**待完成（P0）**

- [x] **发生时间**从用户输入解析（区分上报时间与故障发生时间，宁漏勿错）。
- [x] **版本**按发生时间推断（`git rev-list --before`；显式 rev 优先；钉不到算缺失）。
- [x] 逐次**工具调用 / 模型对话 / token** 落盘（会话 JSONL + runs 指针/汇总，backlog T3/O1/O2/O3/P1）。
- [ ] 展示**时区**统一本地（报告材料范围已本地化，其余待统一）。
- [ ] 落盘前**脱敏**（backlog S1，暂缓）。

---

## 阶段二：评测与效果优化（已调整）

> **2026-10-04**：评测 harness（v1/v2）随观测接入方案整体移除，`npm run eval` 等入口不复存在，
> 以下打勾项保留为历史记录，基线数字不可复现；M2/M3 另行立项时以观测数据为起点。

- [x] **评测 Benchmark（RSI）— M1**：harness + `checkout-timeout` 5 case + 打分器（`npm run eval`）。基线数字唯一事实源见 `docs/status.json#eval`；v2 校准口径（OQ-41）：真实模型中位数 90 / 22.3 / 80（3 次明细在内）。旧口径 90/30.7/80（D6 前 + scorer v1）**已作废，勿引用**。详见 `docs/eval-design.md`。
- [x] **修评测打分器（P0）**：已修——`scorer` 同时按 `evidence_uid` 与 `E#` 建索引，`EvidenceRecord` 增 `evidenceUid`（UID 兼容）；fake 基线误报 0% 已纠正。口径随后升级 v2 校准（OQ-41），数字以 `docs/status.json#eval` 为准。见 `docs/session-handover.md §4`。
- [ ] **评测 Benchmark（RSI）— M2**：`rules.md` 条目化 + 增量 delta + 程序合并（照 ACE）；Pareto + μ_f（照 GEPA）；扩样本（20~30）、judge 版正确率、独立 test 集、CI 门禁。
- [ ] **评测 Benchmark（RSI）— M3**：L1 自动迭代（`docs/evolve-protocol.md`）、场景迁移验证。
- [ ] **独立上下文审计 Agent**：证据充分性审查，结构化输出已确认事实/疑似原因/补证请求（OQ-30）。
- [ ] 提示词调优（针对"跳工具直接作答 / 过度归因 / 漏报缺失材料"做 A/B）。
- [x] 工具补**路径层** `list_files`（照搬 pi `ls`/`find` 分层）。
- [x] `search_code` 改"有界预览 + 路径清单"（清单 ≤20 文件 + 前 8 处预览；每处命中仍签 `E#`，见 OQ-36）。
- [ ] **skill 描述**与**经验案例**（历史成功诊断沉淀）。
- [x] **证据持久化与稳定 UID**：两阶段提交（工具 commit 时落库）、`evidence_uid` 全局唯一、调查内短号续签、崩溃恢复、报告 v1/v2 共存（OQ-38，`docs/evidence-uid-design.md`）。
- [ ] **跨轮上下文复用**（backlog P3/Q3；证据部分已完成，上下文部分待设计）。

---

## 架构演进：Host / Runner / 接入层（对齐平台文档）

> 设计见 `docs/host-runner-design.md`。

- [x] Host 统一入口 + 原子入队 + 按会话严格轮次串行 + 会话间公平 + 显式取消（阶段1）
- [x] 独立 Agent Runner 子进程 + Host 监管 + NDJSON 回写（阶段2）
- [x] Host Web API + EventStore/SSE replay + 投递 claim/result（阶段4）
- [x] Go 接入适配器骨架（飞书 Webhook + 投递轮询）
- [x] 多平台抽象：`internal/platform.Platform` 接口 + 飞书迁入 + 钉钉/Slack 骨架（`ADAPTER_PLATFORMS`，OQ-37）
- [x] Go 适配器长连接模式（官方 larkws SDK，实现 `eventsource.Source`；`ADAPTER_MODE=ws`；真机人工验证待有凭据时执行）
- [x] Web 会话页面（列表 / 时间线 / 进度 / 报告 + SSE 实时刷新，无框架无构建）
- [x] 故障注入：超时 / 运行中取消 / 租约回收后会话恢复 / 僵尸提交被拒（`tests/integration/fault.test.ts`）
- [x] docker-compose / Dockerfile 部署清单（host + adapter + 数据卷 + 源码/日志只读挂载）
- [x] 镜像构建与整链路验证（compose 起 host/adapter，Web/飞书事件/投递均跑通）
- [x] Host 重启的进程级验证（强杀 → 重启 → 轮次恢复且不重复入队/追加输入）

---

## 阶段三：扩展（按触发条件）

| 事项 | 触发条件 | 说明 |
|---|---|---|
| 生产诊断 MCP Server | 工具外化 / 被其他 Agent 复用 | 封装 `query_logs/search_code/read_code` 为 MCP tools；结构化参数限定服务/时间窗/范围，只读凭据 + 超时 + 结果规模控制，返回带来源与版本证据（backlog Q7） |
| 真实日志平台 SLS/ELK 适配器 | 接入真实日志 | 按端口新增实现，不动编排 |
| 图片 / 截图处理 | 需要处理截图 | 下载 → 视觉模型 → 登记证据 |
| PostgreSQL | 多机部署 / 单机写瓶颈 | 单机 SQLite(WAL) 足够，无触发不引入 |
| 管理前端 | 非工程人员需查看 | 当前 CLI/SQL 排查 |
| Playwright 复现 | 测试环境 + 隔离沙箱 + 人工授权 | 非默认链路，与只读定位隔离 |
| Codex 可选引擎 | 需要对比/替换引擎 | 端口已可插拔（backlog Q4） |
