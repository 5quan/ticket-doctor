#!/usr/bin/env node
// 为离线评测准备 fixture git 仓库：源码源要求"版本钉死"，需要一个带历史的真实仓库。
// 关键：提交时间必须早于 benchmark 里的故障发生时间，否则按发生时间钉不到版本（会记为缺失）。
// 幂等：已存在 .git 就直接返回。仓库 .git 不进主仓库（见 .gitignore）。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = join(ROOT, "fixtures", "evals", "checkout-timeout", "repo");

if (existsSync(join(REPO, ".git"))) process.exit(0);
if (!existsSync(REPO)) {
  console.error(`[ticket-doctor] 缺少评测仓库源文件：${REPO}`);
  process.exit(1);
}

const env = {
  ...process.env,
  GIT_AUTHOR_DATE: "2026-09-01T00:00:00+08:00",
  GIT_COMMITTER_DATE: "2026-09-01T00:00:00+08:00",
};
const run = (...args) => execFileSync("git", ["-C", REPO, ...args], { stdio: "ignore", env });
run("init", "-q");
run("config", "user.email", "td@example.com");
run("config", "user.name", "ticket-doctor");
run("add", "-A");
run("commit", "-qm", "eval fixture repo @ 2026-09-01");
console.log("[ticket-doctor] 已初始化评测仓库 fixtures/evals/checkout-timeout/repo");
