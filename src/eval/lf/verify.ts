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
  configId: string | null;
  queueId: string | null;
  subject: { kind: string; id: string; traceId?: string } | null;
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

/** 每条案例都必须能读回的确定性分数（visibility_bc1d 条件生成，不作必需）。 */
export const EXPECTED_SCORE_NAMES = [
  "run_integrity",
  "citation_validity",
  "version_visibility",
  "expected_blocked",
  "prompt_injection",
  "tool_calls",
  "wall_ms",
  "total_tokens",
] as const;

/** 这三项为 0 说明实验/注入/负例校验存在实际问题（不归为平台限制）。 */
const MUST_BE_TRUE = ["run_integrity", "expected_blocked", "prompt_injection"] as const;

async function fetchScores(
  cfg: LfClientConfig,
  traceId: string,
  attempts: number,
  delayMs: number,
): Promise<Array<{ id: string; name?: string; value?: number | string; source?: string; comment?: string | null; dataType?: string; configId?: string | null; queueId?: string | null; subject?: { kind?: string; id?: string; traceId?: string } | null }>> {
  // fields=details,subject,annotation：plan §9 要求读回“值/理由/来源/关联对象”（skill 推荐用现代 v3 + fields）。
  const res = await poll(
    async () =>
      (await call(cfg, "GET", `/api/public/v3/scores?traceId=${encodeURIComponent(traceId)}&fields=details,subject,annotation&limit=100`)).json as {
        data?: Array<Record<string, unknown>>;
      } | null,
    (j) => (j?.data ?? []).length > 0,
    attempts,
    delayMs,
  );
  return (res?.data ?? []) as Array<{ id: string; name?: string; value?: number | string; source?: string; comment?: string | null; dataType?: string; configId?: string | null; queueId?: string | null; subject?: { kind?: string; id?: string; traceId?: string } | null }>;
}

export async function verifyExperiment(
  cfg: LfClientConfig,
  args: { datasetId: string; runName: string; expectTraces: string[] },
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<VerifyReport> {
  const attempts = opts.attempts ?? 6;
  const delayMs = opts.delayMs ?? 2500;
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
    attempts,
    delayMs,
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
    attempts,
    delayMs,
  );
  const rows = items?.data ?? [];
  report.itemCount = rows.length;
  report.linkedTraceIds = rows.map((r) => ({ traceId: r.traceId, experimentItemId: r.id }));

  const linked = new Set(rows.map((r) => r.traceId));
  for (const t of args.expectTraces) {
    if (!linked.has(t)) report.problems.push(`trace ${t.slice(0, 12)} 未关联到实验`);
  }

  // 分数读回（plan §9）：逐条案例核对预期指标、值与归属；缺失即失败，不归为平台限制。
  const targets = args.expectTraces.length > 0 ? args.expectTraces : rows.map((r) => r.traceId);
  for (const traceId of targets) {
    const scores = await fetchScores(cfg, traceId, attempts, delayMs);
    const names = new Set(scores.map((s) => s.name ?? ""));
    const missing = EXPECTED_SCORE_NAMES.filter((n) => !names.has(n));
    if (missing.length > 0) {
      report.problems.push(`trace ${traceId.slice(0, 12)} 缺分数：${missing.join(",")}（v3/scores 读回，非平台限制）`);
    }
    for (const s of scores) {
      const value = s.value ?? 0;
      if ((MUST_BE_TRUE as readonly string[]).includes(s.name ?? "") && !value) {
        report.problems.push(`trace ${traceId.slice(0, 12)} 的 ${s.name}=${String(value)}（应为通过）`);
      }
      // 归属校验：分数的 subject.traceId 必须等于被查 trace（防错挂）。
      const subjectTrace = s.subject?.traceId;
      if (subjectTrace && subjectTrace !== traceId) {
        report.problems.push(`trace ${traceId.slice(0, 12)} 的 ${s.name} 归属错误：subject.traceId=${subjectTrace.slice(0, 12)}`);
      }
      report.scoreDetails.push({
        traceId,
        name: s.name ?? "?",
        value,
        source: s.source ?? null,
        comment: s.comment ?? null,
        dataType: s.dataType ?? null,
        configId: s.configId ?? null,
        queueId: s.queueId ?? null,
        subject: s.subject ? { kind: s.subject.kind ?? "?", id: s.subject.id ?? "?", ...(s.subject.traceId ? { traceId: s.subject.traceId } : {}) } : null,
      });
    }
  }
  report.scoresForSample = report.scoreDetails.length;

  // 过程归属抽查：每条目标 trace 必须有子观测（不只查第一条）。
  for (const traceId of targets) {
    const obs = await poll(
      async () => (await call(cfg, "GET", `/api/public/v2/observations?traceId=${encodeURIComponent(traceId)}&limit=100`)).json as {
        data?: Array<{ id: string; traceId: string }>;
      } | null,
      (j) => (j?.data ?? []).some((o) => o.traceId === traceId),
      attempts,
      delayMs,
    );
    const count = (obs?.data ?? []).filter((o) => o.traceId === traceId).length;
    if (report.observationsForSample === 0) report.observationsForSample = count;
    if (count === 0) report.problems.push(`trace ${traceId.slice(0, 12)} 无子观测（过程未归属）`);
  }
  if (targets.length === 0) report.problems.push("没有可校验的 trace（manifest 与 experiment-items 均为空）");
  return report;
}

export function printVerify(r: VerifyReport): boolean {
  console.log(`${r.experimentFound ? "✅" : "❌"} 实验找到：${r.experimentName ?? "无"}`);
  console.log(`${r.itemCount > 0 ? "✅" : "❌"} experiment-items=${r.itemCount}`);
  console.log(`${r.problems.length === 0 ? "✅" : "❌"} 预期 trace 全部关联且分数可见`);
  console.log(`${r.observationsForSample > 0 ? "✅" : "❌"} 观测回读（首条 trace）=${r.observationsForSample}（v2/observations）`);
  console.log(`${r.scoreDetails.length > 0 ? "✅" : "❌"} 分数读回（v3/scores，逐案例）=${r.scoreDetails.length}`);
  for (const s of r.scoreDetails) {
    const source = s.source ? `来源 ${s.source}` : "来源 ?";
    const ann = s.queueId ? `；queue=${s.queueId.slice(0, 8)}` : "";
    const cfg = s.configId ? `；config=${s.configId.slice(0, 8)}` : "";
    const comment = s.comment ? `；${s.comment.replace(/\s+/g, " ").slice(0, 90)}` : "";
    console.log(`   · [${s.traceId.slice(0, 8)}] ${s.name}=${s.value}（${source}${ann}${cfg}${comment}）`);
  }
  for (const p of r.problems) console.error(`  ❌ ${p}`);
  for (const w of r.warnings) console.warn(`  ⚠ ${w}`);
  return r.problems.length === 0;
}
