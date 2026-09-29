package adapter

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ticket-doctor/adapter/internal/config"
	"ticket-doctor/adapter/internal/hostapi"
	"ticket-doctor/adapter/internal/hostclient"
	"ticket-doctor/adapter/internal/platform"
	"ticket-doctor/adapter/internal/platform/feishu"
)

type fakeHost struct {
	forwarded     hostapi.Message
	claimDelivery *hostapi.Delivery
	claimed       bool
	resultOutcome string
	resultMsgID   string
	resultError   string
	// mechanical=true 时 /message 返回 mechanical 决策（-help 用例）
	mechanical bool
}

func (f *fakeHost) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/message", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&f.forwarded)
		if f.mechanical {
			_ = json.NewEncoder(w).Encode(hostapi.SubmitResult{
				Accepted:       false,
				Decision:       hostapi.Decision{Kind: "mechanical"},
				MechanicalText: "【ticket-doctor 使用说明】",
			})
			return
		}
		_ = json.NewEncoder(w).Encode(hostapi.SubmitResult{
			Accepted:    true,
			Decision:    hostapi.Decision{Kind: "new_investigation"},
			SessionCode: "TD-abcd1234",
		})
	})
	mux.HandleFunc("/deliveries/claim", func(w http.ResponseWriter, _ *http.Request) {
		if f.claimed {
			_ = json.NewEncoder(w).Encode(hostapi.ClaimResponse{})
			return
		}
		f.claimed = true
		_ = json.NewEncoder(w).Encode(hostapi.ClaimResponse{Delivery: f.claimDelivery})
	})
	mux.HandleFunc("/deliveries/", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Outcome           string `json:"outcome"`
			ProviderMessageID string `json:"providerMessageId"`
			Error             string `json:"error"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.resultOutcome = body.Outcome
		f.resultMsgID = body.ProviderMessageID
		f.resultError = body.Error
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})
	return mux
}

func fakeLark() *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/v3/tenant_access_token/internal", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "tenant_access_token": "t-token", "expire": 3600})
	})
	mux.HandleFunc("/im/v1/messages/", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]string{"message_id": "om_reply"}})
	})
	return httptest.NewServer(mux)
}

func newTestCore(t *testing.T, host http.Handler, larkBase string, botOpenID string) *Adapter {
	t.Helper()
	hostSrv := httptest.NewServer(host)
	t.Cleanup(hostSrv.Close)
	cfg := config.Config{
		HostAPIBase: hostSrv.URL,
		Platforms:   []string{"feishu"},
		BotOpenID:   botOpenID,
		AppID:       "app_1",
		AppSecret:   "secret",
		LarkAPIBase: larkBase,
		HostTimeout: 2e9,
		LarkTimeout: 2e9,
	}
	platforms, err := BuildPlatforms(cfg)
	if err != nil {
		t.Fatalf("构建平台失败：%v", err)
	}
	return New(cfg, hostclient.New(hostSrv.URL, cfg.HostTimeout), platforms)
}

func corePlatform(t *testing.T, core *Adapter, name string) platform.Platform {
	t.Helper()
	p := core.Platform(name)
	if p == nil {
		t.Fatalf("平台未启用：%s", name)
	}
	return p
}

func groupEvent(mentioned bool) *feishu.ReceiveEvent {
	event := &feishu.ReceiveEvent{
		Sender: &feishu.Sender{SenderType: "user"},
		Message: &feishu.Message{
			MessageID:   "om_1",
			ChatID:      "oc_1",
			ChatType:    "group",
			MessageType: "text",
			Content:     `{"text":"checkout-service 报错"}`,
		},
	}
	event.Sender.SenderID.OpenID = "ou_user"
	if mentioned {
		event.Message.Mentions = []feishu.Mention{{Key: "@_user_1"}}
		event.Message.Mentions[0].ID.OpenID = "ou_bot"
	}
	return event
}

func eventBody(t *testing.T, event *feishu.ReceiveEvent) []byte {
	t.Helper()
	raw, err := json.Marshal(feishu.Envelope{Event: event})
	if err != nil {
		t.Fatalf("序列化事件失败：%v", err)
	}
	return raw
}

func TestHandleEventForwardsToHost(t *testing.T) {
	lark := fakeLark()
	defer lark.Close()
	fake := &fakeHost{}
	core := newTestCore(t, fake.handler(), lark.URL, "ou_bot")

	result, err := core.HandleEvent(context.Background(), corePlatform(t, core, "feishu"), eventBody(t, groupEvent(true)), nil)
	if err != nil {
		t.Fatalf("转发失败：%v", err)
	}
	if result.Status != "forwarded" || result.SessionCode != "TD-abcd1234" {
		t.Fatalf("结果异常：%+v", result)
	}
	if fake.forwarded.ChatID != "oc_1" || fake.forwarded.Text != "checkout-service 报错" {
		t.Fatalf("转发内容错误：%+v", fake.forwarded)
	}
}

func TestHandleEventForwardsUnmentionedGroupMessage(t *testing.T) {
	// 门控权威在 Host：适配器不再丢弃"群聊未 @"的消息，带 mentionedBot=false 原样转发
	lark := fakeLark()
	defer lark.Close()
	fake := &fakeHost{}
	core := newTestCore(t, fake.handler(), lark.URL, "ou_bot")

	result, err := core.HandleEvent(context.Background(), corePlatform(t, core, "feishu"), eventBody(t, groupEvent(false)), nil)
	if err != nil {
		t.Fatalf("不应报错：%v", err)
	}
	if result.Status != "forwarded" {
		t.Fatalf("未 @ 的群消息应转发 Host（门控在 Host），实际 %+v", result)
	}
	if fake.forwarded.ChatID != "oc_1" || fake.forwarded.MentionedBot {
		t.Fatalf("转发内容错误（mentionedBot 应如实携带 false）：%+v", fake.forwarded)
	}
}

func TestHandleEventSendsMechanicalReply(t *testing.T) {
	fake := &fakeHost{mechanical: true}
	hostSrv := httptest.NewServer(fake.handler())
	defer hostSrv.Close()
	replySeen := false
	lark := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/auth/") {
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "tenant_access_token": "t-token", "expire": 3600})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/im/v1/messages/") {
			replySeen = true
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]string{"message_id": "om_reply"}})
	}))
	defer lark.Close()
	cfg := config.Config{
		HostAPIBase: hostSrv.URL,
		Platforms:   []string{"feishu"},
		AppID:       "app_1",
		AppSecret:   "secret",
		LarkAPIBase: lark.URL,
		HostTimeout: 2e9,
		LarkTimeout: 2e9,
	}
	platforms, err := BuildPlatforms(cfg)
	if err != nil {
		t.Fatalf("构建平台失败：%v", err)
	}
	core := New(cfg, hostclient.New(hostSrv.URL, cfg.HostTimeout), platforms)

	help := groupEvent(true)
	help.Message.Content = `{"text":"-help"}`
	result, err := core.HandleEvent(context.Background(), corePlatform(t, core, "feishu"), eventBody(t, help), nil)
	if err != nil {
		t.Fatalf("不应报错：%v", err)
	}
	if result.Status != "mechanical_reply_sent" {
		t.Fatalf("mechanical 应由适配器发送并返回 mechanical_reply_sent，实际 %+v", result)
	}
	if !replySeen {
		t.Fatal("应对 fake lark 发起回复（线程内 reply）")
	}
}

func TestHandleEventMechanicalSendFailureIsBestEffort(t *testing.T) {
	fake := &fakeHost{mechanical: true}
	hostSrv := httptest.NewServer(fake.handler())
	defer hostSrv.Close()
	lark := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/auth/") {
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "tenant_access_token": "t-token", "expire": 3600})
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 500, "msg": "boom"})
	}))
	defer lark.Close()
	cfg := config.Config{
		HostAPIBase: hostSrv.URL,
		Platforms:   []string{"feishu"},
		AppID:       "app_1",
		AppSecret:   "secret",
		LarkAPIBase: lark.URL,
		HostTimeout: 2e9,
		LarkTimeout: 2e9,
	}
	platforms, err := BuildPlatforms(cfg)
	if err != nil {
		t.Fatalf("构建平台失败：%v", err)
	}
	core := New(cfg, hostclient.New(hostSrv.URL, cfg.HostTimeout), platforms)

	help := groupEvent(true)
	help.Message.Content = `{"text":"-help"}`
	result, err := core.HandleEvent(context.Background(), corePlatform(t, core, "feishu"), eventBody(t, help), nil)
	if err != nil {
		t.Fatalf("发送失败不应上抛（best-effort）：%v", err)
	}
	if result.Status != "ignored" || result.Reason != "mechanical_reply_failed" {
		t.Fatalf("发送失败应返回 ignored/mechanical_reply_failed，实际 %+v", result)
	}
}

func pkcs7Pad(data []byte) []byte {
	pad := aes.BlockSize - len(data)%aes.BlockSize
	for i := 0; i < pad; i++ {
		data = append(data, byte(pad))
	}
	return data
}

func encryptPayload(t *testing.T, key, plaintext string) string {
	t.Helper()
	sum := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	iv := sum[:aes.BlockSize]
	padded := pkcs7Pad([]byte(plaintext))
	out := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(out, padded)
	return base64.StdEncoding.EncodeToString(append(append([]byte{}, iv...), out...))
}

func signBody(key, timestamp, nonce string, body []byte) string {
	h := sha256.New()
	h.Write([]byte(timestamp))
	h.Write([]byte(nonce))
	h.Write([]byte(key))
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

func encryptedServer(t *testing.T, fake *fakeHost, larkBase, encryptKey string) *httptest.Server {
	t.Helper()
	hostSrv := httptest.NewServer(fake.handler())
	t.Cleanup(hostSrv.Close)
	cfg := config.Config{
		HostAPIBase: hostSrv.URL,
		Platforms:   []string{"feishu"},
		AppID:       "app_1",
		AppSecret:   "secret",
		EncryptKey:  encryptKey,
		LarkAPIBase: larkBase,
		HostTimeout: 2e9,
		LarkTimeout: 2e9,
	}
	platforms, err := BuildPlatforms(cfg)
	if err != nil {
		t.Fatalf("构建平台失败：%v", err)
	}
	core := New(cfg, hostclient.New(hostSrv.URL, cfg.HostTimeout), platforms)
	server := httptest.NewServer(NewServer(core).Handler())
	t.Cleanup(server.Close)
	return server
}

func TestServerHandlesEncryptedSignedEvent(t *testing.T) {
	lark := fakeLark()
	defer lark.Close()
	fake := &fakeHost{}
	server := encryptedServer(t, fake, lark.URL, "enc-key")

	event := `{"schema":"2.0","header":{"event_type":"im.message.receive_v1","token":"","app_id":"app_1"},"event":{"sender":{"sender_type":"user","sender_id":{"open_id":"ou_user"}},"message":{"message_id":"om_enc","chat_id":"oc_enc","chat_type":"p2p","message_type":"text","content":"{\"text\":\"checkout-service 报错\"}"}}}`
	body := []byte(`{"encrypt":"` + encryptPayload(t, "enc-key", event) + `"}`)
	timestamp, nonce := "1700000000", "nonce-1"

	req, _ := http.NewRequest(http.MethodPost, server.URL+"/feishu/events", bytes.NewReader(body))
	req.Header.Set("X-Lark-Request-Timestamp", timestamp)
	req.Header.Set("X-Lark-Request-Nonce", nonce)
	req.Header.Set("X-Lark-Signature", signBody("enc-key", timestamp, nonce, body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 %d", resp.StatusCode)
	}
	if fake.forwarded.Text != "checkout-service 报错" || fake.forwarded.ChatID != "oc_enc" {
		t.Fatalf("解密后未正确转发：%+v", fake.forwarded)
	}
}

func TestServerRejectsBadSignature(t *testing.T) {
	lark := fakeLark()
	defer lark.Close()
	fake := &fakeHost{}
	server := encryptedServer(t, fake, lark.URL, "enc-key")

	body := []byte(`{"encrypt":"whatever"}`)
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/feishu/events", bytes.NewReader(body))
	req.Header.Set("X-Lark-Request-Timestamp", "1")
	req.Header.Set("X-Lark-Request-Nonce", "n")
	req.Header.Set("X-Lark-Signature", "deadbeef")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("错误签名应 403，实际 %d", resp.StatusCode)
	}
}

func TestServerAnswersChallenge(t *testing.T) {
	lark := fakeLark()
	defer lark.Close()
	fake := &fakeHost{}
	server := encryptedServer(t, fake, lark.URL, "")

	body := []byte(`{"challenge":"c-xyz","token":"tok-1","type":"url_verification"}`)
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/feishu/events", bytes.NewReader(body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 %d", resp.StatusCode)
	}
	var out struct {
		Challenge string `json:"challenge"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.Challenge != "c-xyz" {
		t.Fatalf("challenge 未原样返回：%+v", out)
	}
	if fake.forwarded.ChatID != "" {
		t.Fatal("challenge 不应触发转发")
	}
}

