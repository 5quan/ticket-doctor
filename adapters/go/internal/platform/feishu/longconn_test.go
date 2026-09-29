package feishu

import (
	"encoding/json"
	"testing"

	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

func strPtr(s string) *string { return &s }

// sdkEvent 构造一个接近真实回调的 SDK 事件结构。
func sdkEvent() *larkim.P2MessageReceiveV1 {
	return &larkim.P2MessageReceiveV1{
		Event: &larkim.P2MessageReceiveV1Data{
			Sender: &larkim.EventSender{
				SenderType: strPtr("user"),
				SenderId:   &larkim.UserId{OpenId: strPtr("ou_user")},
			},
			Message: &larkim.EventMessage{
				MessageId:   strPtr("om_1"),
				ChatId:      strPtr("oc_1"),
				ChatType:    strPtr("group"),
				MessageType: strPtr("text"),
				Content:     strPtr(`{"text":"checkout-service 报错"}`),
				CreateTime:  strPtr("1700000000123"),
				RootId:      strPtr("om_root"),
				ParentId:    strPtr("om_parent"),
				ThreadId:    strPtr("omt_thread"),
				Mentions: []*larkim.MentionEvent{
					{
						Key:  strPtr("@_user_1"),
						Name: strPtr("小助手"),
						Id:   &larkim.UserId{OpenId: strPtr("ou_bot")},
					},
				},
			},
		},
	}
}

func TestReceiveEventFromSDKMapsAllFields(t *testing.T) {
	got := receiveEventFromSDK(sdkEvent())
	if got == nil || got.Sender == nil || got.Message == nil {
		t.Fatalf("映射结果不应为空：%+v", got)
	}
	if got.Sender.SenderType != "user" || got.Sender.SenderID.OpenID != "ou_user" {
		t.Fatalf("sender 映射错误：%+v", got.Sender)
	}
	m := got.Message
	if m.MessageID != "om_1" || m.ChatID != "oc_1" || m.ChatType != "group" ||
		m.MessageType != "text" || m.Content != `{"text":"checkout-service 报错"}` ||
		m.CreateTime != "1700000000123" {
		t.Fatalf("message 基础字段映射错误：%+v", m)
	}
	if m.RootID != "om_root" || m.ParentID != "om_parent" || m.ThreadID != "omt_thread" {
		t.Fatalf("线程字段映射错误：%+v", m)
	}
	if len(m.Mentions) != 1 || m.Mentions[0].Key != "@_user_1" ||
		m.Mentions[0].Name != "小助手" || m.Mentions[0].ID.OpenID != "ou_bot" {
		t.Fatalf("mentions 映射错误：%+v", m.Mentions)
	}
}

func TestReceiveEventFromSDKHandlesNilAndPartial(t *testing.T) {
	if got := receiveEventFromSDK(nil); got != nil {
		t.Fatalf("nil 事件应返回 nil，实际 %+v", got)
	}
	if got := receiveEventFromSDK(&larkim.P2MessageReceiveV1{}); got != nil {
		t.Fatalf("无 Event 应返回 nil，实际 %+v", got)
	}
	// 只有 message、没有 sender：不应 panic，sender 为 nil。
	got := receiveEventFromSDK(&larkim.P2MessageReceiveV1{
		Event: &larkim.P2MessageReceiveV1Data{
			Message: &larkim.EventMessage{MessageId: strPtr("om_2")},
		},
	})
	if got == nil || got.Sender != nil || got.Message == nil || got.Message.MessageID != "om_2" {
		t.Fatalf("部分字段映射错误：%+v", got)
	}
	// mentions 中混入 nil 元素：跳过而非 panic。
	got = receiveEventFromSDK(&larkim.P2MessageReceiveV1{
		Event: &larkim.P2MessageReceiveV1Data{
			Message: &larkim.EventMessage{
				MessageId: strPtr("om_3"),
				Mentions:  []*larkim.MentionEvent{nil, {Key: strPtr("@_user_2")}},
			},
		},
	})
	if got == nil || len(got.Message.Mentions) != 1 || got.Message.Mentions[0].Key != "@_user_2" {
		t.Fatalf("nil mention 应被跳过：%+v", got)
	}
}

// 端到端离线契约：SDK 事件 → sourceEventFromSDK（明文 Envelope）→ Normalize。
func TestSourceEventFromSDKNormalizes(t *testing.T) {
	raw, err := sourceEventFromSDK(sdkEvent())
	if err != nil {
		t.Fatalf("生成 Envelope 失败：%v", err)
	}
	var envelope Envelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("Envelope 非法 JSON：%v", err)
	}
	if envelope.Header.EventType != imMessageReceiveEventType {
		t.Fatalf("event_type 应为 %s，实际 %q", imMessageReceiveEventType, envelope.Header.EventType)
	}
	if envelope.Encrypt != "" {
		t.Fatalf("长连接 Envelope 应为明文，不应有 encrypt 字段")
	}

	message, ok := Normalize(envelope.Event, "app_1", "ou_bot")
	if !ok {
		t.Fatal("明文 Envelope 应能归一化")
	}
	if message.Provider != "feishu" || message.AccountID != "app_1" {
		t.Fatalf("provider/account 错误：%+v", message)
	}
	if message.ExternalMessageID != "om_1" || message.ChatID != "oc_1" || message.ChatType != "group" {
		t.Fatalf("消息基础字段错误：%+v", message)
	}
	if message.RootID != "om_root" || message.ThreadID != "omt_thread" || message.ParentID != "om_parent" {
		t.Fatalf("线程字段错误：%+v", message)
	}
	if message.Text != "checkout-service 报错" {
		t.Fatalf("文本应去掉 @ token，实际 %q", message.Text)
	}
	if !message.MentionedBot {
		t.Fatalf("应识别出 @ 了机器人（botOpenID=ou_bot）：%+v", message)
	}
	if message.SenderID != "ou_user" {
		t.Fatalf("sender 错误：%+v", message)
	}
	if message.ReceivedAt != 1700000000123 {
		t.Fatalf("receivedAt 应取 create_time，实际 %d", message.ReceivedAt)
	}
}

func TestSourceEventFromSDKP2PChatType(t *testing.T) {
	ev := sdkEvent()
	ev.Event.Message.ChatType = strPtr("p2p")
	raw, err := sourceEventFromSDK(ev)
	if err != nil {
		t.Fatalf("生成 Envelope 失败：%v", err)
	}
	var envelope Envelope
	_ = json.Unmarshal(raw, &envelope)
	message, ok := Normalize(envelope.Event, "app_1", "ou_bot")
	if !ok || message.ChatType != "p2p" {
		t.Fatalf("p2p 应保留为 p2p：ok=%v %+v", ok, message)
	}
}
