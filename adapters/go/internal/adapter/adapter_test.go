package adapter

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ticket-doctor/adapter/internal/config"
	"ticket-doctor/adapter/internal/feishu"
	"ticket-doctor/adapter/internal/hostapi"
	"ticket-doctor/adapter/internal/hostclient"
)

type fakeHost struct {
	forwarded     hostapi.Message
	claimDelivery *hostapi.Delivery
	claimed       bool
	resultOutcome string
	resultMsgID   string
}

func (f *fakeHost) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/message", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&f.forwarded)
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
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.resultOutcome = body.Outcome
		f.resultMsgID = body.ProviderMessageID
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

func newTestAdapter(t *testing.T, host http.Handler, larkBase string, botOpenID string) *Adapter {
	t.Helper()
	hostSrv := httptest.NewServer(host)
	t.Cleanup(hostSrv.Close)
	cfg := config.Config{
		HostAPIBase:    hostSrv.URL,
		RequireMention: true,
		BotOpenID:      botOpenID,
		AppID:          "app_1",
		AppSecret:      "secret",
		LarkAPIBase:    larkBase,
		HostTimeout:    2e9,
		LarkTimeout:    2e9,
	}
	return New(cfg, hostclient.New(hostSrv.URL, cfg.HostTimeout), feishu.New(cfg.AppID, cfg.AppSecret, larkBase, cfg.LarkTimeout))
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

func TestHandleEventForwardsToHost(t *testing.T) {
	lark := fakeLark()
	defer lark.Close()
	fake := &fakeHost{}
	core := newTestAdapter(t, fake.handler(), lark.URL, "ou_bot")

	result, err := core.HandleEvent(context.Background(), groupEvent(true))
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

func TestHandleEventMentionGateFailsClosed(t *testing.T) {
	lark := fakeLark()
	defer lark.Close()
	fake := &fakeHost{}
	core := newTestAdapter(t, fake.handler(), lark.URL, "ou_bot")

	result, err := core.HandleEvent(context.Background(), groupEvent(false))
	if err != nil {
		t.Fatalf("不应报错：%v", err)
	}
	if result.Status != "ignored" || result.Reason != "mention_required" {
		t.Fatalf("未 @ 的群消息应 fail-closed：%+v", result)
	}
	if fake.forwarded.ChatID != "" {
		t.Fatal("被门控的消息不应转发 Host")
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
	core := newTestAdapter(t, fake.handler(), lark.URL, "ou_bot")

	if err := core.processOneDelivery(context.Background()); err != nil {
		t.Fatalf("投递失败：%v", err)
	}
	if fake.resultOutcome != "sent" || fake.resultMsgID != "om_reply" {
		t.Fatalf("应上报 sent + 平台消息 ID：outcome=%s id=%s", fake.resultOutcome, fake.resultMsgID)
	}
}
