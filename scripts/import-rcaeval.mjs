#!/usr/bin/env node
// 导入 RCAEval 案例 → 评测 v2 布局（log-only，开源派生）。
//
// 用法：
//   node scripts/import-rcaeval.mjs --dataset RE3 --limit 5 [--eval-root data/eval-v2]
//   [--window-before 120 --window-after 300 --max-lines 3000]
//
// 产出（相对 data/eval-v2/）：
//   public/<caseId>/case.json, r1-message.txt, round-1/<service>.log
//   private/<caseId>/truth.private.json
//   catalog/catalog.json（合并，保留既有条目）
//
// 口径：sourceTier=reproduced_history、split=development、admission=admitted（材料准入）、
// review.provisional=true（语义待人工复核）。题面为合成；无代码 gold → log-only。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HF = "https://huggingface.co/datasets/phamquiluan/RCAEval/resolve/main";
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const dataset = arg("dataset", "RE3");
const limit = Number(arg("limit", "5"));
const evalRoot = resolve(ROOT, arg("eval-root", "data/eval-v2"));
const cache = join(ROOT, "data", "rcaeval");
const winBefore = Number(arg("window-before", "120"));
const winAfter = Number(arg("window-after", "300"));
const maxLines = Number(arg("max-lines", "3000"));

const big = (v) => (typeof v === "bigint" ? v.toString() : v);

async function fetchTo(path) {
  const dest = join(cache, path);
  if (existsSync(dest) && statSync(dest).size > 0) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  // 用 curl（本机 Node fetch 连 HF 超时；curl 可用）。
  execFileSync("curl", ["-sL", "--fail", "--max-time", "180", "-o", dest, `${HF}/${path}`], { stdio: ["ignore", "ignore", "pipe"] });
  if (!existsSync(dest) || statSync(dest).size === 0) throw new Error(`下载失败（空文件）：${path}`);
  return dest;
}

async function readParquet(path) {
  const buf = readFileSync(path);
  return await parquetReadObjects({
    file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    compressors,
  });
}

function levelOf(message) {
  const m = message.toLowerCase();
  if (/(error|exception|fail|fatal|panic|timeout|refused)/.test(m)) return "ERROR";
  if (/(warn)/.test(m)) return "WARN";
  return "INFO";
}

const casesPath = await fetchTo("cases.parquet");
const index = await readParquet(casesPath);
const selected = index.filter((r) => String(r.dataset ?? "").startsWith(dataset)).slice(0, limit);
if (selected.length === 0) {
  console.error(`没有匹配 dataset=${dataset} 的案例`);
  process.exit(1);
}

const catalogPath = join(evalRoot, "catalog", "catalog.json");
const catalog = existsSync(catalogPath)
  ? JSON.parse(readFileSync(catalogPath, "utf8"))
  : { schemaVersion: "prediagnosis-catalog-v2", cases: [] };
const byId = new Map(catalog.cases.map((c) => [c.caseId, c]));

