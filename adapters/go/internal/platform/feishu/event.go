// Package feishu 负责飞书平台的协议解析、事件归一化与消息发送。
//
// 归一化只做确定性转换（与 ticket-doctor 的 TS 实现保持同一语义），不做路由判断。
package feishu

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"ticket-doctor/adapter/internal/hostapi"
)

type Mention struct {
	Key  string `json:"key"`
	Name string `json:"name"`
	ID   struct {
		OpenID string `json:"open_id"`
	} `json:"id"`
}

type Sender struct {
	SenderType string `json:"sender_type"`
	SenderID   struct {
		OpenID string `json:"open_id"`
	} `json:"sender_id"`
	SenderName string `json:"sender_name"`
}

type Message struct {
	MessageID   string    `json:"message_id"`
	ChatID      string    `json:"chat_id"`
	ChatType    string    `json:"chat_type"`
	MessageType string    `json:"message_type"`
	Content     string    `json:"content"`
	CreateTime  string    `json:"create_time"`
	RootID      string    `json:"root_id"`
	ParentID    string    `json:"parent_id"`
	ThreadID    string    `json:"thread_id"`
	Mentions    []Mention `json:"mentions"`
}

type ReceiveEvent struct {
	Sender  *Sender  `json:"sender"`
	Message *Message `json:"message"`
}

// Envelope 是飞书事件回调的完整包体（v2 schema + url_verification）。
// 配置 Encrypt Key 时，外层仅有 encrypt 字段，解密后才是完整事件。
type Envelope struct {
	Encrypt   string        `json:"encrypt"`
	Challenge string        `json:"challenge"`
	Token     string        `json:"token"`
	Type      string        `json:"type"`
	Schema    string        `json:"schema"`
	Header    EventHeader   `json:"header"`
	Event     *ReceiveEvent `json:"event"`
}

type EventHeader struct {
	EventID   string `json:"event_id"`
	EventType string `json:"event_type"`
	Token     string `json:"token"`
	AppID     string `json:"app_id"`
}

func parseText(content string) (string, bool) {
	if content == "" {
		return "", false
	}
	var payload struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(content), &payload); err != nil {
		return "", false
	}
	return payload.Text, true
}

func removeMentionTokens(text string, mentions []Mention) string {
	cleaned := text
	for _, m := range mentions {
		if m.Key != "" {
			cleaned = strings.ReplaceAll(cleaned, m.Key, " ")
		}
	}
	cleaned = strings.ReplaceAll(cleaned, " \t", " ")
	lines := strings.Split(cleaned, "\n")
	for i, line := range lines {
		lines[i] = strings.Trim(line, " ")
	}
	return strings.Join(lines, "\n")
}

// IsBotMentioned：无法验证机器人身份时（botOpenID 未知），一律视为"未被 @"（保守，fail-closed）；
// 由 Host 按会话上下文决定拒绝与否——线程内回复仍可续接，群聊新会话必被拒（feishu-trigger-design §2.2）。
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

// Normalize 把飞书事件转成平台无关的 Host 入站消息；第二个返回值为 false 时表示应忽略。
func Normalize(event *ReceiveEvent, accountID, botOpenID string) (hostapi.Message, bool) {
	if event == nil || event.Message == nil {
		return hostapi.Message{}, false
	}
	message := event.Message
	if event.Sender != nil && event.Sender.SenderType != "" && event.Sender.SenderType != "user" {
		return hostapi.Message{}, false
	}
	if message.MessageID == "" || message.ChatID == "" {
		return hostapi.Message{}, false
	}
	if message.MessageType != "" && message.MessageType != "text" {
		return hostapi.Message{}, false
	}
	raw, ok := parseText(message.Content)
	if !ok {
		return hostapi.Message{}, false
	}
	text := strings.TrimSpace(removeMentionTokens(raw, message.Mentions))
	if text == "" {
		return hostapi.Message{}, false
	}

	receivedAt := time.Now().UnixMilli()
	if ms, err := strconv.ParseInt(message.CreateTime, 10, 64); err == nil && ms > 0 {
		receivedAt = ms
	}

	chatType := "group"
	if message.ChatType == "p2p" {
		chatType = "p2p"
	}

	var senderID, senderName string
	if event.Sender != nil {
		senderID = event.Sender.SenderID.OpenID
		senderName = event.Sender.SenderName
	}

	return hostapi.Message{
		Provider:          "feishu",
		AccountID:         accountID,
		ExternalMessageID: message.MessageID,
		ChatID:            message.ChatID,
		ChatType:          chatType,
		RootID:            message.RootID,
		ThreadID:          message.ThreadID,
		ParentID:          message.ParentID,
		MentionedBot:      IsBotMentioned(message.Mentions, botOpenID),
		SenderID:          senderID,
		SenderName:        senderName,
		Text:              text,
		ReceivedAt:        receivedAt,
	}, true
}
