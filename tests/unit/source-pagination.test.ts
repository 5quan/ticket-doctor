// 材料源分页与覆盖信息（backlog T7）：数量上限不再静默切片，"返回 N 条"不再冒充"只有 N 条"。
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DiagnosisToolbox } from "../../src/agent/toolbox.ts";
import { MemoryEvidenceSink } from "../../src/evidence/memory-sink.ts";
import { GitCodeSource, MultiRepoCodeSource } from "../../src/sources/code.ts";
import { FileLogSource } from "../../src/sources/logs.ts";

const WINDOW = { from: Date.parse("2026-01-01T00:00:00Z"), to: Date.parse("2026-01-02T00:00:00Z") };

function logDirWith(lines: number): string {
  const dir = mkdtempSync(join(tmpdir(), "td-page-"));
  const rows = Array.from(
    { length: lines },
    (_, i) => `2026-01-01T10:00:${String(i).padStart(2, "0")}.000Z\tERROR\tboom ${i}`,
  );
  writeFileSync(join(dir, "svc.log"), `${rows.join("\n")}\n`);
  return dir;
}

function logToolbox(dir: string, maxEntries: number): DiagnosisToolbox {
  return new DiagnosisToolbox({
    logs: new FileLogSource({ dir, allowedServices: undefined, maxEntries }),
    sink: new MemoryEvidenceSink(),
    scope: { services: ["svc"], repos: [], timeWindow: WINDOW },
    maxToolCalls: 12,
    maxToolResultChars: 8_000,
    maxEvidenceChars: 4_000,
    signal: new AbortController().signal,
  });
}

test("FileLogSource 分页给出总数/是否还有/续查位置，cursor 可继续", async () => {
  const dir = logDirWith(5);
  try {
    const source = new FileLogSource({ dir, allowedServices: undefined, maxEntries: 2 });
    const sig = new AbortController().signal;

    const first = await source.query({ service: "svc", ...WINDOW, keywords: [] }, sig);
    assert.equal(first.items.length, 2);
    assert.equal(first.total, 5);
    assert.equal(first.truncated, true);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, "2");

    const second = await source.query({ service: "svc", ...WINDOW, keywords: [], cursor: first.nextCursor }, sig);
    assert.equal(second.items.length, 2);
    assert.equal(second.nextCursor, "4");

    const third = await source.query({ service: "svc", ...WINDOW, keywords: [], cursor: second.nextCursor }, sig);
    assert.equal(third.items.length, 1);
    assert.equal(third.hasMore, false);
    assert.equal(third.nextCursor, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("query_logs 返回覆盖信息（总数 / 截断 / 续查 cursor）", async () => {
  const dir = logDirWith(5);
  try {
    const out = await logToolbox(dir, 2).queryLogs({ service: "svc", from: WINDOW.from, to: WINDOW.to, keywords: [] });
    assert.match(out, /命中 2 条日志/);
    assert.match(out, /返回 2\/5 条；已截断，仍有更多；续查 cursor="2"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("空结果显式标注（与查询失败/越权区分）", async () => {
  const dir = logDirWith(5);
  try {
    const out = await logToolbox(dir, 2).queryLogs({
      service: "svc",
      from: WINDOW.from,
      to: WINDOW.to,
      keywords: ["no-such-keyword"],
    });
    assert.match(out, /^（无结果：/);
    assert.match(out, /返回 0\/0 条；已全部返回/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function gitRepoWithFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "td-page-repo-"));
  writeFileSync(join(dir, name), body);
  execSync("git init -q && git add . && git -c user.email=t@example -c user.name=t commit -qm init", { cwd: dir });
  return dir;
}

test("search_code 分页给出总数与续查位置，cursor 可取下一页剩余命中", async () => {
  const dir = gitRepoWithFile("Big.java", `${Array.from({ length: 60 }, (_, i) => `// needle ${i}`).join("\n")}\n`);
  try {
    const git = await GitCodeSource.create(dir, { repoId: "big" });
    const sig = new AbortController().signal;

    const first = await git.search({ pattern: "needle" }, sig);
    assert.equal(first.items.length, 50);
    assert.equal(first.total, 60);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, "50");

    const next = await git.search({ pattern: "needle", cursor: first.nextCursor }, sig);
    assert.equal(next.items.length, 10);
    assert.equal(next.hasMore, false);
    assert.equal(next.nextCursor, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_code 分页给文件总行数与续读起点，startLine 作为续读位置", async () => {
  const dir = gitRepoWithFile("Long.java", `${Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
  try {
    const git = await GitCodeSource.create(dir, { repoId: "big" });
    const sig = new AbortController().signal;

    const first = await git.read({ path: "Long.java" }, sig);
    assert.equal(first.items.length, 200);
    assert.equal(first.total, 300);
    assert.equal(first.truncated, false);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, "201");

    const next = await git.read({ path: "Long.java", startLine: 201 }, sig);
    assert.equal(next.items.length, 100);
    assert.equal(next.hasMore, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search_code 覆盖信息随工具返回渲染给模型", async () => {
  const dir = gitRepoWithFile("Big.java", `${Array.from({ length: 60 }, (_, i) => `// needle ${i}`).join("\n")}\n`);
  try {
    const git = await GitCodeSource.create(dir, { repoId: "big" });
    const toolbox = new DiagnosisToolbox({
      logs: { name: "stub", async query() { return { items: [], total: 0, truncated: false, hasMore: false }; } },
      code: new MultiRepoCodeSource([git]),
      sink: new MemoryEvidenceSink(),
      scope: { services: [], repos: [] },
      maxToolCalls: 12,
      maxToolResultChars: 8_000,
      maxEvidenceChars: 4_000,
      signal: new AbortController().signal,
    });
    const out = await toolbox.searchCode({ pattern: "needle" });
    assert.match(out, /返回 50\/60 条；已截断，仍有更多；续查 cursor="50"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
