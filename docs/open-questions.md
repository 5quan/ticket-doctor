# 问题与讨论记录（Open Questions）

> 本文记录项目推进过程中提出的问题、结论与状态，避免同一问题反复讨论。
> 状态：`已结论` / `待办` / `待探讨` / `暂缓`。

---

## 一、定位与价值

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| OQ-1 | "只读机器人"是否有业务价值？ | 有。价值在"把开发接手前最机械、最可前置的取证自动化，并做成可核验"；只读是它能进生产、无人值守的前提，不是天花板。价值窄：只在复杂系统 + 有 bug 量 + 有生产只读需求时成立。 | 已结论 |
| OQ-2 | 和直接照搬 OpenClaw 再改改区别大吗？ | 骨架同族（接入→Agent 循环→工具→投递），核心契约不同：证据可核验 / 版本钉死 / 只读边界 / 状态机与代次守卫 / 投递不确定态。 | 已结论 |
| OQ-3 | 下一步是评测优化还是补架构？ | 先补正确性（发生时间、版本、时区）+ 落盘（逐次工具/对话/token），再做评测；架构大件（PG/前端/复现）无触发条件不做。 | 已结论 |

## 二、可靠性与并发

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| OQ-4 | 10 个 bug 一起提能扛住吗？ | 能。持久化队列（`runs` 表）、同调查串行 / 不同调查并行、最多 4 个并发；其余排队，不丢、不串、不重复。真正瓶颈是模型限流（429 → 重试）。 | 已结论 |
| OQ-5 | "4 个"是 4 个进程吗？ | 分两种模式：`inprocess`（默认，worker 内联，1 进程 4 异步循环）/ `process`（生产，Host 每轮 spawn 独立 Runner 子进程，全局 ≤4）。子进程模式隔离性更好，单个 Runner 崩溃不影响其他进程。 | 已结论（已更新） |
| OQ-6 | 要引入 PostgreSQL 吗？ | 暂不。PG 解决多机/多进程写并发，不是"持久化能力"。触发条件：多机部署或单机写瓶颈。 | 已结论 |

## 三、会话与持久化

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| OQ-7 | "pi 会话未持久化"指什么？ | 指模型每一轮的逐条对话、每次工具调用入参/返回/耗时/成败、token 用量**没有落盘**（引擎用 `SessionManager.inMemory` + `dispose`）。业务事实（消息/证据/报告/投递）已落 SQLite。 | 已结论 |
| OQ-8 | pi 和 dsh 的会话记录怎么做？ | **pi**：JSONL append-only 文件（header + message/usage/compaction/…），`inMemory()` 则不落盘。**dsh**：JSONL 不可变 generation 文件 + write lease + torn-write 恢复 + zstd，另有派生 SQLite FTS5 索引（可重建）与 `current/shadowed/log-only` surface。 | 已结论 |
| OQ-9 | 需要 pi compaction 吗？ | 需要，作为**总量兜底**。已开启（`TD_COMPACTION_ENABLED` 默认 true），与单次工具结果上限形成两层防护。 | 已结论 |

## 四、时间与版本

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| OQ-10 | 判断信息/读版本/事件时间应以输入为准？ | 是的。已做：区分上报时间与故障发生时间（从输入提取，宁漏勿错）；版本按发生时间钉 SHA（显式 rev 优先，钉不到算缺失）。 | 已完成 |
| OQ-11 | 本机跟随北京时间？ | 存储统一 epoch ms；报告材料范围已本地化展示（含偏移），其余展示待统一（backlog E2）。 | 进行中 |
| OQ-12 | 提 bug 一定要带 git 版本吗？ | **不现实**，测试不知道 SHA。用户只给"服务名 + 发生时间 + 现象"；版本由系统按环境部署记录或发生时间推断，并如实标注。 | 已结论 |

