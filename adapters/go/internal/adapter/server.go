// HTTP 服务：承接飞书事件回调（含 URL 校验与签名 token 校验），并暴露健康检查。
package adapter

import (
	"encoding/json"
	"io"
	"log"
	"net/http"

	"ticket-doctor/adapter/internal/config"
	"ticket-doctor/adapter/internal/feishu"
)

type Server struct {
	cfg     config.Config
	adapter *Adapter
}

func NewServer(cfg config.Config, adapter *Adapter) *Server {
	return &Server{cfg: cfg, adapter: adapter}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/feishu/events", s.handleFeishuEvent)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	return mux
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (s *Server) handleFeishuEvent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "读取请求体失败"})
		return
	}
	var envelope feishu.Envelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "非法 JSON"})
		return
	}

	// URL 校验：飞书配置回调地址时会先发一次 challenge。
	if envelope.Challenge != "" {
		if s.cfg.VerificationToken != "" && envelope.Token != s.cfg.VerificationToken {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "verification token 不匹配"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"challenge": envelope.Challenge})
		return
	}

	if s.cfg.VerificationToken != "" && envelope.Header.Token != s.cfg.VerificationToken {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "verification token 不匹配"})
		return
	}

	if envelope.Header.EventType != "im.message.receive_v1" {
		writeJSON(w, http.StatusOK, map[string]any{"ignored": true, "reason": "unhandled_event_type"})
		return
	}

	result, err := s.adapter.HandleEvent(r.Context(), envelope.Event)
	if err != nil {
		// Host 不可用：返回 5xx，让飞书按平台策略重投。
		log.Printf("[adapter] 转发 Host 失败：%v", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "服务暂不可用"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      result.Status,
		"reason":      result.Reason,
		"sessionCode": result.SessionCode,
	})
}
