// 工具箱：单次结果总量上限，防止信息爆炸。
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DiagnosisToolbox } from "../../src/agent/toolbox.ts";
import { MemoryEvidenceSink } from "../../src/evidence/memory-sink.ts";
import { GitCodeSource, MultiRepoCodeSource } from "../../src/sources/code.ts";
import type { LogSource } from "../../src/sources/logs.ts";
import type { MaterialScope } from "../../src/domain/types.ts";

const scope: MaterialScope = { services: ["svc"], repos: [] };

function toolboxWith(logs: LogSource, maxToolResultChars: number): DiagnosisToolbox {
  return new DiagnosisToolbox({
    logs,
    sink: new MemoryEvidenceSink(),
    scope,
    maxToolCalls: 12,
    maxToolResultChars,
    maxEvidenceChars: 4_000,
    signal: new AbortController().signal,
  });
}

test("query_logs 结果总量超过预算时截断并提示", async () => {
  const logs: LogSource = {
    name: "stub",
    async query() {
      return Array.from({ length: 20 }, (_, i) => ({
        time: 1_700_000_000_000 + i,
        level: "ERROR",
        message: "x".repeat(500),
      }));
    },
  };
  const toolbox = toolboxWith(logs, 1_000);
  const out = await toolbox.queryLogs({ service: "svc", from: 0, to: 2_000_000_000_000, keywords: [] });

  assert.match(out, /命中 20 条日志/);
  assert.match(out, /结果已截断/);
  assert.ok(out.length < 1_600, `输出应接近预算，实际 ${out.length}`);
});

test("list_files 列出钉死版本的文件路径并签发证据", async () => {
  const repoDir = join(process.cwd(), "fixtures", "demo-repo");
  const git = await GitCodeSource.create(repoDir, { repoId: "app" });
  const toolbox = new DiagnosisToolbox({
    logs: { name: "stub", async query() { return []; } },
    code: new MultiRepoCodeSource([git]),
    sink: new MemoryEvidenceSink(),
    scope: { services: [], repos: [] },
    maxToolCalls: 12,
    maxToolResultChars: 8_000,
    maxEvidenceChars: 4_000,
    signal: new AbortController().signal,
  });

  const out = await toolbox.listFiles({ glob: "OrderService" });
  assert.match(out, /\[E1\]/);
  assert.match(out, /OrderService\.java/);

  const empty = await toolbox.listFiles({ glob: "NoSuchFileAnywhere" });
  assert.match(empty, /没有匹配的文件路径/);
});

test("条目较少时不截断", async () => {
  const logs: LogSource = {
    name: "stub",
    async query() {
      return [{ time: 1_700_000_000_000, level: "ERROR", message: "boom" }];
    },
  };
  const toolbox = toolboxWith(logs, 8_000);
  const out = await toolbox.queryLogs({ service: "svc", from: 0, to: 2_000_000_000_000, keywords: [] });
  assert.match(out, /\[E1\]/);
  assert.doesNotMatch(out, /结果已截断/);
});

function codeToolbox(git: GitCodeSource, sink: MemoryEvidenceSink, maxToolResultChars: number): DiagnosisToolbox {
  return new DiagnosisToolbox({
    logs: { name: "stub", async query() { return []; } },
    code: new MultiRepoCodeSource([git]),
    sink,
    scope: { services: [], repos: [] },
    maxToolCalls: 12,
    maxToolResultChars,
    maxEvidenceChars: 4_000,
    signal: new AbortController().signal,
  });
}

test("search_code 多处命中时输出文件清单与带 E# 的预览", async () => {
  const repoDir = join(process.cwd(), "fixtures", "demo-repo");
  const git = await GitCodeSource.create(repoDir, { repoId: "app" });
  const sink = new MemoryEvidenceSink();
  const toolbox = codeToolbox(git, sink, 8_000);

  const out = await toolbox.searchCode({ pattern: "null" });
  assert.match(out, /命中 4 处代码，分布在 2 个文件/);
  assert.match(out, /OrderService\.java: 命中 3 处/);
  assert.match(out, /InventoryClient\.java: 命中 1 处/);
  // 4 处命中低于预览上限时全部展示，每处带 [E#]
  for (const id of ["E1", "E2", "E3", "E4"]) assert.match(out, new RegExp(`\\[${id}\\] \\S+:\\d+: `));
  assert.doesNotMatch(out, /未预览/);
  assert.equal(sink.all().length, 4);
});

test("search_code 预览条数有界，未预览的命中也登记证据", async () => {
  const dir = mkdtempSync(join(tmpdir(), "td-search-"));
  try {
    writeFileSync(join(dir, "Big.java"), `${Array.from({ length: 12 }, (_, i) => `// needle line ${i}`).join("\n")}\n`);
    execSync("git init -q && git add . && git -c user.email=t@example -c user.name=t commit -qm init", { cwd: dir });
    const git = await GitCodeSource.create(dir, { repoId: "big" });
    const sink = new MemoryEvidenceSink();
    const toolbox = codeToolbox(git, sink, 8_000);

    const out = await toolbox.searchCode({ pattern: "needle" });
    assert.match(out, /命中 12 处代码，分布在 1 个文件/);
    assert.match(out, /Big\.java: 命中 12 处/);
    assert.match(out, /\[E8\] /);
    assert.doesNotMatch(out, /\[E9\]/);
    assert.match(out, /其余 4 处未预览/);
    // 未预览的命中同样登记了证据（逐处可追溯），但不出现在模型输出里
    assert.equal(sink.all().length, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search_code 输出仍受总量预算截断", async () => {
  const dir = mkdtempSync(join(tmpdir(), "td-search-"));
  try {
    writeFileSync(join(dir, "Big.java"), `${Array.from({ length: 12 }, (_, i) => `// needle line ${i}`).join("\n")}\n`);
    execSync("git init -q && git add . && git -c user.email=t@example -c user.name=t commit -qm init", { cwd: dir });
    const git = await GitCodeSource.create(dir, { repoId: "big" });
    const toolbox = codeToolbox(git, new MemoryEvidenceSink(), 200);

    const out = await toolbox.searchCode({ pattern: "needle" });
    assert.match(out, /结果已截断/);
    assert.match(out, /\[E1\] /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
