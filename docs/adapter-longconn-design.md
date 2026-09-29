# Go 适配器长连接模式（S3）实施方案

> 状态：**已实施（S3）**。对应 `docs/handover-technical-plan.md §5.1`（S3）。
> 前置已完成：多平台抽象（S2/OQ-37）、飞书触发修复（门控单点化/OQ-39）。
> 遵守 `docs/handover.md §7` 的 DoD：基线 → 一次一件 → typecheck/test（含 Go）→ 文档 → commit/push。
>
> **实施记录（as-built，2025 会话）**：
> - SDK：`github.com/larksuite/oapi-sdk-go/v3 v3.12.0`（锁版本）。包路径为 `.../v3/ws`（包名 `ws`，代码里别名 `larkws`）；
>   事件分发器是 `.../v3/event/dispatcher`（`dispatcher.NewEventDispatcher`，设计稿误写作 `larkevent`）。
> - `LarkWSSource` 复用官方 SDK 自带的自动重连（默认开启、无限次）；`main` 的 `restartLoop` 仅在 `Start` 返回后兜底重连，两者串行，不产生双连接（§7 风险表）。
> - `receiveEventFromSDK` 显式映射：SDK 的 `EventSender` **无 `sender_name`**，故 `SenderName` 在长连接下为空（仅展示，不影响路由）。
> - 新增 `Adapter.HandleSourceEvent` + 私有 `process/handleMessage`，与 Webhook 共用同一段归一化/转发/mechanical。
> - 离线单测已覆盖 §5 的 1~4；**§5.5 真机验证尚未执行**（无真实凭据），步骤见 `adapters/go/README.md`。

---

## 0. 目标与验收

**目标**：飞书不暴露公网回调，Adapter 通过**长连接（WebSocket）**接收事件；与 Webhook 行为完全一致。

**验收**

1. `ADAPTER_MODE=webhook|ws` 可切换；`ws` 模式不依赖公网入站端口即可收发事件。
2. 群里 @机器人（或线程内回复）→ Host 建调查/续接 → 执行 → 结果经 Adapter 回飞书，链路与 Webhook 相同。
3. 事件处理成功才 ACK；Host 不可用时不 ACK（触发平台重投），Host `inbound_events` 去重兜底。
4. 长连接异常退出时进程不崩：按退避重连。
5. 无真实凭据时，映射与转发逻辑有单测；真机验证步骤写进文档（人工执行）。

**非目标**：S4（弃用 Host 内直连）、钉钉/Slack 实装、多应用配置拆分。

---

## 1. 飞书长连接是什么（先讲清楚）

飞书长连接是**自有 WS 协议**，不是普通 WebSocket：

1. `POST https://open.feishu.cn/callback/ws/endpoint`（带 app_id/app_secret）换取 `wss://` 地址与 `ClientConfig`（心跳间隔、重连参数）。
2. 建立 WS 后，帧为 **protobuf**（`pbbp2`），类型有 EVENT / PING / PONG / CARD 等；需要：
   - 收到 PING 回 PONG；
   - 收到 EVENT 后**回 ACK 帧**（同 `message_id`，带 code）；
   - 大事件按 `sum/seq` **分片重组**。
3. 长连接与 Webhook 是事件订阅的两种投递方式（飞书后台选择），需要 app 开启长连接。

**结论**：从零实现帧协议风险高。**推荐用飞书官方 Go SDK** 的 WS 客户端（`larkws`），它封装了上述握手/心跳/ACK/分片/重连。
以下设计以官方 SDK 为准；SDK 版本一旦确定要**锁版本**。

---

## 2. 现有代码接口（已就位，尽量少改）

