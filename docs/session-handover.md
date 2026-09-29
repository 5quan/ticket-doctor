# 会话交接概要（最新）

> 给下一个接手会话：**先读本文**，再按 §5 的阅读顺序深入。
> 版本 **0.3.0**；仓库 `github.com/5quan/ticket-doctor`，分支 `main`。
> 详细技术方案见 `docs/handover-technical-plan.md`，刻意/规程见 `docs/handover.md §7`。

---

## 1. 一句话现状

「外部触发 → 会话创建 → 执行任务 → 结果返回」**主干闭环已完成并可运行**（Host + 独立 Runner + Go 接入适配器），
证据已升级为**持久化 + 稳定 UID（两阶段提交）**，飞书触发链路已修（门控单点化 + `-help`）。
当前缺口集中在：**长连接、真实数据源、审计 Agent、评测口径修复、图片**。

---

## 2. 基线事实

| 项 | 值 |
|---|---|
| 版本 / 分支 | `0.3.0` / `main` |
| 测试 | TS 126（`npm test`）+ Go adapter（`npm run test:go`）+ `typecheck` 全绿 |
| 迁移 | `001` … `006_evidence_uid.sql` |
| 运行 | `npm run host`（生产）/ `npm run demo`（离线）/ `npm run eval`（评测） |
| 部署 | `docker-compose.yml` + `Dockerfile` + `adapters/go/Dockerfile`（已构建并冒烟） |

---

## 3. 端到端功能评估

### 3.1 外部触发

| 能力 | 状态 | 说明 |
|---|---|---|
| Web API 入站 | ✅ | `POST /api/agent/message`（provider=web） |
| 飞书 Webhook | ✅ | 归一化、签名/Encrypt Key 解密、URL challenge、去重 |
| @ 门控 | ✅ | 单点在 Host `planRoute`（群聊新会话必须 @；线程回复免 @）；`IsBotMentioned` 空 botOpenID 真 fail-closed |
| `-help` 机械回复 | ✅ | Host 出文案、适配器回复；不建调查 |
| 投递发送 | ✅ | Host `deliveries` claim/result + attempt 守卫 + 重试上限；适配器按 provider 发送 |
| 飞书**长连接** | ❌ | 目前必须公网 Webhook 回调；`eventsource.Source` 接口已留（S3） |
| 钉钉 / Slack | ⚪ | 仅骨架（调用报"未实现"） |
| 图片 / 富文本 | ❌ | 只处理 `message_type=text` |
| 多飞书应用 | ⚠️ | 适配器配置是全局单份（多应用需拆配置） |

### 3.2 会话创建

| 能力 | 状态 |
|---|---|
| 原子入队（去重+关联+存消息+建轮次 同事务） | ✅ |
| 路由：`[TD-xxxx]` / root / thread / parent / @ | ✅ |
| 不同群不合并、跨群标号拒绝 | ✅ |
| 按会话严格轮次串行 + 会话间公平 + 全局 ≤4 | ✅ |
| 显式取消（queued 直接取消；running 置标志，终态不重试） | ✅ |
| 来源路由（Web 轮次不回 IM） | ✅ |

### 3.3 执行任务

| 能力 | 状态 |
|---|---|
| 独立 Runner 子进程 + Host 监管（心跳/租约/超时/取消/代次守卫） | ✅ |
| pi 引擎（fake/pi）+ 只读工具（`query_logs/list_files/search_code/read_code/request_info/submit_report`） | ✅ |
| 证据两阶段提交（工具 commit 落库后才返回）+ 稳定 UID + 批次幂等 | ✅ |
| 崩溃恢复（`reconcileSession` + 已提交批次重建补记） | ✅ |
| 版本钉死（按发生时间 `git rev-list --before`）+ 报告校验 | ✅ |
| 独立审计 Agent（证据充分性） | ❌ 设计已定（OQ-30） |
| 真实日志平台（SLS/ELK） | ❌ 当前本地文件日志 |
| 评测打分器适配 v2 | ❌ **有 bug，见 §4** |

### 3.4 结果返回

| 能力 | 状态 |
|---|---|
| 预检报告 IM 回复（线程内 reply） | ✅ |
| 闲聊 / 追问（`request_info`）回复 | ✅ |
| 失败通知 | ✅ |
| Web：SSE 实时进度 + 报告/证据展示 | ✅ |
| 证据不足时 @ 相关人员补证 | ❌ backlog T6 |
| 出站消息映射（回复机器人归入原调查） | 暂缓 |
| 工具执行回放 UI | ❌ |

