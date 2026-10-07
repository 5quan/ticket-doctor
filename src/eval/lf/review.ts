// 原生人工评分配置与标注入口（plan §7 P1）：在 Langfuse 建立 0–2 分的
// `prediagnosis_quality` 评分配置与标注队列，并把实验 trace 加入队列，供人工复核。
// 语义质量由 Langfuse 原生人工标注负责，首期不要求模型裁判；未复核记为 unscored。
import type { LangfuseClient } from "@langfuse/client";

export const QUALITY_SCORE_CONFIG = "prediagnosis_quality";
export const ANNOTATION_QUEUE = "ticket-doctor-prediagnosis-review";
/** 0/1/2 分档（plan §7）——提示词对比期人工统一口径。 */
export const QUALITY_DESCRIPTION =
  "2 分：结论或补问符合当轮标准，重要判断有依据；1 分：部分成立，但遗漏重要事实/边界/补问；0 分：重要错误、无依据断言，或未处理明确反证；未复核 unscored。";

interface ScoreConfigPage {
  data: Array<{ id: string; name: string }>;
}
interface AnnotationQueuePage {
  data: Array<{ id: string; name: string; scoreConfigIds: string[] }>;
}
interface AnnotationQueueItemPage {
  data: Array<{ objectId: string; objectType: string }>;
  meta?: { totalPages?: number };
}

export interface AnnotationSetup {
  scoreConfigId: string;
  scoreConfigCreated: boolean;
  queueId: string;
  queueCreated: boolean;
}

async function findScoreConfig(lf: LangfuseClient, name: string): Promise<string | undefined> {
  const page = (await lf.api.scoreConfigs.get({ limit: 100 })) as unknown as ScoreConfigPage;
  return page.data.find((c) => c.name === name)?.id;
}

/** 幂等建立 0–2 分评分配置与标注队列。 */
export async function ensureAnnotationSetup(lf: LangfuseClient, scoreConfigName = QUALITY_SCORE_CONFIG, queueName = ANNOTATION_QUEUE): Promise<AnnotationSetup> {
  let scoreConfigId = await findScoreConfig(lf, scoreConfigName);
  const scoreConfigCreated = scoreConfigId === undefined;
  if (!scoreConfigId) {
    const created = (await lf.api.scoreConfigs.create({
      name: scoreConfigName,
      dataType: "NUMERIC",
      minValue: 0,
      maxValue: 2,
      description: QUALITY_DESCRIPTION,
    })) as unknown as { id: string };
    scoreConfigId = created.id;
  }

  const queues = (await lf.api.annotationQueues.listQueues({ limit: 100 })) as unknown as AnnotationQueuePage;
  let queue = queues.data.find((q) => q.name === queueName);
  const queueCreated = queue === undefined;
  if (!queue) {
    queue = (await lf.api.annotationQueues.createQueue({
      name: queueName,
      description: "ticket-doctor 合成案例预诊断人工复核（0–2 分；未复核 unscored）",
      scoreConfigIds: [scoreConfigId],
    })) as unknown as { id: string; name: string; scoreConfigIds: string[] };
  }
  return { scoreConfigId, scoreConfigCreated, queueId: queue.id, queueCreated };
}

export interface QueueAddResult {
  added: string[];
  skipped: string[];
}

/** 把实验 trace 加入标注队列（幂等：已在队列中的 trace 跳过）。 */
export async function addTracesToAnnotationQueue(lf: LangfuseClient, queueId: string, traceIds: string[]): Promise<QueueAddResult> {
  const existing = new Set<string>();
  let page = 1;
  for (;;) {
    const res = (await lf.api.annotationQueues.listQueueItems(queueId, { page, limit: 100 })) as unknown as AnnotationQueueItemPage;
    for (const item of res.data) existing.add(item.objectId);
    const totalPages = res.meta?.totalPages ?? 1;
    if (page >= totalPages) break;
    page++;
  }
  const result: QueueAddResult = { added: [], skipped: [] };
  for (const traceId of traceIds) {
    if (existing.has(traceId)) {
      result.skipped.push(traceId);
      continue;
    }
    await lf.api.annotationQueues.createQueueItem(queueId, { objectId: traceId, objectType: "TRACE" });
    existing.add(traceId);
    result.added.push(traceId);
  }
  return result;
}