let imported = 0;
for (const row of selected) {
  const rawName = String(big(row.case));
  const caseId = `rcaeval-${rawName}`;
  const service = String(row.root_cause_service);
  const fault = String(row.fault);
  const faultDesc = String(row.fault_description ?? fault);
  const systemName = String(row.system_name ?? row.system ?? "system");
  const inject = Number(big(row.inject_time));
  const injectIso = new Date(inject * 1000).toISOString();

  const logs = await readParquet(await fetchTo(`${rawName}/logs.parquet`));
  const lo = inject - winBefore;
  const hi = inject + winAfter;
  const byService = new Map();
  for (const l of logs) {
    const t = Number(big(l.timestamp));
    if (!Number.isFinite(t) || t < lo || t > hi) continue;
    const svc = String(l.container_name);
    const arr = byService.get(svc) ?? [];
    arr.push({ t, msg: String(l.message) });
    byService.set(svc, arr);
  }
  if (!byService.has(service)) {
    console.warn(`  跳过 ${caseId}：窗口内无根因服务 ${service} 的日志`);
    continue;
  }

  const publicDir = join(evalRoot, "public", caseId);
  const viewDir = join(publicDir, "round-1");
  mkdirSync(viewDir, { recursive: true });

  let goldLine = null;
  for (const [svc, rows] of byService) {
    const sorted = rows.sort((a, b) => a.t - b.t).slice(0, maxLines);
    const lines = sorted.map((r) => `${new Date(r.t * 1000).toISOString()}\t${levelOf(r.msg)}\t${r.msg}`);
    writeFileSync(join(viewDir, `${svc}.log`), `${lines.join("\n")}\n`);
    if (svc === service) {
      // gold 选“出现频次最高的行”：优先 ERROR/WARN；先排除启动 banner/URL 噪声；
      // 根因服务无错误日志时退化为“该服务最常见日志”（度量“是否读到根因服务日志”，非故障签名）。
      const clean = sorted.filter((r) => !/https?:\/\//i.test(r.msg) && !/^\s*see\s/i.test(r.msg));
      const base = clean.length > 0 ? clean : sorted;
      const errs = base.filter((r) => levelOf(r.msg) === "ERROR");
      const pool = errs.length > 0 ? errs : base;
      const counts = new Map();
      for (const r of pool) counts.set(r.msg, (counts.get(r.msg) ?? 0) + 1);
      goldLine = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
  }

  const question = `${systemName} 的 ${service} 服务在 ${injectIso} 前后出现异常（${faultDesc}），请查日志定位根因。`;
  writeFileSync(join(publicDir, "r1-message.txt"), `${question}\n`);
  const caseJson = {
    schemaVersion: "prediagnosis-case-v2",
    caseId,
    familyId: `rcaeval-${row.dataset}`,
    split: "development",
    sourceTier: "reproduced_history",
    publicBenchmark: false,
    admission: "admitted",
    maxRounds: 1,
    scriptedEngine: false,
    rounds: [
      {
        roundId: "r1",
        messageRef: "r1-message.txt",
        receivedAt: new Date((inject + 60) * 1000).toISOString(),
        occurredAt: injectIso,
        materialView: "round-1",
        services: [service],
        repos: [],
      },
    ],
  };
  writeFileSync(join(publicDir, "case.json"), JSON.stringify(caseJson, null, 2));

  const truth = {
    schemaVersion: "prediagnosis-truth-v2",
    caseId,
    locators: goldLine
      ? [{ kind: "log", locatorId: "loc-rc", keyContent: goldLine.slice(0, 80), level: levelOf(goldLine) }]
      : [],
    rounds: [
      {
        roundId: "r1",
        allowedOutcomes: ["report"],
        allowedClaimDepth: "root",
        requiredFacts: [],
        forbiddenRules: [],
        materialNeeds: [],
        evidenceRequirements: goldLine
          ? [{ requirementId: "req-rc", depth: "direct", supportsAnyOf: [{ allOf: ["loc-rc"] }] }]
          : [],
        contradictedClaims: [],
        writebackRequirements: [],
      },
    ],
    review: {
      author: "rcaeval-import",
      reviewer: "provisional-self",
      provisional: true,
      notes: `RCAEval ${row.dataset} 派生；gold 服务=${service} 故障=${fault}；题面合成、无代码 gold（log-only），语义待人工复核`,
    },
  };
  const privateDir = join(evalRoot, "private", caseId);
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(privateDir, "truth.private.json"), JSON.stringify(truth, null, 2));

  byId.set(caseId, { caseId, publicDir: `public/${caseId}`, privateDir: `private/${caseId}` });
  imported += 1;
  console.log(`  ${caseId}: service=${service} fault=${fault} 服务数=${byService.size} gold="${(goldLine ?? "").slice(0, 60)}"`);
}

catalog.cases = [...byId.values()];
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
console.log(`[import-rcaeval] 导入 ${imported} 个案例 → ${evalRoot}（catalog 现有 ${catalog.cases.length} 条）`);
