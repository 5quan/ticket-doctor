// 材料源授权：allowedRepos 必须是硬白名单，不能让显式 TD_REPOS 越权。
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { resolveSources } from "../../src/config/index.ts";
import { prepareDiagnosis } from "../../src/diagnosis/prepare.ts";
import { testConfig } from "../helpers.ts";

test("TD_ALLOWED_REPOS 是硬白名单：TD_REPOS 中未授权的仓库被排除", () => {
  const sources = resolveSources({ TD_REPOS: "app:/tmp/a,secret:/tmp/s", TD_ALLOWED_REPOS: "app" });
  assert.deepEqual(sources.allowedRepos, ["app"]);
  assert.deepEqual(sources.repos.map((r) => r.repoId), ["app"]);
});

test("未设置 TD_ALLOWED_REPOS 时默认授权 TD_REPOS 声明的全部仓库", () => {
  const sources = resolveSources({ TD_REPOS: "a:/tmp/a,b:/tmp/b" });
  assert.deepEqual(sources.allowedRepos, ["a", "b"]);
  assert.deepEqual(sources.repos.map((r) => r.repoId), ["a", "b"]);
});

test("TD_ALLOWED_REPOS 显式为空时拒绝一切仓库", () => {
  const sources = resolveSources({ TD_REPOS: "a:/tmp/a", TD_ALLOWED_REPOS: "" });
  assert.deepEqual(sources.allowedRepos, []);
  assert.deepEqual(sources.repos, []);
});

test("两者都未设置时回退 app 指向仓库根", () => {
  const sources = resolveSources({});
  assert.deepEqual(sources.allowedRepos, ["app"]);
  assert.deepEqual(sources.repos.map((r) => r.repoId), ["app"]);
});

test("prepareDiagnosis 排除未授权仓库，并记为缺失材料", async () => {
  const config = testConfig();
  const demoRepo = join(config.projectRoot, "fixtures", "demo-repo");
  config.sources.repos = [
    { repoId: "app", dir: demoRepo },
    { repoId: "secret", dir: demoRepo },
  ];
  config.sources.allowedRepos = ["app"];

  const prepared = await prepareDiagnosis(config, {
    investigationId: "inv",
    runId: "run",
    text: "排查",
    receivedAt: Date.now(),
    signal: new AbortController().signal,
  });

  assert.deepEqual(prepared.scope.repos.map((r) => r.repoId), ["app"], "未授权仓库不得进入代码源范围");
  assert.ok(
    prepared.missingMaterial.some((m) => m.includes("secret") && m.includes("授权")),
    `缺失材料应说明未授权仓库：${prepared.missingMaterial.join(" / ")}`,
  );
});
