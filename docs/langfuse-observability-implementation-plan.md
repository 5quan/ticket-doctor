# ticket-doctor：Langfuse Web 观测接入实施方案

编写日期：2026-10-03。执行方：zcode。本文是实施任务书，不表示 SDK 接入、旧 eval 清理或 Linux 部署已经完成。

## 1. 已确认范围与可验证目标

用户已确认：
- 只回退到最近准备测评重构之前，不回到项目初始阶段；分支由本轮选择。
- 可以发送真实用户输入、模型上下文、工具入参和工具返回；不只上传最终结果。
- 允许纠正模型调用次数统计、增加异步观测上报。
- 本期只做到在 Langfuse Web 正常观察 agent。暂不制作数据集、评分器、自动裁判、实验平台或 CI 评测门禁。
- 不再使用旧 eval；新分支完成后再合并。
- 目标是现有 Linux 2 核 2 GiB 机器；尽力启动，资源不足不阻塞框架交付，不擅自扩容。

验收分成两层，分别报告：
| 编号 | 目标 | 必须提供的证据 |
|---|---|---|
| A1 | 观测关闭时原诊断与 SQLite 恢复链路保持可用 | 剩余业务单元/集成测试、Host/Runner 与重启恢复测试 |
| A2 | process 与 inprocess 两种执行模式都捕获完整观测 | 本地 OTel 测试导出结果：根节点、模型、工具、输入输出、状态和关联 |
| A3 | 并发会话、重试、追问、失败不会混淆 | 两会话并发与 attempt 重试测试；clarify 不标为异常 |
| A4 | Langfuse 离线、鉴权失败、观测处理异常不让业务运行失败 | 本地故障导出器/无效地址测试；报告仍正常提交 |
| A5 | 部署配置与六服务依赖、地址、持久化正确 | Compose 配置校验、镜像清单、环境变量说明 |
| B1 | Langfuse 页面可登录、项目可进入 | 目标 Linux 实测结果 |
| B2 | 一条真实 agent 调查在 Web 可见，包含模型及工具过程；追加一轮仍属同一 Session | Trace/Session 链接或 ID、API 查询后的节点审查 |
| B3 | 实际模型、token、耗时、错误、最终输出可检查 | 实测观测记录；未知 usage 为未知，不能捏造零或费用 |

A 为框架交付必须通过项。B 为平台实测项；若目标机器资源不足，明确标记 B 未完成及原因。不能把“Compose 写好了”说成“Web 观测已可用”。真实模型凭据不可用时同样报告未验证，不假造真实结果。

## 2. 分支与基线

本轮已建立：
- 分支：`codex/langfuse-observability`。
- 基线：`4fad75277c0ccd20afd4b57f131507e020efece6`，提交说明为投递轮询默认值修复。
- 独立工作区：`C:/Users/5quan/.codex/worktrees/langfuse-observability/ticket-doctor`。
- 原工作区仍在 main；原先暂存的 pre-diagnosis-evaluation-plan 文档（仅存在于用户本地工作区） 属于用户已有内容，不移动、不覆盖、不用于本方案。
- 本文落地时业务代码尚未修改；旧 v1 eval 尚待 zcode 在第一阶段移除。

选择理由：该提交已经包含 Host/Runner 分离、SQLite 会话恢复、证据 UID、飞书 Webhook/长连接，早于 scorer v2 与后续 eval v2 重构。依赖锁文件、Host/Runner/Agent/Storage/Evidence、migrations 和 Go 适配器与当前 main 的检查快照一致。

后续生产安全修复不能丢：
1. 将 main 检查快照 `66d5425` 中 `src/sources/logs.ts` 的服务名校验、路径边界、realpath 校验和三种授权语义移植回来。
2. `src/config/index.ts` 的 `allowedServices` 改为 `string[] | undefined`；环境变量未设置表示未配置，明确空值表示空授权全拒。
3. `tests/helpers.ts` 默认不限服务从 `[]` 改为 `undefined`。
4. 独立新增日志源安全测试，不整文件搬回 eval-v2 专属测试。
5. 不带回旧 eval 专用的 `onPrepared` 钩和版本评测协议；本期不需要 `repos.rev?` 新能力。若实际发现生产消费者，再按必要性单独说明。

