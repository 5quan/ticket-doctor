#!/usr/bin/env node
// 为 Langfuse 离线评测准备复用材料仓库 fixtures/evals/checkout-timeout/repo：
// 源码源要求"版本钉死"，需要一个带历史的真实仓库；提交时间必须早于案例故障发生时间，
// 否则按发生时间钉不到版本（会记为缺失）。源文件随主仓库提交，.git 不进主仓库（见 .gitignore）。
// 幂等：已存在 .git 就直接返回。engine 侧另有 ensureCheckoutFixtureRepo 自愈（seed 时也会建）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = join(ROOT, "fixtures", "evals", "checkout-timeout", "repo");

if (existsSync(join(REPO, ".git"))) process.exit(0);
mkdirSync(REPO, { recursive: true });

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
