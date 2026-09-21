// 报告展示：把结构化报告渲染成飞书可读文本。纯函数，便于测试与复用。
import type { DiagnosisReport, MaterialScope, RunBudget } from "./types.ts";
import { buildSessionMarker } from "./session.ts";

export const DEFAULT_BUDGET: RunBudget = {
  timeMs: 180_000,
  maxToolCalls: 12,
  maxResultChars: 4_000,
  maxModelTurns: 10,
};

export interface ReportView {
  investigationId: string;
  sessionCode: string;
  round: number;
  title?: string;
  question: string;
}

function fmtScope(scope: MaterialScope): string {
  const repos =
    scope.repos.length === 0
      ? "未使用源码"
      : scope.repos
          .map((r) => `${r.repoId}@${r.sha ? r.sha.slice(0, 10) : r.rev}${r.resolved ? "" : "(未钉死)"}`)
          .join("、");
  const window =
    scope.timeWindow === undefined
      ? "未限定"
      : `${new Date(scope.timeWindow.from).toISOString()} ~ ${new Date(scope.timeWindow.to).toISOString()}`;
  return [
    `- 服务：${scope.services.length > 0 ? scope.services.join("、") : "未指定"}`,
    `- 环境：${scope.environment ?? "未指定"}`,
    `- 时间窗：${window}`,
    `- 源码：${repos}`,
  ].join("\n");
}

export function renderReportText(report: DiagnosisReport, view: ReportView): string {
  const lines: string[] = [];
  lines.push(`【预检报告】${view.title ? view.title : "Bug 预检"}`);
  lines.push(`调查 ${view.investigationId} · 第 ${view.round} 轮 · 材料${report.completeness === "complete" ? "完整" : "不完整"}`);
  lines.push("");
  lines.push("■ 问题摘要");
  lines.push(report.summary || "（无）");

  if (report.confirmedFacts.length > 0) {
    lines.push("");
    lines.push("■ 已确认事实");
    for (const fact of report.confirmedFacts) lines.push(`- ${fact}`);
  }

  lines.push("");
  lines.push("■ 根因假设");
  if (report.hypotheses.length === 0) {
    lines.push("- 暂无足够材料形成假设");
  } else {
    report.hypotheses.forEach((h, i) => {
      const refs = h.evidenceIds.length > 0 ? ` [证据 ${h.evidenceIds.join(",")}]` : "";
      lines.push(`${i + 1}. (${h.confidence}/${h.status}) ${h.cause}${refs}`);
    });
  }

  if (report.uncertainties.length > 0) {
    lines.push("");
    lines.push("■ 不确定点");
    for (const item of report.uncertainties) lines.push(`- ${item}`);
  }

  if (report.missingMaterial.length > 0) {
    lines.push("");
    lines.push("■ 缺失材料（导致部分结论）");
    for (const item of report.missingMaterial) lines.push(`- ${item}`);
  }

  if (report.nextSteps.length > 0) {
    lines.push("");
    lines.push("■ 建议验证步骤");
    for (const item of report.nextSteps) lines.push(`- ${item}`);
  }

  lines.push("");
  lines.push("■ 材料范围");
  lines.push(fmtScope(report.scope));

  if (report.executionLimits.length > 0) {
    lines.push("");
    lines.push("■ 执行限制");
    for (const item of report.executionLimits) lines.push(`- ${item}`);
  }

  lines.push("");
  lines.push("（本报告为开发接手前的预检，根因请以开发确认为准。回复本消息可继续补充材料。）");
  lines.push(buildSessionMarker(view.sessionCode));
  return lines.join("\n");
}