### 2.1 旧 eval 清理

在新分支删除旧执行资产：
- `src/evals/`、`fixtures/evals/`、init-eval-fixture 脚本；
- `package.json` 的 `eval`、`preeval`；`pretest` 只保留 demo 初始化；
- 只依赖旧 eval 的测试，包括旧 scorer 和 eval 集成测试，逐个查引用后清理；
- 清理 README 和活动入口中把旧评测当成现行能力的描述。

历史设计文档可保留为历史，但须标明不属于现行实现并移除活动链接。不要为了删除 eval 顺带删除业务工具安全、证据校验、多轮会话或恢复测试。删除之前逐项列出路径，检查没有业务反向引用。

### 2.2 以后合并 main 的注意事项

此分支从旧提交分叉，main 后来新增的 eval v2 文件不会因“分支里没有这些文件”在 Git merge 时自动消失。

合并前必须先在本分支同步当时最新 main、解决生产代码冲突，再明确删除包括 v2 在内的全部旧 eval 源码、fixture、专属脚本和测试，清理 `eval:v2` 等新入口，并重新跑业务验证。PR 应以同步后的 main 为基准，能看到旧 eval 的实际删除。不能直接合并历史分支然后声称旧 eval 已清理；不能在 main 执行 reset。

## 3. 一期架构与低风险实现选择

```text
飞书 / Web → Host 入队 / SQLite / 调度 → Runner → Pi → 模型与只读工具
                                  ↑         │
                                  └── IPC ──┘
                                    │
                         Host 统一 ObservationRecorder
                                    │
                     OTel 内存批处理 → 本地 Langfuse Web/API
```

内联模式由相同中立观测接口直接送到记录器。SQLite 继续负责业务事实与恢复；Runner 继续不碰数据库。

首期采用以下明确的实现选择：
- 观测采用 best-effort 内存批处理；不增加数据库迁移、durable outbox、JSONL、离线补发或自研网络重试框架。
- Langfuse 离线时允许这部分观测丢失，原业务会话仍在 SQLite。Host 异常终止、队列溢出和导出失败也不保证恢复观测。把这一限制写进运行文档。
- 不逐 token 创建 observation；每次模型调用一个 generation，每次工具调用一个 tool。
- 根 observation 结束后可触发有界 forceFlush，网络发送不成为业务成功条件；进程退出前做有界 shutdown。
- 采用显式父子引用和每次执行独立 registry，不用一个全局 mutable “current span”。
- 观测只通过显式依赖注入；domain 不依赖 Langfuse SDK，Pi 只依赖中立接口。
- 用户允许真实业务内容；不要自动把所有文本脱敏成不可诊断的占位符。采集范围仍限定业务请求/响应，不采集 `.env`、SDK 配置对象、认证头或运行时 API key。
- 初次 Linux 试运行将诊断并发设为 1，保持一个文本调查；这些是试运行参数，不改诊断策略或默认生产业务架构。

上述选择降低一期实现范围；不是承诺全量可靠送达。之后若需要离线补传，另立任务。

## 4. 数据组织与状态语义

| 业务标识 | 映射 |
|---|---|
| investigationId | sessionId；首次调查与后续补材料共用 |
| runId | 同一轮的业务关联键；按 metadata 查同轮各次尝试 |
| 每次 attempt | 独立 trace；根 observation 包含本次尝试的输入与结果 |
| attemptId / generation | attempt 节点与 metadata，保留失败尝试 |
| modelCallId | 每次实际模型调用的逻辑标识 |
| toolCallId | 每次工具调用标识 |
| engine、provider、modelId、source、repo SHA | metadata / environment / release 的稳定维度 |

