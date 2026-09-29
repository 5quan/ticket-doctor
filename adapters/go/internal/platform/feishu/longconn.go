// 飞书长连接（S3）：用官方 SDK 的 WS 客户端接收事件，映射为本项目 Envelope 明文契约。
//
// 设计见 docs/adapter-longconn-design.md：SDK 负责握手/心跳/ACK/分片/重连；
// 本层只做「SDK 事件结构 → 本项目 ReceiveEvent → 明文 Envelope JSON」，与 Webhook 归一化共用。
package feishu

import (
	"encoding/json"

	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
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
