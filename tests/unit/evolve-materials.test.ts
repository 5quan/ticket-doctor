// 交付 A 材料转换器测试（docs/self-improvement-implementation-plan.md §4.3 / §12 A）：
//   * 保真：原 timestamp/severity/msg 原样，附加字段入消息，行号映射一一对应；
//   * 多行值折叠单行，不丢异常关键上下文；
//   * 非法输入显式失败（不静默跳过日志）；
//   * 确定性：同输入必得同 hash；
//   * 目录隔离：映射文件不在 Agent 可见的 logs/ 视图内，附件只登记不可读。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { convertLogsNdjson, buildLogMessage, MaterialConversionError } from "../../src/evolve/materials/convert.ts";
import {
  FIRST_BATCH_CASE_IDS,
  checkSplitHygiene,
  loadRsiBootstrapManifest,
  selectFirstBatch,
  verifyRsiBootstrapHashes,
} from "../../src/evolve/materials/catalog.ts";
import { materializeCase } from "../../src/evolve/materials/materialize.ts";
import { listFilesRecursive } from "../../src/eval/lf/internals/hash.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function ndjson(lines: Array<Record<string, unknown>>): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

test("转换保真：timestamp/severity/msg 原样，附加字段按键排序入消息，多行折叠", () => {
  const raw = ndjson([
    { timestamp: "2026-06-19T10:00:00Z", service: "svc-a", severity_text: "ERROR", msg: "boom", trace_id: "t1", "http.route": "/x" },
    { timestamp: "2026-06-19T10:00:05Z", service: "svc-b", severity_text: "INFO", msg: "ok" },
    { timestamp: "2026-06-19T10:00:06Z", service: "svc-a", severity_text: "ERROR", msg: "boom2", stack: "line1\nline2\nline3" },
  ]);
  const conv = convertLogsNdjson("case-x", "logs.ndjson", raw);
  assert.deepEqual(conv.services.map((s) => s.service), ["svc-a", "svc-b"]);
  const a = conv.services[0]!;
  // 每服务保持源顺序；行号映射指向原始文件行。
  assert.deepEqual(a.lines.map((l) => l.sourceLine), [1, 3]);
  assert.deepEqual(a.lines.map((l) => l.outputLine), [1, 2]);
  // 原 msg 前缀完整保留，附加字段按字典序（http.route < trace_id）。
  assert.equal(a.lines[0]!.message, "boom http.route=/x trace_id=t1");
  // 多行 stack 折叠为单行，关键内容仍在。
  assert.equal(a.lines[1]!.message, "boom2 stack=line1 | line2 | line3");
  assert.ok(!a.content.includes("\nline2"), "stack 不得引入真实换行破坏逐行解析");
  // 文件内容 = 每行 timestamp\tlevel\tmessage。
  const firstLine = a.content.split("\n")[0]!;
  assert.equal(firstLine, "2026-06-19T10:00:00Z\tERROR\tboom http.route=/x trace_id=t1");
});

test("非法输入显式失败：坏 JSON / 缺字段 / 不安全服务名", () => {
  assert.throws(() => convertLogsNdjson("c", "f", "{not json}\n"), MaterialConversionError);
  assert.throws(() => convertLogsNdjson("c", "f", ndjson([{ timestamp: "2026-06-19T10:00:00Z", service: "s", severity_text: "INFO" }])), MaterialConversionError);
  assert.throws(() => convertLogsNdjson("c", "f", ndjson([{ timestamp: "2026-06-19T10:00:00Z", service: "../etc/passwd", severity_text: "INFO", msg: "x" }])), MaterialConversionError);
  assert.throws(() => convertLogsNdjson("c", "f", ndjson([{ timestamp: "not-a-time", service: "s", severity_text: "INFO", msg: "x" }])), MaterialConversionError);
  assert.throws(() => buildLogMessage({ service: "s" }), MaterialConversionError);
});

