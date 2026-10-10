#!/usr/bin/env node
// 自改进交付 B CLI：批量评测桥梁（§6.1）。
//   stdin: 一个 BatchRequest JSON；stdout: 一个结果 JSON；日志走 stderr。
// 例：echo '{"runId":"r1","candidateId":"c1","rulesText":"...","caseIds":["eng-clarify"],"split":"development","repeat":1,"captureTraces":true}' | npm run evolve:batch
//
// 只接受「已准入 + 与请求 split 一致」的 caseId；未批准的 ID 直接拒绝。

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/index.ts";
import { loadCase, loadCatalog } from "../src/eval/lf/internals/load.ts";
import { loadFrozenCase, runCase } from "../src/eval/lf/run-case.ts";
import { BatchProtocolError, SystematicBatchError, parseBatchRequest, runBatch } from "../src/evolve/batch.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : fallback;
}
function evalRoot(): string {
  const raw = arg("eval-root") ?? process.env.TD_EVAL_ROOT ?? join(ROOT, "data", "eval-v2");
  return isAbsolute(raw) ? raw : resolve(ROOT, raw);
}
async function readRequest(): Promise<unknown> {
  const file = arg("request");
  const text = file ? readFileSync(file, "utf8") : await new Promise<string>((res, rej) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => res(buf));
    process.stdin.on("error", rej);
  });
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new BatchProtocolError(`请求不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<number> {
  const raw = await readRequest();
  const split = (raw as { split?: unknown })?.split;
  if (!["train", "validation", "holdout"].includes(String(split))) throw new BatchProtocolError(`split 非法：${String(split)}`);
  const root = evalRoot();
  const catalog = loadCatalog(root);
  // 允许清单：只有 admitted 且 split 匹配的案例可运行。
  const allowed = new Set<string>();
  for (const entry of catalog.cases) {
    try {
      const desc = loadCase(root, entry, ROOT, { requireAdmitted: true });
      if (desc.split === split) allowed.add(entry.caseId);
    } catch {
      // 未准入/未加载的案例不进允许清单（不打印私有原因）
    }
  }
  const request = parseBatchRequest(raw, { allowedCaseIds: allowed });
  const config = loadConfig();
  const outBase = join(ROOT, "data", "evolve", "batch", request.runId);
  mkdirSync(outBase, { recursive: true });

  const outcome = await runBatch(request, {
    runTrial: async ({ caseId, trialId, compiledPrompt, captureTraces }) => {
      const entry = catalog.cases.find((c) => c.caseId === caseId);
      if (!entry) throw new SystematicBatchError(`case 不在 catalog：${caseId}`);
      let loaded;
      try {
        loaded = loadFrozenCase(root, ROOT, entry);
      } catch (err) {
        throw new SystematicBatchError(`case 加载/准入失败（终止整轮）：${err instanceof Error ? err.message : String(err)}`);
      }
      if (!loaded.isolation.ok) throw new SystematicBatchError(`隔离预检失败（终止整轮）：${loaded.violationText}`);
      const outDir = join(outBase, caseId, trialId);
      const result = await runCase({
        projectRoot: ROOT,
        evalRoot: root,
        entry,
        engine: "pi",
        baseConfig: config,
        systemPrompt: compiledPrompt,
        outDir,
      });
      return { result, truth: loaded.truth, ...(captureTraces ? { traceRef: join(outDir, caseId, "trace.jsonl") } : {}) };
    },
  });

  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const code = err instanceof BatchProtocolError ? 2 : err instanceof SystematicBatchError ? 3 : 1;
    process.stderr.write(`[evolve:batch] ${code === 2 ? "协议错误" : code === 3 ? "系统性失败（终止整轮）" : "失败"}：${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(code);
  });
