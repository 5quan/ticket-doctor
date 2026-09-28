// Host Web Channel：HTTP API + SSE，是 Web 前端与 Go 接入适配器的统一入口。
//
// 职责边界（对齐平台文档 03/04）：
//   * 只负责"接收消息 → 原子入队"、"查询会话"、"SSE 推送"、"取消/重试"；
//   * 不做平台鉴权与协议解析（由 Go 接入适配器负责）；
//   * 不直接跑诊断：诊断由 worker/Runner 执行，结果通过 EventStore 推送。
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config/index.ts";
import type { InboundMessage } from "../domain/types.ts";
import { routeInbound } from "../intake/router.ts";
import type { Store } from "../storage/store.ts";
import type { EventStore, HostEvent } from "./event-store.ts";

export interface HostServerDeps {
  store: Store;
  config: AppConfig;
  eventStore: EventStore;
}

export interface HostServer {
  /** 仅测试用：直接访问底层 http server。 */
  server: Server;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

// Web 会话页面：无框架、无构建的静态页，由 Host 直接托管。
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};
const staticCache = new Map<string, string>();

function serveStatic(res: ServerResponse, name: keyof typeof STATIC_FILES): void {
  const entry = STATIC_FILES[name];
  let body = staticCache.get(entry.file);
  if (body === undefined) {
    try {
      body = readFileSync(join(WEB_DIR, entry.file), "utf8");
    } catch {
      sendJson(res, 500, { error: `缺少 Web 资源：${entry.file}` });
      return;
    }
    staticCache.set(entry.file, body);
  }
  res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-cache" });
  res.end(body);
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS });
  res.end(text);
}

function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** 把任意入口的请求归一化为平台无关的入站消息（Web 由 Host 直接归一化）。 */
export function normalizeHostMessage(
  body: Record<string, unknown>,
  now = Date.now(),
): InboundMessage {
  const provider = body.provider === "feishu" ? "feishu" : "web";
  const text = String(body.text ?? "");
  const chatType = body.chatType === "p2p" ? "p2p" : "group";
  return {
    provider,
    accountId: typeof body.accountId === "string" && body.accountId ? body.accountId : provider,
    externalMessageId:
      typeof body.externalMessageId === "string" && body.externalMessageId
        ? body.externalMessageId
        : `${provider}:${randomUUID()}`,
    chatId:
      typeof body.chatId === "string" && body.chatId
        ? body.chatId
        : typeof body.investigationId === "string" && body.investigationId
          ? body.investigationId
          : "web",
    chatType,
    rootId: typeof body.rootId === "string" ? body.rootId : undefined,
    threadId: typeof body.threadId === "string" ? body.threadId : undefined,
    parentId: typeof body.parentId === "string" ? body.parentId : undefined,
    // Web 与已鉴权的适配器请求不需要 @ 门控。
    mentionedBot: provider === "web" ? true : body.mentionedBot === true,
    senderId: typeof body.senderId === "string" ? body.senderId : undefined,
    senderName: typeof body.senderName === "string" ? body.senderName : undefined,
    text,
    receivedAt: typeof body.receivedAt === "number" ? body.receivedAt : now,
  };
}

