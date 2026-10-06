// 独立审计（OQ-30）的角色与结果契约。
//
// 审计是一个**独立上下文/独立会话**，不是主诊断的延续：它只拿到
// 「原始问题 + 调查范围 + 草稿 + 证据快照」，拿不到主诊断的推理历史。
// 模型只出判定，程序按判定对**具体结论**降级（见 src/diagnosis/audit.ts）。
import type { MaterialScope, ReportDraft } from "../domain/types.ts";
import type { EvidenceRef } from "../evidence/types.ts";

/**
 * 审计策略版本：改动「提示词 / 输出契约 / 降级规则」时递增。
 * 结果随 run_events 落库，禁止跨版本比较历史判定（对齐 scorerVersion 口径）。
 */
export const AUDIT_POLICY_VERSION = "1.0.0";

/** 逐结论判定：支持 / 不支持 / 与证据矛盾 / 无法判定。 */
export type ClaimVerdict = "supported" | "unsupported" | "contradicted" | "undecidable";

export interface ClaimAudit {
  /** 对应草稿 hypotheses 的下标（0-based，顺序经校验后不变）。 */
  hypothesisIndex: number;
  verdict: ClaimVerdict;
  reason: string;
  /** 支撑/反驳该判定的证据 UID（可选，仅用于留痕）。 */
  evidenceUids?: string[];
}

export interface MissingEvidence {
  /** 针对的结论下标；-1 表示整体。 */
  hypothesisIndex: number;
  what: string;
  suggestedTool?: "query_logs" | "list_files" | "search_code" | "read_code";
  suggestedArgs?: Record<string, unknown>;
}

export type StopAdvice =
  | { action: "stop"; reason: string }
  | { action: "continue"; reason: string }
  | { action: "ask_user"; reason: string; question: string };

export interface AuditResult {
  claimVerdicts: ClaimAudit[];
  missingEvidence: MissingEvidence[];
  stopAdvice: StopAdvice;
}

/** 审计输入快照：主诊断的推理历史不在此列。 */
export interface AuditInput {
  question: string;
  service?: string;
  environment?: string;
  scope: MaterialScope;
  draft: ReportDraft;
  /** 冻结的证据快照（截断信息由渲染显式标注）。 */
  evidence: EvidenceRef[];
  /** 本轮执行限制（工具/时间），供审计判断“材料不足”还是“预算不足”。 */
  executionLimits: string[];
}

/**
 * 审计端口。首版：`allowRetrieval=false` 时实现方不提供任何检索工具，
 * 只读冻结快照；返回 modelTurns 供调用方并入本次 attempt 的模型调用预算。
 */
export interface AuditOutcome {
  result: AuditResult;
  modelTurns: number;
}

export interface EvidenceAuditor {
  readonly name: string;
  audit(input: AuditInput, signal: AbortSignal): Promise<AuditOutcome>;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function findRef(evidence: EvidenceRef[], citation: string): EvidenceRef | undefined {
  return evidence.find((e) => e.evidenceUid === citation || e.evidenceId === citation);
}

function scopeLine(scope: MaterialScope): string {
  const win = scope.timeWindow;
  const window = win ? `${new Date(win.from).toISOString()} ~ ${new Date(win.to).toISOString()}` : "未指定";
  const repos = scope.repos.length
    ? scope.repos.map((r) => `${r.repoId}@${(r.sha ?? r.rev).slice(0, 10)}`).join("、")
    : "无";
  return `调查范围：服务=${scope.services.join("、") || "未指定"}；环境=${scope.environment ?? "未指定"}；时间窗=${window}；代码版本=${repos}`;
}

/**
 * 把审计输入渲染成一段文本给审计会话。控制总量，标注截断，
 * 让审计明确知道“材料可能不全”，而不是把缺失当成无证据。
 */
export function renderAuditInput(input: AuditInput, maxChars = 16_000): string {
  const lines: string[] = [];
  lines.push("【待审计材料】只依据以下内容判定，不要假设还有未给出的材料。");
  lines.push("");
  lines.push(`原始问题：${input.question}`);
  lines.push(scopeLine(input.scope));
  if (input.executionLimits.length > 0) lines.push(`执行限制：${input.executionLimits.join("；")}`);
  lines.push("");
  lines.push("草稿：");
  lines.push(`- completeness：${input.draft.completeness}`);
  lines.push(`- summary：${input.draft.summary}`);
  if (input.draft.confirmedFacts.length > 0) {
    lines.push("- confirmedFacts：");
    for (const fact of input.draft.confirmedFacts) lines.push(`  · ${truncate(fact, 300)}`);
  }
  if (input.draft.uncertainties.length > 0) {
    lines.push("- uncertainties：");
    for (const u of input.draft.uncertainties) lines.push(`  · ${truncate(u, 300)}`);
  }
  if (input.draft.missingMaterial.length > 0) {
    lines.push("- missingMaterial：");
    for (const m of input.draft.missingMaterial) lines.push(`  · ${truncate(m, 300)}`);
  }
  lines.push("");
  lines.push("结论（逐条判定，hypothesisIndex 用下列序号）：");
  input.draft.hypotheses.forEach((h, i) => {
    const cites = h.evidenceIds ?? [];
    lines.push(`[${i}] ${h.cause}`);
    lines.push(`    模型声明：status=${h.status ?? "(默认)"} confidence=${h.confidence}；引用=${cites.join("、") || "（无）"}`);
    for (const c of cites) {
      const ref = findRef(input.evidence, c);
      if (!ref) {
        lines.push(`      ${c}: <证据快照中没有该引用>`);
        continue;
      }
      const flag = ref.truncated ? "（已截断）" : "";
      lines.push(`      ${ref.evidenceId}/${ref.evidenceUid} ${ref.kind} ${ref.source}${flag}`);
      lines.push(`        ${truncate(ref.excerpt.replace(/\s+/g, " "), 600)}`);
    }
  });

  const cited = new Set(input.draft.hypotheses.flatMap((h) => h.evidenceIds ?? []));
  const others = input.evidence.filter((e) => !cited.has(e.evidenceUid) && !cited.has(e.evidenceId));
  if (others.length > 0) {
    lines.push("");
    lines.push(`其他可用证据（未被子结论引用；可用于发现反证/缺失）：`);
    for (const ref of others) {
      const flag = ref.truncated ? "（已截断）" : "";
      lines.push(`- ${ref.evidenceId}/${ref.evidenceUid} ${ref.kind} ${ref.source}${flag}：${truncate(ref.excerpt.replace(/\s+/g, " "), 300)}`);
    }
  }

  lines.push("");
  lines.push("请调用 submit_audit 给出结构化判定；证据不足或引用不可解析时用 undecidable，不要臆测。");
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n（审计材料已截断：原始 ${text.length} 字符，展示前 ${maxChars} 字符）`;
}
