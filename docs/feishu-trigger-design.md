# 飞书触发链路修复（门控单点化 + `-help` 机械回复）设计方案

> 状态：**设计定稿，待实现**。范围小、风险低，建议在 S3 长连接之前先做（长连接复用同一 `HandleEvent`，修好后不必再动门控）。
> 遵守 `docs/handover.md §7` 的 DoD：基线 → 一次一件 → typecheck/test（含 Go）→ 文档 → commit/push。

---

## 0. 问题（已核对代码）

| 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|
| **P0** | 线程内回复免 @ 丢失 | `adapters/go/internal/adapter/adapter.go` `HandleEvent`：`if cfg.RequireMention && chatType=="group" && !MentionedBot { ignore }`，**不看会话上下文** | 用户在话题/线程里不带 @ 回复报告 → 被适配器丢弃，消息到不了 Host → **多轮追问断裂**（与 `.env.example` 注释"线程内回复免 @"矛盾） |
| **P1** | `-help` 机械回复丢失 | Host `/api/agent/message` 无 `-help` 分支；旧 `src/integrations/feishu/gateway.ts` 有 `sendMechanical(HELP_TEXT)` | `-help` 被当作 Bug 建调查、跑模型 |
| **P1** | botOpenID 未配置时"任意 mention 都算被 @" | `platform/feishu/event.go` `IsBotMentioned`：`botOpenID=="" → len(mentions)>0` | 群里 @ 别人也触发 → fail-closed 变 fail-open |
| **P2** | 门控有两份（适配器 + Host `planRoute`） | `router.ts:96` 与 `adapter.go` 各一套 | 语义漂移；应单一权威 |
| **P2** | 适配器配置是全局单份 | `config.go` + `BuildPlatforms` | 多飞书应用要拆配置（本次不做，登记 follow-up） |

---

## 1. 目标与验收

1. **门控单点化**：@ 门控只在 Host 决策；适配器只做"协议解析 + 归一化 + 转发 + 发送"。
2. 群聊**新会话**未 @ 机器人 → 拒绝（保持 fail-closed）；**线程内/带标号回复**免 @，能正常续接。
3. `botOpenID` 未知时群聊新会话**一定不能**通过（真 fail-closed），线程回复仍可用。
4. `-help` 返回机械使用说明，**不建调查、不跑模型**。
5. 语义与旧 Host 直连路径（`gateway.ts` 的 `conversationActive` + `-help`）一致。
6. 不新增数据库表/迁移。

**非目标**：长连接（S3）、多平台配置拆分、钉钉/Slack 实装。

---

## 2. 设计

### 2.1 门控权威下沉到 Host

- **适配器删掉 mention 丢弃**：`HandleEvent` 不再因为"群聊未 @"就忽略；它只负责
  `Normalize`（非文本/空文本忽略）→ 带 `mentionedBot` 转发 Host。
- Host `planRoute` 保持并明确为唯一权威（逻辑已在 `src/intake/router.ts`）：
  1. 显式指定 / 标号 / `rootId` / `threadId` / `parentId` 命中调查 → **续接，免 @**；
  2. 未命中且是群聊、且 `requireMention`、且未 @ → 拒绝（fail-closed）；
  3. 其余 → 新建。
- Host 的 `requireMention` 取现有 `AppConfig.feishu.requireMention`（默认 true），由 `routeInbound` 透传给 `planRoute`。

### 2.2 `mentionedBot` 的 fail-closed 语义

`platform/feishu/event.go`：

```go
// 旧：botOpenID=="" 时 len(mentions)>0
// 新：无法验证机器人身份时，一律视为"未被 @"（保守）；由 Host 拒绝群聊新会话。
func IsBotMentioned(mentions []Mention, botOpenID string) bool {
    if botOpenID == "" {
        return false
    }
    for _, m := range mentions {
        if m.ID.OpenID == botOpenID {
            return true
        }
    }
    return false
}
```

- 效果：`botOpenID` 未知 → 群聊新会话必被 Host 拒绝；**线程内回复按上下文续接，不受影响**。
- 建议适配器启动时用已有 client 拉一次 `GET /open-apis/bot/v3/info/` 自动补 `BotOpenID`（tenant token 已在 `platform/feishu/client.go` 实现）；拉不到且未显式配置时打 warning，行为即上述保守语义。

