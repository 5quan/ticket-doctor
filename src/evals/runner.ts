// 评测运行器：逐 case 走生产同款链路（prepareDiagnosis → engine → validateDraft），再打分。
//
// 证据走与线上一致的 Store sink（D13）：每个 case 一个 `:memory:` 库 + 合成 `running` run，
// 工具 commit 真实落库、校验用 StoreEvidenceResolver 按调查解析；不碰飞书/调度/投递。
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config/index.ts";
import type { DiagnosisEngine } from "../agent/types.ts";
import { openDatabase, migrate } from "../storage/db.ts";
import { Store } from "../storage/store.ts";
import { StoreEvidenceSink } from "../evidence/store-sink.ts";
import { StoreEvidenceResolver } from "../evidence/store-resolver.ts";
import { evidenceRefToRecord } from "../evidence/util.ts";
import { prepareDiagnosis } from "../diagnosis/prepare.ts";
import { validateDraft } from "../diagnosis/validate.ts";
import { describeLocator, loadBenchmark } from "./benchmark.ts";
import { scoreCase } from "./scorer.ts";
import type { CaseScore, ScenarioScore } from "./types.ts";

const MIGRATIONS_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "migrations");

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
    const runId = `eval-${benchmark.scenario}-${c.id}`;
    // D13：评测与生产同一证据持久化路径——:memory: 库 + 合成 running run + Store sink/resolver
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS_DIR);
    const store = new Store(db);
    const inv = store.createInvestigation({
      sessionCode: runId,
      provider: "web",
      accountId: "eval",
      chatId: "eval",
    });
    const message = store.insertMessage({
      investigationId: inv.id,
      provider: "web",
      accountId: "eval",
      externalMessageId: `${runId}-msg`,
      text: c.question,
      receivedAt: Date.parse(c.receivedAt),
    });
    store.createRun({ investigationId: inv.id, messageId: message.id, maxAttempts: 1 });
    const claimed = store.claimNextRun("eval", 60_000)!;
    const sink = new StoreEvidenceSink(store, {
      investigationId: inv.id,
      runId: claimed.run.id,
      attemptId: claimed.attemptId,
      generation: claimed.generation,
    });
    const prepared = await prepareDiagnosis(config, {
      investigationId: inv.id,
      runId: claimed.run.id,
      text: c.question,
      receivedAt: Date.parse(c.receivedAt),
      service: c.service,
      signal: controller.signal,
      sink,
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
    const resolver = new StoreEvidenceResolver(store, inv.id, claimed.run.id);
    const { report } = validateDraft(draft, {
      resolver,
      scope: prepared.scope,
      investigationId: inv.id,
      executionLimits: [],
    });
    const records = resolver
      .listByInvestigation(inv.id)
      .map((ref) => evidenceRefToRecord(ref, runId));
    cases.push(scoreCase(c, records, report));
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
