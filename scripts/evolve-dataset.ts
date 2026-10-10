#!/usr/bin/env node
// 自改进交付 A CLI：把已准入案例导入 Langfuse Dataset（docs/self-improvement-implementation-plan.md §9）。
//   preflight  检查 Langfuse 连通/鉴权/Dataset API（只记录存在状态，不打印密钥）
//   seed       组装数据集载荷；--sync 才真正推送（幂等 upsert）
//   verify     从服务器读回 dataset items，核对数量与 id
//
// 只导入 admission=admitted 的案例；私有 truth/未来材料不进入 item input。

import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/index.ts";
import { createLfClient, lfConfigOf, preflight, printPreflight, type LfClientConfig } from "../src/eval/lf/client.ts";
import { BOOTSTRAP_DATASET, seedBootstrapDataset } from "../src/evolve/materials/dataset.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function evalRoot(): string {
  const raw = arg("eval-root") ?? process.env.TD_EVAL_ROOT ?? join(ROOT, "data", "eval-v2");
  return isAbsolute(raw) ? raw : resolve(ROOT, raw);
}
function requireLf(): LfClientConfig {
  const cfg = lfConfigOf(loadConfig().observability);
  if (!cfg) throw new Error("缺少 Langfuse 配置：需要 LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY");
  return cfg;
}

async function cmdPreflight(): Promise<number> {
  const report = await preflight(requireLf());
  printPreflight(report);
  return report.server.reachable && report.auth && report.datasetApi ? 0 : 1;
}

async function cmdSeed(): Promise<number> {
  const sync = flag("sync");
  const root = evalRoot();
  if (!sync) {
    // dry-run 不需要凭据：只组装并打印。
    const { buildBootstrapDataset } = await import("../src/evolve/materials/dataset.ts");
    const built = buildBootstrapDataset(root, ROOT);
    console.log(`[evolve:dataset] dry-run：dataset=${built.datasetName} items=${built.items.length} skipped=${built.skipped.length}`);
    for (const it of built.items) console.log(`  ${it.metadata.caseId} [${it.metadata.split}] itemId=${it.metadata.itemId} caseHash=${it.metadata.casePublicHash.slice(0, 12)}…`);
    for (const s of built.skipped) console.log(`  跳过 ${s.caseId}（${s.admission}）：${s.reason}`);
    console.log("[evolve:dataset] 加 --sync 才会推送；私有 truth 不进 input。");
    return 0;
  }
  const lf = createLfClient(requireLf());
  const res = await seedBootstrapDataset(lf, root, ROOT, { sync: true });
  console.log(`[evolve:dataset] 已同步 dataset=${res.datasetName} datasetId=${res.datasetId ?? "-"}`);
  for (const it of res.items) console.log(`  ${it.caseId} itemId=${it.itemId} ${it.ok ? "ok" : `失败：${it.error}`}`);
  for (const s of res.skipped) console.log(`  跳过 ${s.caseId}（${s.admission}）：${s.reason}`);
  return res.items.every((i) => i.ok) ? 0 : 1;
}

async function cmdVerify(): Promise<number> {
  const lf = createLfClient(requireLf());
  const { buildBootstrapDataset } = await import("../src/evolve/materials/dataset.ts");
  const expected = buildBootstrapDataset(evalRoot(), ROOT).items.map((i) => i.metadata.itemId).sort();
  const page = (await lf.api.datasetItems.list({ datasetName: BOOTSTRAP_DATASET })) as unknown as { data?: Array<{ id?: string }>; items?: Array<{ id?: string }> };
  const actual = (page.data ?? page.items ?? []).map((x) => x.id ?? "").filter(Boolean).sort();
  const missing = expected.filter((id) => !actual.includes(id));
  console.log(`[evolve:dataset] 服务器 dataset=${BOOTSTRAP_DATASET} items=${actual.length}；本地应导入=${expected.length}`);
  if (missing.length > 0) {
    console.log(`[evolve:dataset] 失败：服务器缺少 ${missing.length} 个 item（${missing.map((m) => m.slice(0, 8)).join(",")}…）`);
    return 1;
  }
  console.log("[evolve:dataset] 通过：全部预期 item 已在服务器");
  return 0;
}

function usage(): void {
  console.log(`用法：
  npm run evolve:dataset:preflight
  npm run evolve:dataset:seed [--sync] [--eval-root <dir>]
  npm run evolve:dataset:verify`);
}

const cmd = process.argv[2];
try {
  let code: number;
  switch (cmd) {
    case "preflight": code = await cmdPreflight(); break;
    case "seed": code = await cmdSeed(); break;
    case "verify": code = await cmdVerify(); break;
    default: usage(); code = 2; break;
  }
  process.exit(code);
} catch (err) {
  console.error(`[evolve:dataset] 错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
