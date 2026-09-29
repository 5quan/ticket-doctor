// Package hostapi 定义 Go 适配器与 Host Web Channel 之间的 JSON 契约。
package hostapi

// Message 是提交给 Host 的归一化入站消息（POST /api/agent/message）。
type Message struct {
	Provider          string `json:"provider"`
	AccountID         string `json:"accountId"`
	ExternalMessageID string `json:"externalMessageId"`
	ChatID            string `json:"chatId"`
	ChatType          string `json:"chatType"`
	RootID            string `json:"rootId,omitempty"`
	ThreadID          string `json:"threadId,omitempty"`
	ParentID          string `json:"parentId,omitempty"`
	MentionedBot      bool   `json:"mentionedBot"`
	SenderID          string `json:"senderId,omitempty"`
	SenderName        string `json:"senderName,omitempty"`
	Text              string `json:"text"`
	ReceivedAt        int64  `json:"receivedAt"`
}

// Decision 是 Host 的路由判定。
type Decision struct {
	Kind   string `json:"kind"`
	Reason string `json:"reason"`
}

// SubmitResult 是 Host 对入站消息的处理结果。
type SubmitResult struct {
	Accepted        bool     `json:"accepted"`
	Decision        Decision `json:"decision"`
	InvestigationID string   `json:"investigationId"`
	RunID           string   `json:"runId"`
	Round           int      `json:"round"`
	SessionCode     string   `json:"sessionCode"`
	// MechanicalText 是 decision.kind="mechanical"（-help）时的固定文案（Host 出文案，适配器发送）。
	MechanicalText string `json:"mechanicalText,omitempty"`
}

// Delivery 是 Host 交给适配器发送的一条出站消息。
type Delivery struct {
	ID              string `json:"id"`
	Attempt         int    `json:"attempt"`
	Kind            string `json:"kind"`
	Content         string `json:"content"`
	TargetMessageID string `json:"targetMessageId"`
	ChatID          string `json:"chatId"`
	Provider        string `json:"provider"`
	SessionCode     string `json:"sessionCode"`
}

// ClaimResponse 是 POST /api/agent/deliveries/claim 的响应；无待发送时 Delivery 为 null。
type ClaimResponse struct {
	Delivery *Delivery `json:"delivery"`
}
