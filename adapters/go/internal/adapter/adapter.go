// Package adapter 编排接入适配器：事件归一化 → 门控 → 转发 Host；投递轮询 → 平台发送。
package adapter

import (
	"context"
	"errors"
	"log"
	"time"

	"ticket-doctor/adapter/internal/config"
	"ticket-doctor/adapter/internal/feishu"
	"ticket-doctor/adapter/internal/hostclient"
)

// Adapter 是接入适配器的业务核心，不感知 HTTP/平台协议细节。
type Adapter struct {
	cfg  config.Config
	host *hostclient.Client
	lark *feishu.Client
}

func New(cfg config.Config, host *hostclient.Client, lark *feishu.Client) *Adapter {
	return &Adapter{cfg: cfg, host: host, lark: lark}
}

// HandleResult 描述一条平台事件的处理结果（仅用于日志/响应）。
type HandleResult struct {
	// Status: forwarded | ignored | duplicate
	Status string
	Reason string
	// SessionCode 仅新建调查时返回。
	SessionCode string
}

// HandleEvent 执行 fail-closed mention 门控并转发 Host。
//
// 群聊必须 @机器人（requireMention）；bot open_id 未知时按 fail-closed 忽略。
func (a *Adapter) HandleEvent(ctx context.Context, event *feishu.ReceiveEvent) (HandleResult, error) {
	message, ok := feishu.Normalize(event, a.cfg.AppID, a.cfg.BotOpenID)
	if !ok {
		return HandleResult{Status: "ignored", Reason: "unsupported_or_empty"}, nil
	}
	if a.cfg.RequireMention && message.ChatType == "group" && !message.MentionedBot {
		if a.cfg.BotOpenID == "" {
			log.Printf("[adapter] bot open_id 未知，群聊消息 fail-closed 忽略")
		}
		return HandleResult{Status: "ignored", Reason: "mention_required"}, nil
	}

	result, err := a.host.SubmitMessage(ctx, message)
	if err != nil {
		return HandleResult{}, err
	}
	if !result.Accepted {
		return HandleResult{Status: result.Decision.Kind, Reason: result.Decision.Reason}, nil
	}
	return HandleResult{
		Status:      "forwarded",
		Reason:      result.Decision.Kind,
		SessionCode: result.SessionCode,
	}, nil
}

// RunDeliveryLoop 轮询 Host 待发送记录并调用平台发送，直到 ctx 结束。
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
	if delivery.Provider != "" && delivery.Provider != "feishu" {
		return a.host.ReportDelivery(ctx, delivery.ID, delivery.Attempt, "failed", "", "适配器不支持该来源："+delivery.Provider)
	}

	messageID, sendErr := a.lark.Send(ctx, delivery.ChatID, delivery.TargetMessageID, delivery.Content)
	if sendErr == nil {
		return a.host.ReportDelivery(ctx, delivery.ID, delivery.Attempt, "sent", messageID, "")
	}

	outcome := "failed"
	var classified *feishu.SendError
	if errors.As(sendErr, &classified) {
		switch classified.Kind {
		case feishu.KindUncertain:
			outcome = "uncertain"
		case feishu.KindRetryable:
			outcome = "retry"
		case feishu.KindFatal:
			outcome = "failed"
		}
	}
	return a.host.ReportDelivery(ctx, delivery.ID, delivery.Attempt, outcome, "", sendErr.Error())
}
