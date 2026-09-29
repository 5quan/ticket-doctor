// Go 接入适配器：企业 IM（飞书等）平台事件 → Host Web Channel；Host 待发送记录 → 平台消息。
//
// 平台按 ADAPTER_PLATFORMS 启用（默认 feishu）；每平台一个 Platform 实现
// （归一化 + 回调校验 + 发送），回调路由 POST /{platform}/events，投递按 provider 路由。
//
// 事件入站模式由 ADAPTER_MODE 决定：
//   - webhook（默认）：平台回调到 /{platform}/events（走 VerifyRequest）。
//   - ws：飞书长连接（larkws），SDK 负责握手/心跳/ACK/分片/重连；Start 返回后由 main 退避重连。
//
// 明确不做：不启动执行器、不管 Agent 会话、不做调度与并发控制。
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"ticket-doctor/adapter/internal/adapter"
	"ticket-doctor/adapter/internal/config"
	"ticket-doctor/adapter/internal/eventsource"
	"ticket-doctor/adapter/internal/hostclient"
	"ticket-doctor/adapter/internal/platform"
)

const (
	modeWebhook = "webhook"
	modeWS      = "ws"

	restartBackoffInitial = time.Second
	restartBackoffMax     = 30 * time.Second
)

func main() {
	cfg := config.Load()
	if cfg.Mode != modeWebhook && cfg.Mode != modeWS {
		log.Fatalf("[adapter] 未知 ADAPTER_MODE=%q（可用：%s | %s）", cfg.Mode, modeWebhook, modeWS)
	}
	for _, name := range cfg.Platforms {
		if name == "feishu" && (cfg.AppID == "" || cfg.AppSecret == "") {
			log.Println("[adapter] 警告：未配置 LARK_APP_ID/LARK_APP_SECRET，飞书投递发送将失败（事件仍可转发）")
		}
	}
	platforms, err := adapter.BuildPlatforms(cfg)
	if err != nil {
		log.Fatalf("[adapter] 平台配置错误：%v", err)
	}

	host := hostclient.New(cfg.HostAPIBase, cfg.HostTimeout)
	core := adapter.New(cfg, host, platforms)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go core.RunDeliveryLoop(ctx)

	if cfg.Mode == modeWS {
		startLongConn(ctx, core, platforms)
	}

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           adapter.NewServer(core).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[adapter] HTTP 服务退出：%v", err)
		}
	}()
	log.Printf("[adapter] 已启动：mode=%s addr=%s host=%s platforms=%v", cfg.Mode, cfg.Addr, cfg.HostAPIBase, cfg.Platforms)

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	log.Println("[adapter] 已停止")
	os.Exit(0)
}

// startLongConn 为每个启用平台启动长连接事件源；缺实现/缺凭据直接报错（不静默）。
func startLongConn(ctx context.Context, core *adapter.Adapter, platforms []platform.Platform) {
	for _, p := range platforms {
		src := p.LongConn()
		if src == nil {
			log.Fatalf("[adapter] 平台 %s 不支持长连接（未实现或缺少 LARK_APP_ID/LARK_APP_SECRET）", p.Name())
		}
		go restartLoop(ctx, src, sourceHandler(ctx, core, p))
		log.Printf("[adapter] 已启动长连接事件源：platform=%s source=%s", p.Name(), src.Name())
	}
}

// sourceHandler 把事件源投递的明文 Envelope 交给适配器处理。
// 返回非 nil → SDK 回非 200，平台重投；Host 侧 inbound_events 去重兜底。
func sourceHandler(ctx context.Context, core *adapter.Adapter, p platform.Platform) func([]byte) error {
	return func(raw []byte) error {
		result, err := core.HandleSourceEvent(ctx, p, raw)
		if err != nil {
			log.Printf("[adapter] 长连接事件处理失败（不 ACK，等待重投）：platform=%s err=%v", p.Name(), err)
			return err
		}
		log.Printf("[adapter] 长连接事件已处理：platform=%s status=%s reason=%s session=%s",
			p.Name(), result.Status, result.Reason, result.SessionCode)
		return nil
	}
}

// restartLoop 按默认退避（1s→2s→…→30s）重启事件源，直到 ctx 结束。
// 约定：src.Start 返回即视为本次会话结束，不在 Start 内自旋。SDK 自身的重连仍由其负责。
func restartLoop(ctx context.Context, src eventsource.Source, onEvent func([]byte) error) {
	restartLoopWith(ctx, src, onEvent, restartBackoffInitial, restartBackoffMax)
}

// restartLoopWith 是 restartLoop 的可注入退避版本（便于单测）。
func restartLoopWith(ctx context.Context, src eventsource.Source, onEvent func([]byte) error, initial, maxBackoff time.Duration) {
	backoff := initial
	for {
		if ctx.Err() != nil {
			return
		}
		err := src.Start(ctx, onEvent)
		src.Stop()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			log.Printf("[adapter] 事件源 %s 退出：%v；%s 后重连", src.Name(), err, backoff)
		} else {
			log.Printf("[adapter] 事件源 %s 已结束；%s 后重连", src.Name(), backoff)
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}