### 2.3 `-help` 机械回复（Host 出文案，适配器发送）

理由：产品文案属诊断产品，不属传输适配器；且便于将来按平台定制。

数据流：

```text
飞书 "-help"（门控通过）
  → 适配器 Normalize/转发
  → Host /api/agent/message：planRoute 识别 -help → 返回 { decision:{kind:"mechanical"}, mechanicalText }
  → 适配器 p.Send(reply 到原消息)
```

**不改 `deliveries` 表**（其 `investigation_id NOT NULL`，机械回复不建调查）。

判定顺序（必须与旧行为一致）：

1. 先算"是否续接已有调查"（含 `conversationActive` 语义）；
2. 未命中时应用 @ 门控（未 @ 的新群聊会话 → 拒绝，`-help` 也不例外）；
3. 通过门控后，若 `text.trim().toLowerCase() === "-help"` 且来源非 web → 机械回复（不建消息、不建轮次）。

`HELP_TEXT` 从 `src/integrations/feishu/gateway.ts` 抽到共享模块（建议 `src/intake/help.ts` 或 `src/domain/help.ts`），gateway 与新入口共用，避免两份文案。

---

## 3. 接口改动清单（文件级）

### 3.1 Go 适配器

| 文件 | 改动 |
|---|---|
| `internal/platform/feishu/event.go` | `IsBotMentioned`：空 `botOpenID` → `false`；补/改单测 |
| `internal/adapter/adapter.go` | `HandleEvent` **删除** mention 丢弃块；新增 mechanical 分支：`result.Decision.Kind=="mechanical"` → `p.Send(ctx, hostapi.Delivery{ChatID, TargetMessageID: message.ExternalMessageID, Content: result.MechanicalText})` → 返回 `{Status:"mechanical_reply_sent"}`；发送失败 → 返回 `ignored/mechanical_reply_failed`（best-effort，不重试） |
| `internal/hostapi/types.go` | `SubmitResult` 增 `MechanicalText string \`json:"mechanicalText"\`` |
| `internal/config/config.go` | 删除 `RequireMention` 字段与 `ADAPTER_REQUIRE_MENTION` 解析（门控已上移 Host）；启动日志提示 |
| `internal/platform/feishu/platform.go` | 可选：启动时拉 `bot/v3/info` 补 `BotOpenID` |
| `internal/adapter/adapter_test.go` | 改"未 @ 群消息"断言（不再丢弃，应转发）；新增 mechanical 回复用例；改 `IsBotMentioned` 用例 |

### 3.2 Host（TS）

| 文件 | 改动 |
|---|---|
| `src/domain/types.ts` | `IntakeDecision` 增 `{ kind: "mechanical"; text: string }` |
| `src/intake/router.ts` | `planRoute` 增 `requireMention: boolean` 入参；判定顺序见 §2.3；返回 `{ decision:"mechanical", text }` 计划；`IntakeResult` 增 `mechanicalText?: string`；`routeInbound` 从 `config.feishu.requireMention` 传参 |
| `src/intake/help.ts`（新） | 导出 `HELP_TEXT`；`gateway.ts` 改为复用 |
| `src/storage/store.ts` | `InboundPlan` 增 mechanical 变体；`acceptInbound` 命中 mechanical 时：去重照旧、`finishInbound(inboundId,"processed")`、**不建 message/run**，返回 `{ accepted:false, decision:{kind:"mechanical"}, mechanicalText }` |
| `src/host/server.ts` | `/api/agent/message`：mechanical 分支返回 `{ accepted:false, decision, mechanicalText }`（在 duplicate 分支之后、unroutable 之前） |
| `tests/unit/router.test.ts`、`tests/unit/host-queue.test.ts`、`tests/integration/host-api.test.ts` | 见 §5 |

---

## 4. 行为矩阵（实现与测试的对照表）

