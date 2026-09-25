# 交接文档

> 仓库：https://github.com/5quan/ticket-doctor （private）
> 代码根目录：`/opt/ticket-doctor`

## 一、我们要实现的目标

**产品目标**
在测试于飞书群提交 Bug 后，利用“开发接手前”的空窗期，自动查询日志、读取指定版本源码，
生成**每条结论都可追溯到证据编号**的预检报告，并支持在同一调查内多轮补充材料。
报告给的是**根因假设**，最终根因由开发确认。

**工程目标（为什么要自己做，而不是“接一个现成 Agent”）**
1. 把“通用 Agent 循环”变成**有保证的产品**：接入可靠、状态可恢复、证据可核验、权限可控。
2. 明确边界：只读、不自动修复、不写业务系统；单机、SQLite、无 Redis/向量库。
3. 作为可展示的个人项目：体现的是**Agent 系统工程的 harness（工具/权限/证据/状态/投递）**，
   而不仅是“调了一次大模型”。

**推进优先级（已确立）**
1. 第一阶段（当前）：完成「外部触发 → 只读功能 → 结论写回」的闭环；保证会话管理、对话记录保存合理，满足治理与观测需求。
2. 第二阶段：优化使用效果——提示词、工具、skill 描述、经验案例等。

## 二、当前实现情况

**已实现（可运行、有测试）**

| 模块 | 内容 | 状态 |
|---|---|---|
| 飞书接入 | 官方 SDK 长连接、事件归一化、fail-closed mention 门控 | ✅ 真机跑通 |
| 会话路由 | 标号 `[TD-xxxxxxxx]` / root / thread / parent；不同群不合并 | ✅ 真机跑通 |
| 持久化 | SQLite(`node:sqlite`) schema：inbound/investigation/messages/runs/attempts/run_events/evidence/reports/deliveries | ✅ |
| 调度 | worker 池、同调查串行 / 不同调查并行、租约 + 代次守卫、过期回收 | ✅ |
| 诊断引擎 | 端口 + 假引擎（离线）+ pi 引擎（真实，SDK 隔离在单文件） | ✅ 真机两轮跑通 |
| 交互回复 | 闲聊直接回复、必要时 `request_info` 反问追问；`submit_report` 提交即结束（`terminate`） | ✅ 新增 |
| 机械回复 | 仅 `-help` 走程序固定回复（不建调查、不走模型）；其余消息一律交 LLM | ✅ 新增 |
| 工具 | `query_logs / search_code / read_code / request_info / submit_report`，限次/限长/白名单 | ✅ |
| 上下文防护 | 单条证据 + 单次工具结果双重截断，pi compaction 兜底 | ✅ |
| 时间区分 | 上报时间（平台）+ 故障发生时间（从输入提取，宁漏勿错）；时间窗依据如实标注 | ✅ |
| 版本钉死 | 有发生时间时按 `git rev-list --before` 钉当时 SHA（显式 rev 优先；钉不到记为缺失，不回退 HEAD） | ✅ |
| 证据 | 程序签发 `E#`、报告只引用 ID、校验引用与版本、无证据强制降级 | ✅ |
| 投递 | 待发送记录、退避重试、**不确定态**、平台消息 ID | ✅ 真机回复成功 |
| 测试 | 45 个（单元 + 集成），`npm test` 全绿 | ✅ |

**未实现 / 明确边界**

- 真实日志平台（SLS/ELK）适配器；当前为本地文件日志源。
- 逐次工具调用、模型对话、token 用量的落盘（只存了材料与聚合计数）。
- 脱敏。
- 环境部署记录推断版本（当前按发生时间/HEAD 推断）。
- 图片/截图处理（当前只处理 `text`）。
- 路径层工具 `list_files`（照搬 pi `ls`/`find` 分层）。
- 独立上下文审计 Agent（证据充分性审查，见 `open-questions.md` OQ-30）。
- 仓库同步器（本地只读镜像由外部更新）。
- pi 会话持久化（当前用 `contextSummary` 传多轮）。
- 出站消息映射（已决定暂缓）；跨轮证据复用。

