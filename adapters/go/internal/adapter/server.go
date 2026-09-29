// HTTP 服务：承接平台事件回调（POST /{platform}/events，校验/challenge 由各平台实现），
// 并暴露健康检查。/feishu/events 即 platform=feishu，回调地址与单平台时期一致。
package adapter

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"

	"ticket-doctor/adapter/internal/platform"
)

type Server struct {
	adapter *Adapter
}

func NewServer(core *Adapter) *Server {
	return &Server{adapter: core}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /{platform}/events", s.handlePlatformEvent)
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

func (s *Server) handlePlatformEvent(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("platform")
	p := s.adapter.Platform(name)
	if p == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "未启用的平台：" + name})
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "读取请求体失败"})
		return
	}

	challenge, err := p.VerifyRequest(r, raw)
	if err != nil {
		status := http.StatusBadRequest
		var se *platform.StatusError
		if errors.As(err, &se) {
			status = se.Status
		}
		log.Printf("[adapter] 平台 %s 回调校验失败：%v", name, err)
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	// URL 校验：平台配置回调地址时会先发一次 challenge，原样返回即可。
	if challenge != "" {
		writeJSON(w, http.StatusOK, map[string]string{"challenge": challenge})
		return
	}

	result, err := s.adapter.HandleEvent(r.Context(), p, raw, r.Header)
	if err != nil {
		// Host 不可用等瞬态错误：返回 5xx，让平台按自身策略重投。
		log.Printf("[adapter] 平台 %s 事件处理失败：%v", name, err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "服务暂不可用"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      result.Status,
		"reason":      result.Reason,
		"sessionCode": result.SessionCode,
	})
}
