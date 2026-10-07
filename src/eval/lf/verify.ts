// 读回验证（plan §9）：实验与 Dataset Item 关联、案例过程归属、分数读回、原生 prompt 关联。
// 用当前部署的接口面：Experiments / Experiment Items / Observations v2（fields）/ Scores v3（fields）。
// 官方 Scores v3 用 subject 表达归属；本模块逐条校验「值类型 + 必需字段 + 归属对象」，缺即失败。
import type { LfClientConfig } from "./client.ts";

export interface ScoreDetail {
  traceId: string;
  name: string;
  /** 按 dataType 的原生值；缺失记 null（不默认成 0）。 */
  value: number | string | boolean | null;
  source: string | null;
  comment: string | null;
  dataType: string | null;
  configId: string | null;
  queueId: string | null;
  subject: { kind: string; id: string; traceId?: string } | null;
}

export interface PromptAssociation {
  traceId: string;
  generations: number;
  /** 带原生 prompt 关联的 generation 及其 name/version。 */
  associated: Array<{ name: string; version: number }>;
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
  /** plan §5：目标提示词在模型 generation 上的原生 name/version 关联。 */
  promptAssociations: PromptAssociation[];
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

const VALID_SUBJECT_KINDS = ["trace", "observation", "session", "experiment"] as const;

type RawScore = { id: string; name?: string; value?: number | string | boolean; source?: string; comment?: string | null; dataType?: string; configId?: string | null; queueId?: string | null; subject?: { kind?: string; id?: string; traceId?: string } | null };

/** 按 dataType 校验必需字段：缺失值不默认成 0，类型不符即失败。 */
function validateScoreValue(s: RawScore): string[] {
  const problems: string[] = [];
  const dt = s.dataType ?? null;
  if (s.value === undefined || s.value === null) {
    problems.push("缺 value（不默认成 0）");
    return problems;
  }
  if (dt === "BOOLEAN" && typeof s.value !== "boolean") problems.push(`BOOLEAN 值应为布尔（得到 ${typeof s.value}）`);
  else if (dt === "NUMERIC" && typeof s.value !== "number") problems.push(`NUMERIC 值应为数字（得到 ${typeof s.value}）`);
  else if ((dt === "CATEGORICAL" || dt === "TEXT" || dt === "CORRECTION") && typeof s.value !== "string") problems.push(`${dt} 值应为字符串（得到 ${typeof s.value}）`);
  else if (dt === null) problems.push("缺 dataType");
  return problems;
}

/** Scores v3 用 subject 表达归属；缺 subject 或 kind/id 非法即失败（防错挂）。 */
function validateScoreSubject(s: RawScore, traceId: string): string[] {
  const problems: string[] = [];
  const subject = s.subject;
  if (!subject || !subject.kind || !subject.id) {
    problems.push("缺 subject/归属（kind/id）");
    return problems;
  }
  if (!(VALID_SUBJECT_KINDS as readonly string[]).includes(subject.kind)) problems.push(`subject.kind 非法：${subject.kind}`);
  if (subject.kind === "observation" && subject.traceId !== traceId) {
    problems.push(`subject.traceId=${subject.traceId?.slice(0, 12) ?? "null"} 与查询 trace 不符`);
  }
  if (subject.kind === "trace" && subject.id !== traceId) {
    problems.push(`subject.id=${subject.id.slice(0, 12)} 与查询 trace 不符`);
  }
  return problems;
}

/** 按指标名约定校验通过条件（不缺分类，不把“仅配置”当通过）。 */
function validateScorePolicy(s: RawScore): string[] {
  const problems: string[] = [];
  if (s.name === "run_integrity" || s.name === "expected_blocked") {
    if (s.value !== true) problems.push(`${s.name}=${String(s.value)}（应为 true）`);
  }
  if (s.name === "prompt_injection") {
    const v = String(s.value);
    if (v === "config_only") problems.push("prompt_injection=config_only（仅配置一致，未验证实际请求）");
    else if (v === "mismatch") problems.push("prompt_injection=mismatch");
    else if (v !== "actual_request_verified" && v !== "not_called") problems.push(`prompt_injection 状态非法：${v}`);
  }
  return problems;
}

async function fetchScores(cfg: LfClientConfig, traceId: string, attempts: number, delayMs: number): Promise<RawScore[]> {
  // fields=details,subject,annotation：plan §9 要求读回“值/理由/来源/关联对象”（skill 推荐用现代 v3 + fields）。
  const res = await poll(
    async () =>
      (await call(cfg, "GET", `/api/public/v3/scores?traceId=${encodeURIComponent(traceId)}&fields=details,subject,annotation&limit=100`)).json as {
        data?: RawScore[];
      } | null,
    (j) => (j?.data ?? []).length > 0,
    attempts,
    delayMs,
  );
  return res?.data ?? [];
}

/** plan §5：读回 generation 上的原生 prompt name/version 关联。 */
async function fetchPromptAssociation(cfg: LfClientConfig, traceId: string, attempts: number, delayMs: number): Promise<PromptAssociation> {
  const res = await poll(
    async () =>
      (await call(cfg, "GET", `/api/public/v2/observations?traceId=${encodeURIComponent(traceId)}&fields=prompt&limit=100`)).json as {
        data?: Array<Record<string, unknown>>;
      } | null,
    (j) => (j?.data ?? []).some((o) => o.type === "GENERATION"),
    attempts,
    delayMs,
  );
  const gens = (res?.data ?? []).filter((o) => o.type === "GENERATION");
  const associated = gens
    .filter((g) => typeof g.promptName === "string")
    .map((g) => ({ name: String(g.promptName), version: Number(g.promptVersion) }));
  return { traceId, generations: gens.length, associated };
}

export async function verifyExperiment(
  cfg: LfClientConfig,
  args: { datasetId: string; runName: string; expectTraces: string[]; expectedPrompt?: { name: string; version: number } },
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
    promptAssociations: [],
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
  const promptStateByTrace = new Map<string, string>();
  for (const traceId of targets) {
    const scores = await fetchScores(cfg, traceId, attempts, delayMs);
    const pi = scores.find((s) => s.name === "prompt_injection");
    if (pi) promptStateByTrace.set(traceId, String(pi.value));
    const names = new Set(scores.map((s) => s.name ?? ""));
    const missing = EXPECTED_SCORE_NAMES.filter((n) => !names.has(n));
    if (missing.length > 0) {
      report.problems.push(`trace ${traceId.slice(0, 12)} 缺分数：${missing.join(",")}（v3/scores 读回，非平台限制）`);
    }
    for (const s of scores) {
      const issues = [...validateScoreValue(s), ...validateScoreSubject(s, traceId), ...validateScorePolicy(s)];
      for (const issue of issues) report.problems.push(`trace ${traceId.slice(0, 12)} ${s.name ?? "?"}: ${issue}`);
      report.scoreDetails.push({
        traceId,
        name: s.name ?? "?",
        value: s.value ?? null,
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

  // 过程归属 + 原生 prompt 关联：每条目标 trace 必须有子观测，且 generation 带目标 prompt name/version。
  for (const traceId of targets) {
    const assoc = await fetchPromptAssociation(cfg, traceId, attempts, delayMs);
    report.promptAssociations.push(assoc);
    if (report.observationsForSample === 0) report.observationsForSample = assoc.generations;
    if (assoc.generations === 0) {
      // 预期阻断/未调用模型的案例本就没有 generation（prompt_injection=not_called），不算缺失。
      if (promptStateByTrace.get(traceId) !== "not_called") {
        report.problems.push(`trace ${traceId.slice(0, 12)} 无 generation（过程未归属或未调用模型）`);
      }
    } else if (args.expectedPrompt) {
      if (assoc.associated.length === 0) {
        report.problems.push(`trace ${traceId.slice(0, 12)} 未读回原生 prompt 关联（generations=${assoc.generations}）`);
      } else {
        const wrong = assoc.associated.filter((a) => a.name !== args.expectedPrompt!.name || a.version !== args.expectedPrompt!.version);
        if (wrong.length > 0) {
          report.problems.push(`trace ${traceId.slice(0, 12)} 原生 prompt 关联不符：${wrong.map((w) => `${w.name}@v${w.version}`).join(",")} ≠ ${args.expectedPrompt.name}@v${args.expectedPrompt.version}`);
        }
        if (assoc.associated.length < assoc.generations) {
          report.warnings.push(`trace ${traceId.slice(0, 12)} 有 ${assoc.generations - assoc.associated.length}/${assoc.generations} 个 generation 未带 prompt 关联（可能为审计/压缩）`);
        }
      }
    }
  }
  if (targets.length === 0) report.problems.push("没有可校验的 trace（manifest 与 experiment-items 均为空）");
  return report;
}

export function printVerify(r: VerifyReport): boolean {
  console.log(`${r.experimentFound ? "✅" : "❌"} 实验找到：${r.experimentName ?? "无"}`);
  console.log(`${r.itemCount > 0 ? "✅" : "❌"} experiment-items=${r.itemCount}`);
  console.log(`${r.problems.length === 0 ? "✅" : "❌"} 预期 trace 全部关联且分数可见`);
  console.log(`${r.observationsForSample > 0 ? "✅" : "❌"} 观测回读（首条 trace generations）=${r.observationsForSample}（v2/observations）`);
  const assocTotal = r.promptAssociations.reduce((a, x) => a + x.associated.length, 0);
  const genTotal = r.promptAssociations.reduce((a, x) => a + x.generations, 0);
  console.log(`${assocTotal > 0 ? "✅" : "❌"} 原生 prompt 关联回读=${assocTotal}/${genTotal} 个 generation（v2 observations fields=prompt）`);
  console.log(`${r.scoreDetails.length > 0 ? "✅" : "❌"} 分数读回（v3/scores，逐案例）=${r.scoreDetails.length}`);
  for (const s of r.scoreDetails) {
    const source = s.source ? `来源 ${s.source}` : "来源 ?";
    const ann = s.queueId ? `；queue=${s.queueId.slice(0, 8)}` : "";
    const cfg = s.configId ? `；config=${s.configId.slice(0, 8)}` : "";
    const comment = s.comment ? `；${s.comment.replace(/\s+/g, " ").slice(0, 90)}` : "";
    const subject = s.subject ? `；subject=${s.subject.kind}:${s.subject.id.slice(0, 8)}` : "；subject=缺";
    console.log(`   · [${s.traceId.slice(0, 8)}] ${s.name}=${s.value}（${source}${ann}${cfg}${subject}${comment}）`);
  }
  for (const p of r.problems) console.error(`  ❌ ${p}`);
  for (const w of r.warnings) console.warn(`  ⚠ ${w}`);
  return r.problems.length === 0;
}
