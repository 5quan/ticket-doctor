import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EventStore } from "../../src/host/event-store.ts";
import { createHostServer, type HostServer } from "../../src/host/server.ts";
import { memoryStore, testConfig } from "../helpers.ts";

const store = memoryStore();
const config = testConfig();
const eventStore = new EventStore(store);
let host: HostServer;
let base = "";

before(async () => {
  host = createHostServer({ store, config, eventStore });
  const { port } = await host.listen();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  host.server.closeAllConnections?.();
  await host.close();
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("POST /api/agent/message 原子入队并返回轮次", async () => {
  const { status, json } = await post("/api/agent/message", {
    provider: "web",
    externalMessageId: "web:first",
    text: "checkout-service 下单报错",
  });
  assert.equal(status, 201);
  assert.equal(json.accepted, true);
  assert.equal(json.decision.kind, "new_investigation");
  assert.ok(json.investigationId && json.runId && json.sessionCode);
  assert.equal(json.round, 1);
});

test("重复 externalMessageId 不重复建轮次", async () => {
  const { json } = await post("/api/agent/message", {
    provider: "web",
    externalMessageId: "web:first",
    text: "重复投递",
  });
  assert.equal(json.accepted, false);
  assert.equal(json.decision.kind, "duplicate");
});

test("按 investigationId 续接同一调查并分配下一轮次", async () => {
  const first = await post("/api/agent/message", {
    provider: "web",
    externalMessageId: "web:continue-1",
    text: "checkout-service 超时",
  });
  const second = await post("/api/agent/message", {
    provider: "web",
    investigationId: first.json.investigationId,
    text: "补充：只在下单高峰出现",
  });
  assert.equal(second.json.accepted, true);
  assert.equal(second.json.investigationId, first.json.investigationId);
  assert.equal(second.json.round, 2);
});

test("GET 调查列表与详情包含消息/轮次", async () => {
  const list = await (await fetch(`${base}/api/agent/investigations`)).json();
  assert.ok(Array.isArray(list.investigations));
  assert.ok(list.investigations.length >= 1);
  const id = list.investigations[0].id;
  const detail = await (await fetch(`${base}/api/agent/investigations/${id}`)).json();
  assert.equal(detail.investigation.id, id);
  assert.ok(detail.messages.length >= 1);
  assert.ok(detail.runs.length >= 1);
});

test("取消与重试接口改变轮次状态", async () => {
  const created = await post("/api/agent/message", {
    provider: "web",
    externalMessageId: "web:cancel",
    text: "checkout-service 报错",
  });
  const runId = created.json.runId;
  const cancelled = await post(`/api/agent/runs/${runId}/cancel`, {});
  assert.equal(cancelled.json.status, "cancelled");
  const retried = await post(`/api/agent/runs/${runId}/retry`, {});
  assert.equal(retried.json.ok, true);
  assert.equal(retried.json.status, "queued");
});

test("SSE 先 replay 已保存事件，再推送新事件", async () => {
  const stream = "inv-sse-test";
  eventStore.publish(stream, "report", { reportId: "r1", completeness: "complete" });

  const controller = new AbortController();
  const res = await fetch(`${base}/api/agent/investigations/${stream}/events?lastEventId=0`, {
    signal: controller.signal,
  });
  assert.equal(res.headers.get("content-type")?.startsWith("text/event-stream"), true);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  let acc = "";
  const readUntil = async (marker: string) => {
    const deadline = Date.now() + 3000;
    while (!acc.includes(marker) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
    }
  };

  await readUntil("event: report");
  assert.match(acc, /id: \d+/);
  assert.match(acc, /"reportId":"r1"/);

  acc = "";
  eventStore.publish(stream, "run_started", { runId: "run-1" });
  await readUntil("event: run_started");
  assert.match(acc, /"runId":"run-1"/);

  controller.abort();
});
