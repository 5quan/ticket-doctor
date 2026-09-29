// Go 接入适配器：企业 IM（飞书等）平台事件 → Host Web Channel；Host 待发送记录 → 平台消息。
//
// 平台按 ADAPTER_PLATFORMS 启用（默认 feishu）；每平台一个 Platform 实现
// （归一化 + 回调校验 + 发送），回调路由 POST /{platform}/events，投递按 provider 路由。
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
	"ticket-doctor/adapter/internal/hostclient"
)

func main() {
	cfg := config.Load()
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
	log.Printf("[adapter] 已启动：addr=%s host=%s platforms=%v", cfg.Addr, cfg.HostAPIBase, cfg.Platforms)

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	log.Println("[adapter] 已停止")
	os.Exit(0)
}
