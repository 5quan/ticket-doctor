// 可见性四层（方案 §8）：A sourceReturned / B persisted / C1 toolReturned / C2 requestContext / D reportUsed。
//
// 关键口径：
//   * B = 工具 commit 入库的证据（含未展示部分）；C1 = 实际出现在模型可见工具返回文本中的内容。
//     入库 ≠ 可见：search_code 预览上限、query_logs 渲染预算都会制造 B\C1 差距。
//   * C1 从 session_entries 的真实 toolResult 文本取（模型实际看到什么），不靠渲染重放推断。
//   * C2 无请求观测恒为 null（observationLevel 记录），不得冒充"模型收到了"。
//   * 命中判定以 locator.keyContent 为主键；level 只作辅助；相邻行/注释不自动命中。
import { FileLogSource } from "../../sources/logs.ts";
import type { LogEntry } from "../../domain/types.ts";
import type {
  CodeLocatorV2,
  LogLocatorV2,
  LocatorV2,
  ObservationLevel,
  RequirementSatisfaction,
  TruthFileV2,
} from "./types.ts";

// ---------- A 层：记录日志源实际返回 ----------

export interface SourceCallRecord {
  tool: "query_logs";
  args: { service: string; from: number; to: number; keywords: string[] };
  /** 源实际返回给工具的条目（已含源侧上限/过滤）。 */
  entries: LogEntry[];
}

/** 记录型日志源：A 层观测点。继承生产实现注入（executeRun 的 deps.logSource），不改源语义。 */
export class RecordingFileLogSource extends FileLogSource {
  readonly calls: SourceCallRecord[] = [];

  async query(intent: Parameters<FileLogSource["query"]>[0], signal: AbortSignal): Promise<LogEntry[]> {
    const entries = await super.query(intent, signal);
    this.calls.push({
      tool: "query_logs",
      args: { service: intent.service, from: intent.from, to: intent.to, keywords: [...intent.keywords] },
      entries: entries.map((e) => ({ time: e.time, level: e.level, message: e.message })),
    });
    return entries;
  }
}

// ---------- B 层：入库证据 ----------

export interface LayerEvidence {
  evidenceId: string;
  evidenceUid?: string;
  runId: string;
  kind: string;
  excerpt: string;
  truncated: boolean;
  level?: string | null;
  codeRef?: { repoId: string; sha: string; path: string; startLine: number; endLine: number } | null;
}

/** 最小 SQL 面：node:sqlite DatabaseSync 的结构化子集，评测侧只读查询。 */
export interface SqliteLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
}

const EVIDENCE_SELECT =
  "SELECT run_id, evidence_id, evidence_uid, kind, excerpt, truncated, level, repo_id, sha, path, start_line, end_line FROM evidence";

function rowToEvidence(runIdFallback: string, r: Record<string, unknown>): LayerEvidence {
  return {
    evidenceId: String(r.evidence_id),
    evidenceUid: r.evidence_uid === null || r.evidence_uid === undefined ? undefined : String(r.evidence_uid),
    runId: r.run_id === null || r.run_id === undefined ? runIdFallback : String(r.run_id),
    kind: String(r.kind),
    excerpt: String(r.excerpt),
    truncated: Number(r.truncated) === 1,
    level: r.level === null || r.level === undefined ? null : String(r.level),
    codeRef:
      r.repo_id && r.sha && r.path
        ? {
            repoId: String(r.repo_id),
            sha: String(r.sha),
            path: String(r.path),
            startLine: Number(r.start_line),
            endLine: Number(r.end_line),
          }
        : null,
  };
}

/** B 层：某轮（run）入库的全部证据。 */
export function layerB(sqlite: SqliteLike, runId: string): LayerEvidence[] {
  const rows = sqlite
    .prepare(`${EVIDENCE_SELECT} WHERE run_id = ? ORDER BY created_at ASC, CAST(SUBSTR(evidence_id, 2) AS INTEGER) ASC`)
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map((r) => rowToEvidence(runId, r));
}

/** B 层（调查级累计）：跨轮全部证据。 */
export function layerBByInvestigation(sqlite: SqliteLike, investigationId: string): LayerEvidence[] {
  const rows = sqlite
    .prepare(`${EVIDENCE_SELECT} WHERE investigation_id = ? ORDER BY created_at ASC, CAST(SUBSTR(evidence_id, 2) AS INTEGER) ASC`)
    .all(investigationId) as Array<Record<string, unknown>>;
  return rows.map((r) => rowToEvidence("", r));
}

// ---------- C1 层：模型实际可见的工具返回文本 ----------

export interface ToolReturnRecord {
  runId: string;
  callId: string;
  tool: string;
  isError: boolean;
  text: string;
}

