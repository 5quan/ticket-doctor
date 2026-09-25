# 接口与格式约束

> 本文规定：业务场景与问题、部署形态（Docker 与数据来源）、可读范围、能输入什么/怎么输入、
> 统一的数据交互格式、工具设计与全流程格式约束。

---

## 一、业务场景与要解决的问题

**场景**：某电商交易 / 支付团队，测试在飞书群提交线上或测试环境的 Bug。

**要解决的问题**：

1. 开发接手前，日志、源码、版本、环境信息是散的，**排查准备耗时**；
2. 线上异常涉及权限敏感数据，**不敢给宽权限**，导致"能取证"和"能安全"两难；
3. 同一 Bug 常有重复提问、来回补材料。

**目标**：在"开发接手前"的空窗期，自动把**可核验的证据**和**根因假设**准备好，缩短开发的排查准备时间；
全程只读，可安全用于生产。

---

## 二、部署形态：Docker 与数据来源

### 2.1 Docker 是什么（先把概念说清）

- **镜像（Image）**：构建时生成的**只读模板**，不可变。里面是**应用代码 + 运行时**（Node、git、依赖）。
- **容器（Container）**：镜像的**运行实例**，有自己独立的文件系统 / 进程 / 网络空间。
- **挂载（Volume / bind mount）**：运行时把**宿主机目录**接进容器，例如 `-v /srv/repos:/repos:ro`。

所以："**应用代码打进镜像；被诊断的数据运行时挂载**"。

| 内容 | 何时进入 | 方式 |
|---|---|---|
| 应用代码、Node、git、依赖 | **构建时** | 打进镜像 |
| 被诊断的**源码仓库** | **运行时** | 只读挂载 `-v /srv/repos:/repos:ro` |
| **日志目录** | **运行时** | 只读挂载 `-v /var/log/app:/logs:ro` |
| SQLite 数据 | **运行时** | 命名卷 `-v ticket-doctor-data:/data` |
| 密钥 / 配置 | **运行时** | `--env-file .env` |

**为什么仓库不打包进镜像**：仓库天天变（新 commit），每次重建镜像不现实；而且把私有代码烤进镜像层会泄露、膨胀。
镜像里只放"不变的运行环境"，变化的数据一律挂载。

### 2.2 Docker 里怎么读代码仓库

工具**不需要知道 Docker 的存在**。它只按配置里的路径去读；Docker 只负责把这些路径挂进来。

- 挂载：`-v /srv/repos:/repos:ro`
- 配置：`TD_REPOS=app:/repos/app,backend:/repos/backend`
- 工具：在容器内对挂载点执行 git 命令（镜像需装 `git`）：
  - 列出：`git -C /repos/app ls-tree -r --name-only <sha>`
  - 检索：`git -C /repos/app grep -n -F -e <pattern> <sha> -- .`
  - 读取：`git -C /repos/app show <sha>:<path>`
- **前提**：挂载的仓库要包含历史对象（全量 clone 或 `git clone --mirror`）。
  浅克隆（shallow）缺历史提交，钉不住"事件发生时的版本"。

### 2.3 推荐运行方式

```bash
docker run -d --name ticket-doctor --restart unless-stopped \
  --env-file .env \
  -v /srv/repos:/repos:ro \
  -v /var/log/app:/logs:ro \
  -v ticket-doctor-data:/data \
  ticket-doctor:latest
```

- 飞书是**长连接（出站 WebSocket）**，**不需要公网入站端口**。
- 推荐 Docker 的核心理由：`:ro` 把"只读边界"变成**文件系统层面的强制**，而不是只靠代码白名单。
- 备选：裸程序 + systemd + 专用低权限用户 + 只读 bind mount。
- **不推荐**多容器共享同一 SQLite（WAL 跨盘/网络盘有锁风险）；要横向扩展时再换 PostgreSQL。

### 2.4 仓库来源与更新（本地 / 云端）

服务**只读本地镜像**，不直接连云端仓库。更新由**外部同步器**负责：

- 本地已有仓库：cron 定期 `git -C /srv/repos/app fetch --all --prune`；或 CI / webhook 触发。
- 仓库在云端（GitHub / GitLab / 自建）：先 `git clone --mirror` 到本地，再由同步器 fetch。
- **凭据只给同步器，不给诊断服务**（诊断服务无网也能跑，权限最小）。
- 挂载的仓库必须含历史对象（全量 clone / mirror），否则钉不住历史 SHA。

工具只看挂载后的本地路径（`TD_REPOS`），不感知云端、不感知 Docker。

---

## 三、可读范围（权限边界）

| 数据 | 是否可读 | 约束 |
|---|---|---|
| 日志目录 | ✅ | 只读挂载；服务白名单 + 时间窗 + 关键词 + 条数上限 |
| 源码仓库 | ✅ | 只读挂载；钉死 SHA；路径白名单（拒绝对路径、`..`、控制字符） |
| 飞书消息 | ✅ | 仅被授权的事件（群聊需 @；最小权限 scope） |
| SQLite | ✅ | 仅本服务自己的数据卷 |
| 密钥 / `.env` | ❌ | 仅进程启动时读一次；工具不可访问 |
| 生产数据库 / 其他服务 | ❌ | 不接入 |
| 容器内任意文件 | ❌ | 无内置 `read`/shell；只有白名单工具 |