**运行方式**

```bash
npm install
npm test                 # 45 个测试
npm run demo             # 离线端到端（假引擎）
TD_ENGINE=pi npm run demo
npm run gateway          # 飞书接入 + 投递 + 内嵌 4 worker（常驻）
npm run worker           # 只跑 worker
```

配置见 `.env.example`；真实飞书需 `FEISHU_APP_ID/SECRET`，真实模型需 `TD_ENGINE=pi` + key。

## 三、问题与讨论

- 所有提出过的问题、结论与状态，统一记录在 `docs/open-questions.md`（OQ-1 ~ OQ-30）。
- 本轮已解决（示例）：只读价值定位、并发能力、pi 会话持久化含义、信息爆炸处理、路径压缩、
  工具分层照搬、交互/机械回复、发生时间与版本按输入锚定。
- 仍待探讨：独立上下文审计 Agent（OQ-30）、图片处理（OQ-27）、跨轮证据复用。

## 四、关键决策记录

| 决策 | 结论 |
|---|---|
| commit 是否强制 | 不强制。有发生时间则按 `git rev-list --before` 钉事件当时的版本；显式 rev 优先；钉不到记为缺失（不回退 HEAD），并如实标注依据 |
| 时间锚点 | 区分**上报时间**（平台）与**故障发生时间**（从输入提取，宁漏勿错）；提取不到按上报时间回溯宽窗并标注 |
| 工具语义不为预算让路 | 照搬 pi 分层（路径→定位→内容）；预算在编排层管，不合并/裁剪工具 |
| 标号 vs 引用 id 冲突 | **以标号为主**（当前实现即如此） |
| 出站消息映射 | 暂缓，不做 |
| pi 会话持久化 | 暂不启用，用 `contextSummary` 传多轮 |
| 飞书交互 | 最小权限 `im:message.group_at_msg:readonly`，**每次回复 @机器人** |
| 存储 | 单机 SQLite(WAL) + `node:sqlite`，暂不引入 PostgreSQL |
| 引擎 | 默认 `fake`（离线）；真实模型切 `TD_ENGINE=pi` |
| 里程碑优先级 | 先完成「外部触发→只读取证→结论写回」闭环 + 会话/对话记录满足治理观测；再优化效果（提示词/工具/skill 描述/经验案例） |
| 闲聊/追问 | 一律走 LLM；闲聊直接回复；必要时 `request_info` 向用户追问后结束本轮；仅 `-help` 由程序机械回复（不建调查） |
| 工具结果上限 | 单条证据按 `maxResultChars` 截断 + 单次工具调用总量按 `maxToolResultChars` 截断并提示 |
| 上下文兜底 | 开启 pi compaction 作为总量兜底（`TD_COMPACTION_ENABLED`，默认 true）；单次工具结果仍有界 |

## 五、待办

- `docs/roadmap.md`：路线图与阶段目标。
- `docs/backlog.md`：可优化清单（F 飞书、T 工具、O 可观测、P 持久化、S 安全、M 材料、R 可靠性、E 工程、Q 专项、N 输入与版本、D 部署）。
- `docs/open-questions.md`：问题与讨论记录（OQ）。
- `docs/interface.md`：接口与格式约束（业务场景、部署、输入输出、数据交互、**触发后流程与可调用清单**）。
- `docs/usage.md` / `docs/feishu-channel.md`：产品用法与飞书渠道设计。

## 六、当前进度与下一步

**阶段一剩余 P0**

1. 逐次**工具调用 / 模型对话 / token 落盘**（T3/O1/O2/O3/P1 合并）——也是第二阶段“评测”的前提。
2. 落盘前**脱敏**（S1）。
3. 时区展示统一（报告材料范围已本地化）。

**之后（阶段二）**：提示词调优、路径层工具 `list_files`、审计 Agent、skill/经验案例。

**明确边界**：不复现、不写业务系统、不自动修复；生产只读。
