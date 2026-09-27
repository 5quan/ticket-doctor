// seed 文件：把已落库条目交给 pi 原生 SessionManager.open 能正确重建会话上下文。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { writeSeedFile } from "../../src/agent/seed-file.ts";

function user(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 0 },
  } as unknown as SessionEntry;
}

test("writeSeedFile + SessionManager.open 重建用户消息", () => {
  const dir = mkdtempSync(join(tmpdir(), "td-seed-"));
  const path = writeSeedFile(dir, [user("u1", "下单失败")]);
  const manager = SessionManager.open(path);
  const context = manager.buildSessionContext();
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].role, "user");
});