interface PiEntryShape {
  type: string;
  message?: {
    role?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
}

function textOf(content: PiEntryShape["message"] extends undefined ? never : NonNullable<PiEntryShape["message"]>["content"]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/** C1 层：某调查内真实 toolResult 文本（按 seq 序；runId 给定时过滤单轮）。 */
export function layerC1(sqlite: SqliteLike, investigationId: string, runId?: string): ToolReturnRecord[] {
  const rows = runId
    ? sqlite
        .prepare("SELECT run_id, data FROM session_entries WHERE investigation_id = ? AND run_id = ? ORDER BY seq ASC")
        .all(investigationId, runId)
    : sqlite
        .prepare("SELECT run_id, data FROM session_entries WHERE investigation_id = ? ORDER BY seq ASC")
        .all(investigationId);
  const out: ToolReturnRecord[] = [];
  for (const row of rows as Array<{ run_id: string; data: string }>) {
    let entry: PiEntryShape | undefined;
    try {
      entry = JSON.parse(row.data) as PiEntryShape;
    } catch {
      continue;
    }
    const m = entry?.message;
    if (entry?.type === "message" && m?.role === "toolResult") {
      out.push({
        runId: row.run_id,
        callId: m.toolCallId ?? "",
        tool: m.toolName ?? "unknown",
        isError: m.isError === true,
        text: textOf(m.content),
      });
    }
  }
  return out;
}

// ---------- 定位匹配 ----------

export function matchesLog(loc: LogLocatorV2, kind: string, excerpt: string, level: string | null | undefined): boolean {
  if (kind !== "log") return false;
  if (!excerpt.includes(loc.keyContent)) return false;
  if (loc.level && level !== null && level !== undefined && level !== loc.level) return false;
  return true;
}

export function matchesCode(loc: CodeLocatorV2, kind: string, excerpt: string, codeRef: LayerEvidence["codeRef"]): boolean {
  if (kind !== "code" || !codeRef) return false;
  if (codeRef.repoId !== loc.repoId || codeRef.path !== loc.path) return false;
  if (loc.sha && codeRef.sha !== loc.sha) return false;
  if (!(codeRef.startLine <= loc.lineEnd && codeRef.endLine >= loc.lineStart)) return false;
  return excerpt.includes(loc.keyContent);
}

export function matchesEvidence(loc: LocatorV2, e: LayerEvidence): boolean {
  return loc.kind === "log" ? matchesLog(loc, e.kind, e.excerpt, e.level) : matchesCode(loc, e.kind, e.excerpt, e.codeRef);
}

// ---------- 需求满足 ----------

export type LayerKey = "A" | "B" | "C1" | "C2" | "D";

/** 一次工具调用的可见性身份：模型看到的文本 + 该调用实际提交入库的证据。 */
export interface CallEvidence {
  callId: string;
  text: string;
  isError: boolean;
  evidence: LayerEvidence[];
}

export interface LayerContext {
  /** A 层：日志源调用记录（仅日志 locator 可判；无记录 = null 未观测）。 */
  sourceCalls: SourceCallRecord[];
  /** B 层：截至本轮累计入库证据。 */
  persisted: LayerEvidence[];
  /**
   * C1 层：按调用绑定的「实际返回文本 + 该调用提交的批次证据」。
   * C1 命中必须同时满足：文本含关键内容 且 同调用批次证据匹配 locator
   * （类型/仓库/SHA/路径/内容）——全局文本搜索会把错误版本的相同文本算成可见（审计探针
   * wrongShaVisibility），禁止。
   */
  callEvidence: CallEvidence[];
  /** D 层：报告引用解析出的证据。 */
  cited: LayerEvidence[];
  observationLevel: ObservationLevel;
  c2Reason: string;
}

function locatorLayers(loc: LocatorV2, ctx: LayerContext): { A: boolean | null; B: boolean; C1: boolean; C2: boolean | null; D: boolean; reason?: string } {
  const b = ctx.persisted.some((e) => matchesEvidence(loc, e));
  // C1：文本与批次证据必须来自同一次调用且同时匹配（身份绑定，见 LayerContext.callEvidence）。
  const c1 = ctx.callEvidence.some(
    (call) => !call.isError && call.text.includes(loc.keyContent) && call.evidence.some((e) => matchesEvidence(loc, e)),
  );
  const d = ctx.cited.some((e) => matchesEvidence(loc, e));
  if (loc.kind === "code") {
    return { A: null, B: b, C1: c1, C2: null, D: d, reason: "A 层未观测代码源（评测侧无注入点）；B 为其超集（源侧上限丢弃除外）" };
  }
  if (ctx.observationLevel === "none" || ctx.sourceCalls.length === 0) {
    return { A: null, B: b, C1: c1, C2: null, D: d, reason: "A 层无调用记录，未观测" };
  }
  const a = ctx.sourceCalls.some((call) =>
    call.entries.some((e) => e.message.includes(loc.keyContent) && (loc.level ? e.level === loc.level : true)),
  );
  return { A: a, B: b, C1: c1, C2: null, D: d };
}

export interface RoundVisibilityInput {
  caseRoundIds: string[];
  truth: TruthFileV2;
  roundId: string;
  ctx: LayerContext;
}

/** 逐需求可见性：满足 = 某 OR 组合的 AND 成员全部命中该层；部分命中记 partial。 */
export function computeRequirementSatisfaction(input: RoundVisibilityInput): RequirementSatisfaction[] {
  const { truth, roundId, ctx } = input;
  const roundIndex = input.caseRoundIds.indexOf(roundId);
  const locatorMap = new Map(truth.locators.map((l) => [l.locatorId, l]));
  const out: RequirementSatisfaction[] = [];
  for (const round of truth.rounds) {
    for (const req of round.evidenceRequirements) {
      if (req.notRequiredBeforeRound) {
        const fromIndex = input.caseRoundIds.indexOf(req.notRequiredBeforeRound);
        if (fromIndex >= 0 && roundIndex >= 0 && roundIndex < fromIndex) {
          out.push({
            requirementId: req.requirementId,
            depth: req.depth,
            applicable: false,
            notApplicableReason: `证据仅 ${req.notRequiredBeforeRound} 轮后可取得`,
            locators: [],
            satisfied: { A: null, B: false, C1: false, C2: null, D: false },
            partial: false,
          });
          continue;
        }
      }
      const groups = req.supportsAnyOf.map((g) =>
        g.allOf.map((id) => {
          const loc = locatorMap.get(id);
          return loc
            ? { locatorId: id, layers: locatorLayers(loc, ctx) }
            : {
                locatorId: id,
                layers: { A: null, B: false, C1: false, C2: null, D: false },
                reason: "truth 引用了未定义 locator",
              };
        }),
      );
      const layerSatisfied = (key: LayerKey): boolean | null => {
        const anyGroup = groups.some((g) => g.every((m) => m.layers[key] === true));
        if (anyGroup) return true;
        // 该层存在未观测成员且没有任何否定性命中 → 记 null（不可判），不冒充 0。
        const anyFalse = groups.some((g) => g.some((m) => m.layers[key] === false));
        if (key === "A" || key === "C2") return anyFalse ? false : null;
        return false;
      };
      out.push({
        requirementId: req.requirementId,
        depth: req.depth,
        applicable: true,
        locators: groups.flat(),
        satisfied: {
          A: layerSatisfied("A"),
          B: layerSatisfied("B") ?? false,
          C1: layerSatisfied("C1") ?? false,
          C2: layerSatisfied("C2"),
          D: layerSatisfied("D") ?? false,
        },
        partial: groups.some((g) => g.some((m) => m.layers.C1 === true)) && layerSatisfied("C1") !== true,
      });
    }
  }
  return out;
}

/** D 层：报告引用（uid）解析为证据。 */
export function citedEvidence(sqlite: SqliteLike, investigationId: string, uids: string[]): LayerEvidence[] {
  const out: LayerEvidence[] = [];
  const seen = new Set<string>();
  for (const uid of uids) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    const row = sqlite
      .prepare(`${EVIDENCE_SELECT} WHERE investigation_id = ? AND evidence_uid = ?`)
      .get(investigationId, uid) as Record<string, unknown> | undefined;
    if (row) out.push(rowToEvidence("", row));
  }
  return out;
}

/**
 * C1 用的调用身份表：调查级累计，callId → 该调用实际提交的批次证据行。
 * 与 layerC1 的 toolResult 文本按 callId 关联，构成 CallEvidence。
 */
export function layerBatchesByCall(sqlite: SqliteLike, investigationId: string): Map<string, LayerEvidence[]> {
  const rows = sqlite
    .prepare(
      `SELECT b.tool_call_id AS call_id, e.run_id, e.evidence_id, e.evidence_uid, e.kind, e.excerpt,
              e.truncated, e.level, e.repo_id, e.sha, e.path, e.start_line, e.end_line
         FROM evidence_batches b JOIN evidence e ON e.batch_id = b.batch_id
        WHERE b.investigation_id = ?
        ORDER BY e.created_at ASC`,
    )
    .all(investigationId) as Array<Record<string, unknown>>;
  const map = new Map<string, LayerEvidence[]>();
  for (const row of rows) {
    const callId = String(row.call_id);
    const list = map.get(callId) ?? [];
    list.push(rowToEvidence(String(row.run_id ?? ""), row));
    map.set(callId, list);
  }
  return map;
}