## 五、权限与复现

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| OQ-13 | 生产只读 vs 放开权限复现？ | 生产永久只读、白名单、无 shell；复现放**隔离沙箱**（非生产 VM），远期可选。 | 已结论 |
| OQ-14 | 引入 Playwright 复现现实吗？ | 作为默认链路不现实（起服务要依赖/密钥/数据状态，且与只读定位冲突）。仅"测试环境 + 隔离沙箱 + 接口优先 + 人工授权"下作为可选验证。 | 已结论 |

## 六、工具与上下文

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| OQ-15 | 现在的只读工具有哪些、怎么读？ | `query_logs`/`search_code`/`read_code`（+常驻 `request_info`）。详见 `docs/interface.md`。 | 已结论 |
| OQ-16 | 信息爆炸怎么优化？ | 工具级有界（单条 `maxResultChars` + 单次 `maxToolResultChars`）+ compaction 兜底。 | 已结论 |
| OQ-17 | pi 怎么处理信息爆炸？ | 两层：每个工具结果有界（2000 行/50KB、grep 100 条、bash 溢出到文件）+ 自动 compaction（默认开）。 | 已结论 |
| OQ-18 | "只放路径、按需检索"是成熟思路吗？ | 成熟。别名：延迟加载 / 索引+下钻 / 引用代替载荷 / 渐进披露。例：dsh `file-reference`、pi `read(offset)`/bash 落文件、Aider repo map。 | 已结论 |
| OQ-19 | 直接照搬 pi 的工具设计可以吗？ | 照搬**原则**（路径→定位→内容；结果有界；告知总量与续读）；实现改为 git 只读（`ls-tree`/`grep`/`show`）+ 路径白名单。**不为预算裁剪工具语义**。 | 已结论 |

## 七、交互与人设

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| OQ-20 | hello 也要走 LLM？ | 是。除 `-help` 外一律走 LLM；闲聊直接回复，`-help` 走程序机械回复。 | 已结论 |
| OQ-21 | 结束动作/反问动作？ | `submit_report` 返回 `terminate: true` 提交即结束；新增 `request_info` 反问，追问后本轮结束。 | 已结论 |
| OQ-22 | 结束用 tool 还是程序？ | 结束用 tool 的 `terminate`（确定性）；机械回复用程序；闲聊/追问走 LLM。 | 已结论 |
| OQ-23 | 输入判断 + 检索倾向要专门实现吗？ | 不专门实现，写在 prompt 里。 | 已结论 |

## 八、部署与数据格式

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| OQ-24 | Docker 还是裸程序？ | 推荐 Docker 单容器：`:ro` 挂载把只读边界变成文件系统强制。备选 systemd + 低权限用户。 | 已结论 |
| OQ-25 | Docker 里怎么读代码仓库？ | 应用打进镜像；**仓库/日志运行时只读挂载**；工具对挂载点跑 git。镜像需装 git。 | 已结论 |
| OQ-26 | 仓库本地还是云端？每次 git 都更新？ | 服务只读**本地镜像**；更新由外部同步器（cron / CI / webhook）负责。云端仓库先镜像到本地。凭据只给同步器，不给诊断服务。 | 已结论 |
| OQ-27 | 现在能处理图片吗？ | **不能**。当前只处理 `message_type=text`，图片被忽略。截图是真实提 bug 的主要形式，是明确缺口。 | 待办 |
| OQ-28 | 输入字段全选填还是写死？ | 只把"可排查的现象"视为必要；其余能提取则提取、缺失则推断/追问/标注，不因格式不合而拒绝。看团队习惯。 | 已结论 |
| OQ-29 | 提 bug 附带信息靠模型辨别吗？ | 分层：能结构化的字段（服务名、时间、标号、@、图片类型）由**程序**提取；程序做不到的（意图、歧义、是否需要追问）才交给**模型**。 | 已结论 |

## 九、设计讨论

