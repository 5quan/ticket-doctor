// Package hostclient 是调用 Host Web Channel 的 HTTP 客户端。
package hostclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"ticket-doctor/adapter/internal/hostapi"
)

type Client struct {
	base string
	http *http.Client
}

func New(base string, timeout time.Duration) *Client {
	return &Client{
		base: strings.TrimRight(base, "/"),
		http: &http.Client{Timeout: timeout},
	}
}

func (c *Client) postJSON(ctx context.Context, path string, body any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("host %s 返回 %d: %s", path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// SubmitMessage 把归一化消息交给 Host 原子入队。
func (c *Client) SubmitMessage(ctx context.Context, message hostapi.Message) (hostapi.SubmitResult, error) {
	var out hostapi.SubmitResult
	err := c.postJSON(ctx, "/message", message, &out)
	return out, err
}

// ClaimDelivery 领取一条待发送记录；无待发送时返回 nil。
func (c *Client) ClaimDelivery(ctx context.Context) (*hostapi.Delivery, error) {
	var out hostapi.ClaimResponse
	if err := c.postJSON(ctx, "/deliveries/claim", map[string]any{}, &out); err != nil {
		return nil, err
	}
	return out.Delivery, nil
}

// ReportDelivery 上交发送结果，由 Host 校验 attempt 后收敛状态。
func (c *Client) ReportDelivery(ctx context.Context, id string, attempt int, outcome, providerMessageID, errMsg string) error {
	return c.postJSON(ctx, "/deliveries/"+id+"/result", map[string]any{
		"attempt":           attempt,
		"outcome":           outcome,
		"providerMessageId": providerMessageID,
		"error":             errMsg,
	}, nil)
}
