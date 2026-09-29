package config

import (
	"testing"
	"time"
)

// Load 的默认值必须是人可用的：曾经 PollInterval 默认写成 1000（纳秒≈1µs），
// 会把投递循环变成死循环疯狂打 Host。
func TestLoadDefaults(t *testing.T) {
	for _, key := range []string{
		"ADAPTER_ADDR", "ADAPTER_MODE", "ADAPTER_PLATFORMS",
		"HOST_API_BASE", "HOST_TIMEOUT_MS",
		"LARK_API_BASE", "LARK_TIMEOUT_MS", "LARK_LOG_LEVEL",
		"ADAPTER_POLL_INTERVAL_MS", "ADAPTER_REQUIRE_MENTION",
	} {
		t.Setenv(key, "")
	}

	cfg := Load()

	if cfg.Mode != "webhook" {
		t.Fatalf("ADAPTER_MODE 默认应为 webhook，实际 %q", cfg.Mode)
	}
	if cfg.PollInterval != time.Second {
		t.Fatalf("ADAPTER_POLL_INTERVAL_MS 默认应为 1s，实际 %v", cfg.PollInterval)
	}
	if cfg.HostTimeout != 5*time.Second {
		t.Fatalf("HOST_TIMEOUT_MS 默认应为 5s，实际 %v", cfg.HostTimeout)
	}
	if cfg.LarkTimeout != 5*time.Second {
		t.Fatalf("LARK_TIMEOUT_MS 默认应为 5s，实际 %v", cfg.LarkTimeout)
	}
	if cfg.Addr != "0.0.0.0:3002" {
		t.Fatalf("ADAPTER_ADDR 默认错误：%q", cfg.Addr)
	}
	if len(cfg.Platforms) != 1 || cfg.Platforms[0] != "feishu" {
		t.Fatalf("ADAPTER_PLATFORMS 默认应为 [feishu]，实际 %v", cfg.Platforms)
	}
}

func TestLoadOverridesFromEnv(t *testing.T) {
	t.Setenv("ADAPTER_MODE", "ws")
	t.Setenv("ADAPTER_POLL_INTERVAL_MS", "250")
	t.Setenv("LARK_LOG_LEVEL", "debug")

	cfg := Load()
	if cfg.Mode != "ws" {
		t.Fatalf("ADAPTER_MODE 覆盖失败：%q", cfg.Mode)
	}
	if cfg.PollInterval != 250*time.Millisecond {
		t.Fatalf("ADAPTER_POLL_INTERVAL_MS 覆盖失败：%v", cfg.PollInterval)
	}
	if cfg.LarkLogLevel != "debug" {
		t.Fatalf("LARK_LOG_LEVEL 覆盖失败：%q", cfg.LarkLogLevel)
	}
}