---

## 四、能输入什么、怎么输入

分三类，别混：

1. **运行时输入（用户）**：飞书消息。
   - 自然语言，或 `-help` 给出的固定模板；
   - 续接同一调查：带 `[TD-xxxxxxxx]` 标号；
   - 机械命令：`-help`（不建调查，直接回使用方法）。
2. **运维输入（配置）**：环境变量。
   - `TD_REPOS`、`TD_LOG_DIR`、`TD_ALLOWED_SERVICES`、`TD_ALLOWED_REPOS`；
   - `TD_ENGINE`、`TD_PROVIDER`、`TD_MODEL`、模型 key；
   - 调度与预算：`TD_WORKER_COUNT`、`TD_MAX_TOOL_CALLS`、`TD_MAX_TOOL_RESULT_CHARS`、`TD_COMPACTION_ENABLED`。
3. **数据输入（挂载）**：只读的日志与仓库、SQLite 数据卷。

**推荐输入模板**（由 `-help` 给出）：

```text
服务名：
发生时间：
现象/报错：
版本(可选)：
复现步骤(可选)：
```

**程序解析**：`service` 正则提取；`occurredAt` 解析为 epoch ms（失败则回退消息接收时间并标注）；
其余文本作为 `question`。

### 4.1 必填 vs 选填（推荐）

契约只要求一件事：**有一个可排查的现象**（文本或图片）。其余字段：

- 能提取则提取（程序正则 / 解析）；
- 缺则推断（版本用环境 / 发生时间，服务名从上下文）或 `request_info` 追问；
- 仍没有则在报告里标注并走 `partial`。

**不因格式不合而拒绝**——真实提 Bug 的人不会严格按模板。是否强制各字段，可由团队习惯决定（后续可加配置项）。

### 4.2 图片

当前**不支持**：只处理 `message_type=text`，图片被 `unsupported_message_type` 忽略。
截图是真实提 Bug 的主要形式，是明确缺口（见 `open-questions.md` OQ-27）。
处理路径：下载图片 → 视觉模型读文字/报错 → 登记为用户提供证据（注意存储与 PII）。

### 4.3 程序提取 vs 模型辨别

| 谁 | 负责 |
|---|---|
| 程序（确定性） | 服务名正则、发生时间解析、会话标号、@ 判断、消息类型、证据签发与校验 |
| 模型 | 意图判断、歧义消解、自然语言里的服务/现象、是否需要追问 |

原则：**能程序做的别交给模型**（确定、可测、省 token）。

---

## 五、统一数据交互格式

### 5.1 入站（飞书 → 系统）

```text
飞书 im.message.receive_v1
  → normalizeFeishuEvent()
  → InboundMessage {
      provider, accountId, externalMessageId, chatId, chatType,
      rootId?, threadId?, parentId?, mentionedBot,
      senderId?, senderName?, text, receivedAt
    }
  → routeInbound()
  → decision = new_investigation | continue_investigation | duplicate | unroutable | ignored
```

飞书消息正文是 JSON：`{"text": "..."}`。

### 5.2 工具 I/O（系统 ↔ 模型）

所有工具返回都带 **`[E#]` 证据编号**，并有条数/截断提示：

```text
query_logs   → 命中 N 条日志：\n[E1] <iso>\t<level>\t<原文>...
search_code  → 命中 N 处代码：\n[E1] <path>:<line>: <原文>...
read_code    → [E1] <path>:<start>-<end>\n<原文>
request_info → 向用户追问（调用后本轮结束，等用户补充）
submit_report→ 提交结构化报告（调用后本轮结束）
```

### 5.3 证据格式（程序签发，模型只能引用）

```text
evidence {
  evidenceId: "E1"              // 运行内唯一
  kind: "log" | "code"
  source: string                // 日志：来源+服务+时间窗；代码：repo@sha path#Lx-Ly
  excerpt: string               // 已按 maxResultChars 截断
  truncated: boolean
  time?, level?                 // 日志
  codeRef?: { repoId, sha, path, startLine, endLine }  // 代码
}
```

### 5.4 出站（系统 → 飞书）

```text
deliveries.kind = report | reply | notice
  → FeishuClient.send({ chatId, targetMessageId?, text })
      targetMessageId 有 → im.message.reply（线程内回复）
      无                → im.message.create
```

出站四类：

1. **预检报告**（`report`）：结构化 + 末尾 `[TD-xxxxxxxx]`；
2. **闲聊回复**（`reply`）：自然语言；
3. **追问**（`reply`，reason=clarify）：`request_info` 产出；
4. **机械回复**：`-help` 的使用方法（不进队列，直接回）。

---

## 六、工具设计（照搬 pi 分层）

| 层 | pi | ticket-doctor |
|---|---|---|
| 路径（广度） | `ls` / `find` | `list_files`（待补，`git ls-tree`） |
| 定位（收窄） | `grep` | `search_code`（`git grep`） |
| 内容（按需） | `read` | `read_code`（`git show`） |
| — | `bash`（输出溢出到文件） | （不适用，只读） |

