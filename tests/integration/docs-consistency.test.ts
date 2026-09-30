// 文档状态一致性：docs:check 挂进 npm test（OQ-41 工作单 §B.2.2）。
// 易变事实（版本/测试数/迁移头/基线/功能状态）唯一事实源是 docs/status.json；
// 任何文档漂移（旧口径、数字不一致、失效内链）在这里直接失败，而不是靠自觉。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("docs:check：文档状态与 docs/status.json 一致", () => {
  let output = "";
  try {
    execFileSync(process.execPath, [join(ROOT, "..", "scripts", "check-docs.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    output = String(e.stdout ?? e.message ?? err);
    assert.fail(`文档存在漂移（跑 npm run docs:check 看明细）：\n${output}`);
  }
});
