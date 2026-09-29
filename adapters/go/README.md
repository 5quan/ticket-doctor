# Go 接入适配器

企业 IM / Webhook 的**外部接入层**（对应平台文档 `03-外部接入层`）。它把飞书事件转换成
Host Web Channel 能理解的请求，再把 Host 的出站投递发送回飞书。

**明确不做**：不启动 Agent、不管会话、不做队列与并发控制、不执行工具。

```
飞书事件 ──POST /feishu/events──► Go 适配器 ──POST /api/agent/message──► Host
Host 待发送记录 ◄──POST /deliveries/claim── Go 适配器 ──► 飞书发送 ──► POST /deliveries/:id/result
```

长连接模式（`ADAPTER_MODE=ws`）把第一跳换成官方 SDK 的 WebSocket（无需公网回调）：

```
飞书 ──WS(larkws)──► Go 适配器 ──POST /api/agent/message──► Host
```

## 运行

```bash
cd adapters/go
go build ./...
go test ./...

ADAPTER_ADDR=0.0.0.0:3002 \
HOST_API_BASE=http://127.0.0.1:3000/api/agent \
LARK_APP_ID=... LARK_APP_SECRET=... LARK_VERIFICATION_TOKEN=... LARK_BOT_OPEN_ID=ou_... \
go run .
```

飞书后台把事件回调地址指到 `http(s)://<adapter>/feishu/events`。已实现：URL 校验（`challenge`）、Verification Token 校验、
Encrypt Key 签名校验（`X-Lark-Signature = sha256(timestamp+nonce+encryptKey+body)`）与事件解密。
若要免公网回调，见下方「长连接模式」。

## 长连接模式（`ADAPTER_MODE=ws`）

无需公网回调：用官方 SDK（`github.com/larksuite/oapi-sdk-go/v3`，锁定版本）的 WS 客户端接收事件。
前提：**飞书后台事件订阅选择“使用长连接接收事件”**（同一应用与 Webhook 二选一；两种都开会双投递，靠 Host 去重兜底）。

```bash
ADAPTER_MODE=ws \
HOST_API_BASE=http://127.0.0.1:3000/api/agent \
LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx LARK_BOT_OPEN_ID=ou_xxx \
LARK_LOG_LEVEL=info \
./adapter
```

要点：

- SDK 负责握手/心跳/ACK/分片/重连；适配器只在 `Start` 返回后由 `main` 退避重连（1s→…→30s）。
- **成功才 ACK**：事件处理返回 `nil` 才回 200；Host 不可用返回 error→非 200，飞书重投，Host `inbound_events` 去重兜底。
- 长连接不走 `VerifyRequest`（签名/Verification Token 是 Webhook 概念）；加解密配置在长连接下被忽略。
- 缺 `LARK_APP_ID`/`LARK_APP_SECRET` 或平台未实现长连接 → **启动直接报错**（不静默）。

### 人工验证步骤（需真实凭据）

无凭据时只能跑单测（映射/凭据/入口/退避）；下列步骤需在真实飞书应用上人工执行：

1. 飞书开放平台 → 应用 → 事件与回调：订阅方式选“长连接”，添加事件 `接收消息 im.message.receive_v1`；确认应用已开通长连接权限。
2. 只设 `ADAPTER_MODE=ws` 启动适配器（**不要**同时配 Webhook 回调地址，避免双投递）；日志出现 `已启动长连接事件源：platform=feishu source=feishu-larkws`。
3. 群里 @机器人 发一条报错描述：飞书内应收到预检报告；Host 产生对应调查（可查 Web 页面/会话库）。
4. 断开网络或重启适配器：日志应按退避重连，恢复后再次 @机器人仍可正常收发。
5. 反向验证“成功才 ACK”：暂时停掉 Host（适配器日志报“不 ACK，等待重投”），恢复 Host 后飞书重投的事件应只处理一次（Host 去重兜底）。

> 本仓库无法在无凭据环境验证线上链路；上述步骤须由具备飞书应用的执行者人工确认。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADAPTER_ADDR` | `0.0.0.0:3002` | 监听地址 |
| `ADAPTER_MODE` | `webhook` | 事件接入模式：`webhook`（平台回调）\| `ws`（飞书长连接，无需公网回调） |
| `HOST_API_BASE` | `http://127.0.0.1:3000/api/agent` | Host Web Channel 基址 |
| `HOST_TIMEOUT_MS` | `5000` | 调用 Host 超时 |
| `LARK_APP_ID` / `LARK_APP_SECRET` | — | 飞书应用凭证（发送用） |
| `LARK_VERIFICATION_TOKEN` | — | 事件回调校验 token |
| `LARK_ENCRYPT_KEY` | — | 配置后校验 `X-Lark-Signature` 并 AES-256-CBC 解密 `encrypt` 事件体 |
| `LARK_BOT_OPEN_ID` | — | 机器人 open_id；未配置时群聊新会话由 Host 门控 fail-closed 拒绝（线程回复不受影响） |
| `LARK_API_BASE` | `https://open.feishu.cn/open-apis` | OpenAPI 基址（测试可覆盖） |
| `LARK_LOG_LEVEL` | — | 长连接模式传给飞书 SDK 的日志级别（`debug`/`info`/`warn`/`error`），排障用 |
| `ADAPTER_POLL_INTERVAL_MS` | `1000` | 投递轮询间隔 |

> `ADAPTER_REQUIRE_MENTION` 已废弃：@ 门控由 Host 单点决策（`ADAPTER_REQUIRE_MENTION` 不再读取）。

## 职责边界

| 组件 | 职责 |
|---|---|
| Go 适配器 | 平台事件接入、token/参数校验、归一化转发 Host（含 mechanical 发送）、平台消息发送；**不做 @ 门控** |
| Host Web Channel | 接收消息、@ 门控与路由（`planRoute` 单点）、原子入队、调度、持久化、SSE |
| Agent Runner | 由 Host 启动子进程执行诊断，只上报结构化结果 |

失败处理：平台签名/token 错误 → 拒绝；Host 不可用 → 返回 5xx 让平台重投；
发送结果不确定（超时/网络中断）→ 上报 `uncertain`，不做无限重试。
