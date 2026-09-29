// Platform 接口的飞书实现：Webhook 回调校验（签名/Encrypt Key/challenge/token）+
// 事件归一化 + 文本消息发送。协议细节复用同包的纯函数（Normalize/VerifySignature/DecryptEvent）。
package feishu

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"ticket-doctor/adapter/internal/eventsource"
	"ticket-doctor/adapter/internal/hostapi"
	"ticket-doctor/adapter/internal/platform"
)

// PlatformConfig 是飞书平台的独立凭据与开关（由 adapter.BuildPlatforms 从全局配置映射）。
type PlatformConfig struct {
	AppID      string
	AppSecret  string
	APIBase    string
	APITimeout time.Duration

	VerificationToken string
	// EncryptKey：配置后校验签名并解密 encrypt 事件体。
	EncryptKey string
	// BotOpenID：未知时群聊 mention 判定 fail-closed（出现任何 mention 即视为可能被 @）。
	BotOpenID string
	// LogLevel：长连接（larkws）SDK 日志级别（debug/info/warn/error）；留空用 SDK 默认。
	LogLevel string
}

// Platform 是飞书平台接入实现（Webhook + 长连接 S3）。
type Platform struct {
	appID             string
	appSecret         string
	botOpenID         string
	verificationToken string
	encryptKey        string
	logLevel          string
	client            *Client
}

// NewPlatform 构建飞书 Platform。
func NewPlatform(cfg PlatformConfig) *Platform {
	return &Platform{
		appID:             cfg.AppID,
		appSecret:         cfg.AppSecret,
		botOpenID:         cfg.BotOpenID,
		verificationToken: cfg.VerificationToken,
		encryptKey:        cfg.EncryptKey,
		logLevel:          cfg.LogLevel,
		client:            New(cfg.AppID, cfg.AppSecret, cfg.APIBase, cfg.APITimeout),
	}
}

func (p *Platform) Name() string { return "feishu" }

// LongConn 返回飞书长连接事件源；缺少 app_id/app_secret 时返回 nil（由 main 报错，不静默）。
func (p *Platform) LongConn() eventsource.Source {
	if p.appID == "" || p.appSecret == "" {
		return nil
	}
	return &LarkWSSource{
		appID:             p.appID,
		appSecret:         p.appSecret,
		verificationToken: p.verificationToken,
		encryptKey:        p.encryptKey,
		logLevel:          p.logLevel,
	}
}

// payload 解出回调明文：配置 Encrypt Key 时先解密，否则原样返回。
func (p *Platform) payload(body []byte) ([]byte, error) {
	if p.encryptKey == "" {
		return body, nil
	}
	var outer struct {
		Encrypt string `json:"encrypt"`
	}
	if err := json.Unmarshal(body, &outer); err != nil {
		return nil, &platform.StatusError{Status: http.StatusBadRequest, Msg: "非法 JSON"}
	}
	if outer.Encrypt == "" {
		return body, nil
	}
	decrypted, err := DecryptEvent(p.encryptKey, outer.Encrypt)
	if err != nil {
		return nil, &platform.StatusError{Status: http.StatusBadRequest, Msg: "事件解密失败"}
	}
	return decrypted, nil
}

// VerifyRequest 校验飞书回调：签名（Encrypt Key）→ 解密 → verification token → challenge。
func (p *Platform) VerifyRequest(r *http.Request, body []byte) (string, error) {
	if p.encryptKey != "" {
		timestamp := r.Header.Get("X-Lark-Request-Timestamp")
		nonce := r.Header.Get("X-Lark-Request-Nonce")
		signature := r.Header.Get("X-Lark-Signature")
		if !VerifySignature(p.encryptKey, timestamp, nonce, body, signature) {
			return "", &platform.StatusError{Status: http.StatusForbidden, Msg: "签名校验失败"}
		}
	}

	raw, err := p.payload(body)
	if err != nil {
		return "", err
	}
	var envelope Envelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return "", &platform.StatusError{Status: http.StatusBadRequest, Msg: "非法 JSON"}
	}

	// challenge 用顶层 token，事件用 header.token（与飞书 v2 schema 一致）。
	if p.verificationToken != "" {
		token := envelope.Header.Token
		if envelope.Challenge != "" {
			token = envelope.Token
		}
		if token != p.verificationToken {
			return "", &platform.StatusError{Status: http.StatusForbidden, Msg: "verification token 不匹配"}
		}
	}
	if envelope.Challenge != "" {
		return envelope.Challenge, nil
	}
	return "", nil
}

// Normalize 把回调明文转成 Host 入站消息；不支持的事件类型与空消息返回 ok=false。
func (p *Platform) Normalize(raw []byte, _ http.Header) (hostapi.Message, bool, error) {
	plaintext, err := p.payload(raw)
	if err != nil {
		return hostapi.Message{}, false, err
	}
	var envelope Envelope
	if err := json.Unmarshal(plaintext, &envelope); err != nil {
		return hostapi.Message{}, false, &platform.StatusError{Status: http.StatusBadRequest, Msg: "非法 JSON"}
	}
	if envelope.Header.EventType != "" && envelope.Header.EventType != "im.message.receive_v1" {
		return hostapi.Message{}, false, nil
	}
	message, ok := Normalize(envelope.Event, p.appID, p.botOpenID)
	return message, ok, nil
}

// Send 发送文本：有 targetMessageID 走线程内回复，否则发送到 chat。
func (p *Platform) Send(ctx context.Context, d hostapi.Delivery) (string, error) {
	return p.client.Send(ctx, d.ChatID, d.TargetMessageID, d.Content)
}