建议树：
```text
diagnose-turn (span：原始问题 → 实际可见最终结果)
├─ diagnosis-attempt (agent：attempt 1)
│  ├─ model-request (generation)
│  ├─ query_logs (tool)
│  ├─ model-request (generation)
│  ├─ read_code (tool)
│  └─ submit_report (tool)
└─ report-validation (span：草稿 → 校验后报告与 issues)
```

首期每个 attempt 单独创建 trace，避免跨排队重试维护长生命周期根 span；同轮重试用 runId 关联，多轮用 sessionId 关联。attempt 重试保留独立记录，不能覆盖上次错误和费用。工具是 agent 的子节点，与要求该工具的 generation 为兄弟节点。本期不增加 Go 适配器埋点或独立投递 trace。

输入输出：
- 根 input：本轮原始用户问题和必要的调查关联；不是函数全部入参或全部历史。
- 根 output：实际提交给 Web/投递队列的 report/chat/clarify 内容与结果类型。
- generation input：真实请求边界看到的 systemPrompt、messages、工具定义；能捕获 provider payload 时也保存对应 body，标注捕获层级。
- generation output：模型实际返回的文本、tool calls、提供的 thinking/reasoning、stopReason、error、usage。只记录 provider 已返回的数据，不生成“内部思考”。
- tool input/output：实际参数及 agent 真正可见的结果，保留 toolCallId、evidence UID、耗时与错误；不要用数据库中未展示的证据冒充模型已看到的结果。
- report-validation：保留原 draft、校验 issues、校验后 report，便于区分模型输出与程序纠正。
- environment 使用 development/test/production 等部署标签，不能混同被诊断业务的环境字段。

成功提交 report、普通 chat、请求补信息 clarify 都是合法结果。执行失败、取消、超时、过期 attempt 与材料 partial 分开记录。异常终止时 Host 关闭未结束的 observation，标记 interrupted/incomplete；不虚构模型完整输出或结束 token。

如果 SDK 无法直接指定 trace ID，使用受支持的 trace context/ID API；不要把业务 UUID 当成合法 OTel trace ID。优先让本次 attempt 根 span 的 context 决定 trace，业务 ID 作为 metadata。Host 重启后重新执行仍可使用新的 trace，以 runId/attemptId 查询关联；首期不承诺持久 trace ID。

## 5. Pi 模型与工具采集

Pi 固定使用 @earendil-works 0.84.2。先核对实际安装类型与公开接口，不根据旧教程猜接口。

### 5.1 模型请求边界

优先包装该 session 的公开 `session.agent.streamFunction`，而不是全局 patch HTTP，也不是只靠最终 `message_end`：
1. 保存原 streamFunction。
2. 在调用时生成 modelCallId，记录 start 时间、model 和有效 context。
3. 原调用保持原 model/context/options 和 AbortSignal；不修改提示词、工具参数或重试行为。
4. 原函数若未显式赋值，应确认 Agent 的默认 streamSimple 路径并使用对应公开入口，不能把 undefined 当函数调用。
5. 如使用 `options.onPayload` 捕获实际 provider body，链式调用原回调并完全保留其异步返回值与 payload 替换语义；不因记录而改变请求体。
6. 原函数可能同步或异步返回流，按本版本 StreamFn 类型处理。
7. 用同一流的 `result()` 观察完整 AssistantMessage，返回原流供 Pi 消费。严禁另开第二个 async iterator 抢走 token 事件。
8. 同步 throw、Promise reject、abort 和正常 stopReason 都关闭 generation。观测异常单独 catch，不改变原错误和正常返回值。
9. 显式管理 pending capture，返回本轮结果前确保记录结束；只等待本地数据采集，不等待 Langfuse 网络请求。
10. 恢复原函数，清理 listeners/registry，避免下次重复包装。

公开 streamFunction 也可能服务 compaction 等内部模型请求。实际发生就记录，增加 callPurpose/阶段标识，不能漏计或伪装成用户对话。生命周期重试和压缩事件可用于辅助阶段标识，不推断不存在的 API 请求。