| 场景 | 门控 | 结果 |
|---|---|---|
| 群聊新会话，被 @ | 通过 | 新建调查 + 跑 |
| 群聊新会话，未 @ | 拒绝 | `unroutable`（fail-closed） |
| 群聊线程回复/带 `[TD-xxxx]`，未 @ | 通过（命中调查） | 续接 + 跑 |
| p2p 私聊，未 @ | 通过 | 新建/续接 |
| `botOpenID` 未知，群聊新会话 | 拒绝 | `unroutable`（不因"有 mention"误放行） |
| `botOpenID` 未知，群聊线程回复 | 通过（上下文命中） | 续接 |
| `-help`，被 @（或被门控放行） | 通过 | 机械回复，不建调查 |
| `-help`，群聊新会话未 @ | 拒绝 | `unroutable`，不回机械文案 |
| `requireMention=false` + 群聊未 @ | 通过 | 新建调查 |

---

## 5. 测试清单（必须新增/修改）

**Go**
1. `IsBotMentioned("")` → `false`（改现有 `TestMentionDetectionFailsClosedWithoutBotID` 断言）。
2. 适配器：群聊未 @ 的消息**会被转发**（fake host 返回 accepted），不再 `ignored`。
3. 适配器：fake host 返回 `decision.kind="mechanical"` + `mechanicalText` → 适配器对 fake lark 调用 reply，返回 `mechanical_reply_sent`；发送失败 → `ignored/mechanical_reply_failed`。

**TS 单元（`router.test.ts`）**
4. 群聊新会话未 @ → `unroutable`（保持）。
5. 群聊线程回复未 @（`threadId` 命中调查）→ `continue_investigation`（**锁 P0 修复**）。
6. 带 `[TD-xxxx]` 未 @ → 续接（保持）。
7. `-help` 群聊被 @ → `mechanical`，且 `store.getInvestigation` 无新增、无 run。
8. `-help` 群聊新会话未 @ → `unroutable`（门控优先）。
9. `-help` 在活跃会话（线程命中）未 @ → `mechanical`。
10. `requireMention=false` + 群聊未 @ → 新建。

**集成（`host-api.test.ts`）**
11. `POST /api/agent/message` `{provider:"feishu",chatType:"group",mentionedBot:true,text:"-help"}` → `decision.kind="mechanical"`、`mechanicalText` 非空、`investigations` 未增加。
12. 既有 web/续接/取消等用例仍通过。

---

## 6. 实施顺序（小步，一次一件）

1. `IsBotMentioned` fail-closed + Go 单测（最小、独立）。
2. 抽取 `HELP_TEXT` 共享模块（不动行为）。
3. Host：`planRoute` 加 `requireMention` 入参 + mechanical 计划 + `acceptInbound` 分支 + router 单测。
4. Host `/api/agent/message` 返回 `mechanicalText` + 集成测试。
5. 适配器：删 mention 丢弃 + mechanical 发送分支 + Go 测试。
6. 删适配器 `RequireMention` 配置，更新 `.env.example`、`adapters/go/README.md`、`docs/feishu-channel.md`。
7. 文档：`open-questions.md` 登记"门控单点化"结论；`handover-technical-plan.md §5.2` 注明；`interface.md` 若提到门控位置则同步。

每步跑 `npm run typecheck && npm test`（第 1/5/6 步加 `npm run test:go`）。

---

## 7. 兼容、回滚与风险

- **无迁移**，纯代码改动，回滚即 revert。
- 兼容性：旧 Host 直连路径（`TD_FEISHU_DIRECT=true`）仍走 `gateway.ts`，行为不变；本方案只改"经适配器"的新路径。S4 清理直连时，`gateway.ts` 的 `-help`/`conversationActive` 已被 Host 吸收，删除安全。
- 风险：`requireMention` 目前取自 `config.feishu`（飞书专属）。多平台后应改为按 provider 的配置（登记 follow-up）。
- 风险：`-help` 机械回复不落库、best-effort；飞书重投时 Host 去重会挡住第二次发送——与旧行为一致，可接受。

---

## 8. 与长连接（S3）的衔接

长连接实现（`eventsource.Source`）只是换事件入口，事件最终仍走 `Adapter.HandleEvent` 与 Host `planRoute`。
本方案完成后，S3 **不需要再改门控**，只需：
- `main.go` 按 `ADAPTER_MODE=webhook|ws` 启动 source；
- 长连接事件同样调用 `HandleEvent`（`Normalize` 复用）；
- 处理成功后再 ACK（ACK 由官方 SDK 负责）。
