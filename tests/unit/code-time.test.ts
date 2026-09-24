// 版本按发生时间钉死：取事件时间点之前的最近提交；找不到则报缺失，不回退 HEAD。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitCodeSource, resolveRepoShaAt } from "../../src/sources/code.ts";

function initRepo(): { dir: string; first: string; second: string } {
  const dir = mkdtempSync(join(tmpdir(), "td-code-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "td@example.com");
  git("config", "user.name", "ticket-doctor");
  git("config", "commit.gpgsign", "false");

  const commit = (date: string, content: string, message: string): string => {
    writeFileSync(join(dir, "app.js"), content);
    git("add", "-A");
    execFileSync("git", ["-C", dir, "commit", "-qm", message], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    return git("rev-parse", "HEAD").trim();
  };

  const first = commit("2026-08-01T10:00:00+08:00", "v1\n", "first");
  const second = commit("2026-09-10T10:00:00+08:00", "v2\n", "second");
  return { dir, first, second };
}

const MID = Date.parse("2026-09-06T12:00:00+08:00"); // 在两次提交之间

test("resolveRepoShaAt 取时间点之前的最近提交", async () => {
  const { dir, first } = initRepo();
  try {
    assert.equal(await resolveRepoShaAt(dir, MID), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitCodeSource.create 按发生时间钉版本并标注依据", async () => {
  const { dir, first } = initRepo();
  try {
    const src = await GitCodeSource.create(dir, { repoId: "app", at: MID });
    assert.equal(src.revision, first);
    assert.equal(src.pinnedBy, "time");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("按时间找不到提交时抛错，不回退 HEAD", async () => {
  const { dir } = initRepo();
  try {
    await assert.rejects(
      () => GitCodeSource.create(dir, { repoId: "app", at: Date.parse("2020-01-01T00:00:00+08:00") }),
      /无法钉版本/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("显式 rev 优先于 at", async () => {
  const { dir, second } = initRepo();
  try {
    const src = await GitCodeSource.create(dir, { repoId: "app", rev: second, at: MID });
    assert.equal(src.revision, second);
    assert.equal(src.pinnedBy, "explicit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
