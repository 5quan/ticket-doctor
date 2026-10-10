# 业务观测迁移到 Langfuse tracing SDK

本次改造基于 `origin/codex/langfuse-eval` 的 `724a9bf4c75f77dd80763c8d3448abffd9ad6199`，官方包继续锁定 `5.13.1`，不改 Dataset、Prompt、runExperiment 或 evaluator 的业务语义。

## 迁移范围

`src/observability/langfuse.ts` 的业务节点改用 `startObservation`、父 observation 的 `startObservation`、`update` 和 `end`，不再手动 `tracer.startSpan` 或序列化模型、工具、用量、错误级别、prompt 属性。保留原 `ObservationRecorder` 接口，Runner 仍只传中立事件，Host 注入 investigation/run/attempt/generation 身份。

有源事件时间的模型、工具和审计节点使用顶层 `startObservation` 加 `parentSpanContext` 与 `startTime: Date`；其他子节点用父 observation 方法。`5.13.1` 的父方法只接收 `asType`，不能传 `startTime`。结束传入源事件时间，不伪造首 token 时刻。

每个 attempt 保留节点的开始与结束 metadata、结束 tombstone，并校验结束事件的类型、父引用和工具调用 ID。先到的结束事件及缺父事件进入至多 256 条的 pending 队列；依赖补齐后处理，终态时释放。已完成 attempt 的防重缓存保留最近 1024 个身份，防止长期 Host 无界增长。超过乱序缓存上限的无法关联事件会被忽略并节流告警；正常 IPC FIFO 路径不依赖此缓存。

## 实验上下文与所有权

删除未被消费的 `otelParentContext` 参数。实际链路是 `dataset.runExperiment → experiment-item-run → propagateAttributes → task → runCase → executeRun → beginAttempt`，由实验拥有的 AsyncLocalStorage context manager 传播。Recorder 在开始时保存完整 Context，后续离开 active context 的 IPC/回调也使用该基座，并显式指定父 observation。

实验初始化一套 provider/processor，Recorder 借用。单案例不关闭共享资源；Recorder shutdown 结束残留业务节点，实验入口在 finally 中处理客户端 scores 队列，再由实验所有者 flush/shutdown traces 与自有基础设施。重复关闭只执行一次；已有或后来接管的全局 provider/context manager 不被关闭。

SDK 的 isolated provider 是进程 singleton，父 observation 方法也会重新查询它。Recorder 仅在同步创建节点期间选择所属 provider，finally 恢复原 provider；这段代码不能引入 await，否则会产生并发串写风险。

实验业务节点只更新自己的 observation 输入、输出、metadata，不设置 trace 名称或 trace IO。主诊断 generation 才接受原生 prompt 关联；审计及 compaction 调用不关联诊断 prompt。

生产 Recorder 拥有自己的 provider/processor，不安装自动 HTTP/DB 埋点。demo 的业务执行放入 finally 清理，Host 信号关闭增加幂等守卫。观测初始化和采集异常继续降级，不向业务调用方抛错。

## 最小 OTel 保留项

- `BasicTracerProvider`、`LangfuseSpanProcessor` 和显式 Context：SDK 本身基于 OTel，需要这些组件导出和传播实验属性。
- `otelSpan.setStatus`：SDK `update({level,statusMessage})` 没有 OTel `status.code` 等价字段，两者均保留。
- `release`：SDK observation 属性没有此字段，沿用原标识。
- 生产 trace 的结构化 metadata：`propagateAttributes.metadata` 仅支持受限短字符串，不能等价保留原 number/null 值。
- 生产无 context manager 时的 trace name/session 回退：优先使用 `propagateAttributes`，其 active-span 路径不可用时仅写这两个兼容属性。生产 IPC 的父子关系仍显式指定。
- 普通 trace IO 使用正式但已弃用的 `setTraceIO`，兼容既有平台和 evaluator。实验节点不调用它。

默认 processor 使用官方 SDK tracer 过滤，不再全量放行自建 tracer。健康探测和既有能力探测保持原 HTTP 接口，不强行换成客户端。

## 验证与边界

Recorder 内存测试验证父子结构、事件时间与用量、四身份隔离、重复/乱序处理、错误事件过滤、异常残留、故障隔离、prompt 限定、多个 provider 交错、实验多轮根 IO/name 保护和延迟事件的传播属性。

独立所有权测试验证 async context、已有/后来接管资源、重复关闭以及 flush/shutdown 故障路径。SDK 实验测试实际执行锁定包的 `dataset.runExperiment`，后端 mock，使用内存 processor，两个并发 Dataset Item 各有多轮业务；比较有/无 Recorder 的 fake/scripted 结果，检查 Dataset 关联、根 IO、节点 trace/父引用、分数值/类型/归属。测试 processor 的 onStart 使用官方 `getPropagatedAttributesFromContext` 模拟正式 processor 的传播职责。

这些 fake/scripted 测试验证工程行为，不验证真实模型质量。未发起真实模型或真实 Langfuse 实验，因此未确认服务器实际落库、原生 prompt 关联回读或线上观测质量。后续可在现有预算闸门内运行小规模实验，再通过既有 verify 从服务器读回实验关联、观测、分数和 prompt；发送成功不能作为验收结论。

本轮结果：完整 TypeScript 测试串行执行 `229/229` 通过；Recorder `20/20`、资源所有权 `5/5`、SDK fake/scripted 实验 `2/2` 均通过。项目类型检查、CLI 独立类型检查、文档检查、CLI help 和明确关闭观测的 fake 多轮 demo 均通过。首次默认并行运行的 Runner 启动/IPC 重投计时失败在定向及完整串行复核中通过，未修改这些模块。独立审阅另复现并修正了 SDK 默认全局 provider 回退被固定成旧 Proxy 的问题，加入后来注册 provider 仍接收 SDK observation 的回归测试。`docs/status.json` 的 228 是既有静态 `test(` 统计口径，SDK 参数化测试实际展开两条，完整 runner 计数为 229。Go adapter 未改动，本轮未重复验证。

官方依据：[Langfuse 官网](https://langfuse.com) 的 SDK Overview、Instrumentation、Observability Best Practices，以及 Advanced Features 中的 Isolated TracerProvider 章节。实现另核对了已安装 `5.13.1` 的 tracing/client/core/otel 类型及发布实现。
