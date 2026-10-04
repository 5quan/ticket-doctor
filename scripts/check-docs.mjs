#!/usr/bin/env node
// docs:check —— 文档状态一致性检查（OQ-41 工作单 §B.2.2）。
//
// 易变事实（版本/测试数/迁移头/基线/功能状态）唯一事实源是 docs/status.json；
// 本脚本把"文档漂移"变成会失败的检查：任一规则不满足即打印 `文件:行: 原因` 并以非 0 退出。
// 已接入 npm test（tests/integration/docs-consistency.test.ts）——漂移直接挂测试。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const fail = (file, line, reason) => failures.push(`${file}:${line}: ${reason}`);

// ---------- 事实源 ----------
const status = JSON.parse(readFileSync(join(ROOT, "docs", "status.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// ---------- 1. 派生事实校验 ----------
if (pkg.version !== status.version) {
  fail("docs/status.json", 0, `version ${status.version} ≠ package.json ${pkg.version}`);
}

/** 静态统计测试数：tests 目录下所有 .ts 里 `test(` 出现次数（node:test）。 */
function countTests(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) n += countTests(p);
    else if (entry.name.endsWith(".ts")) n += (readFileSync(p, "utf8").match(/(^|[^.\w])test\(/g) ?? []).length;
  }
  return n;
}
const testCount = countTests(join(ROOT, "tests"));
if (testCount !== status.tests.ts) {
  fail("docs/status.json", 0, `tests.ts ${status.tests.ts} ≠ 静态统计 ${testCount}（tests/**/*.ts 的 test(）`);
}

const migrations = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
const head = migrations.at(-1);
if (head !== status.migrations.head) {
  fail("docs/status.json", 0, `migrations.head ${status.migrations.head} ≠ 实际 ${head}`);
} else {
  const nextPrefix = `${String(Number(head.slice(0, 3)) + 1).padStart(3, "0")}_`;
  if (status.migrations.nextPrefix !== nextPrefix) {
    fail("docs/status.json", 0, `nextPrefix ${status.migrations.nextPrefix} 应为 ${nextPrefix}`);
  }
}

// gitHead：由脚本写入或跳过；写了就必须与 HEAD 一致
if (status.gitHead) {
  const rev = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (rev !== status.gitHead) fail("docs/status.json", 0, `gitHead ${status.gitHead} ≠ HEAD ${rev}`);
}

// ---------- 文档扫描 ----------
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : p;
  });
const docFiles = [join(ROOT, "README.md"), ...walk(join(ROOT, "docs")).filter((f) => f.endsWith(".md"))];
const VOLATILE = "<!-- status:volatile -->";


// 禁用旧口径（出现即 fail）
const FORBIDDEN = [
  { re: /打分器待修|评分器未修/, why: "打分器 UID 兼容与 v2 校准均已完成（OQ-41）" },
  { re: /仍按 .E#. 建索引/, why: "打分器已按 UID+E# 双键索引" },
  { re: /长连接（S3）待做|长连接.{0,10}待做|长连接.{0,10}待扩展/, why: "长连接 S3 已实现（OQ-40）" },
  { re: /docker-compose 待补|Host 重启进程级验证与 docker-compose/, why: "已完成" },
  { re: /001…005|001 … 005/, why: "迁移已是 001…006" },
  { re: /OQ-1…OQ-35/, why: "OQ 已到 41" },
  { re: /跨轮证据复用/, why: '请区分表述："证据跨轮（已完成）／上下文跨轮（待做）"' },
];

/** 内链存在性：先查精确路径；不存在时按"目录 + 前缀"放宽（如 `migrations/006_` 这种前缀引用）。 */
function linkExists(captured) {
  const p = join(ROOT, captured);
  if (existsSync(p)) return true;
  const base = dirname(p);
  if (!existsSync(base)) return false;
  const stem = captured.split("/").pop();
  return readdirSync(base).some((e) => e.startsWith(stem));
}

for (const file of docFiles) {
  const rel = file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((text, i) => {
    const lineNo = i + 1;
    const volatile = text.includes(VOLATILE);

    // 2. 禁用旧口径
    {
      for (const { re, why } of FORBIDDEN) {
        if (re.test(text)) fail(rel, lineNo, `旧口径：${why}`);
      }
      // 旧基线数字：30.7 或（真实模型基线 + 90%）必须同句带作废/旧口径标注
      if (/30\.7|真实模型基线.*90%/.test(text) && !/作废|旧口径|deprecated/i.test(text)) {
        fail(rel, lineNo, "旧基线数字未标「作废/旧口径」");
      }
    }
    // 3. 测试数字一致性（带豁免标记的行跳过）
    if (!volatile) {
      const patterns = [/TS\s*(\d{2,4})\s*个/g, /当前\s*(\d{2,4})\s*个/g, /(\d{2,4})\s*个测试/g, /TS\s*(\d{3})\b/g];
      for (const re of patterns) {
        for (const m of text.matchAll(re)) {
          const n = Number(m[1]);
          if (n !== status.tests.ts) fail(rel, lineNo, `测试数 ${n} ≠ status.json.tests.ts ${status.tests.ts}`);
        }
      }
      // 版本号一致性（`版本 X.Y.Z` 形态）
      for (const m of text.matchAll(/版本[^\d\n]{0,6}(\d+\.\d+\.\d+)/g)) {
        if (m[1] !== status.version) fail(rel, lineNo, `版本 ${m[1]} ≠ status.json ${status.version}`);
      }
    }
    // 4. `npm run gateway` 必须同句标注旧链路
    if (text.includes("npm run gateway") && !/旧链路|过渡|legacy/i.test(text)) {
      fail(rel, lineNo, "`npm run gateway` 必须同句标注 旧链路/过渡/legacy");
    }
    // 5. 内链存在性（时点手册里的模板示例豁免）
    {
      for (const m of text.matchAll(/((?:docs|fixtures|adapters|scripts|migrations)\/[A-Za-z0-9._/-]+)/g)) {
        if (!linkExists(m[1])) fail(rel, lineNo, `内链不存在：${m[1]}`);
      }
    }
  });
}

if (failures.length > 0) {
  console.error(`[docs:check] ${failures.length} 处不一致：`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `[docs:check] 通过（docs=${docFiles.length} 个文件，tests.ts=${status.tests.ts}，migrations.head=${status.migrations.head}）`,
);
