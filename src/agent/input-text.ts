// 组装本轮发给模型的用户文本（材料范围事实 + 问题）。
//
// 会话持久化后，跨轮上下文由历史条目承载，不再拼 `contextSummary`，避免与历史重复。
import type { DiagnosisInput } from "../domain/types.ts";

export function renderDiagnosisInput(input: DiagnosisInput): string {
  const lines = [`用户消息：${input.question}`];
  if (input.service) lines.push(`服务：${input.service}`);
  lines.push(`上报时间：${new Date(input.receivedAt).toISOString()}`);
  lines.push(
    input.occurredAt !== undefined
      ? `故障发生时间：${new Date(input.occurredAt).toISOString()}（来源：${input.occurredSource ?? "输入"}）`
      : "故障发生时间：未从输入获取（时间窗按上报时间回溯，可能遗漏）",
  );
  if (input.repositories?.length) {
    lines.push(`代码仓库：${input.repositories.map((r) => `${r.repoId}@${r.rev ?? "HEAD"}`).join("、")}`);
  }
  lines.push("请遵循系统提示：闲聊直接回复；有排查需求先取证，完成时用 submit_report 提交报告。");
  return lines.join("\n");
}
