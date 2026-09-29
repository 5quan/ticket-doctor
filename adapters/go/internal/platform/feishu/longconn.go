// 飞书长连接（S3）：用官方 SDK 的 WS 客户端接收事件，映射为本项目 Envelope 明文契约。
//
// 设计见 docs/adapter-longconn-design.md：SDK 负责握手/心跳/ACK/分片/重连；
// 本层只做「SDK 事件结构 → 本项目 ReceiveEvent → 明文 Envelope JSON」，与 Webhook 归一化共用。
package feishu

import (
	"context"
	"encoding/json"
	"strings"
	"sync"

	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	larkdispatcher "github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

// imMessageReceiveEventType 是飞书接收消息事件的 event_type；Webhook 归一化据此过滤。
const imMessageReceiveEventType = "im.message.receive_v1"

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// receiveEventFromSDK 把官方 SDK 的 P2MessageReceiveV1 显式映射为本项目 ReceiveEvent。
// 不靠 JSON tag 往返，避免 SDK 字段/tag 随版本漂移。
//
// 注意：SDK 的 EventSender 无 sender_name 字段，故 SenderName 留空（仅影响展示，不影响路由）。
func receiveEventFromSDK(ev *larkim.P2MessageReceiveV1) *ReceiveEvent {
	if ev == nil || ev.Event == nil {
		return nil
	}
	out := &ReceiveEvent{}

	if s := ev.Event.Sender; s != nil {
		sender := &Sender{SenderType: derefString(s.SenderType)}
		if s.SenderId != nil {
			sender.SenderID.OpenID = derefString(s.SenderId.OpenId)
		}
		out.Sender = sender
	}

	if m := ev.Event.Message; m != nil {
		message := &Message{
			MessageID:   derefString(m.MessageId),
			ChatID:      derefString(m.ChatId),
			ChatType:    derefString(m.ChatType),
			MessageType: derefString(m.MessageType),
			Content:     derefString(m.Content),
			CreateTime:  derefString(m.CreateTime),
			RootID:      derefString(m.RootId),
			ParentID:    derefString(m.ParentId),
			ThreadID:    derefString(m.ThreadId),
		}
		for _, mention := range m.Mentions {
			if mention == nil {
				continue
			}
			item := Mention{Key: derefString(mention.Key), Name: derefString(mention.Name)}
			if mention.Id != nil {
				item.ID.OpenID = derefString(mention.Id.OpenId)
			}
			message.Mentions = append(message.Mentions, item)
		}
		out.Message = message
	}

	return out
}

// envelopeFor 把内部事件包成明文 Envelope（长连接不走加密/签名，故无 encrypt/token）。
func envelopeFor(event *ReceiveEvent) Envelope {
	return Envelope{
		Header: EventHeader{EventType: imMessageReceiveEventType},
		Event:  event,
	}
}

// sourceEventFromSDK 生成交给适配器的明文 Envelope JSON（Source → Adapter 契约）。
func sourceEventFromSDK(ev *larkim.P2MessageReceiveV1) ([]byte, error) {
	return json.Marshal(envelopeFor(receiveEventFromSDK(ev)))
}

// LarkWSSource 实现 eventsource.Source：官方 SDK 的飞书长连接事件源。
//
// 约定（S3 决策 4）：Start 返回即视为本次会话结束，不在内部自旋；由调用方（main）退避重启。
// 成功才 ACK：onEvent 返回 nil → SDK 回 200；返回 error → SDK 回 500，飞书重投，Host inbound_events 去重兜底。
type LarkWSSource struct {
	appID             string
	appSecret         string
	verificationToken string
	encryptKey        string
	logLevel          string

	mu     sync.Mutex
	client *larkws.Client
}

// Name 事件源标识。
func (s *LarkWSSource) Name() string { return "feishu-larkws" }

// Start 建立长连接并持续投递事件，阻塞直到 ctx 取消或 SDK 会话结束。
// 每次调用新建一个 SDK Client（SDK 的 Client 终态后不可复用）。
func (s *LarkWSSource) Start(ctx context.Context, onEvent func(raw []byte) error) error {
	eventDispatcher := larkdispatcher.NewEventDispatcher(s.verificationToken, s.encryptKey).
		OnP2MessageReceiveV1(func(_ context.Context, ev *larkim.P2MessageReceiveV1) error {
			raw, err := sourceEventFromSDK(ev)
			if err != nil {
				return err
			}
			return onEvent(raw)
		})

	opts := []larkws.ClientOption{larkws.WithEventHandler(eventDispatcher)}
	if level, ok := parseLogLevel(s.logLevel); ok {
		opts = append(opts, larkws.WithLogLevel(level))
	}
	client := larkws.NewClient(s.appID, s.appSecret, opts...)

	s.mu.Lock()
	s.client = client
	s.mu.Unlock()

	return client.Start(ctx)
}

// Stop 主动关闭当前 SDK Client（幂等；Start 未运行时为 no-op）。
func (s *LarkWSSource) Stop() {
	s.mu.Lock()
	client := s.client
	s.mu.Unlock()
	if client != nil {
		client.Close()
	}
}

// parseLogLevel 解析 LARK_LOG_LEVEL；未知/留空返回 ok=false（用 SDK 默认）。
func parseLogLevel(value string) (larkcore.LogLevel, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "debug":
		return larkcore.LogLevelDebug, true
	case "info":
		return larkcore.LogLevelInfo, true
	case "warn", "warning":
		return larkcore.LogLevelWarn, true
	case "error":
		return larkcore.LogLevelError, true
	default:
		return 0, false
	}
}