| # | 议题 | 状态 |
|---|---|---|
| OQ-30 | 独立上下文审计 Agent（证据充分性审查） | 已实施（首版单次审计，2026-10-04；见下实施记录） |
| OQ-31 | 评测 Benchmark（RSI）与记忆规则迭代 | 已结论（阶段二，依赖逐次落盘；见 backlog Q6） |
| OQ-32 | 生产诊断 MCP Server | 已结论（阶段三；工具外化，见 backlog Q7） |
| OQ-33 | 会话 JSONL 是否照搬 pi 的 durable storage 契约 | **已结论（被 OQ-34 取代）**。最终未采用 JSONL 契约，改为单库（SQLite）；仍借鉴其“恢复语义”。半截模型流不落盘（失败丢弃尾巴 + 整轮重试）。 | 已结论（取代） |
| OQ-34 | 是否取消两个存储，收敛为单库（SQLite） | **已实施 v0**。会话条目进 `session_entries`，`tool_executions` 记工具；引擎读回写 seed 给 pi 重建、崩溃时 `reconcileSession` 补未决工具结果并 `Agent.continue()`；JSONL 与 pi 文件持久化已移出运行路径。详见 `docs/session-log-design.md §0.5`。 | 已完成 |
| OQ-35 | 是否按平台文档改造为 Go 接入层 + Node Host + 独立 Runner | **已实施**。Go 只做平台接入/门控/转发/发送；Host 统一入口、原子入队、按会话严格轮次调度、EventStore/SSE、Runner 监管；Runner 每轮独立子进程、只上报不碰库。差异：队列按调查、并发 4、不做注入/定时/审批/权限。详见 `docs/host-runner-design.md`。 | 已完成（阶段3为骨架） |
| OQ-36 | `search_code` 命中很多时的输出形态与证据签发口径 | **已实施（S1）**。输出改为「按文件聚合的路径清单（≤20 个文件，`path: 命中 n 处`）+ 前 8 处带 `[E#]` 的预览」，命中很多时不再回一堆片段；未预览命中提示用 glob 缩小范围或 `read_code` 读取。证据签发选「**每处命中仍签 `E#`**」（含未预览的命中，逐处可追溯；预览按签发顺序取前 8 处，模型看到的编号连续）：注册行为与原先完全一致，只有输出格式变，`validateDraft` 引用/版本语义不变、无需改动。glob 过滤与源侧 ≤50 条上限保留；`maxToolResultChars` 总量截断仍在。 | 已完成 |
| OQ-37 | Go 适配器多平台抽象的接口形态与迁移约定 | **已实施（S2）**。`internal/platform.Platform` 接口：`Name / Normalize(raw, headers) / VerifyRequest(r, body) (challenge, err) / Send(ctx, delivery) / LongConn()`；飞书迁入 `internal/platform/feishu/`，钉钉/Slack 为骨架（调用即报「尚未实现」，不静默吞事件）。约定：① 回调路由 `POST /{platform}/events`（`/feishu/events` 不变），校验失败用 `*StatusError{Status}` 回带 HTTP 语义；② 加密事件由平台在 `Normalize` 内自行解密（`VerifyRequest` 与 `Normalize` 各解一次，保持接口无状态、不偏离方案签名）；③ 投递按 `delivery.Provider` 路由到平台，缺 provider 兜底到第一个启用平台（兼容历史记录），未知 provider 上报 `failed`；④ `eventsource.Source`（§5.1 长连接契约）随接口一并定义，纯 Webhook 平台 `LongConn()` 返回 nil，S3 只需补实现；⑤ 启用平台由 `ADAPTER_PLATFORMS`（默认 `feishu`）控制，未知/重复平台启动即报错；门控（RequireMention）留在核心，平台无关。 | 已完成 |
| OQ-38 | 证据持久化与稳定 UID（两阶段提交） | **已实施（按 `docs/evidence-uid-design.md`，D1~D13 全部落地）**。工具采集 → `sink.commit` → Host 事务内分配 `evidence_uid`（全局唯一）与调查内短号 `E{n}`（历史最大 +1 续签）→ ACK 后工具才把带 `[E#]` 的文本交给模型；`evidence_batches` 以 `(run_id, tool_call_id)` 为恢复/幂等键，同批同 hash 幂等、异 hash/同 call 二批 → conflict，commit 失败 fail-closed 本轮失败（D9）。协议 v2：`evidence_commit/ack/reject` + `protocolVersion` 硬校验（D12）；**v3（2026-10-04）新增 `observation` 观测消息与 `RunnerTask.observability`**（见 `docs/evidence-uid-design.md` D12）。恢复：已提交批次经共享渲染器重建补记（isError:false），未命中维持结果未知（D5/§8）。报告 v2 `evidenceIds` = uid（`reference_format_version=2`），v1 按 `(run_id, E#)` 解析；`validateDraft` 走 `EvidenceResolver`：跨调查结构性不可达、历史重号要求 UID、D10 历史版本不冒充本轮（全非本轮 sha → supported 降 candidate）。`EvidenceRegistry` 退役。实现细化（相对 §4 类型草图，非决策变更）：`EvidenceItem.truncated` 在工具侧 commit 前置位（入库内容 = 模型可见内容）。D6 取消跨调用去重 → 评测口径变化。**打分器未适配 v2 的 bug 已修**（`src/evals/scorer.ts` 同时按 uid 与 E# 建索引；`EvidenceRecord` 增可选 `evidenceUid`，`evidenceRefToRecord` 带上）：离线 fake 基线**修正后为召回 70% / 精确 20% / 正确率 60%**（`npm run eval`；修复前误报 0% 正确率）；真实模型基线（90%/30.7%/80%，D6 前 + scorer v1 口径，已作废），M2 重跑后再对标。 | 已完成 |
| OQ-39 | 飞书触发链路：@ 门控单点化 + `-help` 机械回复 | **已实施（`docs/feishu-trigger-design.md`）**。① 门控权威单点下沉 Host `planRoute`：先算调查关联（标号/线程/root/parent 命中即免 @ 续接）→ 未命中时应用门控（群聊新会话必须 @，fail-closed）→ 门控后 `-help`（非 web）→ mechanical；适配器只归一化转发，不再因"群聊未 @"丢弃（修 P0：线程内回复免 @ 丢失导致多轮追问断裂）。② `IsBotMentioned` 空 `botOpenID` 恒 false（真 fail-closed，不再"有 mention 即放行"）。③ `-help` 由 Host 出文案（`src/intake/help.ts` HELP_TEXT，gateway 与新路径共用）：`planRoute` 识别 → `acceptInbound` 不建消息/轮次/投递 → `/api/agent/message` 返回 `{decision:"mechanical", mechanicalText}` → 适配器对原消息线程内回复（best-effort，失败不重试）；去重照旧，重复投递不重复发送。④ `ADAPTER_REQUIRE_MENTION` 废弃（配置归属 Host `FEISHU_REQUIRE_MENTION`）。follow-up：多平台后 requireMention 应按 provider 配置；适配器可选拉 `bot/v3/info` 自动补 BotOpenID。 | 已完成 |
| OQ-40 | Go 适配器飞书长连接（S3）的落地口径 | **已实施（`docs/adapter-longconn-design.md`，2025 会话）**。决策：① 用官方 Go SDK `github.com/larksuite/oapi-sdk-go/v3 v3.12.0`（**锁版本**），WS 客户端在 `.../v3/ws`（包名 `ws`），事件分发在 `.../v3/event/dispatcher`；不自研 protobuf 帧协议。② `Source → Adapter` 契约为**明文 Envelope JSON**，新增 `Adapter.HandleSourceEvent` 跳过 `VerifyRequest`（WS 会话已由 SDK 用凭据鉴权），与 Webhook 共用 `process/handleMessage`。③ **成功才 ACK**：handler 返回 `nil` 才 ACK 200；失败返回 error → 平台重投，Host `inbound_events` 去重兜底。④ `ADAPTER_MODE=webhook|ws` 全局切换，默认 `webhook`；SDK 自带自动重连，`main.restartLoop` 仅在 `Start` 返回后按 1s→30s 退避兜底（不在 `Start` 内自旋）。⑤ 缺实现/缺凭据启动报错，不静默。**已知偏差**：SDK `EventSender` 无 `sender_name`，长连接下 `SenderName` 为空（不影响路由）。**遗留**：真机人工验证待具备飞书凭据时执行（步骤见 `adapters/go/README.md`），未声称线上已验证。 | 已完成（真机验证待执行） |
| OQ-41 | 评测"正确率"定义校准（scorer v2） | **已实施（eval-calibration-and-doc-consistency 文档（已随 eval 清理移除） 问题 A）**。动机：v1 的 correct 只判"top supported + 引用 ≥1 条 gold"，不读根因文本——错误根因 + 顺手引证也能判对、只答直接原因也能判对、不罚干扰独证、重复引用放大精确率分母，故旧"正确率"实为**引证支持率**。判定规则（v2，`SCORER_VERSION=2.0.0`）：诊断类 `correct = top.status==="supported" && causeMatched && evidenceSupported && !distractorOnly`。`causeMatched` 用确定性概念匹配（`requiredConcepts` 每组 any-of 必须命中 + `forbiddenConcepts` 断言即错，否定语境约 12 字符前窗豁免，如"不是 Redis 而是库存"）；`evidenceSupported` = 引用 ≥1 条 gold；`distractorOnly` = 引用全部非 gold；引用集合按证据身份去重（uid 优先）。gold 缺 `requiredConcepts` = legacy（`correctBasis="evidence-only(legacy)"`，场景级 `calibrated=false` 不得报校准正确率）。结果带 `scorerVersion/benchmarkVersion(内容 hash)/gradeMode/calibrated/gitRev/evidencePolicy=d6_no_dedupe`，**不同 scorerVersion 禁止同表对比，旧基线一律作废重跑**。benchmark 注解为人工黄金标准（禁区），judge 语义判定留 M2（独立模型、温度 0、需过 kappa≥0.8 门槛、不得覆盖确定性硬失败）。**实测（Z2，git=e1449cd，benchmark=ffa8cab246bd）**：fake 离线 70/20/40；真实模型 3 次明细 90/26.8/80、90/22.3/80、80/17.8/60，中位数 **90/22.3/80**。与旧口径（90/30.7/80）差异原因：正确率定义变严（根因概念匹配 + 罚干扰独证）+ D6 证据口径变化（分母变大）；旧数已作废。真实问题两次显形：ct-005「材料不足仍 supported」三次全挂、引用精确率低（干扰混入），交阶段二 rules/审计 Agent。 | 已完成（实测见 Z2 回填） |

