// 真正执行锁定版本的 dataset.runExperiment；只 mock 服务端，验证业务和上下文契约。
// fake/scripted 结果用于工程回归，不代表模型质量或服务器实际落库。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LangfuseClient } from "@langfuse/client";
import { getPropagatedAttributesFromContext } from "@langfuse/core";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { loadConfig } from "../../src/config/index.ts";
import { createLangfuseRecorder } from "../../src/observability/langfuse.ts";
import { setupEvalOtel } from "../../src/eval/lf/otel.ts";
import { buildSmokePayloads, SMOKE_DATASET } from "../../src/eval/lf/seed.ts";
import { makeTicketDoctorTask, type CaseTaskOutput } from "../../src/eval/lf/task.ts";
import { smokeEvaluators } from "../../src/eval/lf/evaluators.ts";
import { compileHash } from "../../src/eval/lf/prompt.ts";
import { buildSystemPrompt } from "../../src/agent/pi-engine.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EVAL_ROOT = join(ROOT, "data", "eval-v2");
const CONFIG = { baseUrl: "http://127.0.0.1:19999", publicKey: "pk-lf-test", secretKey: "sk-lf-test" };

/** 排除随机身份/会话标记和耗时，比较用户可见结果与既有评测语义。 */
function businessResult(output: CaseTaskOutput) {
  return {
    caseId: output.caseId,
    engine: output.engine,
    auditEngine: output.auditEngine,
    prompt: output.prompt,
    failure: output.failure,
    rounds: output.rounds.map((r) => ({
      roundId: r.roundId, outcome: r.outcome, status: r.status, blocked: r.blocked,
      engineCalls: r.engineCalls, toolCalls: r.toolCalls, usage: r.usage,
      hasWriteback: !!r.writebackText, hasReport: r.report !== null,
      citations: r.citations.map((c) => ({ stage: c.stage, resolved: c.resolved, wrongSha: c.wrongSha })),
      visibility: r.visibility, allLogQueriesEmpty: r.allLogQueriesEmpty,
    })),
  };
}