**结论**：主干闭环完成度约 **90%**；剩下的是接入侧深度（长连接/多平台/图片）、效果侧（审计/评测）、运维侧（真实数据源）。

---

## 4. 评测打分器（已修复，v0.3.1）

**曾经的 bug**：报告 v2 的 `evidenceIds` 存的是 **`evidence_uid`**（`validate.ts`），但
`src/evals/scorer.ts` 的 `byId` 仍按 **`E#`** 建索引，且 `evidenceRefToRecord` 丢掉了 `evidenceUid`
→ `byId.get(uid)` 恒 undefined → 诊断类精确率与正确率虚低（实测正确率 **0%**）。

**修复**：`EvidenceRecord` 增可选 `evidenceUid`；`evidenceRefToRecord` 带上；`scorer` 同时按
`evidenceId` 与 `evidenceUid` 建键；新增 v2 打分回归测试（`tests/unit/scorer.test.ts`）。

**修正后 fake 基线**：`npm run eval` → 召回 **70%** / 精确 **20%** / 正确率 **60%**。
剩余低分（精确率 20%、ct-004 代码证据缺失、ct-005 材料不足仍 supported）是**真实效果问题**，
交给阶段二 rules / 审计 Agent，不是打分 bug。

---

## 5. 下一个会话怎么上手

### 5.1 阅读顺序

1. 本文（`docs/session-handover.md`）
2. `docs/handover.md`（总交接 + §7 交接规程）
3. `docs/handover-technical-plan.md`（剩余工作的技术方案 + §6 执行顺序）
4. 按任务读专项：
   - 接入/长连接 → `docs/feishu-trigger-design.md`、`adapters/go/README.md`
   - 证据 → `docs/evidence-uid-design.md`（已实现）
   - 评测 → `docs/eval-design.md`、`docs/evolve-protocol.md`
   - 会话/持久化 → `docs/interface.md §8`、`docs/session-log-design.md`
   - 并发 → `docs/concurrency.md`

### 5.2 基线命令

```bash
npm install
npm run typecheck && npm test && npm run test:go
npm run demo        # 离线端到端冒烟
```

### 5.3 执行规程（DoD）

一次只做一件 → 先复述「目标/验收/改哪些文件」→ 实现 → `typecheck` → `test`（+Go）→ 更新文档
（`open-questions.md` 记决策、`roadmap.md`/`backlog.md` 记状态、本文/`handover.md §六` 记进度）→ `commit` → `push`。
新增迁移从 `007_` 起，禁止改历史迁移。

---

## 6. 建议的后续顺序

| 优先级 | 任务 | 说明 |
|---|---|---|
| ✅ | ~~修评测打分器（§4）~~ | 已完成（v0.3.1）；fake 基线 70/20/60 |
| **P0** | S3 Go 长连接 | 官方 `larkws` 实现 `eventsource.Source`，`ADAPTER_MODE=webhook|ws`；需真实凭据人工验证 |
| P1 | S4 弃用 Host 内直连 | 删 `TD_FEISHU_DIRECT`、`src/integrations/feishu` SDK 路径（**注意 `demo.ts` 也用 `createFeishuGateway`**） |
| P1 | 独立审计 Agent（OQ-30） | Runner 内新上下文，输出结构化判定，Host 确定性应用 |
| P1 | 评测 M2/M3 | rules 条目化 + delta/Pareto、扩样本、judge、CI 门禁；修完打分器后重跑基线 |
| P2 | 钉钉/Slack 实装、图片处理（OQ-27） | 平台按 `Platform` 接口；图片下载→视觉模型→登记证据 |
| P2 | 真实日志平台 `LogSource`、工具回放 UI | 按端口新增，不动编排 |
| P3 | 生产诊断 MCP Server、多飞书应用配置 | 触发条件见 backlog |

---

## 7. 已知坑

- 本机到 Debian/镜像源很慢，docker 首次构建约 30 分钟；改 `src` 只重建 COPY 层。
- 长连接/真实发送**无凭据无法端到端验证**，只能单测 + 人工；不要声称"已验证线上"。
- `demo.ts` 仍依赖 `createFeishuGateway`（S4 清理时要保留 demo 可用）。
- 证据短号是**调查内** `E{n}`（历史 run 级 `E#` 保留），展示/解析不要混用两套编号。
- `ADAPTER_REQUIRE_MENTION` 已废弃；@ 门控配置在 Host（`FEISHU_REQUIRE_MENTION`）。