---

## 附：独立上下文审计 Agent 设计讨论

**设计命题**：把"证据是否充分"的判定从主诊断 Agent 剥离到**独立上下文**的审计 Agent，避免自查自证的确认偏差；
审计输出结构化"补证项 + 终止建议"，由程序结合调用预算决定重试或收敛。

### 参考思路（同类成熟模式）

| 模式 | 说明 | 与本设计的关系 |
|---|---|---|
| Evaluator-Optimizer | 一个 LLM 生成，另一个 LLM 评估并反馈，循环 | 最接近的规范参考（Anthropic《Building Effective Agents》） |
| Generator-Critic / Actor-Critic | 生成者与批评者分离 | 同源思想，强调批评者独立 |
| LLM-as-a-Judge | 用独立模型评分 | 用于"是否回答了问题/是否充分"的判定 |
| Verifier / 过程监督 | 生成难、验证易（verification asymmetry），可训练/使用独立验证器 | 支持"审计可以用更便宜模型/规则" |
| Reflexion | 自我反思 | **同一上下文**，正是本设计要避免的确认偏差来源 |
| Multi-agent Debate | 多智能体辩论 | 更强但更贵，非首版 |
| Subagent 模式 | dsh `subagent*`、Claude Code subagents | 工程上如何拿到"独立上下文"的实现参考 |

