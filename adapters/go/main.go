// Go 接入适配器：飞书等企业 IM 事件 → Host Web Channel；Host 待发送记录 → 平台消息。
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
	"ticket-doctor/adapter/internal/feishu"
	"ticket-doctor/adapter/internal/hostclient"
)

func main() {
	cfg := config.Load()
	if cfg.AppID == "" || cfg.AppSecret == "" {
		log.Println("[adapter] 警告：未配置 LARK_APP_ID/LARK_APP_SECRET，投递发送将失败（事件仍可转发）")
	}

	host := hostclient.New(cfg.HostAPIBase, cfg.HostTimeout)
	lark := feishu.New(cfg.AppID, cfg.AppSecret, cfg.LarkAPIBase, cfg.LarkTimeout)
	core := adapter.New(cfg, host, lark)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go core.RunDeliveryLoop(ctx)

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           adapter.NewServer(cfg, core).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[adapter] HTTP 服务退出：%v", err)
		}
	}()
	log.Printf("[adapter] 已启动：addr=%s host=%s", cfg.Addr, cfg.HostAPIBase)

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	log.Println("[adapter] 已停止")
	os.Exit(0)
}
