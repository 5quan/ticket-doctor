# 路线图（Roadmap）

> 目标与优先级：先完成闭环与治理观测，再优化效果，最后按触发条件扩展。
> 详细待办见 `backlog.md`；问题与结论见 `open-questions.md`；接口与格式约束见 `interface.md`。
> 当前处于暂停开发状态；状态日期与功能事实见 [status.json](status.json#development)。文档导航见 [文档目录](README.md)。

## 恢复开发时先做什么

先读 [自改进交接](self-improvement-handover.md)，再按下列顺序逐项推进；暂停期间不自动运行真实模型实验。

| 顺序 | 工作 | 可验证结果 |
|---|---|---|
| 1 | 恢复本地依赖、材料与运行环境 | 工程检查通过；原始材料核验通过；派生案例重建后准入与冻结搜索配置校验通过；Windows 换行造成的指纹差异须先核对，不能直接覆盖冻结值 |
| 2 | 验证现有 C 适配器，补搜索保障 | 无模型单测通过；搜索制品与 holdout/私有答案隔离；请求前预算拦截覆盖诊断、审计、反思和裁判，检查点与恢复行为可核验 |
| 3 | 首次真实 GEPA 搜索与候选复核 | 在确认模型调用预算后，仅优化 `diagnosis_rules`；保留候选历史、逐 case/trial 对比、失败反馈与成本，不强制产生提升 |
| 4 | 固定候选并独立验收 | 候选 hash 固定后，基线与候选在独立 holdout 上成对评测；保留集结果不回传同一轮搜索 |
| 5 | 完成交付 D 审核与发布闭环 | 完整审核报告、人工批准记录、实际加载版本核对、发布与回滚入口；无可靠提升则保留基线 |
| 并行 | 语义裁判校准与 E 真实案例 | 训练材料的人工标注正反例校准裁判，复现 FastAPI 历史故障；若改变材料或评分口径，重新冻结并重跑基线 |
| 后续 | F 有限历史回放 | 积累足够候选历史后再实施，离线回放改善还需新的在线搜索验证 |

具体状态以 [自改进状态](status.json#self_improvement) 和 backlog 的 RSI 清单为准。搜索配置中的预算字段目前不等于请求前硬限额。

## 总览

| 阶段 | 目标 | 状态 |
|---|---|---|
| 一、闭环与治理观测 | 外部触发 → 只读取证 → 结论写回；会话/对话记录满足治理与观测 | 主干已实现；飞书长连接待真机验收，时区统一待补，脱敏暂缓 |
| 二、评测与效果优化 | 独立审计、Langfuse 原生评测、GEPA 诊断规则优化 | 审计与评测底座已实现；A/B、冻结基线与配置、C 适配器已入库；真实搜索、独立验收与完整发布闭环待完成 |
| 三、扩展（按触发条件） | 生产诊断 MCP Server、真实日志平台、图片、多机/DB、前端、复现沙箱 | 未开始 |

---

## 阶段一：闭环与治理观测（主干已实现）

**已实现**

- 接入：Go 适配器（飞书 Webhook + 长连接 `ADAPTER_MODE=ws` + 签名/解密 + 门控单点化 + `-help`）、Host 统一入口、路由与去重。
- 持久化/调度：SQLite 单库（`session_entries`/`tool_executions`，**无 JSONL**）+ 租约/代次守卫 + 按会话严格轮次 + 投递（重试/不确定态）。
- 执行：独立 Runner 子进程；引擎端口（fake/pi）+ 6 个只读工具（`query_logs/list_files/search_code/read_code/request_info/submit_report`）。
- 证据：两阶段提交 + `evidence_uid` + 报告 v1/v2 + 崩溃恢复（OQ-38）。
- 交互：闲聊/追问 + `-help` 机械回复（Host 出文案、适配器发送）。
- 上下文防护：单条证据 + 单次工具结果双重截断 + pi compaction。
- 检索覆盖：工具返回带覆盖信息（总数 / 是否截断 / 是否还有 / 续查 cursor），数量上限不再静默切片；空结果与失败/越权分开（backlog T7）。
- 检索范围：`query_logs` 强制本轮服务/时间窗，`TD_ALLOWED_REPOS` 是硬白名单（OQ-44）；环境/request-id 结构化过滤仍待做。
- 历史工程检查已有通过记录；测试数量见 `docs/status.json#tests`。当前暂停快照存在本机依赖与生成产物缺口，恢复时须重新验证，不沿用历史“全绿”结论。

**验收与遗留**

- [x] **发生时间**从用户输入解析（区分上报时间与故障发生时间，宁漏勿错）。
- [x] **版本**按发生时间推断（`git rev-list --before`；显式 rev 优先；钉不到算缺失）。
- [x] 逐次**工具调用 / 模型对话 / token** 落盘（SQLite `session_entries` / `tool_executions` + runs 汇总，backlog T3/O1/O2/O3/P1；JSONL 已移除）。
- [ ] 展示**时区**统一本地（报告材料范围已本地化，其余待统一）。
- [ ] 落盘前**脱敏**（backlog S1，暂缓）。

---

## 阶段二：评测与效果优化（底座完成，搜索与发布待做）

> 旧 v1/v2 harness（`src/evals/`）已移除，旧基线只保留为历史，不与现体系混比。
> 当前已有 `src/eval/` 离线 MVP、`src/eval/lf/` 原生 Langfuse 实验、`src/evolve/` 固定评测桥梁和 `tools/evolve/` GEPA 适配器。
> 自改进按 [实施方案](self-improvement-implementation-plan.md) 和 [交接](self-improvement-handover.md) 推进；首版只修改外部 `diagnosis_rules`，基础 prompt、工具、案例、答案与评分器冻结。

- [x] **离线评测 MVP 与 Langfuse 原生实验**：本地执行、dataset/prompt 版本、trace/score 关联与严格读回已接入；语义人工复核仍待完成，见 `docs/status.json#eval_langfuse`。
- [x] **Langfuse tracing SDK 迁移**：业务观测已迁移官方 SDK，见 `docs/langfuse-sdk-migration.md`。
- [x] **交付 A：材料与准入**：日志-only 材料转换、私有 rubric、复核记录、数据集装配与 train/validation 准入；holdout 保留，见 `docs/self-improvement-materials.md`。
- [x] **交付 B：固定评测桥梁**：候选编译、确定性评分、轨迹与批量协议、预算账本；账本目前是 monitor，不代表请求前硬限额，见 `docs/self-improvement-bridge.md`。
- [x] **冻结基线与搜索配置**：真实模型重复基线已记录可复现缺口；模型、评分与允许改动范围已冻结，见 `docs/self-improvement-baseline.md`、`docs/self-improvement-search-config.md`。
- [x] **交付 C 的适配器与入口**：`tools/evolve/` 已实现批量桥接、反馈整理、反射 LM、GEPA 入口和初步报告输出；真实搜索未运行。
- [ ] **请求前预算与隔离验收**：统一模型 gateway、原子预留与恢复结算；独立搜索制品与 holdout 验收环境须核验。
- [ ] **真实搜索与候选重复比较**：确认付费调用预算后执行，保留候选树、逐例变化、硬失败、成本与检查点。
- [ ] **交付 D：完整审核、独立验收、发布与回滚**：当前仅有初步报告代码；自动结论不构成人工批准或生产发布。
- [ ] **语义裁判与 E 真实案例扩展**：人工标注校准、FastAPI 历史故障复现及内部事故沉淀；与公开模拟集分别报告。
- [ ] **F 有限历史回放**：留第二阶段，先积累候选历史。
- [x] **独立上下文审计 Agent（含有界补证循环）**：诊断 → 程序冻结草稿+证据快照 → 独立审计会话（不主动检索）→ 程序逐结论降级；审计判 continue 且有缺证项时按 `TD_AUDIT_MAX_ROUNDS`（默认 1）回主诊断补证再审计；失败显式降级不阻断；`AUDIT_POLICY_VERSION=1.0.0`（OQ-30）。并行审计/主动检索待后续。
- [ ] 提示词调优（针对“跳工具直接作答 / 过度归因 / 漏报缺失材料”做 A/B；改基础 prompt 须另开冻结实验，不混入当前规则搜索）。
- [x] 工具补**路径层** `list_files`（照搬 pi `ls`/`find` 分层）。
- [x] `search_code` 改"有界预览 + 路径清单"（清单 ≤20 文件 + 前 8 处预览；每处命中仍签 `E#`，见 OQ-36）。
- [ ] **skill 描述**与**经验案例**（历史成功诊断沉淀）。
- [x] **证据持久化与稳定 UID**：两阶段提交（工具 commit 时落库）、`evidence_uid` 全局唯一、调查内短号续签、崩溃恢复、报告 v1/v2 共存（OQ-38，`docs/evidence-uid-design.md`）。
- [ ] **跨轮上下文选择与压缩优化**（backlog P3/Q3；会话条目恢复与证据跨轮引用已实现，进一步的材料选择策略待设计）。

**历史编号保留**：M1 与 OQ-41 打分器修正属于已移除的 v1/v2 体系，历史结果见 `docs/status.json#eval`；M2/M3 是扩样本、judge、CI 与迁移验证的旧规划编号，不表示当前评测入口尚不存在。ACE 式条目化 delta 合并不属于首版全文规则候选范围。

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
- [x] 服务器迁移清单与导出/恢复脚本（`scripts/migrate-export.sh`、`scripts/migrate-restore.sh`）；迁移包可附同架构预编译适配器，源码仓库不包含密钥与数据库备份。

---

## 阶段三：扩展（按触发条件）

| 事项 | 触发条件 | 说明 |
|---|---|---|
| 生产诊断 MCP Server | 工具外化 / 被其他 Agent 复用 | 封装 `query_logs/search_code/read_code` 为 MCP tools；结构化参数限定服务/时间窗/范围，只读凭据 + 超时 + 结果规模控制，返回带来源与版本证据（backlog Q7） |
| 真实日志平台 SLS/ELK 适配器 | 接入真实日志 | 按端口新增实现，不动编排 |
| 图片 / 截图处理 | 需要处理截图 | 下载 → 视觉模型 → 登记证据 |
| PostgreSQL | 多机部署 / 单机写瓶颈 | 单机 SQLite(WAL) 足够，无触发不引入 |
| 管理前端增强 | 非工程人员需管理或工具回放 | 已有 Web 会话页面；完整管理、工具回放与移动端体验仍可扩展 |
| Playwright 复现 | 测试环境 + 隔离沙箱 + 人工授权 | 非默认链路，与只读定位隔离 |
| Codex 可选引擎 | 需要对比/替换引擎 | 端口已可插拔（backlog Q4） |