原则：**先路径 → 再定位 → 再内容**；每个结果有界；结果里明确"总量 vs 已展示"和"如何继续"。

---

## 七、全流程格式约束

- **证据 ID**：`E#`，程序签发；模型只能引用；无证据的 `supported` 强制降为 `candidate/low`。
- **版本**：`repoId@SHA`，程序绑定。有发生时间时钉“事件发生时”的提交（`git rev-list -1 --before`），显式 rev 优先；
  钉不到按缺失处理，**不回退 HEAD 读错版本**；引用版本与本次运行不一致即剔除。报告标注按发生时间 / 当前 HEAD。
- **时间**：存储统一 epoch ms；展示本地时区（含偏移）。明确区分**上报时间**（平台事实）与**故障发生时间**（从输入提取）；
  提取器**宁漏勿错**（拿不准返回未知，绝不回退成上报时间），提取不到时按上报时间回溯宽窗并在报告中标注。
- **截断**：单条证据 ≤ `maxResultChars`；单次工具 ≤ `maxToolResultChars`，超出必须标注总量。
- **预算**：工具调用 ≤ `maxToolCalls`；接近上下文窗口由 compaction 兜底。
- **会话标号**：`[TD-xxxxxxxx]`。

---

## 八、触发后流程与可调用清单

### 8.1 触发后的完整链路

```text
飞书 im.message.receive_v1
  │  FeishuClient.start()（长连接）
  ▼
createFeishuGateway().handleEvent(event)        src/integrations/feishu/gateway.ts
  ├─ normalizeFeishuEvent()                     非用户/非 text/空内容 → ignored
  ├─ evaluateMentionGate()                      botOpenId 未知 → fail-closed；群聊新会话需 @
  ├─ text === "-help" → sendMechanical()        固定使用方法，不建调查、不走模型
  └─ routeInbound()                             src/intake/router.ts
       去重 → 路由（标号 → root/thread → parent →（@）新建）→ insertMessage + createRun(queued)
  ▼
Worker claimNextRun() → executeRun()            src/diagnosis/orchestrator.ts
   stripSessionMarker → extractOccurredAt（宁漏勿错）→ 时间窗
   → buildCodeSource（按发生时间钉 SHA）→ EvidenceRegistry / FileLogSource / DiagnosisToolbox
   → engine.run()（fake 或 pi）→ validateDraft → finalizeSuccess/finalizeReply → enqueueDelivery
  ▼
投递循环 processDeliveriesOnce() → FeishuClient.send() → reply / create
```

### 8.2 模型可调用的工具

| 工具 | 常驻 | 作用 | 约束 |
|---|---|---|---|
| `query_logs` | ✅ | 查服务时间窗内日志 | 服务白名单、时间窗、关键词、条数、总量上限 |
| `search_code` | 仅有源码时 | 钉死 SHA 上 `git grep` | 子串、glob、≤50 条、总量上限 |
| `read_code` | 仅有源码时 | 钉死 SHA 上 `git show` 读区间 | 路径白名单、默认 200 行、截断 |
| `request_info` | ✅ | 向用户追问（反问），调用即结束本轮 | - |
| `submit_report` | ✅ | 提交结构化报告，调用即结束（`terminate`） | 引用/版本校验 |

**不能调用**：pi 内置工具全关（`noTools:"builtin"`）——无 shell、无 `read`/`write`/`edit`/`bash`。

### 8.3 程序（非模型）能力

时间提取（`extractOccurredAt`）、版本钉死（`resolveRepoShaAt`）、证据签发（`E#`）、
报告校验（`validateDraft`）、投递与重试、机械回复（`-help`）。

### 8.4 外部只读源

日志（`FileLogSource` 读只读挂载的本地文件）、源码（`GitCodeSource` 对只读镜像跑 git）、飞书（仅出站发送）。

### 8.5 边界（不可调用）

生产 DB、其他服务、任意文件系统、shell、写操作、密钥（`.env` 仅启动读一次）。

### 8.6 触发条件

| 场景 | 条件 | 结果 |
|---|---|---|
| 新建调查 | 群聊 @机器人 | 建调查 + run |
| 续接 | 带 `[TD-xxxxxxxx]` / 线程字段 / 回复机器人 | 续接 + run |
| `-help` | 门控通过 | 机械回使用方法 |
| 非 text（图片等） | — | 当前忽略 |
| 未 @ 且无归属 | — | 忽略（fail-closed） |
| 重复事件 | message_id 重复 | 去重，不重复执行 |

### 8.7 一次触发产生什么

- 落库：`inbound_events` / `messages` / `runs` / `run_events` / `evidence` / `reports` / `deliveries`。
- 出站：一条飞书消息（报告 / 闲聊回复 / 追问 / 提示）。
- 可观测：`run_events` 目前仅 `run_started / engine_finished / report_saved / reply_saved / run_error / commit_rejected`
  （逐次工具调用尚未落盘，见 backlog T3/O1）。