### 本项目的建议分工

- **程序（确定性）**：结构校验——引用是否存在、版本是否一致、无证据是否降级（已有 `validate.ts`）。
- **审计 Agent（语义性）**：是否真正回答了问题、缺哪些关键材料、是否该停止。只拿"证据池 + 草稿报告"，
  **不拿主 Agent 的推理过程**；最好换模型/温度，降低同源盲区。
- **结构化输出**：`missingEvidence[]`（缺什么、建议调哪个工具、为什么）、`terminateAdvice`（continue/stop + 理由）、
  `claimVerdicts[]`（每条结论 → 证据 → 判定）。
- **程序决定收敛**：审计只**建议**；程序结合 `maxAuditRounds` 与调用预算决定重试或收敛，避免死循环。

### 风险

- 同模型相关错误（盲区相同）→ 换模型或让审计只看证据、不看主 Agent 结论能缓解。
- 额外成本/延迟（每次审计一次 LLM 调用）→ 只在"主 Agent 要提交"或"预算将尽"时触发。
- "独立上下文"是独立**推理**，不是独立**信息**（证据相同）→ 不要把独立性绝对化。
- 验证比生成容易 → 结构部分用程序、语义部分用小模型，性价比更高。

### OQ-30 实施记录（首版单次审计，2026-10-04）

