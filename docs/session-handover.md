# 会话交接概要（最新）

> 给下一个接手会话：**先读本文**，再按 §5 的阅读顺序深入。
> 版本 **0.3.1**（以 `docs/status.json` 为准）；仓库 `github.com/5quan/ticket-doctor`，分支 `main`。
> 详细技术方案见 `docs/handover-technical-plan.md`，刻意/规程见 `docs/handover.md §7`。

---

## 1. 一句话现状

「外部触发 → 会话创建 → 执行任务 → 结果返回」**主干闭环已完成并可运行**（Host + 独立 Runner + Go 接入适配器），
证据已升级为**持久化 + 稳定 UID（两阶段提交）**，飞书触发链路已修（门控单点化 + `-help`）。
当前缺口集中在：**真实数据源、审计 Agent、评测 M2/M3、图片**（飞书长连接 S3 已实现，待真机验证）。

---

## 2. 基线事实

| 项 | 值 |
|---|---|
| 版本 / 分支 | `0.3.1` / `main` |
| 测试 | TS 196（`npm test`，数字以 docs/status.json 为准）+ Go adapter（`npm run test:go`）+ `typecheck` 全绿 |
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
| 飞书**长连接** | ✅ | 官方 Go SDK（锁 v3.12.0）`LarkWSSource` + `ADAPTER_MODE=ws`；成功才 ACK、跳 Verify；**真机人工验证待有凭据时执行**（S3，OQ-40） |
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
| 评测打分器 | ✅ UID 兼容已修 + v2 校准口径（OQ-41，见 §4） |

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

**结论**：主干闭环完成度约 **95%**；剩下的是接入侧深度（真机验证/多平台/图片）、效果侧（审计/评测）、运维侧（真实数据源）。

---

## 4. 评测打分器（v2 校准口径，OQ-41）

**演进**：① UID 兼容修复（v0.3.1）——报告 v2 的 `evidenceIds` 是 `evidence_uid`，scorer 补齐双键索引；
② 正确率校准（scorer **v2.0.0**）——v1 的 correct 只判"supported + 引用 ≥1 条 gold"、不读根因文本，
错误根因 + 顺手引证也能判对；v2 改为「根因概念匹配（`requiredConcepts`/`forbiddenConcepts` 确定性匹配、
否定语境豁免）+ 引用 gold + 非干扰独证」三层联合判定，引用按身份去重，结果带
`scorerVersion/benchmarkVersion/calibrated/gitRev/evidencePolicy` 口径，**不同 scorerVersion 禁止同表比数**。

**v2 校准基线**（git=e1449cd，benchmark=ffa8cab246bd，数字唯一事实源 `docs/status.json#eval`）：
- fake（离线）：召回 **70%** / 精确 **20%** / 正确率 **40%**。
- 真实模型（pi，连跑 3 次）：90/26.8/80、90/22.3/80、80/17.8/60 → **中位数 90 / 22.3 / 80**。
- 旧数 90/30.7/80（D6 前 + scorer v1）与 fake 70/20/60（v1）**均已作废，勿引用**。

剩余低分是**真实效果问题**（ct-005 材料不足仍 supported 三次全挂、引用精确率低=干扰混入、
ct-004 代码证据漏检），交阶段二 rules / 审计 Agent，不是打分 bug。

---

## 5. 下一个会话怎么上手

### 5.1 阅读顺序

1. 本文（`docs/session-handover.md`）
2. `docs/handover.md`（总交接 + §7 交接规程）
3. `docs/handover-technical-plan.md`（剩余工作的技术方案 + §6 执行顺序）
4. 按任务读专项：
   - 接入/长连接 → `docs/adapter-longconn-design.md`、`docs/feishu-trigger-design.md`、`adapters/go/README.md`
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
| ✅ | ~~S3 Go 长连接~~ | 已完成（单测全覆盖）；**实施方案：`docs/adapter-longconn-design.md`**；官方 Go SDK `.../v3/ws` 实现 `eventsource.Source`，`ADAPTER_MODE=webhook|ws`；真机人工验证待有凭据时执行（OQ-40） |
| P1 | S4 弃用 Host 内直连 | 删 `TD_FEISHU_DIRECT`、`src/integrations/feishu` SDK 路径（**注意 `demo.ts` 也用 `createFeishuGateway`**） |
| P1 | 独立审计 Agent（OQ-30） | Runner 内新上下文，输出结构化判定，Host 确定性应用 |
| P1 | 评测 M2/M3 | rules 条目化 + delta/Pareto、扩样本、judge、CI 门禁；v2 校准基线已重跑（OQ-41，见 §4 与 `docs/status.json#eval`），旧口径数字已作废 |
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
