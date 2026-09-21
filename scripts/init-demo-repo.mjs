#!/usr/bin/env node
// 为 demo / 集成测试准备一个本地 git 仓库：源码源要求"版本钉死"，所以需要一个真实仓库。
// 幂等：已存在 .git 就直接返回。fixtures/demo-repo 下的 .git 不进主仓库（见 .gitignore）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = join(ROOT, "fixtures", "demo-repo");

if (existsSync(join(REPO, ".git"))) process.exit(0);
mkdirSync(REPO, { recursive: true });
const run = (...args) => execFileSync("git", ["-C", REPO, ...args], { stdio: "ignore" });
run("init", "-q");
run("config", "user.email", "td@example.com");
run("config", "user.name", "ticket-doctor");
run("add", "-A");
run("commit", "-qm", "demo repo");
console.log("[ticket-doctor] 已初始化示例仓库 fixtures/demo-repo");