function sseWrite(res: ServerResponse, event: HostEvent): void {
  const data = event.payload === null || event.payload === undefined ? {} : event.payload;
  res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createHostServer(deps: HostServerDeps): HostServer {
  const { store, config, eventStore } = deps;

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // Web 会话页面（无框架静态资源）
    if (req.method === "GET" && path in STATIC_FILES) {
      return serveStatic(res, path as keyof typeof STATIC_FILES);
    }

    if (req.method === "GET" && path === "/api/agent/capabilities") {
      return sendJson(res, 200, {
        engine: config.diagnosis.engine,
        tools: ["query_logs", "list_files", "search_code", "read_code", "request_info", "submit_report"],
        maxWorkers: config.scheduler.workerCount,
        sources: ["feishu", "web"],
      });
    }

    if (req.method === "GET" && path === "/api/agent/investigations") {
      return sendJson(res, 200, { investigations: store.listInvestigations(Number(url.searchParams.get("limit") ?? 50)) });
    }

    const detail = path.match(/^\/api\/agent\/investigations\/([^/]+)$/);
    if (req.method === "GET" && detail) {
      const investigation = store.getInvestigation(detail[1]);
      if (!investigation) return sendJson(res, 404, { error: "调查不存在" });
      const report = store.getLatestReportByInvestigation(investigation.id);
      return sendJson(res, 200, {
        investigation,
        messages: store.listMessages(investigation.id),
        runs: store.listRunsByInvestigation(investigation.id),
        report: report ? { ...report, content: safeParse(report.content) } : null,
        evidence: report ? store.listEvidence(report.run_id) : [],
      });
    }

    const events = path.match(/^\/api\/agent\/investigations\/([^/]+)\/events$/);
    if (req.method === "GET" && events) {
      return openEventStream(req, res, events[1], url);
    }

    if (req.method === "POST" && path === "/api/agent/message") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const text = String(body.text ?? "").trim();
      if (!text) return sendJson(res, 400, { error: "text 不能为空" });
      const message = normalizeHostMessage(body);
      const forcedInvestigationId =
        typeof body.investigationId === "string" ? body.investigationId : undefined;
      const result = routeInbound(store, config, message, { forcedInvestigationId });
      if (result.decision.kind === "duplicate") {
        return sendJson(res, 200, { accepted: false, decision: result.decision });
      }
      if (result.decision.kind === "unroutable" || result.decision.kind === "ignored") {
        return sendJson(res, 200, { accepted: false, decision: result.decision });
      }
      eventStore.publish(result.investigationId!, "message_accepted", {
        runId: result.runId,
        round: result.round,
        source: message.provider,
        text,
      });
      return sendJson(res, 201, { accepted: true, ...result });
    }

    const cancel = path.match(/^\/api\/agent\/runs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancel) {
      const run = store.getRun(cancel[1]);
      if (!run) return sendJson(res, 404, { error: "轮次不存在" });
      const result = store.requestCancel(run.id);
      eventStore.publish(run.investigation_id, "cancel_requested", {
        runId: run.id,
        status: result.status,
      });
      return sendJson(res, 200, result);
    }

    // ---- 出站投递交给外部平台适配器（Go）发送，Host 保持可靠状态机 ----
    if (req.method === "POST" && path === "/api/agent/deliveries/claim") {
      store.recoverExpiredDeliveries();
      const delivery = store.claimNextDelivery(config.scheduler.leaseMs);
      if (!delivery) return sendJson(res, 200, { delivery: null });
      const investigation = store.getInvestigation(delivery.investigation_id);
      return sendJson(res, 200, {
        delivery: {
          id: delivery.id,
          attempt: delivery.attempt,
          kind: delivery.kind,
          content: delivery.content,
          targetMessageId: delivery.target_message_id,
          chatId: investigation?.chat_id ?? null,
          provider: investigation?.provider ?? null,
          sessionCode: investigation?.session_code ?? null,
        },
      });
    }

    const deliveryResult = path.match(/^\/api\/agent\/deliveries\/([^/]+)\/result$/);
    if (req.method === "POST" && deliveryResult) {
      const body = (await readBody(req)) as Record<string, unknown>;
      const outcome = body.outcome;
      if (outcome !== "sent" && outcome !== "retry" && outcome !== "uncertain" && outcome !== "failed") {
        return sendJson(res, 400, { error: "outcome 非法" });
      }
      const attempt = Number(body.attempt);
      // 重试次数上限由 Host 掌控：适配器只报“可重试”，超限即落 failed，避免无限重试。
      const effectiveOutcome = outcome === "retry" && attempt >= config.delivery.maxAttempts ? "failed" : outcome;
      const ok = store.settleDelivery({
        id: deliveryResult[1],
        attempt,
        outcome: effectiveOutcome,
        providerMessageId: typeof body.providerMessageId === "string" ? body.providerMessageId : undefined,
        error: typeof body.error === "string" ? body.error : undefined,
        // 退避策略留在 Host：重试等待随时间递增，避免适配器侧自旋。
        availableAt:
          effectiveOutcome === "retry"
            ? Date.now() + config.delivery.baseBackoffMs * Math.max(1, attempt)
            : undefined,
      });
      return sendJson(res, ok ? 200 : 409, { ok });
    }

    const retry = path.match(/^\/api\/agent\/runs\/([^/]+)\/retry$/);
    if (req.method === "POST" && retry) {
      const run = store.getRun(retry[1]);
      if (!run) return sendJson(res, 404, { error: "轮次不存在" });
      const ok = store.retryRun(run.id);
      if (ok) {
        eventStore.publish(run.investigation_id, "retry_requested", { runId: run.id });
      }
      return sendJson(res, ok ? 200 : 409, { ok, status: store.getRun(run.id)?.status });
    }

    return sendJson(res, 404, { error: "not found" });
  }

  function openEventStream(
    req: IncomingMessage,
    res: ServerResponse,
    investigationId: string,
    url: URL,
  ): void {
    const lastEventId =
      Number(req.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? 0) || 0;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...CORS_HEADERS,
    });
    res.write("retry: 3000\n\n");

    // replay 与 subscribe 均为同步调用，期间不会插入新事件，故不会遗漏/乱序。
    for (const event of eventStore.replay(investigationId, lastEventId, config.host.sseReplayLimit)) {
      sseWrite(res, event);
    }
    const unsubscribe = eventStore.subscribe(investigationId, (event) => sseWrite(res, event));
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  return {
    server,
    listen(): Promise<{ host: string; port: number }> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.host.port, config.host.host, () => {
          const address = server.address();
          const port = typeof address === "object" && address ? address.port : config.host.port;
          resolve({ host: config.host.host, port });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
