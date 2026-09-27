// 一次性 seed 文件：pi 0.84.2 的 `SessionManager.inMemory` 不接受初始 entries，
// 因此把已落库条目写成临时 JSONL 交给 `SessionManager.open` 原生加载/重建。
// SQLite 仍是唯一真相源；该文件 run 后即删。
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "@earendil-works/pi-coding-agent";

export function writeSeedFile(dir: string, entries: SessionEntry[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `seed-${randomUUID()}.jsonl`);
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  const lines = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}
