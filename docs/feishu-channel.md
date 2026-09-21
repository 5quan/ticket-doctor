# 飞书渠道设计

结论先行：**飞书有成熟方案，且本机 `/opt/miniclaw` 就有一份生产级实现可参考。**
不需要自己造轮子，也不需要用正则猜会话归属。本项目采用官方 SDK 长连接 + 结构化会话标号的组合。

## 一、接入方式：长连接，不需要公网回调

官方 `@larksuiteoapi/node-sdk` 提供 `WSClient` + `EventDispatcher`，应用在飞书后台选择
「使用长连接接收事件」即可，无需暴露公网地址、无需处理回调验签与重放。

```ts
const dispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => { /* 处理消息 */ },
});
const ws = new Lark.WSClient({ appId, appSecret });
await ws.start({ eventDispatcher: dispatcher });
```

本项目只在 `src/integrations/feishu/client.ts` 里接触 SDK，业务层看到的是归一化后的事件。

## 二、miniclaw 已经验证过的做法（可直接借鉴的部分）

| 问题 | miniclaw 的做法 | 本项目对应 |
|---|---|---|
| 事件重复投递 | `channel_inbox` 表 `UNIQUE(provider, account_id, external_message_id)` | `inbound_events` 同款唯一约束 |
| 一个输入一次执行 | `turn_runs` 表 `idempotency_key UNIQUE` + 租约 | `runs` / `attempts` + `generation` 代次 |
| 出站可靠性 | `channel_outbox` + 平台消息 ID + 「不确定」状态 | `deliveries` + `uncertain` 状态 |
| 群聊是否必须 @ | `feishu-mention-gate.ts` 纯函数，**botOpenId 未知时 fail-closed** | `mention-gate.ts` 同语义 |
| 会话归属 | 卡片按钮 value 带 `sourceJid/targetJid/messageId`；`reply_in_thread` 锚定 root | 回复正文带稳定标号 `[TD-xxxxxxxx]` |
| 线程内免 @ | `feishu-conversation-policy.ts` 的 `activeContext` 分支 | `conversationActive` 判定 |

特别值得继承的两条经验：

1. **fail-closed**：机器人 `open_id` 未知时，旧实现「默认放行」会让「必须 @」在群里静默失效。
   miniclaw 把它改成拒绝，并用单测锁住语义。本项目 `tests/unit/mention-gate.test.ts` 同款。
2. **结构化标号而非正则猜测**：卡片按钮和消息锚点都携带不可变身份，不用自然语言猜归属。

## 三、本项目的路由规则

一条群聊消息按固定优先级判定归属，任一步命中即停止：

```text
1. 正文含 [TD-xxxxxxxx]        → 精确续接（且必须同一群聊，防跨群串消息）
2. root_id / thread_id 命中     → 续接该线程的调查
3. parent_id 映射到历史消息     → 回复机器人消息时归入原调查
4. 被 @ 且无归属                → 新建调查，生成新标号
5. 其余                         → 无法关联，不猜；仅在“回复机器人却关联不上”时提示
```

- 每条机器人回复末尾都带 `[TD-xxxxxxxx]`，用户引用任意历史回复即可继续。
- 不同群聊的调查**不自动合并**：所有查找都带 `chat_id`。
- 群聊新会话默认必须 `@机器人`；已有线程的回复可免 @（可用 `FEISHU_REQUIRE_MENTION=false` 关闭）。

## 四、为什么这样不绕弯路

- 不用自己维护 WebSocket 协议、重连、心跳、事件签名 —— SDK 负责。
- 不用正则解析自然语言来猜“这是不是同一个人问的同一个 Bug” —— 标号 + 线程字段负责。
- 不用把发送可靠性建在内存队列上 —— `deliveries` 表 + 状态机负责，“结果不确定”有独立状态。
- 权限最小化：群聊默认必须 @，且只注册需要的 `im.message.receive_v1` 事件。