这里计数的是逻辑 generation，包含 Pi 重新发起的请求与压缩调用。provider 内部 HTTP 网络重试可能发生在 onPayload 之后，一期不声称能逐次捕获这些底层 HTTP 尝试。立即快照有效 context/payload，避免后续消息变更污染记录。最终结果的 error/aborted stopReason 也必须处理，不能只看 Promise rejection。

采集证据层级明确：
- effective_context：包装点看到的真正有效模型上下文；
- provider_payload：原 SDK 回调给出的实际请求 body；
- final_message：最终真实 AssistantMessage。
若某 provider 不触发 onPayload，明确标注只有 effective_context，不编造 payload。

### 5.2 工具与计数

工具事件优先使用 session 的 tool_execution_start/end；已有 timedTool 中的业务记账继续保留。观测只选一条产生 span 的路径，以 attemptId + toolCallId 去重，不能两处各产生一个 tool observation。

当前 `modelTurns` 在 tool_execution_start 增加，这是工具次数口径。将其改为逻辑模型 streamFunction 调用次数，报告与存储中的同名字段保持一致；文档说明包含 compaction 等实际模型请求。如需区分对话模型请求，增加 metadata 分类，不顺便增加模型预算或改变 retry 策略。

计数修正独立于 TD_OBSERVABILITY_ENABLED：关闭网络观测时也要按逻辑模型调用计数，不得让关闭状态保留工具次数或变成零。实现可保留仅计数的轻量包装，noop sink 不产生/导出观测。

不要重复累计 usage：现有会话落库的业务 usage 保持原账本；Langfuse generation 使用该次模型返回值。部分字段缺失标注 unavailable。Pi 可能在请求开始就将 usage/cost 初始化为零，鉴权失败、发送前错误或 abort 返回的这类零不是可靠消费证据；error/aborted 或缺少可靠 token 来源时省略 usageDetails/costDetails，metadata 标 unavailable。不能只因字段存在就把零当成真实值。费用来自可靠 provider cost 或有可靠 usage 的 Langfuse 配置，不能估算后声称准确账单。

## 6. Runner IPC 与 Host 记录器

新增中立 ObservationEvent 联合类型，建议最小字段：
- schemaVersion、eventId、局部 seq、timestamp；
- kind：model_start/model_end/tool_start/tool_end/phase 等；
- logicalObservationId、parentLogicalId；
- input/output、model、usage、status/error、metadata 中与当前事件有关的字段。

Host 从实际派发任务注入 investigationId/runId/attemptId/generation，不能信任 Runner 任意传入身份。中立 ID 到 OTel observation/context 的映射由 Host 持有，并发隔离。eventId 去重仅限本次进程内必要范围，不建立长期缓存。

IPC 约束：
1. 扩展 RunnerTask 开关与 RunnerMessage 观测消息；在同仓库协议版本校验体系中更新版本及对应测试/文档。
2. Runner 不需要 Langfuse key/base URL；它只知道采集开关和本地关联。
3. 所有已准备观测消息必须在 terminal result/error 前按 stdout FIFO 发出。
4. fire-and-forget promise 必须在 terminal 前结算；terminal 后不再 emit 观测。
5. 新观测消息同样经合法 JSON 序列化输出 stdout，诊断日志走 stderr。
6. 同步已写出的观测消息先于 result 被读取；不要错误地假设 Host kill 必然丢弃此前 FIFO 消息。真正要防的是异步采集晚于 terminal 和 Runner 内异步网络导出。
7. Host 处理观测消息必须自己捕获错误。异常不得穿透到现有 IPC 协议错误路径，导致业务 runtime_error。
8. 通用日志/输入可能很大。实现可配置字节上限、显式截断标记和原长度，保证按字节而非 UTF-16 字符估算；默认建议 512 KiB/事件作为可调整试运行值。不静默截断、不改变 agent 自己接收的内容。
9. 协议解析器现有 buffer/消息限制要一起核对，避免记录真实上下文后出现无限 buffer 或错误拆行。