**形态**：同一个 Runner 进程 / 同一事件循环内按顺序跑两个独立 pi 会话——诊断会话（有工具、保留调查历史）
→ 程序冻结草稿与证据快照 → 审计会话（独立 in-memory session、无检索工具）→ 程序按判定对**具体结论**降级。
Agent 是角色/上下文/权限，Runner 是执行进程：不新增 Worker/队列，两者共享一次 attempt 与总超时。

**已冻结的策略（用户已拍板）**：

1. **审计不主动检索**（`TD_AUDIT_ALLOW_RETRIEVAL=false`，首版）：审计只读冻结证据快照 + 范围/覆盖信息；
   避免预算/恢复/上下文复杂度，并保持与主诊断的语义独立性。主动检索留待首版验证有效后再评估。
2. **审计失败不阻断、显式降级**（`TD_AUDIT_FAIL_BLOCKS=false`）：模型报错/超时/未产出 `submit_audit` 时，
   报告照常提交，但 `completeness→partial` 且 `corrections`/`missingMaterial` 标注「未经独立复核」；
   置 true 则走 `failRun`（可重试）。
3. **降级映射**：`contradicted → refuted`；`unsupported`/`undecidable` 把 `supported → candidate`（confidence→low）；
   已是 candidate 的结论不因弱判定强行降完整度。只有「原标 supported 的结论被降级」或有 `missingEvidence` 才判 partial。
4. **程序决定收敛**：审计只出 `claimVerdicts[] / missingEvidence[] / stopAdvice`；程序按确定性规则决定是否继续。
   **有界补证循环（2026-10-04 追加）**：`stopAdvice=continue` 且有 `missingEvidence`、轮次 < `TD_AUDIT_MAX_ROUNDS`
   （默认 1）、工具额度未耗尽时，把缺证项写回**同一诊断会话**补证（保留调查历史），再审计；补证轮与主诊断
   共享工具额度与总超时（同一 Toolbox/AbortSignal）；补证后若变成闲聊/反问，以该结果为准但仍记录审计判定。

**版本控制**：`AUDIT_POLICY_VERSION = "1.0.0"`（`src/agent/audit-types.ts`），改动提示词/输出契约/降级规则时递增；
结果随 `run_events`（`audit_started` / `audit_applied` / `audit_failed`）与 `policyVersion` 落库，禁止跨版本比较判定。

