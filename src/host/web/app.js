// ticket-doctor Web 会话页：无框架、无构建。
// 数据来源：Host Web API；实时进度：SSE（浏览器自带 Last-Event-ID 重连补发）。
(() => {
  "use strict";

  const EVENT_TYPES = [
    "message_accepted",
    "run_started",
    "prepared",
    "report",
    "reply",
    "run_error",
    "cancelled",
    "cancel_requested",
    "retry_requested",
  ];

  const state = {
    list: [],
    currentId: null,
    source: null,
    events: [],
  };

  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[ch]);
  }

  function fmtTime(ms) {
    if (!ms) return "";
    try {
      return new Date(Number(ms)).toLocaleString("zh-CN", { hour12: false });
    } catch {
      return String(ms);
    }
  }

  async function api(path, options) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  // ---------- 左侧列表 ----------

  async function loadList() {
    const data = await api("/api/agent/investigations");
    state.list = data.investigations || [];
    renderList();
  }

  function renderList() {
    const list = $("list");
    if (state.list.length === 0) {
      list.innerHTML = '<div class="muted">暂无调查</div>';
      return;
    }
    list.innerHTML = state.list
      .map((item) => {
        const active = item.id === state.currentId ? " active" : "";
        const status = item.latest_run_status || "无轮次";
        return `<button class="item${active}" data-id="${esc(item.id)}" type="button">
          <div class="item-title">${esc(item.title || item.session_code)}</div>
          <div class="item-meta">
            <span class="code">[TD-${esc(item.session_code)}]</span>
            <span class="tag tag-${esc(status)}">${esc(statusLabel(status))}</span>
          </div>
        </button>`;
      })
      .join("");
  }

  function statusLabel(status) {
    return (
      {
        queued: "排队中",
        running: "执行中",
        succeeded: "已完成",
        failed: "失败",
        cancelled: "已取消",
        interrupted: "已中断",
      }[status] || status
    );
  }

  // ---------- 详情 ----------

  async function openInvestigation(id) {
    state.currentId = id;
    renderList();
    const data = await api(`/api/agent/investigations/${encodeURIComponent(id)}`);
    renderDetail(data);
    subscribe(id);
  }

  function renderDetail(data) {
    $("empty").hidden = true;
    $("detail").hidden = false;
    const inv = data.investigation;

    $("detail-header").innerHTML = `
      <h2>${esc(inv.title || "Bug 预检")}</h2>
      <div class="meta">
        <span class="code">[TD-${esc(inv.session_code)}]</span>
        <span>来源：${esc(inv.provider)}</span>
        <span>服务：${esc(inv.service || "未指定")}</span>
        <span>轮次：${esc(inv.total_rounds)}</span>
      </div>`;

    renderTimeline(data);
    renderReport(data);
  }

  function renderTimeline(data) {
    const runsByMessage = new Map((data.runs || []).map((r) => [r.message_id, r]));
    const html = (data.messages || [])
      .map((m) => {
        const run = runsByMessage.get(m.id);
        const runRow = run
          ? `<div class="run">
               <span class="tag tag-${esc(run.status)}">${esc(statusLabel(run.status))}</span>
               <span class="muted">第 ${esc(run.round)} 轮 · ${esc(run.source)}</span>
               ${run.error_message ? `<div class="error">${esc(run.error_code)}: ${esc(run.error_message)}</div>` : ""}
               <span class="run-actions">
                 ${
                   run.status === "running" || run.status === "queued"
                     ? `<button data-action="cancel" data-run="${esc(run.id)}" type="button">取消</button>`
                     : ""
                 }
                 ${
                   run.status === "failed" || run.status === "cancelled"
                     ? `<button data-action="retry" data-run="${esc(run.id)}" type="button">重试</button>`
                     : ""
                 }
               </span>
             </div>`
          : "";
        return `<div class="msg">
            <div class="msg-head"><span class="from">${esc(m.sender_name || m.provider)}</span><span class="muted">${fmtTime(m.received_at)}</span></div>
            <div class="msg-body">${esc(m.text)}</div>
            ${runRow}
          </div>`;
      })
      .join("");
    $("timeline").innerHTML = html || '<div class="muted">还没有消息</div>';
  }

  function renderReport(data) {
    const report = data.report && data.report.content;
    if (!report) {
      $("report").innerHTML = "";
      return;
    }
    const evidenceById = new Map((data.evidence || []).map((e) => [e.evidence_id, e]));
    const evidenceText = (id) => {
      const e = evidenceById.get(id);
      return e ? `<span class="evidence" title="${esc(e.source)}">${esc(e.evidence_id)}</span>` : `<span class="evidence">${esc(id)}</span>`;
    };
    const list = (items) => (items && items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : '<div class="muted">无</div>');

    $("report").innerHTML = `
      <h2>预检报告 <span class="tag tag-${report.completeness}">${report.completeness === "complete" ? "材料完整" : "材料不完整"}</span></h2>
      <p class="summary">${esc(report.summary)}</p>
      <h3>已确认事实</h3>${list(report.confirmedFacts)}
      <h3>根因假设</h3>
      ${
        report.hypotheses && report.hypotheses.length
          ? `<ul>${report.hypotheses
              .map(
                (h) =>
                  `<li>${esc(h.cause)} <span class="muted">（${esc(h.status)} / ${esc(h.confidence)}）</span> ${(h.evidenceIds || [])
                    .map(evidenceText)
                    .join(" ")}</li>`,
              )
              .join("")}</ul>`
          : '<div class="muted">暂无足够材料形成假设</div>'
      }
      <h3>缺失材料</h3>${list(report.missingMaterial)}
      <h3>不确定性</h3>${list(report.uncertainties)}
      <h3>建议验证步骤</h3>${list(report.nextSteps)}
      ${
        report.corrections && report.corrections.length
          ? `<h3>程序强制修正</h3>${list(report.corrections)}`
          : ""
      }
      <h3>证据（${(data.evidence || []).length}）</h3>
      ${
        data.evidence && data.evidence.length
          ? `<ul class="evidence-list">${data.evidence
              .map(
                (e) =>
                  `<li><span class="evidence">${esc(e.evidence_id)}</span> <span class="muted">${esc(e.source)}</span><pre>${esc(
                    e.excerpt,
                  )}</pre></li>`,
              )
              .join("")}</ul>`
          : '<div class="muted">无</div>'
      }`;
  }

  // ---------- SSE ----------

  function subscribe(id) {
    if (state.source) {
      state.source.close();
      state.source = null;
    }
    state.events = [];
    $("events").innerHTML = "";
    setConn("连接中…", "pending");

    const source = new EventSource(`/api/agent/investigations/${encodeURIComponent(id)}/events`);
    state.source = source;

    source.onopen = () => setConn("已连接（实时）", "on");
    source.onerror = () => setConn("连接断开，自动重连中…", "off");
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        let payload = {};
        try {
          payload = JSON.parse(event.data || "{}");
        } catch {
          payload = { raw: event.data };
        }
        pushEvent(type, event.lastEventId, payload);
        refreshCurrent();
      });
    }
  }

  function pushEvent(type, id, payload) {
    state.events.push({ type, id, payload, at: Date.now() });
    if (state.events.length > 200) state.events.shift();
    const el = $("events");
    const row = document.createElement("div");
    row.className = `event event-${type}`;
    row.innerHTML = `<span class="event-type">${esc(type)}</span> <span class="muted">#${esc(id)}</span> <span class="event-detail">${esc(
      summarize(payload),
    )}</span>`;
    el.prepend(row);
  }

  function summarize(payload) {
    if (!payload || typeof payload !== "object") return "";
    if (payload.text) return String(payload.text).slice(0, 80);
    if (payload.completeness) return `材料${payload.completeness}`;
    if (payload.message) return String(payload.message).slice(0, 80);
    if (payload.reason) return String(payload.reason);
    return Object.keys(payload).join(", ");
  }

  function setConn(text, cls) {
    const el = $("conn");
    el.textContent = text;
    el.className = `conn conn-${cls}`;
  }

  let refreshTimer = null;
  function refreshCurrent() {
    if (!state.currentId) return;
    if (refreshTimer) return;
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      try {
        await Promise.all([loadList(), openInvestigationSilently(state.currentId)]);
      } catch {
        /* 忽略瞬时错误 */
      }
    }, 300);
  }

  async function openInvestigationSilently(id) {
    const data = await api(`/api/agent/investigations/${encodeURIComponent(id)}`);
    renderDetail(data);
  }

  // ---------- 交互 ----------

  document.addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const item = target.closest(".item");
    if (item && item.dataset.id) {
      await openInvestigation(item.dataset.id);
      return;
    }

    if (target.id === "new-btn") {
      const text = window.prompt("描述 Bug（服务名、发生时间、现象）：");
      if (!text) return;
      const res = await api("/api/agent/message", {
        method: "POST",
        body: JSON.stringify({ provider: "web", text, senderName: "web" }),
      });
      if (res.investigationId) {
        await loadList();
        await openInvestigation(res.investigationId);
      }
      return;
    }

    const action = target.dataset.action;
    if (action && target.dataset.run) {
      const runId = target.dataset.run;
      await api(`/api/agent/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST", body: "{}" });
      refreshCurrent();
    }
  });

  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const textarea = $("text");
    const text = textarea.value.trim();
    if (!text || !state.currentId) return;
    textarea.value = "";
    await api("/api/agent/message", {
      method: "POST",
      body: JSON.stringify({ provider: "web", investigationId: state.currentId, text, senderName: "web" }),
    });
    refreshCurrent();
  });

  $("text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });

  // 初始化
  loadList().catch((err) => setConn(`加载失败：${err.message}`, "off"));
})();