Host 用手动 observation 管理跨回调生命周期，显式指定父 context。按 Recorder registry 更新、结束、清理，禁止依赖跨 IPC 自动延续的 AsyncLocalStorage。内联路径使用同样的 Recorder 语义。

本轮 attempt 收尾、Host timeout/取消/Runner crash 都需收敛未结束节点。过期 attempt 可作为失败事实保留，但不能把拒绝提交的结果设置为本轮 accepted output。根节点只由正式 finalize 接受的业务结果更新。

Host shutdown 做一次幂等有界流程：停止新调度、沿现有路径收尾运行、关闭观测节点、结束批处理器。建议 5 秒导出期限作为可配置值；网络失败或重复信号不能拖住退出。不要把关闭观测的失败转为业务失败。不要改写 SQLite 恢复状态机。

## 7. 模块与修改清单

建议新增目录 `src/observability/`，模块规模保持小：
| 模块 | 职责 |
|---|---|
| types.ts | 中立事件与 Recorder/Sink 接口 |
| noop.ts | 默认禁用实现 |
| pi-observer.ts | streamFunction 包装、模型/工具事件与本地安全采集 |
| langfuse.ts | Host SDK 初始化、显式 observation registry、导出和 shutdown |

如果实际两文件就足够，可以合并；不要为了目录形式建设通用可插拔平台。

必要生产接线：
- `src/config/index.ts`：集中解析可选观测配置与日志授权安全修复。
- `src/agent/pi-engine.ts`、`src/agent/types.ts`、`src/agent/factory.ts`：注入中立 observer，纠正实际模型调用计数。
- `src/runner/protocol.ts`、`src/entrypoints/runner.ts`：开关、事件消息、terminal 前本地采集收尾。
- `src/host/runner-executor.ts`：Host 身份注入、安全事件处理与 attempt 收尾。
- `src/diagnosis/orchestrator.ts`、`src/diagnosis/finalize.ts`：内联同等接线、原 draft 与最终结果，不带回旧 eval hook。
- `src/entrypoints/bootstrap.ts`、`src/entrypoints/host.ts`：配置后初始化 Recorder、依赖注入和关闭。
- `src/entrypoints/demo.ts`：使用明确的禁用或测试 Recorder，不依赖 Langfuse。
- 如共享 bootstrap 被 gateway/worker 使用，保证这些入口观测默认禁用也可正常工作；开启时必须使用同等生命周期关闭，不能默默只记录半条。
- `package.json` 与 lock：SDK 依赖和旧 eval 脚本清理。
- `.env.example`、README、部署说明、必要测试。

不变更 domain 业务模型、证据签发规则、提示词内容、日志/源码检索策略或飞书协议。日志源安全修复和 modelTurns 口径调整是用户目标必要配套，收尾单独列出。

## 8. SDK、配置与异步行为

固定 Langfuse 版本：
- `@langfuse/tracing@5.11.1`
- `@langfuse/otel@5.11.1`
- 本期没有 datasets/prompts/scores 需求，不安装 `@langfuse/client`；验收查询可用 CLI。
- 按 SDK 的实际 peer dependencies 选择兼容 `@opentelemetry/sdk-node` 等依赖，并写入 package-lock，不凭空指定 OTel 版本。
- Server Web/Worker `4.50.0`，使用 OTel ingestion，不增加 Dify/旧 batch ingestion 兼容开关。

应用侧建议配置：
| 配置 | 默认/规则 |
|---|---|
| TD_OBSERVABILITY_ENABLED | false；默认不发任何观测请求 |
| LANGFUSE_BASE_URL | 启用时必填，必须指向本地/内网服务，不能落到 Cloud 默认值 |
| LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY | 启用时必填，存运行环境；不进入消息、日志或文档 |
| LANGFUSE_TRACING_ENVIRONMENT | development；按部署指定 |
| LANGFUSE_TRACING_RELEASE | 实际代码版本，可在部署注入 |
| TD_OBSERVABILITY_MAX_EVENT_BYTES | 建议 524288，按实测调整 |
| TD_OBSERVABILITY_SHUTDOWN_MS | 建议 5000，有界关闭 |

