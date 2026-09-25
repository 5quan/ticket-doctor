// 离线评测入口：npm run eval -- --scenario checkout-timeout
//
// 与线上平行：复用同一套引擎/工具/校验，但不碰飞书/调度/投递。
// fake 引擎用于自测 harness；TD_ENGINE=pi 出真实分数。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/index.ts";
import { FakeDiagnosisEngine } from "../agent/fake-engine.ts";
import { buildSystemPrompt, PiDiagnosisEngine } from "../agent/pi-engine.ts";
import type { DiagnosisEngine } from "../agent/types.ts";
import { runScenario } from "./runner.ts";

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const config = loadConfig();
const scenario = arg("--scenario", "checkout-timeout");
const scenarioDir = join(config.projectRoot, "fixtures", "evals", scenario);
if (!existsSync(join(scenarioDir, "benchmark.json"))) {
  console.error(`[eval] 找不到 benchmark：${scenarioDir}/benchmark.json`);
  process.exit(1);
}
const rulesPath = join(scenarioDir, "rules.md");
const rules = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : undefined;

const engine: DiagnosisEngine =
  config.diagnosis.engine === "pi"
    ? new PiDiagnosisEngine({
        provider: config.diagnosis.provider,
        modelId: config.diagnosis.modelId,
        apiKey: config.diagnosis.apiKey,
        maxToolCalls: config.diagnosis.maxToolCalls,
        maxModelTurns: config.diagnosis.maxModelTurns,
        compactionEnabled: config.diagnosis.compactionEnabled,
        systemPrompt: buildSystemPrompt(rules),
      })
    : new FakeDiagnosisEngine({ defaultService: "checkout-service" });

console.log(`[eval] 场景=${scenario} 引擎=${engine.name} 规则=${rules ? rulesPath : "(无)"}`);
const score = await runScenario({ scenarioDir, config, engine });

for (const c of score.cases) {
  const extra =
    (c.missedGold.length ? `  漏证据=${c.missedGold.join("; ")}` : "") +
    (c.citedDistractor.length ? `  引用干扰=${c.citedDistractor.join(",")}` : "") +
    (c.note ? `  (${c.note})` : "");
  console.log(
    `${c.correct ? "✅" : "❌"} ${c.id}  召回=${(c.recall * 100).toFixed(0)}%  精确=${(c.precision * 100).toFixed(0)}%${extra}`,
  );
}
console.log(
  `\n[eval] 汇总：证据召回率=${(score.recall * 100).toFixed(1)}%  ` +
    `引用精确率=${(score.precision * 100).toFixed(1)}%  决策正确率=${(score.accuracy * 100).toFixed(1)}%`,
);

const resultsDir = join(config.projectRoot, "data", "evals");
mkdirSync(resultsDir, { recursive: true });
const resultsFile = join(resultsDir, `${scenario}.jsonl`);
appendFileSync(resultsFile, JSON.stringify({ ts: Date.now(), ...score }) + "\n", "utf8");
console.log(`[eval] 已追加结果：${resultsFile}`);
