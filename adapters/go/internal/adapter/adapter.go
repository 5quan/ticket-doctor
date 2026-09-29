// Package adapter 编排接入适配器：平台事件归一化 → 门控 → 转发 Host；投递轮询 → 按平台发送。
//
// 核心只面向 platform.Platform 接口，不知道具体平台协议；新增平台在 BuildPlatforms 注册即可。
package adapter

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"ticket-doctor/adapter/internal/config"
	"ticket-doctor/adapter/internal/hostapi"
	"ticket-doctor/adapter/internal/hostclient"
	"ticket-doctor/adapter/internal/platform"
	"ticket-doctor/adapter/internal/platform/dingtalk"
	"ticket-doctor/adapter/internal/platform/feishu"
	"ticket-doctor/adapter/internal/platform/slack"
)

// Adapter 是接入适配器的业务核心，不感知 HTTP/平台协议细节。
type Adapter struct {
	cfg  config.Config
	host *hostclient.Client
	// platforms 按 Name() 索引的启用平台；投递按 delivery.Provider 路由。
	platforms map[string]platform.Platform
	// defaultPlatform 兜底平台：历史投递记录可能缺 provider，按第一个启用平台处理。
	defaultPlatform string
}

// BuildPlatforms 按配置构建启用的平台实现（ADAPTER_PLATFORMS，如 feishu,dingtalk）。
func BuildPlatforms(cfg config.Config) ([]platform.Platform, error) {
	seen := map[string]bool{}
	var out []platform.Platform
	for _, name := range cfg.Platforms {
		if seen[name] {
			return nil, fmt.Errorf("平台重复配置：%s", name)
		}
		seen[name] = true
		switch name {
		case "feishu":
			out = append(out, feishu.NewPlatform(feishu.PlatformConfig{
				AppID:             cfg.AppID,
				AppSecret:         cfg.AppSecret,
				APIBase:           cfg.LarkAPIBase,
				APITimeout:        cfg.LarkTimeout,
				VerificationToken: cfg.VerificationToken,
				EncryptKey:        cfg.EncryptKey,
				BotOpenID:         cfg.BotOpenID,
				LogLevel:          cfg.LarkLogLevel,
			}))
		case "dingtalk":
			out = append(out, dingtalk.New())
		case "slack":
			out = append(out, slack.New())
		default:
			return nil, fmt.Errorf("未知平台 %q（可用：feishu, dingtalk, slack）", name)
		}
	}
	return out, nil
}

// New 组装核心；platforms 至少一个，第一个同时作为缺 provider 投递的兜底平台。
func New(cfg config.Config, host *hostclient.Client, platforms []platform.Platform) *Adapter {
	byName := make(map[string]platform.Platform, len(platforms))
	var first string
	for _, p := range platforms {
		if first == "" {
			first = p.Name()
		}
		byName[p.Name()] = p
	}
	return &Adapter{cfg: cfg, host: host, platforms: byName, defaultPlatform: first}
}

// Platform 返回已启用的平台实现；未启用返回 nil。
func (a *Adapter) Platform(name string) platform.Platform {
	return a.platforms[name]
}

// HandleResult 描述一条平台事件的处理结果（仅用于日志/响应）。
type HandleResult struct {
	// Status: forwarded | ignored | duplicate
	Status string
	Reason string
	// SessionCode 仅新建调查时返回。
	SessionCode string
}

// HandleEvent 归一化平台事件并转发 Host；门控权威在 Host（planRoute），
// 适配器不再因"群聊未 @"丢弃消息——线程回复/带标号续接免 @ 由 Host 按上下文放行。
func (a *Adapter) HandleEvent(ctx context.Context, p platform.Platform, raw []byte, headers http.Header) (HandleResult, error) {
	message, ok, err := p.Normalize(raw, headers)
	if err != nil {
		return HandleResult{}, err
	}
	if !ok {
		return HandleResult{Status: "ignored", Reason: "unsupported_or_empty"}, nil
	}

	result, err := a.host.SubmitMessage(ctx, message)
	if err != nil {
		return HandleResult{}, err
	}
	if !result.Accepted {
		// 机械回复（-help）：Host 出文案，适配器对原消息做线程内回复；best-effort，失败不重试
		if result.Decision.Kind == "mechanical" {
			_, sendErr := p.Send(ctx, hostapi.Delivery{
				ChatID:          message.ChatID,
				TargetMessageID: message.ExternalMessageID,
				Content:         result.MechanicalText,
			})
			if sendErr != nil {
				log.Printf("[adapter] 机械回复发送失败：%v", sendErr)
				return HandleResult{Status: "ignored", Reason: "mechanical_reply_failed"}, nil
			}
			return HandleResult{Status: "mechanical_reply_sent"}, nil
		}
		return HandleResult{Status: result.Decision.Kind, Reason: result.Decision.Reason}, nil
	}
	return HandleResult{
		Status:      "forwarded",
		Reason:      result.Decision.Kind,
		SessionCode: result.SessionCode,
	}, nil
}

// RunDeliveryLoop 轮询 Host 待发送记录并按平台发送，直到 ctx 结束。
func (a *Adapter) RunDeliveryLoop(ctx context.Context) {
	ticker := time.NewTicker(a.cfg.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := a.processOneDelivery(ctx); err != nil {
				log.Printf("[adapter] 投递失败：%v", err)
			}
		}
	}
}

func (a *Adapter) processOneDelivery(ctx context.Context) error {
	delivery, err := a.host.ClaimDelivery(ctx)
	if err != nil {
		return err
	}
	if delivery == nil {
		return nil
	}
	name := delivery.Provider
	if name == "" {
		name = a.defaultPlatform
	}
	p := a.platforms[name]
	if p == nil {
		return a.host.ReportDelivery(ctx, delivery.ID, delivery.Attempt, "failed", "", "适配器不支持该来源："+delivery.Provider)
	}

	messageID, sendErr := p.Send(ctx, *delivery)
	if sendErr == nil {
		return a.host.ReportDelivery(ctx, delivery.ID, delivery.Attempt, "sent", messageID, "")
	}

	outcome := "failed"
	var classified *platform.SendError
	if errors.As(sendErr, &classified) {
		switch classified.Kind {
		case platform.KindUncertain:
			outcome = "uncertain"
		case platform.KindRetryable:
			outcome = "retry"
		case platform.KindFatal:
			outcome = "failed"
		}
	}
	return a.host.ReportDelivery(ctx, delivery.ID, delivery.Attempt, outcome, "", sendErr.Error())
}