**隔离与预算**：审计会话用 `SessionManager.inMemory()`，**不写 `session_entries`**（不污染主会话、不跨轮）；
审计器无工具，不占检索额度；其模型调用次数并入本轮 `modelTurns`；共享同一 `AbortSignal`（总超时）。
跨轮证据：Host 在任务里带 `priorEvidence`（仅审计开启时），Runner 内与本轮工具箱证据按 uid 合并。

**接口/文件**：`EvidenceAuditor`（`src/agent/audit-types.ts`）、`PiEvidenceAuditor`（`src/agent/pi-auditor.ts`）、
`FakeEvidenceAuditor`（`src/agent/fake-auditor.ts`）、程序控制器（`src/diagnosis/audit.ts`：`buildAuditInput` /
`selectAuditEvidence` / `runAuditPhase` / `applyAudit` / `applyAuditFailure`）；Host 在 `finalize.ts` 应用；
两条执行路径（`orchestrator.ts` 内联、`entrypoints/runner.ts` 进程 + `runner-executor.ts`）都接入；协议 v4。

**程序控制器**：`src/diagnosis/diagnosis-loop.ts`（`runDiagnosisLoop` / `shouldSupplement` / `renderSupplementPrompt`）
内联与进程两条路径共用；无界风险由 `maxRounds` + 工具额度 + 总超时三重封顶。

**观测（2026-10-04 追加）**：审计不单独建 trace，与诊断同属一次 attempt：trace 根下诊断是 `diagnosis-attempt` agent、
每轮审计是 `audit#n` 兄弟 agent（`phase: "audit"`），审计 generation 挂对应 `audit#n` 下；程序应用记 `audit-apply` span。
用量/耗时按父节点分离（诊断 vs 审计），trace 根仍是 attempt 总量；进程模式经 Runner `observation` 上报、Host 记录。

**未做**：并行专项审计、Supervisor、审计主动检索。

## 观测（Langfuse）（2026-10-04 新增）

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| OQ-42 | generation 的 completionStartTime 用请求开始时间填充，Langfuse 的 TTFT 指标可信吗？ | 不可信。该字段当前等于 span startTime（streamFunction 调用时刻），TTFT 恒为约 0。pi 流的事件时序：HTTP 响应头 → `start`（TTFB）→ 首个 `text_delta`/`thinking_delta`（真首 Token）→ `result()`；观测只被动取 `result()`，拿不到首 Token 时刻。generation 的总时延、usage、输出内容不受影响，均为可靠值。 | 待办 |
| OQ-43 | 同一 Session 第二轮 trace 的模型上下文为什么只有各轮 user 消息？ | 会话恢复断链：pi 0.84.2 只对 custom entry 发 `entry_appended` 事件，常规 assistant/toolResult 条目从不发；引擎恰好只靠该事件落库，第一轮仅 2 条入库，第二轮重建时无历史可用（实测第二轮首次调用上下文 6,987 字符，全部工具结果缺失，模型被迫从头重查）。 | 已结论（已修复） |

### OQ-42 待办方案（未实施，2026-10-04）

- 方案 A（推荐）：引擎把 session 的 `message_update` 事件转发给 observer，取在飞 generation 的首个内容 delta
  时刻作为 completionStartTime。用 pi 公开会话事件，不动流、不违反"不多消费流"约束，精度到内容级首 Token。
- 方案 B：透明代理包装返回的流，拦截首个内容事件。可行但替换了返回对象（身份/行为面变化），风险高于 A。
- 方案 C：不设 completionStartTime（宁缺毋假），TTFT 指标消失。
- 备注：在实施前，Langfuse 界面上的 TTFT/首 Token 延迟数字不可引用。

### OQ-43 修复记录（2026-10-04）