明确写出哪些是本项目变量，哪些是 SDK 原生变量；不能假定 SDK 支持所有项目自定义变量。

加载配置后再初始化 SDK。禁用时不需要 key，也不应意外创建默认 Cloud exporter。启用但缺配置时打印不含秘密的清晰错误并降级 noop，Host 业务继续运行。网路错误采用有界批处理/受控日志；不要做每秒无限重试、无限缓冲或逐条 forceFlush。

若配置批大小、exportTimeout 等参数，必须依据 5.11.1 的实际类型，不照抄另一语言 SDK 参数。测试需验证导出器确实只把目标 observation 发给 Langfuse，避免 Node 自动 HTTP/DB 埋点噪声。

## 9. Linux 部署：按用户指定指南及官方 Compose

用户最新指定 [中文版 Docker Compose 指南](https://langfuse.com.cn/self-hosting/deployment/docker-compose) 为部署参考，并明确忽略先前 DeepSeek 生成的镜像部署资料。本文不以那份资料为依据，也不预置任何第三方公共镜像代理。

已通过网页检索读取该中文页面的缓存内容；直接抓取遇到限流。它给出的流程是获取 Langfuse 官方仓库、修改凭据、Docker Compose 启动，并建议 4 核 16 GiB。缓存较旧，不能仅凭中文页面推断当前镜像版本。具体配置以该指南指向的官方 GitHub 仓库 v4.50.0 release Compose 为准。

新增部署资产建议：
```text
deploy/langfuse/
  compose.yml
  .env.example
  README.md
  # 如标准模板试运行失败且仍需调参，再增加可选 compose.small.yml
docs/
  langfuse-observability-implementation-plan.md
```

compose.yml 取固定 release 的官方文件做最小配置改动：固定 Web/Worker 版本、外部端口、环境变量与必要持久化。首次按标准官方模板尝试，不先叠加来自第三方教程的低内存优化。Langfuse 是独立栈，不给 ticket-doctor Host 增加平台健康依赖。

官方 v4.50.0 模板实际包含六服务；这是对官方仓库的核验结果，不是采用 DeepSeek 资料：
| 服务 | 固定/选择 |
|---|---|
| Web | docker.langfuse.com/langfuse/langfuse:4.50.0 |
| Worker | docker.langfuse.com/langfuse/langfuse-worker:4.50.0 |
| ClickHouse | docker.io/clickhouse/clickhouse-server:25.12 |
| PostgreSQL | docker.io/postgres:17 |
| Redis | docker.io/redis:7 |
| MinIO | cgr.dev/chainguard/minio |

后三种 tag 和 ClickHouse 的 minor tag 仍可能变化，实际拉取后记录 digest；不能填入未经验证存在的 MinIO tag/digest。不要复制历史 :4 的 digest。镜像引用不带 http:// 前缀。

平台配置重点：
- Langfuse 宿主机端口 3001，容器内部仍 3000，避开项目 Host 的 3000。
- NEXTAUTH_URL 填浏览器实际访问地址；不能直接使用中文缓存里显示不完整的示例占位地址，也不能在服务器上固定为 localhost。
- 数据库、Redis、MinIO 认证与 Langfuse SALT/ENCRYPTION_KEY/NEXTAUTH_SECRET 按官方格式生成，Web/Worker 共享项一致。
- 命名卷持久化 PostgreSQL、ClickHouse、Redis、MinIO；排查失败时不执行 down -v。
- 默认不启用 Assistant、代码评测或额外模型功能；观测无需给 Langfuse 配诊断模型 key。
- 如使用附件，MinIO 浏览器外部地址与服务间内部地址分别设置；本期先用纯文本验收。
- 原 Host 与 Langfuse 若分开 Compose，同机器可使用明确的共享 Docker 网络与服务名，或实际可达的内网地址；不能用容器内 localhost 访问另一容器。
- 只发布需要的 Web/附件端口；数据库不对外发布。配置由实际入口决定，不猜公网 IP。
- 检查目标 uname -m 后使用原生 amd64/arm64；不得默认 Linux 都是 amd64。
- 官方镜像源拉取失败时如实记录网络阻塞；先由实际部署环境提供可达 Registry 或同版本离线镜像，再核验摘要。不要未经核验替换源、换旧镜像或默认增加公共代理。

### 9.1 2 核 2 GiB 试运行

用户接受资源不足时无法启动。官方指南的 VM 建议是至少 4 核、16 GiB 和足够存储；2G 没有可运行保证。

试运行原则：
- 使用预构建镜像，不在这台机器 build Langfuse。
- 保留官方完整依赖；不能删掉 ClickHouse/Redis/S3 来声称支持 v4。
- 一次一个调查，少量文本，不运行批量实验、导出或大范围分析。
- 先检查内存/磁盘/架构/已有容器，再启动标准官方模板。不要与 ticket-doctor 大并发同时压测。
- 若明确出现资源不足，可在可选 compose.small.yml 中尝试经当前版本文档查证的 Node 堆/并发约束；数值由实测调整。它不是默认部署，也不承诺保证启动。
- Node 堆限制不等于整个进程 RSS；过低限制也可能使初始化失败。
- Docker stdout 日志轮转；健康检查合理等待；故障持续重启时停止循环，保留数据卷和诊断日志。
- 不自动创建 swap、不调整内核/全机 daemon、不扩容；这些若需要，另行说明与授权。
- 失败分清镜像网络、鉴权、迁移、端口、健康超时和 OOM。提供 OOMKilled、日志、可用内存/磁盘等证据。

### 9.2 操作顺序

在部署目录使用：
```sh
docker compose --env-file .env -f compose.yml config --quiet
docker compose --env-file .env -f compose.yml pull
docker compose --env-file .env -f compose.yml up -d
docker compose --env-file .env -f compose.yml ps
docker compose --env-file .env -f compose.yml logs --tail=100
```

只有完成标准模板尝试、明确需要并制作了低资源覆盖时，才额外加 -f compose.small.yml。config 输出可能含 secrets，校验用 --quiet，不把展开的完整配置粘到工单或聊天。

Web 健康后按当前官方说明建立用户、组织、ticket-doctor 项目与项目 API key；凭据只写运行环境。本期无需启用 evaluator。观测 SDK 走 v4 OTel；不增加 Dify/旧 batch ingestion 兼容开关。

## 10. zcode 执行阶段

按阶段提交可审查结果，不把环境资源不足变成停止代码工作的理由：

1. 基线与清理：确认分支/工作区，移除旧 v1 eval，保留日志源安全修复与独立测试。跑一次剩余业务基线检查。
2. 无网络观测：中立接口、noop、Pi streamFunction 包装、工具记录、modelTurns 修正；用内存测试 collector 检查真实边界。
3. Host/Runner 接线：协议扩展、并发 registry、内联路径、terminal 顺序、失败收尾与本地测试。
4. OTel/Langfuse 适配：固定 SDK，配置后初始化，手动父子 span、批处理、关闭、失效降级。用本地 OTel 测试 exporter 验证内容和结构。
5. 部署资产：用户指定指南与固定官方模板、地址与密钥说明、镜像 digest 记录；低资源覆盖仅在标准模板试运行后按实测需要增加。
6. 实机验证：在已提供的 Linux 环境尝试启动；成功就真实调用并查询 Langfuse 审查。未提供访问方式时交付框架，列明实机未验证，不自行寻找服务器凭据。
7. 合并准备：同步最新 main 后再完整清理包括 v2 在内的旧 eval；解决生产差异，重新验证并给出 main 对比。此阶段不可跳过。
8. 收尾：列出实际修改、测试结果、平台真实状态、未完成原因和后续可运行命令。后续合并由用户另行安排。

## 11. 测试与实测审查

最低自动化检查：
- TypeScript typecheck；剩余 TS 单元/集成测试；Go 测试（Go 环境缺失则说明）。
- 业务 Host/Runner、会话重启恢复、证据提交与投递测试。
- 日志安全：未设置授权正常、[] 全拒、白名单、非法服务名、文件链接越界。路径用例不能被空授权先行拒绝掩盖；仅 EPERM/EACCES 等明确权限不足可跳过链接用例。
- Pi 包装：不修改请求、不多消费 stream、保留原 onPayload 的返回/替换值；同步/异步失败和 abort 均有收尾；一次模型请求只计一次。
- 工具两条记账路径不重复建 span；fake 引擎不假造 generation/token。
- 关闭观测时逻辑模型计数仍正确；鉴权/取消返回 Pi 零初始化 usage 时不记录虚假的零费用/零消费。
- 并发：两个 investigation 的模型、工具、父 span 不串。
- attempt 重试：失败调用保留，最终输出只来自 accepted finalize；clarify/report/chat/partial 状态分明。
- IPC：晚到异步采集在 terminal 前收口；观测 handler 抛错不触发业务协议失败。
- 导出：关闭与缺配置不连接 Cloud；本地导出故障不阻断报告；队列/registry 清理且关闭有界。
- Compose config 校验；原生架构和实际镜像可拉取性分开检查。

真实 Langfuse 验收不能只检查 HTTP 200：
1. 用已有真实模型凭据发起一条能调用日志/源码工具的调查，随后补材料/追问一轮。
2. 从 Web 观察两轮同一个 Session、不同轮 trace、正确 attempt/generation/tool 层级。
3. 使用 langfuse-cli 当前 schema/help 或本地 deployment API 查询对应 observations（v4 观测查询接口），检查实际 input/output、模型、usage、时间、错误。
4. 重新获取当前最佳实践文档审查，修复缺口后重跑。
5. 提供最终 Session/Trace 链接或 ID。若 Web 可用但数据未出现，先查 SDK base URL/鉴权/队列/Worker/ClickHouse，再查应用采集。不要套用 Dify 的旧协议开关。

## 12. 当前交付事实与实施方收尾格式

本轮实际完成：基线审查、独立工作区与新分支、本文。尚未实现 SDK 接线、删除旧 eval、移植安全修复、创建部署文件或连接 Linux。
当前原工作区 typecheck 已通过；新分支的运行状态、未来接入测试与 Linux 平台均未实测。

zcode 收尾必须分别报告：
1. 本轮完成度；
2. 主线目标和完成度：框架与 Web 实测分开；
3. 已完成的关键改动，包括必要配套；
4. 未完成/阻塞项及验证证据；
5. 下一步建议。

不得因 2G 起不来而宣称 Web 已验收；不得因实机起不来就丢弃已验证的接入框架。

## 13. 查证来源

- Langfuse Server 4.50.0（github.com/langfuse/langfuse releases）
- Langfuse JS SDK 5.11.1（github.com/langfuse/langfuse-js releases）
- SDK 官方初始化（langfuse.com 文档 observability/sdk/overview 页）
- 手动 observation 与父子关联（langfuse.com 文档 observability/sdk/instrumentation 页）
- 观测最佳实践（langfuse.com 文档 observability/best-practices 页）
- 版本兼容与 v4 OTel（langfuse.com 文档 compatibility 页）
- Docker Compose 部署与资源建议（langfuse.com self-hosting/deployment/docker-compose 页）
- 固定 release Compose（raw.githubusercontent.com langfuse v4.50.0 docker-compose.yml）
- 官方镜像来源（langfuse.com self-hosting/deployment/infrastructure/containers 页）
- 用户指定中文版部署指南（langfuse.com.cn self-hosting/deployment/docker-compose 页）

官方 Pi 插件仍为实验性，且本项目自行创建 session、默认扩展列表为空。可参考其事件建模，但本方案优先包装当前项目公开 SDK 请求边界，不安装 CLI 插件后假定已经覆盖业务。

