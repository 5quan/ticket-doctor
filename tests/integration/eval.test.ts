// 评测 harness 自测：用 fake 引擎跑通整条评测链路（不调真实模型），先证明"考卷 + 批卷"本身正确。
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { FakeDiagnosisEngine } from "../../src/agent/fake-engine.ts";
import { runScenario } from "../../src/evals/runner.ts";
import { testConfig } from "../helpers.ts";

const SCENARIO = join(testConfig().projectRoot, "fixtures", "evals", "checkout-timeout");

test("评测 harness：跑完场景并产出 0~1 的指标", async () => {
  const score = await runScenario({
    scenarioDir: SCENARIO,
    config: testConfig(),
    engine: new FakeDiagnosisEngine({ defaultService: "checkout-service" }),
  });
  assert.equal(score.scenario, "checkout-timeout");
  assert.equal(score.cases.length, 5);
  for (const c of score.cases) {
    assert.ok(c.recall >= 0 && c.recall <= 1, `${c.id} recall 越界`);
    assert.ok(c.precision >= 0 && c.precision <= 1, `${c.id} precision 越界`);
    assert.equal(typeof c.correct, "boolean");
  }
  assert.ok(score.recall >= 0 && score.recall <= 1);
  assert.ok(score.accuracy >= 0 && score.accuracy <= 1);
});

test("评测 harness：至少有一个 case 命中 gold 证据", async () => {
  const score = await runScenario({
    scenarioDir: SCENARIO,
    config: testConfig(),
    engine: new FakeDiagnosisEngine({ defaultService: "checkout-service" }),
  });
  assert.ok(
    score.cases.some((c) => c.matchedGold.length > 0),
    "应至少有一个 case 命中 gold 证据（否则 fixture/匹配逻辑有问题）",
  );
});
