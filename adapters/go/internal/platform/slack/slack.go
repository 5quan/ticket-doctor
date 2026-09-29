// Package slack Slack 平台接入骨架：Platform 接口已就位，协议实现待补。
//
// 实现要点（照 feishu 的结构）：
//   - Normalize：Events API（url_verification / event_callback，app_mention 或 message）→
//     hostapi.Message；channel/ts/thread_ts 映射到 chatId/rootId/threadId。
//   - VerifyRequest：Signing Secret（X-Slack-Signature + X-Slack-Request-Timestamp）与
//     url_verification challenge。
//   - Send：chat.postMessage；Rate Limited（429）归 retryable，网络超时归 uncertain。
package slack

import (
	"context"
	"errors"
	"net/http"

	"ticket-doctor/adapter/internal/eventsource"
	"ticket-doctor/adapter/internal/hostapi"
	"ticket-doctor/adapter/internal/platform"
)

// Platform 是 Slack 平台的未完成实现：任何调用都返回未实现错误，避免静默吞事件。
type Platform struct{}

func New() *Platform { return &Platform{} }

func (p *Platform) Name() string { return "slack" }

func (p *Platform) Normalize(_ []byte, _ http.Header) (hostapi.Message, bool, error) {
	return hostapi.Message{}, false, errors.New("slack 平台尚未实现")
}

func (p *Platform) VerifyRequest(_ *http.Request, _ []byte) (string, error) {
	return "", errors.New("slack 平台尚未实现")
}

func (p *Platform) Send(_ context.Context, _ hostapi.Delivery) (string, error) {
	return "", &platform.SendError{Kind: platform.KindFatal, Err: errors.New("slack 平台尚未实现")}
}

func (p *Platform) LongConn() eventsource.Source { return nil }