| 位置 | 现状 |
|---|---|
| `adapters/go/internal/eventsource/source.go` | 已定义 `Source{ Name(); Start(ctx, onEvent func(raw []byte) error) error; Stop() }` |
| `adapters/go/internal/platform/platform.go` | `Platform` 接口含 `LongConn() eventsource.Source` |
| `adapters/go/internal/platform/feishu/platform.go` | 飞书 `LongConn()` 目前返回 `nil`；`Platform` 已存 `appID/botOpenID/verificationToken/encryptKey/client` |
| `adapters/go/internal/adapter/adapter.go` | `HandleEvent(ctx, p, raw, headers)` = `VerifyRequest` → `Normalize` → 门控/转发 |
| `adapters/go/internal/adapter/server.go` | `POST /{platform}/events`（Webhook） |
| `adapters/go/main.go` | 建平台、起 HTTP、起投递循环；**未启动任何事件源** |
| `adapters/go/internal/config/config.go` | 有 `Platforms`、`AppID/Secret`、`EncryptKey`、`BotOpenID`、`LARK_API_BASE`；**无 `Mode`** |
| `go.mod` | **无第三方依赖**（引入 SDK 会改此处） |

---

## 3. 设计

### 3.1 事件源：`LarkWSSource`

新增 `adapters/go/internal/platform/feishu/longconn.go`：

```go
type LarkWSSource struct {
    appID, appSecret string
    verificationToken, encryptKey string
    logLevel string
    // 由 Start 构造/持有
    client *larkws.Client
}

func (s *LarkWSSource) Name() string { return "feishu-larkws" }

func (s *LarkWSSource) Start(ctx context.Context, onEvent func(raw []byte) error) error {
    dispatcher := larkevent.NewEventDispatcher(s.verificationToken, s.encryptKey).
        OnP2MessageReceiveV1(func(_ context.Context, ev *larkim.P2MessageReceiveV1) error {
            msg := receiveEventFromSDK(ev)              // 映射到本项目结构（§3.2）
            raw, err := json.Marshal(envelopeFor(msg))  // 明文 Envelope（§3.3）
            if err != nil { return err }
            return onEvent(raw)                         // 处理成功才返回 nil → SDK 才 ACK 200
        })
    s.client = larkws.NewClient(s.appID, s.appSecret,
        larkws.WithEventHandler(dispatcher),
        /* 可选：larkws.WithLogLevel(...) */)
    return s.client.Start(ctx)   // 阻塞；内部心跳/重连/分片/ACK
}

func (s *LarkWSSource) Stop() { if s.client != nil { s.client.Close() } }
```

要点：
- **成功才返回 nil**：`onEvent` 返回错误 → SDK 回非 200 → 飞书重投；Host `inbound_events` 去重兜底（与 Webhook 返回 503 语义一致）。
- `Start` 返回错误表示事件源异常退出；由 `main` 负责**退避重启**（不要在 `Start` 内部吞掉）。
- SDK API 名称（`larkws.NewClient` / `larkevent.NewEventDispatcher` / `OnP2MessageReceiveV1`）**以所选版本 `go doc` 为准**。

### 3.2 SDK 事件 → 本项目 `ReceiveEvent`

`receiveEventFromSDK(ev *larkim.P2MessageReceiveV1) *ReceiveEvent` 做显式字段映射（不靠 marshal 往返，避免 tag 差异）：

| 本项目 `ReceiveEvent` | SDK（约） |
|---|---|
| `Sender.SenderType` / `SenderID.OpenID` / `SenderName` | `ev.Event.Sender.SenderType` / `.SenderId.OpenId` / `.SenderName` |
| `Message.MessageID/ChatID/ChatType/MessageType/Content` | `ev.Event.Message.MessageId` / `ChatId` / `ChatType` / `MessageType` / `Content` |
| `Message.CreateTime` | `ev.Event.Message.CreateTime`（字符串毫秒） |
| `Message.RootID/ParentID/ThreadID` | `ev.Event.Message.RootId` / `ParentId` / `ThreadId` |
| `Message.Mentions[].Key/ID.OpenID` | `ev.Event.Message.Mentions[].Key` / `.Id.OpenId` |

