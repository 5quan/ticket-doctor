// 飞书 OpenAPI 客户端：租户 token 获取与文本消息发送。
package feishu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"ticket-doctor/adapter/internal/platform"
)

func classifyTransportError(err error) *platform.SendError {
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return &platform.SendError{Kind: platform.KindUncertain, Err: err}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &platform.SendError{Kind: platform.KindUncertain, Err: err}
	}
	return &platform.SendError{Kind: platform.KindUncertain, Err: err}
}

var retryableCodes = map[int]bool{99991400: true, 99991663: true, 429: true}

// Client 是并发安全的飞书客户端（token 带过期缓存）。
type Client struct {
	appID     string
	appSecret string
	base      string
	http      *http.Client

	mu          sync.Mutex
	token       string
	tokenExpiry time.Time
}

func New(appID, appSecret, base string, timeout time.Duration) *Client {
	return &Client{
		appID:     appID,
		appSecret: appSecret,
		base:      base,
		http:      &http.Client{Timeout: timeout},
	}
}

func (c *Client) tenantToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	if c.token != "" && time.Now().Before(c.tokenExpiry) {
		token := c.token
		c.mu.Unlock()
		return token, nil
	}
	c.mu.Unlock()

	body, _ := json.Marshal(map[string]string{"app_id": c.appID, "app_secret": c.appSecret})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/auth/v3/tenant_access_token/internal", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var parsed struct {
		Code              int    `json:"code"`
		Msg               string `json:"msg"`
		TenantAccessToken string `json:"tenant_access_token"`
		Expire            int    `json:"expire"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", fmt.Errorf("解析 token 响应失败: %w", err)
	}
	if parsed.Code != 0 || parsed.TenantAccessToken == "" {
		return "", fmt.Errorf("获取 tenant_access_token 失败: code=%d msg=%s", parsed.Code, parsed.Msg)
	}
	c.mu.Lock()
	c.token = parsed.TenantAccessToken
	expire := parsed.Expire
	if expire <= 0 {
		expire = 3600
	}
	c.tokenExpiry = time.Now().Add(time.Duration(expire-60) * time.Second)
	c.mu.Unlock()
	return c.token, nil
}

// Send 发送文本：有 targetMessageID 走线程内回复，否则发送到 chat。
func (c *Client) Send(ctx context.Context, chatID, targetMessageID, text string) (string, error) {
	token, err := c.tenantToken(ctx)
	if err != nil {
		return "", &platform.SendError{Kind: platform.KindRetryable, Err: err}
	}
	content, _ := json.Marshal(map[string]string{"text": text})

	var endpoint string
	var payload []byte
	if targetMessageID != "" {
		endpoint = c.base + "/im/v1/messages/" + url.PathEscape(targetMessageID) + "/reply"
		payload, _ = json.Marshal(map[string]any{"content": string(content), "msg_type": "text"})
	} else {
		endpoint = c.base + "/im/v1/messages?receive_id_type=chat_id"
		payload, _ = json.Marshal(map[string]any{
			"receive_id": chatID,
			"msg_type":   "text",
			"content":    string(content),
		})
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", &platform.SendError{Kind: platform.KindUncertain, Err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.http.Do(req)
	if err != nil {
		return "", classifyTransportError(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	var parsed struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			MessageID string `json:"message_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		if resp.StatusCode >= 500 {
			return "", &platform.SendError{Kind: platform.KindRetryable, Err: fmt.Errorf("飞书 %d: %s", resp.StatusCode, string(raw))}
		}
		return "", &platform.SendError{Kind: platform.KindFatal, Err: fmt.Errorf("解析发送响应失败: %w", err)}
	}
	if parsed.Code != 0 {
		kind := platform.KindFatal
		if retryableCodes[parsed.Code] || resp.StatusCode >= 500 {
			kind = platform.KindRetryable
		}
		return "", &platform.SendError{Kind: kind, Err: fmt.Errorf("飞书返回 code=%d msg=%s", parsed.Code, parsed.Msg)}
	}
	return parsed.Data.MessageID, nil
}
