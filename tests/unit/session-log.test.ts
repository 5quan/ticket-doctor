// 会话日志：append-only JSONL、token 汇总、torn-write 恢复。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSessionLog, SessionLog } from "../../src/diagnosis/session-log.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "td-session-"));
}

test("SessionLog 写入 header + typed events，seq 单调递增", () => {
  const dir = tmp();
  const log = SessionLog.open({ dir, runId: "r1", attemptId: "a1", investigationId: "i1", cwd: "/tmp" });
  assert.equal(log.append("message", { role: "user", content: "hi" }), 1);
  assert.equal(log.append("tool_started", { tool: "query_logs", input: {} }), 2);
  assert.equal(log.summary().lastSeq, 2);

  const entries = readSessionLog(log.path);
  assert.equal(entries[0].type, "session");
  assert.equal(entries[0].runId, "r1");
  assert.equal(entries[1].seq, 1);
  assert.equal(entries[1].type, "message");
  assert.equal(entries[2].seq, 2);
  assert.equal(entries[2].type, "tool_started");
});

test("recordUsage 累计 token 汇总", () => {
  const dir = tmp();
  const log = SessionLog.open({ dir, runId: "r1", attemptId: "a1", investigationId: "i1", cwd: "/tmp" });
  log.recordUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  log.recordUsage({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  const s = log.summary();
  assert.equal(s.inputTokens, 30);
  assert.equal(s.outputTokens, 15);
  assert.equal(s.totalTokens, 45);
});

test("readSessionLog 丢弃末尾半写行（torn-write 恢复），中间损坏抛错", () => {
  const dir = tmp();
  const torn = join(dir, "torn.jsonl");
  writeFileSync(torn, '{"seq":1,"type":"message","data":{}}\n{"seq":2,"type":"tool_');
  const entries = readSessionLog(torn);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].seq, 1);

  const bad = join(dir, "bad.jsonl");
  writeFileSync(bad, '{"seq":1}\nnot-json\n{"seq":3}\n');
  assert.throws(() => readSessionLog(bad), /损坏/);
});
