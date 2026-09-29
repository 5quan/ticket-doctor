// IpcEvidenceSink：ACK 丢失重投幂等、reject 分类重试、超限失败（docs/evidence-uid-design.md §11 阶段 3 / D9）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { IpcEvidenceSink } from "../../src/evidence/ipc-sink.ts";
import { EvidenceCommitError } from "../../src/evidence/errors.ts";
import type { EvidenceCommitRequest, EvidenceRef } from "../../src/evidence/types.ts";

const REQ: EvidenceCommitRequest = {
  batchId: "batch-1",
  tool: "query_logs",
  toolCallId: "call-1",
  payloadHash: "hash-1",
  items: [{ kind: "log", source: "stub", excerpt: "boom" }],
  result: { count: 1 },
};

function ref(id: string): EvidenceRef {
  return { kind: "log", source: "stub", excerpt: "boom", evidenceUid: `uid-${id}`, evidenceId: id, truncated: false };
}

interface Harness {
  sink: IpcEvidenceSink;
  sent: Array<{ batchId: string; payloadHash: string }>;
  abort: AbortController;
}

function makeSink(over: Partial<{ maxAttempts: number; ackTimeoutMs: number; backoffMs: number }> = {}): Harness {
  const sent: Array<{ batchId: string; payloadHash: string }> = [];
  const abort = new AbortController();
  const sink = new IpcEvidenceSink({
    emit: (message) => sent.push({ batchId: message.batchId, payloadHash: message.payloadHash }),
    signal: abort.signal,
    maxAttempts: over.maxAttempts ?? 3,
    ackTimeoutMs: over.ackTimeoutMs ?? 20,
    backoffMs: over.backoffMs ?? 1,
  });
  return { sink, sent, abort };
}

test("首次 ack 即返回原 refs", async () => {
  const { sink, sent } = makeSink();
  const promise = sink.commit(REQ);
  assert.ok(sink.handleControl({ type: "evidence_ack", batchId: "batch-1", refs: [ref("E1")] }));
  const { refs } = await promise;
  assert.deepEqual(refs.map((r) => r.evidenceId), ["E1"]);
  assert.equal(sent.length, 1);
});

test("ACK 丢失：超时后重投同 batchId 同 payload，幂等拿到映射", async () => {
  const { sink, sent } = makeSink({ ackTimeoutMs: 40 });
  const promise = sink.commit(REQ);
  // 第一次尝试超时（40ms）重发后，在第二次尝试窗口内 ack
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sent.length, 2, "应已重发");
  assert.equal(sent[0]!.batchId, sent[1]!.batchId, "重发必须同 batchId");
  assert.equal(sent[0]!.payloadHash, sent[1]!.payloadHash, "重发必须同 payload");
  assert.ok(sink.handleControl({ type: "evidence_ack", batchId: "batch-1", refs: [ref("E2")] }));
  const { refs } = await promise;
  assert.deepEqual(refs.map((r) => r.evidenceId), ["E2"]);
});

test("internal 拒绝可重试，第二次 ack 成功", async () => {
  const { sink, sent } = makeSink();
  const promise = sink.commit(REQ);
  assert.ok(sink.handleControl({ type: "evidence_reject", batchId: "batch-1", code: "internal", message: "db busy" }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 2);
  assert.ok(sink.handleControl({ type: "evidence_ack", batchId: "batch-1", refs: [ref("E1")] }));
  await promise;
});

test("lease_lost / conflict 拒绝立即失败，不重试", async () => {
  for (const code of ["lease_lost", "conflict", "content_conflict"] as const) {
    const { sink, sent } = makeSink();
    const attempt = sink.commit(REQ);
    assert.ok(sink.handleControl({ type: "evidence_reject", batchId: REQ.batchId, code, message: "x" }));
    await assert.rejects(
      () => attempt,
      (err: unknown) => err instanceof EvidenceCommitError && err.code === code,
    );
    assert.equal(sent.length, 1, `${code} 不应重试`);
  }
});

test("internal 重试耗尽 → 本轮失败信号（抛错）", async () => {
  const sent: Array<{ batchId: string; payloadHash: string }> = [];
  const abort = new AbortController();
  let sink: IpcEvidenceSink;
  sink = new IpcEvidenceSink({
    emit: (message) => {
      sent.push({ batchId: message.batchId, payloadHash: message.payloadHash });
      // 每次 emit 都以 internal 拒绝，模拟 Host DB 故障
      setTimeout(() => {
        sink.handleControl({ type: "evidence_reject", batchId: message.batchId, code: "internal", message: "db busy" });
      }, 1);
    },
    signal: abort.signal,
    maxAttempts: 2,
    ackTimeoutMs: 50,
    backoffMs: 1,
  });
  await assert.rejects(
    () => sink.commit(REQ),
    (err: unknown) => err instanceof EvidenceCommitError && err.code === "internal",
  );
  assert.equal(sent.length, 2, "单次 commit 应重试到上限");
});

test("取消后不再提交", async () => {
  const { sink, abort, sent } = makeSink();
  abort.abort();
  await assert.rejects(
    () => sink.commit(REQ),
    (err: unknown) => err instanceof EvidenceCommitError && err.code === "cancelled",
  );
  assert.equal(sent.length, 0);
});

test("非证据回执的控制消息不被消费", () => {
  const { sink } = makeSink();
  assert.equal(sink.handleControl({ type: "cancel" }), false);
});
