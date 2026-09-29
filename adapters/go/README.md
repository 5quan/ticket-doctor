# Go 接入适配器

企业 IM / Webhook 的**外部接入层**（对应平台文档 `03-外部接入层`）。它把飞书事件转换成
Host Web Channel 能理解的请求，再把 Host 的出站投递发送回飞书。

**明确不做**：不启动 Agent、不管会话、不做队列与并发控制、不执行工具。

```
飞书事件 ──POST /feishu/events──► Go 适配器 ──POST /api/agent/message──► Host
Host 待发送记录 ◄──POST /deliveries/claim── Go 适配器 ──► 飞书发送 ──► POST /deliveries/:id/result
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

飞书后台把事件回调地址指到 `http(s)://<adapter>/feishu/events`（也支持长连接方式，
当前实现为 Webhook 回调）。已实现：URL 校验（`challenge`）、Verification Token 校验、
Encrypt Key 签名校验（`X-Lark-Signature = sha256(timestamp+nonce+encryptKey+body)`）与事件解密。

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
