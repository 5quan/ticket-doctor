// Package platform 定义多平台接入抽象：一个平台 = 事件归一化 + 回调校验 + 消息发送。
//
// 新增平台（钉钉/Slack…）只需实现 Platform 并在 adapter.BuildPlatforms 注册，不改 Host。
package platform

import (
	"context"
	"net/http"

	"ticket-doctor/adapter/internal/eventsource"
	"ticket-doctor/adapter/internal/hostapi"
)

// Platform 是一个 IM 平台的接入实现。
type Platform interface {
	// Name 平台标识，同时是入站消息的 provider 与投递路由键（"feishu" | "dingtalk" | …）。
	// 必须与 HTTP 回调路由 /{platform}/events 一致。
	Name() string

	// Normalize 平台原始事件 → Host 入站消息；ok=false 表示忽略（非文本/空文本/不支持的事件类型）。
	// raw 是回调请求体（加密平台自行解密）；headers 供需要签名头的平台使用。
	Normalize(raw []byte, headers http.Header) (hostapi.Message, bool, error)

	// VerifyRequest 处理回调校验：签名、verification token、URL 校验 challenge。
	// challenge != "" 表示这是一次 URL 校验，调用方应原样返回 {"challenge": ...}；
	// 校验失败返回 *StatusError（调用方按其 Status 响应）。
	VerifyRequest(r *http.Request, body []byte) (challenge string, err error)

	// Send 发送文本，返回平台消息 ID。
	// 错误用 *SendError 分类（uncertain/retryable/fatal），与 Host 的投递状态机对齐。
	Send(ctx context.Context, d hostapi.Delivery) (string, error)

	// LongConn 长连接事件源；纯 Webhook 平台返回 nil。
	LongConn() eventsource.Source
}

// SendErrorKind 表示发送失败的收敛语义，与 Host 的投递状态机对齐。
type SendErrorKind string

const (
	// KindUncertain：发送结果未知（网络中断/超时），可能已送达。
	KindUncertain SendErrorKind = "uncertain"
	// KindRetryable：明确未送达且可重试（限流/平台 5xx）。
	KindRetryable SendErrorKind = "retryable"
	// KindFatal：明确不可恢复（参数/权限错误）。
	KindFatal SendErrorKind = "fatal"
)

// SendError 平台发送失败的分类错误。
type SendError struct {
	Kind SendErrorKind
	Err  error
}

func (e *SendError) Error() string { return string(e.Kind) + ": " + e.Err.Error() }
func (e *SendError) Unwrap() error { return e.Err }

// StatusError 带 HTTP 语义的请求级错误：调用方按 Status 响应（4xx 不重试）。
type StatusError struct {
	// Status 建议返回的 HTTP 状态码（400 非法请求体 / 403 校验失败）。
	Status int
	Msg    string
}

func (e *StatusError) Error() string { return e.Msg }
