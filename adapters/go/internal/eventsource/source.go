// Package eventsource 定义平台事件源抽象：Webhook 之外的第二种事件进入方式（长连接）。
//
// S3（Go 适配器长连接模式）将提供飞书 larkws 实现；当前只有接口，Webhook 平台返回 nil。
package eventsource

import "context"

// Source 是一个持续投递平台原始事件的事件源。
type Source interface {
	// Name 事件源标识（如 "feishu-larkws"）。
	Name() string
	// Start 持续投递原始事件；ctx 取消即停止。raw 为平台原始 JSON。
	// 飞书长连接（LarkWSSource）投递的是明文 Envelope JSON（header.event_type + event），
	// 交由 Platform.Normalize 解析。
	// 返回的 error 表示事件源本身异常退出（调用方决定是否重启进程/重连策略）。
	Start(ctx context.Context, onEvent func(raw []byte) error) error
	// Stop 主动停止事件源（幂等）。
	Stop()
}
