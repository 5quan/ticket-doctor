// Package dingtalk 钉钉平台接入骨架：Platform 接口已就位，协议实现待补。
//
// 实现要点（照 feishu 的结构）：
//   - Normalize：钉钉机器人回调（加签/Stream 模式二选一）→ hostapi.Message；
//     用户标识与线程语义按 rootId/conversationId 映射到 hostapi.Message 的 rootId/threadId。
//   - VerifyRequest：加签 timestamp+sign 或 token 校验。
//   - Send：机器人 webhook 或 sessionWebhook 发文本；超时归 uncertain，限流归 retryable。
package dingtalk

import (
	"context"
	"errors"
	"net/http"

	"ticket-doctor/adapter/internal/eventsource"
	"ticket-doctor/adapter/internal/hostapi"
	"ticket-doctor/adapter/internal/platform"
)

// Platform 是钉钉平台的未完成实现：任何调用都返回未实现错误，避免静默吞事件。
type Platform struct{}

func New() *Platform { return &Platform{} }

func (p *Platform) Name() string { return "dingtalk" }

func (p *Platform) Normalize(_ []byte, _ http.Header) (hostapi.Message, bool, error) {
	return hostapi.Message{}, false, errors.New("dingtalk 平台尚未实现")
}

func (p *Platform) VerifyRequest(_ *http.Request, _ []byte) (string, error) {
	return "", errors.New("dingtalk 平台尚未实现")
}

func (p *Platform) Send(_ context.Context, _ hostapi.Delivery) (string, error) {
	return "", &platform.SendError{Kind: platform.KindFatal, Err: errors.New("dingtalk 平台尚未实现")}
}

func (p *Platform) LongConn() eventsource.Source { return nil }