- 指针字段要判空（SDK 多为 `*string`）。
- 建议**先写一个映射单测**（构造 SDK 结构体 → 断言我们的 `ReceiveEvent`），这是长连接唯一能离线验证的部分。

### 3.3 明文 `Envelope` 契约（关键）

事件源交给适配器的 `raw` 必须是**明文 Envelope JSON**（含 `header.event_type` 与 `event`）：
- 复用现有 `feishu.Normalize(raw, headers)`；`Normalize` 内部 `payload()` 在无 `encrypt` 字段时**原样返回**，因此明文可直接解析。
- **长连接不走 `VerifyRequest`**：WS 会话已由 SDK 用凭据鉴权，签名/token 是 Webhook 的概念。

因此适配器新增一个入口（隔离"传输鉴权"与"业务处理"）：

```go
// server.go 的 Webhook 路径不变：VerifyRequest → HandleEvent
// 新增（长连接/事件源）：跳过 VerifyRequest，直接 Normalize
func (a *Adapter) HandleSourceEvent(ctx context.Context, p platform.Platform, raw []byte) (HandleResult, error)
```

内部与 `HandleEvent` 共用 `normalize → 门控 → Host 转发 → mechanical` 同一段（抽一个私有 `handleMessage`），避免两份语义。

### 3.4 `Platform.LongConn()` 提供实现

- `feishu.NewPlatform` 时把 `appID/appSecret/encryptKey/logLevel` 存进 `Platform`（现在 `appSecret` 在 `client` 内部，需提到字段）。
- `LongConn()` 返回 `&LarkWSSource{...}`；无凭据（`appID==""` 或 `appSecret==""`）时返回 `nil`，由 `main` 报错（见 §3.5）。
- 其余平台（钉钉/Slack）继续返回 `nil`，直到各自实现。

### 3.5 `main.go` 按模式启动（含重连）

```
cfg.Mode == "ws":
  for each platform:
     src := p.LongConn()
     if src == nil → log.Fatalf("%s 平台不支持长连接（未实现/缺凭据）", p.Name())
     go restartLoop(ctx, p, src)      // 退避：1s→2s→4s…封顶 30s；ctx.Done 退出
  HTTP 仍启动，但只挂 /healthz（Webhook 路由可保留不使用，或按模式不挂载）
otherwise (webhook, 默认):
  现状不变：HTTP server 挂 /{platform}/events + 投递循环
投递循环（RunDeliveryLoop）两种模式都启动，不受影响
```

`restartLoop`：调用 `src.Start(ctx, onEvent)`；返回错误则记日志、退避、`src.Stop()` 后重试；`ctx.Done` 时返回。

### 3.6 配置