- 修复：运行结束（终态 result 之前）按 entry_id 幂等补齐 `manager.getEntries()` 全部条目；
  sink 侧 store/Host 本就是 INSERT OR IGNORE 去重设计；Runner/Host 进程路径同样受益
  （条目经 stdout FIFO 先于终态 result 到达）。见提交 df308a2。
- 实测：第一轮落库 2 → 19 条；修复后第二轮首次调用上下文 6,987 → 34,145 字符，
  包含第一轮问题、E# 证据与全部助手轮次。修复前产生的旧 trace 不会回填，属既成数据。

## 检索范围与权限（2026-10-04 新增）

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| OQ-44 | 静态服务/仓库白名单能否代替每次调查的范围约束？ | 不能。检索必须两层：部署级授权（`allowedServices`/`allowedRepos`）+ 每次调查的 `MaterialScope`。此前 `query_logs` 把模型传入的 service/timeWindow 直接交给日志源（`DiagnosisToolbox.scope` 只存不用），`allowedRepos` 也只在 `TD_REPOS` 缺省时兜底、显式 `TD_REPOS` 可越过——两处都违背“约束在工具入口”的原则。 | 已结论（已修复） |

### OQ-44 修复记录（2026-10-04）

- `query_logs`：工具入口强制 `service ∈ scope.services`（scope 为空才退回日志源白名单），并把请求时间窗**收窄**到 `scope.timeWindow`；与本轮调查窗无交集直接拒绝（`ToolScopeViolation`，与空结果/查询失败区分）。实际生效的时间窗回写进证据来源并渲染给模型。
- 仓库：`resolveSources` 让 `TD_ALLOWED_REPOS` 成为**硬白名单**（显式 `TD_REPOS` 也不得越权）；未显式设置时默认授权 `TD_REPOS` 声明的全部仓库。`prepareDiagnosis` 再兜底过滤一次，未授权仓库记入 `missingMaterial`。
- 测试：`tests/unit/config-sources.test.ts`、`tests/unit/toolbox.test.ts`（服务越权/时间窗收窄/无交集/来源标注）。
- 后续已补（T7，2026-10-04）：材料源统一返回覆盖信息（`total/truncated/hasMore/nextCursor`），`query_logs/list_files/search_code` 支持 `cursor` 续查、`read_code` 用 `startLine` 续读，空结果显式 `（无结果：…）`；崩溃恢复从 `result_json` 还原覆盖信息。
- 仍未做（见 backlog M2）：日志过滤缺 environment 与 request/trace id 结构化字段。

## 入站服务名提取（2026-10-05 新增）

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| OQ-45 | `extractService` 会把日期当服务名，污染材料范围 | **已修复**（评测 v2 迁移 M1 时发现）：标注捕获 `服务: xxx` 不要求含字母，`"checkout-service 服务: 2026-09-06 10:01 ..."` 会把 `2026-09-06` 提取为服务名写入 `investigation.service`，使 `MaterialScope.services` 错误。T1（OQ-44）范围约束生效后，`query_logs` 会因 `service ∉ scope.services` 被拒（真实故障会因此查不到日志）。修复：标注捕获必须含字母，否则回退 `xxx-service` 命名匹配；新增 `tests/unit/intake-service-extract.test.ts`。 | 已完成 |
| OQ-46 | 预期内的"读取前阻断"（版本/隔离预检）应算失败还是合法产出？ | **已结论（M3，2026-10-05）**：提升为一等结果 `blocked`——与真实 `error` 区分；当 `"blocked" ∈ round.allowedOutcomes` 时不产生硬失败、`executionSuccess` 仍为 false（未产报告）。否则预期阻断与真实失败分不开，CI 门禁会误伤（对应 M10）。实现：`RoundOutcomeKind`+`allowedOutcomes` 加 `blocked`、runner 按 `preReadBlock` 记 blocked、scorer 跳过预期阻断的 `execution_error`/`outcome_out_of_policy`、engcases 版本用例改 `["blocked"]`。 | 已完成 |
