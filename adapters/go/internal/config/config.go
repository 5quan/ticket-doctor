// Package config 读取 Go 接入适配器的运行配置（ENV 优先，含默认值）。
//
// 适配器只做"平台事件 ↔ Host Web Channel"的转换，因此配置只有三类：
// 监听地址、Host API 地址、飞书平台凭据与限流。
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// HTTP 监听地址（平台事件回调 / 健康检查）。
	Addr string
	// Host Web Channel 的 /api/agent 基址。
	HostAPIBase string
	// 调用 Host 的超时。
	HostTimeout time.Duration

	// 启用的平台列表（回调路由 /{platform}/events 与投递路由键）。
	// 空缺省 ["feishu"]；未知平台名在启动时直接报错。
	Platforms []string

	// 飞书平台凭据与校验。
	AppID             string
	AppSecret         string
	VerificationToken string
	// 事件订阅 Encrypt Key：配置后校验签名并解密 encrypt 事件体。
	EncryptKey string
	// 机器人 open_id；未知时群聊 fail-closed。
	BotOpenID string
	// 群聊是否必须 @机器人（默认 true）。
	RequireMention bool
	// 飞书 OpenAPI 基址（测试可覆盖）。
	LarkAPIBase string
	// 飞书 API 调用超时。
	LarkTimeout time.Duration

	// 投递轮询间隔。
	PollInterval time.Duration
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return parsed
}

func envDuration(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return fallback
	}
	return time.Duration(n) * time.Millisecond
}

func envList(key string) []string {
	var out []string
	for _, part := range strings.Split(os.Getenv(key), ",") {
		if name := strings.TrimSpace(part); name != "" {
			out = append(out, name)
		}
	}
	return out
}

func Load() Config {
	platforms := envList("ADAPTER_PLATFORMS")
	if len(platforms) == 0 {
		platforms = []string{"feishu"}
	}
	return Config{
		Addr:              env("ADAPTER_ADDR", "0.0.0.0:3002"),
		HostAPIBase:       env("HOST_API_BASE", "http://127.0.0.1:3000/api/agent"),
		HostTimeout:       envDuration("HOST_TIMEOUT_MS", 5*time.Second),
		Platforms:         platforms,
		AppID:             os.Getenv("LARK_APP_ID"),
		AppSecret:         os.Getenv("LARK_APP_SECRET"),
		VerificationToken: os.Getenv("LARK_VERIFICATION_TOKEN"),
		EncryptKey:        os.Getenv("LARK_ENCRYPT_KEY"),
		BotOpenID:         os.Getenv("LARK_BOT_OPEN_ID"),
		RequireMention:    envBool("ADAPTER_REQUIRE_MENTION", true),
		LarkAPIBase:       env("LARK_API_BASE", "https://open.feishu.cn/open-apis"),
		LarkTimeout:       envDuration("LARK_TIMEOUT_MS", 5*time.Second),
		PollInterval:      envDuration("ADAPTER_POLL_INTERVAL_MS", 1000),
	}
}