`config.go` 增：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADAPTER_MODE` | `webhook` | `webhook` \| `ws` |
| `LARK_LOG_LEVEL`（可选） | — | 传给 SDK 的日志级别，排障用 |

`.env.example` / `adapters/go/README.md` 同步。长连接需在飞书后台**开启长连接事件订阅**（与 Webhook 二选一）。

### 3.7 依赖与镜像

- `go.mod` 增加 `github.com/larksuite/oapi-sdk-go/v3`（**锁定版本**）。
- `adapters/go/Dockerfile`：构建前加 `COPY go.mod go.sum ./` + `RUN go mod download`，再 `COPY . .`。
- 只读诊断边界不变：SDK 只用于**收发事件/发送消息**，不引入任何写业务能力。

---

## 4. 与其它部分的关系

- **门控**：长连接事件同样走 Host `planRoute`（@ 门控单点，OQ-39），适配器不重复判定。
- **去重**：飞书重投靠 Host `inbound_events` 唯一键，不需要在长连接侧另做。
- **投递发送**：不变（`Platform.Send` + Host claim/result）。长连接只影响"事件怎么进来"。
- **Webhook 保留**：`ADAPTER_MODE=webhook` 是默认与回退；两种入口可共存但同一 app 建议只选一种（否则双投递，靠去重兜底）。

---

## 5. 测试清单

**可离线（必须做）**
1. `receiveEventFromSDK` 映射单测：普通群消息、带 mentions、p2p、`root_id/thread_id/parent_id`、`create_time`。
2. `Platform.LongConn()`：有凭据返回非 nil、缺凭据返回 nil。
3. `Adapter.HandleSourceEvent`：跳过 `VerifyRequest`（即使配置了 `EncryptKey`/`VerificationToken` 也能处理明文 Envelope）；转发 Host 成功 → `forwarded`；Host 错误 → 返回 error（模拟不 ACK）。
4. `main` 的 `restartLoop` 退避：用 fake `Source`（`Start` 前两次返回错误）断言重试次数与结束行为。

**需真实凭据（人工，写步骤）**
5. 飞书后台开启长连接 → 群里 @机器人 → 建调查并在飞书收到报告；断网/重启 Adapter 后能自动重连。

---

## 6. 实施顺序（一次一件，每步跑 typecheck/test）

1. **配置 + 依赖**：`ADAPTER_MODE`/`LARK_LOG_LEVEL`；`go.mod` 引入并锁 SDK 版本；Dockerfile 加 `go mod download`；`go build ./...` 通过。
2. **事件映射**：`receiveEventFromSDK` + 单测（§5.1）。
3. **事件源**：`LarkWSSource` 骨架 + `Platform.LongConn()`（§5.2）。
4. **适配器入口**：抽 `handleMessage`，新增 `HandleSourceEvent`（跳过 Verify）+ 单测（§5.3）。
5. **main 接线**：`restartLoop` + 模式分支 + 优雅停止 + 单测（§5.4）。
6. **人工验证步骤**写入 `adapters/go/README.md`（§5.5）。
7. **文档**：`docs/feishu-channel.md` 补长连接小节；`backlog.md` H5、`roadmap.md`、`handover-technical-plan.md §5.1`/§6、`session-handover.md` 标记 S3 完成；`open-questions.md` 登记 S3 结论（建议 OQ-40，记录 SDK 版本与"成功才 ACK"语义）。

---

## 7. 风险与已知坑

| 风险 | 缓解 |
|---|---|
| 官方 SDK API/字段随版本变 | **锁版本**；映射单测兜住字段差异 |
| 长连接与 Webhook 同时开启 → 双投递 | 同 app 二选一；Host 去重兜底 |
| `EncryptKey` 配置下误走 `VerifyRequest` | `HandleSourceEvent` 明确跳过 Verify（§3.3） |
| `Start` 内部已重连却又在 main 重试 → 双重连接 | 约定：`Start` 返回即视为本次会话结束，main 才重试；不在 `Start` 内自旋 |
| 无凭据无法端到端验证 | 只保证单测 + 转发路径；真机步骤文档化，不声称"已验证线上" |
| 引入 SDK 膨胀镜像/构建变慢 | 首次构建多下载；可接受；锁版本避免漂移 |

---

## 8. 决策（实现时不再重新讨论）

- **用官方 SDK**，不自研 WS 帧协议。
- **明文 Envelope** 作为 `Source → Adapter` 契约；**长连接跳过 `VerifyRequest`**。
- **成功才 ACK**（handler 返回 nil），失败让平台重投，由 Host 去重。
- **`ADAPTER_MODE` 全局切换**，默认 `webhook`；Webhook 保留为回退。
- 每平台**独立** `LongConn()`；缺实现/缺凭据 → 启动报错，不静默。

---

## 9. 完成后下一步

S4：弃用 Host 内直连（删 `TD_FEISHU_DIRECT`、`src/integrations/feishu` 的 SDK 路径、`gateway.ts`），
注意 `src/entrypoints/demo.ts` 仍用 `createFeishuGateway`，需保留一条不依赖 SDK 的 demo 路径。
