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

## 二、当前实现情况

**已实现（可运行、有测试）**

| 模块 | 内容 | 状态 |
|---|---|---|
| 飞书接入 | 官方 SDK 长连接、事件归一化、fail-closed mention 门控 | ✅ 真机跑通 |
| 会话路由 | 标号 `[TD-xxxxxxxx]` / root / thread / parent；不同群不合并 | ✅ 真机跑通 |
| 持久化 | SQLite(`node:sqlite`) schema：inbound/investigation/messages/runs/attempts/run_events/evidence/reports/deliveries | ✅ |
| 调度 | worker 池、同调查串行 / 不同调查并行、租约 + 代次守卫、过期回收 | ✅ |
| 诊断引擎 | 端口 + 假引擎（离线）+ pi 引擎（真实，SDK 隔离在单文件） | ✅ 真机两轮跑通 |
| 工具 | `query_logs / search_code / read_code / submit_report`，限次/限长/白名单 | ✅ |
| 证据 | 程序签发 `E#`、报告只引用 ID、校验引用与版本、无证据强制降级 | ✅ |
| 投递 | 待发送记录、退避重试、**不确定态**、平台消息 ID | ✅ 真机回复成功 |
| 测试 | 27 个（单元 + 集成），`npm test` 全绿 | ✅ |

**未实现 / 明确边界**

- 真实日志平台（SLS/ELK）适配器；当前为本地文件日志源。
- 逐次工具调用、模型对话、token 用量的落盘（只存了材料与聚合计数）。
- 脱敏。
- pi 会话持久化（当前用 `contextSummary` 传多轮）。
- 出站消息映射（已决定暂缓）；跨轮证据复用。

**运行方式**

```bash
npm install
npm test                 # 27 个测试
npm run demo             # 离线端到端（假引擎）
TD_ENGINE=pi npm run demo
npm run gateway          # 飞书接入 + 投递 + 内嵌 4 worker（常驻）
npm run worker           # 只跑 worker
```

配置见 `.env.example`；真实飞书需 `FEISHU_APP_ID/SECRET`，真实模型需 `TD_ENGINE=pi` + key。

## 三、本次对话中提出的问题（归纳）

**A. 架构与方案**
- 这个方案整体怎么样？风险在哪？
- 为什么 pi 要持久化？有原因吗？
- 是否加 PostgreSQL 做持久化？

**B. 工程整理与操作**
- 在 `/opt` 建项目，`ticket` 开头，不要放进 local 的 demo。
- `Tenant` 目录改名；目录拍平；对应的 linux 命令怎么用。

**C. 飞书接入**
- miniclaw 里的飞书渠道是怎么做的？
- 飞书是否已有成熟方案，会不会走弯路？
- 这个 webhook 能做什么？真正跑通还需要什么？
- 多轮追问的设计是什么？硬性需求是 @ 还是回复带标号？
- 引用导致 `root_id` 与标号冲突怎么办？有处理吗？

**D. 交付与验收方法**
- 推进太快，不知道该看哪一步，怎么验收和测试？
- 是否需要逐行看一遍代码/文件？
- AI 产出代码太快、人看不过来，怎么办？

**E. 真实循环与数据**
- 真实循环里工具怎么调、效果如何、实现了哪些工具？
- 访问环境有限制吗？
- llm / 用户 / tool 的信息有落盘和记录吗？
- pi 内置 `read` 能不能给？
- 我只说了“你好”，为什么会自动查信息？
- pi 会话用完就结束，会话信息会拼装吗？

**F. 项目定位**
- 能否直接接入 Codex？那做这个项目有什么必要，定制化的好处在哪？

## 四、关键决策记录

| 决策 | 结论 |
|---|---|
| commit 是否强制 | 不强制；缺省用当前解析出的 SHA，并在报告中如实标注 |
| 标号 vs 引用 id 冲突 | **以标号为主**（当前实现即如此） |
| 出站消息映射 | 暂缓，不做 |
| pi 会话持久化 | 暂不启用，用 `contextSummary` 传多轮 |
| 飞书交互 | 最小权限 `im:message.group_at_msg:readonly`，**每次回复 @机器人** |
| 存储 | 单机 SQLite(WAL) + `node:sqlite`，暂不引入 PostgreSQL |
| 引擎 | 默认 `fake`（离线）；真实模型切 `TD_ENGINE=pi` |

## 五、待办

见 `docs/backlog.md`（按类别编号：F 飞书、T 工具、O 可观测、P 持久化、S 安全、M 材料、R 可靠性、E 工程、Q 专项）。
