// 评测运行器：逐 case 走生产同款链路（prepareDiagnosis → engine → validateDraft），再打分。
//
// 这里**不碰**飞书/调度/投递，也不写诊断数据库；只产出分数。
import { join } from "node:path";
import type { AppConfig } from "../config/index.ts";
import type { DiagnosisEngine } from "../agent/types.ts";
import { prepareDiagnosis } from "../diagnosis/prepare.ts";
import { validateDraft } from "../diagnosis/validate.ts";
import { describeLocator, loadBenchmark } from "./benchmark.ts";
import { scoreCase } from "./scorer.ts";
import type { CaseScore, ScenarioScore } from "./types.ts";

export interface RunScenarioOptions {
  scenarioDir: string;
  /** 基础配置：提供 diagnosis 参数（引擎 opts 由调用方组装）。 */
  config: AppConfig;
  engine: DiagnosisEngine;
}

export async function runScenario(opts: RunScenarioOptions): Promise<ScenarioScore> {
  const benchmark = loadBenchmark(join(opts.scenarioDir, "benchmark.json"));
  const cases: CaseScore[] = [];

  for (const c of benchmark.cases) {
    const config: AppConfig = {
      ...opts.config,
      sources: {
        ...opts.config.sources,
        logDir: join(opts.scenarioDir, "logs"),
        allowedServices: [],
        allowedRepos: [c.repo ?? "app"],
        repos: [{ repoId: c.repo ?? "app", dir: join(opts.scenarioDir, "repo") }],
      },
    };
    const controller = new AbortController();
    const prepared = await prepareDiagnosis(config, {
      investigationId: `eval-${benchmark.scenario}-${c.id}`,
      runId: `eval-${benchmark.scenario}-${c.id}`,
      text: c.question,
      receivedAt: Date.parse(c.receivedAt),
      service: c.service,
      signal: controller.signal,
    });

    const result = await opts.engine.run(prepared.input, prepared.toolbox, controller.signal);
    if (result.kind === "reply") {
      cases.push({
        id: c.id,
        recall: c.gold.evidence.length === 0 ? 1 : 0,
        precision: 0,
        correct: false,
        matchedGold: [],
        missedGold: c.gold.evidence.map(describeLocator),
        citedDistractor: [],
        note: "引擎返回了非报告回复",
      });
      continue;
    }

    const draft = result.draft;
    for (const m of prepared.missingMaterial) draft.missingMaterial.push(m);
    const { report } = validateDraft(draft, {
      registry: prepared.registry,
      scope: prepared.scope,
      executionLimits: [],
    });
    cases.push(scoreCase(c, prepared.registry.all(), report));
  }

  const avg = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  return {
    scenario: benchmark.scenario,
    engine: opts.engine.name,
    cases,
    recall: avg(cases.map((x) => x.recall)),
    precision: avg(cases.map((x) => x.precision)),
    accuracy: avg(cases.map((x) => (x.correct ? 1 : 0))),
  };
}