for (const engine of ["scripted", "fake"] as const) {
  test(`SDK experiment（${engine}）：并发 Dataset Item 的多轮业务同 trace，评测根不被覆盖`, async (t) => {
    const ended: ReadableSpan[] = [];
    let providerShutdowns = 0;
    const processor: SpanProcessor = {
      // 与正式 LangfuseSpanProcessor.onStart 一致，应用实验传播属性。
      onStart(span, parentContext) { span.setAttributes(getPropagatedAttributesFromContext(parentContext)); },
      onEnd(span) { ended.push(span); },
      async forceFlush() {}, async shutdown() { providerShutdowns++; },
    };
    const evalOtel = setupEvalOtel(CONFIG, "test", processor);
    const recorder = createLangfuseRecorder({
      ...CONFIG, enabled: true, environment: "test", maxEventBytes: 524_288, shutdownMs: 100,
    }, undefined, { joinActiveContext: true, tracerProvider: evalOtel.provider })!;
    const lf = new LangfuseClient(CONFIG);
    const items = buildSmokePayloads(ROOT, EVAL_ROOT)
      .filter((p) => ["eng-clarify", "eng-audit-loop"].includes(p.metadata.caseId))
      .map((p) => ({ ...p, id: p.metadata.itemId, datasetId: "dataset-test", status: "ACTIVE" as const }));
    const links: Array<{ datasetItemId: string; traceId: string; observationId?: string | null }> = [];
    const scoreBatches: Array<Array<{ body: Record<string, unknown> }>> = [];
    t.mock.method(lf.api.datasets, "get", async () => ({ id: "dataset-test", name: SMOKE_DATASET }));
    t.mock.method(lf.api.datasetItems, "list", async () => ({ data: items, meta: { totalPages: 1 } }));
    t.mock.method(lf.api.datasetRunItems, "create", async (body: typeof links[number]) => {
      // 强制跨 await，使实验关联验证依赖真实 async context 路径。
      await new Promise<void>((resolve) => setImmediate(resolve));
      links.push(body);
      return { datasetRunId: "dataset-run-test" };
    });
    t.mock.method(lf.api.ingestion, "batch", async (body: { batch: typeof scoreBatches[number] }) => {
      scoreBatches.push(body.batch);
      return { errors: [], successes: [] };
    });
    t.mock.method(lf, "getTraceUrl", async (id: string) => `${CONFIG.baseUrl}/project/test/traces/${id}`);
    const config = loadConfig();
    const prompt = { name: "diagnosis", version: 1, compiled: buildSystemPrompt(), hash: compileHash(buildSystemPrompt()) };
    const baseOptions = {
      projectRoot: ROOT, evalRoot: EVAL_ROOT,
      baseConfig: { ...config, diagnosis: { ...config.diagnosis, audit: { ...config.diagnosis.audit, enabled: true } } },
      engine, prompt, outDir: mkdtempSync(join(tmpdir(), "td-lf-sdk-")),
    };
    try {
      const baselineTask = makeTicketDoctorTask(baseOptions);
      const baseline = await Promise.all(items.map((item) => baselineTask(item)));
      const task = makeTicketDoctorTask({ ...baseOptions, recorder });
      const dataset = await lf.dataset.get(SMOKE_DATASET);
      const result = await dataset.runExperiment({
        name: "sdk-migration", runName: `sdk-migration-${engine}`, maxConcurrency: 2,
        task: async (item) => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return task({ input: item.input, metadata: item.metadata });
        },
        evaluators: smokeEvaluators,
      });
      assert.equal(result.itemResults.length, 2);
      assert.equal(links.length, 2);
      assert.equal(new Set(links.map((l) => l.traceId)).size, 2, "并发 item 身份互不混入");
      for (const itemResult of result.itemResults) {
        const output = itemResult.output as CaseTaskOutput;
        const baselineOutput = baseline.find((b) => b.caseId === output.caseId)!;
        assert.equal(output.failure, undefined);
        assert.deepEqual(businessResult(output), businessResult(baselineOutput));
        const link = links.find((l) => l.traceId === itemResult.traceId)!;
        const tree = ended.filter((s) => s.spanContext().traceId === link.traceId);
        const experiment = tree.find((s) => s.name === "experiment-item-run")!;
        assert.equal(experiment.spanContext().spanId, link.observationId);
        assert.deepEqual(JSON.parse(String(experiment.attributes["langfuse.observation.input"])), itemResult.item.input);
        assert.deepEqual(JSON.parse(String(experiment.attributes["langfuse.observation.output"])), output);
        const turns = tree.filter((s) => s.name === "diagnose-turn");
        assert.equal(turns.length, output.rounds.length, "各业务轮次均落在当前 item 的 trace");
        for (const turn of turns) {
          assert.equal(turn.parentSpanContext?.spanId, experiment.spanContext().spanId);
          for (const key of ["name", "input", "output", "metadata"]) {
            assert.equal(turn.attributes[`langfuse.trace.${key}`], undefined);
          }
          assert.equal(turn.attributes["langfuse.experiment.item.root_observation_id"], experiment.spanContext().spanId);
        }
        for (const child of tree.filter((s) => s !== experiment)) {
          assert.ok(tree.some((p) => p.spanContext().spanId === child.parentSpanContext?.spanId), `${child.name} 必须有真实父节点`);
        }
        const scores = scoreBatches.flat().map((e) => e.body).filter((b) => b.traceId === link.traceId);
        assert.equal(scores.length, itemResult.evaluations.length);
        for (const score of scores) {
          assert.equal(score.observationId, experiment.spanContext().spanId);
          const evaluation = itemResult.evaluations.find((e) => e.name === score.name)!;
          assert.ok(evaluation);
          assert.equal(score.value, evaluation.value);
          assert.equal(score.dataType, evaluation.dataType);
        }
      }
      await recorder.shutdown();
      assert.equal(providerShutdowns, 0, "recorder 不关闭借用的实验 provider");
    } finally {
      await recorder.shutdown();
      await lf.shutdown();
      await evalOtel.shutdown();
    }
    assert.equal(providerShutdowns, 1);
  });
}