test("确定性：同输入两次转换字节与 hash 完全一致", () => {
  const raw = readFileSync(join(ROOT, "fixtures/research/rsi-bootstrap/public/rcb-001/logs.ndjson"), "utf8");
  const a = convertLogsNdjson("rcb-001", "logs.ndjson", raw);
  const b = convertLogsNdjson("rcb-001", "logs.ndjson", raw);
  assert.deepEqual(a.services.map((s) => s.sha256), b.services.map((s) => s.sha256));
  assert.deepEqual(a.services.map((s) => s.content), b.services.map((s) => s.content));
});

test("真实案例 rcb-001：全部非空行一一映射，panic 关键内容可在日志视图中检索", () => {
  const raw = readFileSync(join(ROOT, "fixtures/research/rsi-bootstrap/public/rcb-001/logs.ndjson"), "utf8");
  const conv = convertLogsNdjson("rcb-001", "logs.ndjson", raw);
  const nonEmpty = raw.split(/\r?\n/).filter((l) => l.trim()).length;
  const mapped = conv.services.reduce((n, s) => n + s.lines.length, 0);
  assert.equal(mapped, nonEmpty);
  // 原始行号无丢失、无重复。
  const sourceLines = conv.services.flatMap((s) => s.lines.map((l) => l.sourceLine)).sort((x, y) => x - y);
  assert.equal(new Set(sourceLines).size, sourceLines.length);
  const pay = conv.services.find((s) => s.service === "paymentservice")!;
  assert.match(pay.content, /panic: runtime error: invalid memory address or nil pointer dereference/);
});

test("目录隔离：映射不在 logs/ 内；附件只登记不可读；日志视图只含 .log", () => {
  const manifest = loadRsiBootstrapManifest(ROOT);
  const entry = selectFirstBatch(manifest).find((c) => c.caseId === "rcb-001")!;
  const out = mkdtempSync(join(tmpdir(), "evolve-materials-"));
  try {
    const res = materializeCase(ROOT, out, entry);
    const logsDir = join(out, "rcb-001", "round-1", "logs");
    const files = listFilesRecursive(logsDir).map((f) => f.path).sort();
    assert.ok(files.length > 0);
    assert.ok(files.every((f) => f.endsWith(".log")), `logs/ 只应含 .log：${files.join(",")}`);
    // 映射文件在 logs/ 之外。
    const mapping = join(out, "rcb-001", "round-1", "mapping.json");
    assert.ok(readFileSync(mapping, "utf8").includes("rsi-material-mapping/v0"));
    // 变更/指标等附件存在但标记不可读，且不进入日志视图。
    const archived = res.manifest.archivedAttachments;
    assert.ok(archived.some((a) => a.path === "metrics.csv"));
    assert.ok(archived.some((a) => a.path === "context/deploys.json"));
    assert.ok(archived.every((a) => a.readable === false));
    assert.ok(!files.some((f) => f.includes("metrics.csv")));
    // 日志视图 hash 覆盖全部日志文件。
    assert.equal(res.manifest.logView.files.length, files.length);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("冻结目录：hash 全过、split 分布正确、首批为 001/004/007、无跨 split 家族", () => {
  const manifest = loadRsiBootstrapManifest(ROOT);
  const check = verifyRsiBootstrapHashes(ROOT, manifest);
  assert.deepEqual(check.missing, []);
  assert.deepEqual(check.mismatches, []);
  assert.equal(check.checked, manifest.files.length);
  const splits = manifest.cases.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.split]: (acc[c.split] ?? 0) + 1 }), {});
  assert.deepEqual(splits, { train: 4, validation: 3, holdout: 2 });
  assert.deepEqual(selectFirstBatch(manifest).map((c) => c.caseId), [...FIRST_BATCH_CASE_IDS]);
  assert.deepEqual(checkSplitHygiene(manifest.cases), []);
});