func TestServerRejectsUnsupportedEventType(t *testing.T) {
	lark := fakeLark()
	defer lark.Close()
	fake := &fakeHost{}
	server := encryptedServer(t, fake, lark.URL, "")

	body := []byte(`{"schema":"2.0","header":{"event_type":"im.chat.member_bot.added_v1","token":"","app_id":"app_1"},"event":{}}`)
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/feishu/events", bytes.NewReader(body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 %d", resp.StatusCode)
	}
	var out struct {
		Status string `json:"status"`
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.Status != "ignored" || out.Reason != "unsupported_or_empty" {
		t.Fatalf("不支持的事件类型应忽略：%+v", out)
	}
	if fake.forwarded.ChatID != "" {
		t.Fatal("不支持的事件不应转发 Host")
	}
}

func TestServerUnknownPlatformRoute(t *testing.T) {
	lark := fakeLark()
	defer lark.Close()
	fake := &fakeHost{}
	server := encryptedServer(t, fake, lark.URL, "")

	req, _ := http.NewRequest(http.MethodPost, server.URL+"/dingtalk/events", bytes.NewReader([]byte(`{}`)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("未启用平台应 404，实际 %d", resp.StatusCode)
	}
}

func TestDeliveryLoopSendsAndReports(t *testing.T) {
	lark := fakeLark()
	defer lark.Close()
	fake := &fakeHost{
		claimDelivery: &hostapi.Delivery{
			ID:              "d1",
			Attempt:         1,
			Kind:            "report",
			Content:         "【预检报告】...",
			TargetMessageID: "om_target",
			ChatID:          "oc_1",
			Provider:        "feishu",
		},
	}
	core := newTestCore(t, fake.handler(), lark.URL, "ou_bot")

	if err := core.processOneDelivery(context.Background()); err != nil {
		t.Fatalf("投递失败：%v", err)
	}
	if fake.resultOutcome != "sent" || fake.resultMsgID != "om_reply" {
		t.Fatalf("应上报 sent + 平台消息 ID：outcome=%s id=%s", fake.resultOutcome, fake.resultMsgID)
	}
}

func TestDeliveryLoopRejectsUnknownProvider(t *testing.T) {
	lark := fakeLark()
	defer lark.Close()
	fake := &fakeHost{
		claimDelivery: &hostapi.Delivery{
			ID:       "d2",
			Attempt:  1,
			Kind:     "report",
			Content:  "【预检报告】...",
			ChatID:   "oc_9",
			Provider: "telegram",
		},
	}
	core := newTestCore(t, fake.handler(), lark.URL, "ou_bot")

	if err := core.processOneDelivery(context.Background()); err != nil {
		t.Fatalf("未知 provider 应上报 failed 而非报错：%v", err)
	}
	if fake.resultOutcome != "failed" || fake.resultError == "" {
		t.Fatalf("未知 provider 应上报 failed：outcome=%s err=%q", fake.resultOutcome, fake.resultError)
	}
}

func TestBuildPlatformsValidatesConfig(t *testing.T) {
	lark := fakeLark()
	defer lark.Close()

	feishuOnly := config.Config{Platforms: []string{"feishu"}, LarkAPIBase: lark.URL}
	platforms, err := BuildPlatforms(feishuOnly)
	if err != nil || len(platforms) != 1 || platforms[0].Name() != "feishu" {
		t.Fatalf("feishu 平台应可构建：err=%v platforms=%v", err, platforms)
	}
	if platforms[0].LongConn() != nil {
		t.Fatal("纯 Webhook 平台的 LongConn 应为 nil")
	}

	if _, err := BuildPlatforms(config.Config{Platforms: []string{"telegram"}}); err == nil {
		t.Fatal("未知平台应报错")
	}
	if _, err := BuildPlatforms(config.Config{Platforms: []string{"feishu", "feishu"}}); err == nil {
		t.Fatal("重复平台应报错")
	}
}
