// 读回验证（plan §9）：实验与 Dataset Item 关联、案例过程归属、分数读回。
// 用当前部署的接口面：Experiments / Experiment Items / Observations v2 / Scores v3。
// 已知事实（eval/langfuse 分支核验）：events_only 下 scores GET 全部返回空——
// "仅 HTTP 写入成功不算通过，旧接口返回空也不能直接判断新数据丢失"，以 UI 为准并显式标注。
import type { LfClientConfig } from "./client.ts";

export interface ScoreDetail {
  traceId: string;
  name: string;
  value: number | string;
  source: string | null;
  comment: string | null;
  dataType: string | null;
}

export interface VerifyReport {
  experimentFound: boolean;
  experimentName: string | null;
  itemCount: number;
  linkedTraceIds: Array<{ traceId: string; experimentItemId: string }>;
  observationsForSample: number;
  scoresForSample: number;
  /** plan §9：读回分数值/来源/理由/关联对象（含人工标注）。 */
  scoreDetails: ScoreDetail[];
  problems: string[];
  warnings: string[];
}

const base = (cfg: LfClientConfig): string => cfg.baseUrl.replace(/\/$/, "");
const auth = (cfg: LfClientConfig): string =>
  `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64")}`;

async function call(cfg: LfClientConfig, method: string, path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base(cfg)}${path}`, { method, headers: { authorization: auth(cfg) } });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/**
 * plan §9：写入后 Langfuse 存在短暂索引延迟（旧接口空不能直接判定数据丢失）。
 * 轮询直到满足条件或超出重试窗口；返回最后一次结果。
 */
async function poll<T>(fn: () => Promise<T>, ok: (value: T) => boolean, attempts = 6, delayMs = 2500): Promise<T> {
  let last = await fn();
  for (let i = 1; i < attempts && !ok(last); i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    last = await fn();
  }
  return last;
}

export async function verifyExperiment(
  cfg: LfClientConfig,
  args: { datasetId: string; runName: string; expectTraces: string[] },
): Promise<VerifyReport> {
  const report: VerifyReport = {
    experimentFound: false,
    experimentName: null,
    itemCount: 0,
    linkedTraceIds: [],
    observationsForSample: 0,
    scoresForSample: 0,
    scoreDetails: [],
    problems: [],
    warnings: [],
  };
  const from = "2026-01-01T00:00:00.000Z";
  const experiments = await poll(
    async () => (await call(cfg, "GET", `/api/public/experiments?datasetId=${encodeURIComponent(args.datasetId)}&fromStartTime=${from}&limit=50`)).json as {
      data?: Array<{ id: string; name: string | null }>;
    } | null,
    (j) => (j?.data ?? []).some((e) => e.name === args.runName),
  );
  const experiment = experiments?.data?.find((e) => e.name === args.runName);
  if (!experiment) {
    report.problems.push(`实验「${args.runName}」未找到（dataset 下可见：${experiments?.data?.map((e) => e.name).join(", ") ?? "无"}；已等待索引延迟）`);
    return report;
  }
  report.experimentFound = true;
  report.experimentName = experiment.name;

  const items = await poll(
    async () => (await call(cfg, "GET", `/api/public/experiment-items?experimentId=${encodeURIComponent(experiment.id)}&fromStartTime=${from}&limit=100`)).json as {
      data?: Array<{ id: string; traceId: string }>;
    } | null,
    (j) => (j?.data ?? []).length > 0,
  );
  const rows = items?.data ?? [];
  report.itemCount = rows.length;
  report.linkedTraceIds = rows.map((r) => ({ traceId: r.traceId, experimentItemId: r.id }));

  const linked = new Set(rows.map((r) => r.traceId));
  for (const t of args.expectTraces) {
    if (!linked.has(t)) report.problems.push(`trace ${t.slice(0, 12)} 未关联到实验`);
  }

  const sample = rows[0]?.traceId ?? args.expectTraces[0];
  if (sample) {
    const obs = await poll(
      async () => (await call(cfg, "GET", `/api/public/v2/observations?traceId=${encodeURIComponent(sample)}&limit=100`)).json as {
        data?: Array<{ id: string; traceId: string }>;
      } | null,
      (j) => (j?.data ?? []).some((o) => o.traceId === sample),
    );
    report.observationsForSample = (obs?.data ?? []).filter((o) => o.traceId === sample).length;
    if (report.observationsForSample === 0) report.problems.push(`样本 trace ${sample.slice(0, 12)} 无子观测（过程未归属）`);

    const scores = (await call(cfg, "GET", `/api/public/v3/scores?traceId=${encodeURIComponent(sample)}&limit=100`)).json as {
      data?: Array<{ id: string; name?: string; value?: number | string; source?: string; comment?: string | null; dataType?: string }>;
    } | null;
    report.scoresForSample = (scores?.data ?? []).length;
    report.scoreDetails = (scores?.data ?? []).map((s) => ({
      traceId: sample,
      name: s.name ?? "?",
      value: s.value ?? 0,
      source: s.source ?? null,
      comment: s.comment ?? null,
      dataType: s.dataType ?? null,
    }));
    if (report.scoresForSample === 0) {
      report.warnings.push("v3/scores 对样本返回空——events_only 已知限制：写入 2xx 但读 API 恒空，请在 UI 分数面板核对（不能据此判定丢失）");
    }
  }
  return report;
}

export function printVerify(r: VerifyReport): boolean {
  console.log(`${r.experimentFound ? "✅" : "❌"} 实验找到：${r.experimentName ?? "无"}`);
  console.log(`${r.itemCount > 0 ? "✅" : "❌"} experiment-items=${r.itemCount}`);
  console.log(`${r.problems.length === 0 ? "✅" : "❌"} 预期 trace 全部关联`);
  console.log(`${r.observationsForSample > 0 ? "✅" : "❌"} 样本观测回读=${r.observationsForSample}（v2/observations）`);
  console.log(`⚠ 分数读回=${r.scoresForSample}（v3/scores；恒空为平台限制，UI 为准）`);
  for (const s of r.scoreDetails) console.log(`   · ${s.name}=${s.value}${s.source ? `（来源 ${s.source}` : "（来源 ?"}${s.comment ? `；${s.comment.slice(0, 80)}` : ""}）`);
  for (const p of r.problems) console.error(`  ❌ ${p}`);
  for (const w of r.warnings) console.warn(`  ⚠ ${w}`);
  return r.problems.length === 0;
}
