// 评测对比：把同一场景的多次运行按「可比变量」分组，输出差异。
//
// 可比条件 = engine / model / rulesHash / scorerVersion / auditEnabled（同一批 case + 材料指纹）。
// 用途：审计关/开、rules 版本前后、提示词版本的收益/成本/退化比较。
import type { EvalRecord } from "./report.ts";
import { summarize, type EvalSummary } from "./report.ts";

export interface VariantGroup {
  key: string;
  summary: EvalSummary;
}

/** 可变条件；材料/场景不一致时不应放在一起比。 */
export function variantKey(r: EvalRecord): string {
  const f = r.fingerprint;
  return [
    `scenario=${f.scenario}`,
    `engine=${f.engine}`,
    `model=${f.model ?? "-"}`,
    `rules=${f.rulesHash ?? "-"}`,
    `scorer=${f.scorerVersion}`,
    `audit=${f.auditEnabled ? "on" : "off"}`,
  ].join("|");
}

/** 按变量分组汇总；返回按 key 排序的结果。 */
export function groupVariants(records: EvalRecord[]): VariantGroup[] {
  const groups = new Map<string, EvalRecord[]>();
  for (const r of records) {
    const key = variantKey(r);
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.entries()]
    .map(([key, rs]) => ({ key, summary: summarize(rs) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function pct(v: number | null): string {
  return v === null ? "unscored" : `${(v * 100).toFixed(0)}%`;
}

export function formatComparison(groups: VariantGroup[]): string {
  const lines: string[] = [
    "variant                                                    | runs ok fail | recall  precision | tools turns | tokens | ms",
    "-----------------------------------------------------------+--------------+-------------------+-------------+--------+-----",
  ];
  for (const g of groups) {
    const s = g.summary;
    lines.push(
      `${g.key.padEnd(58)} | ${String(s.runs).padStart(4)} ${String(s.ok).padStart(2)} ${String(s.failed).padStart(4)} | ` +
        `${pct(s.meanRecall).padStart(6)} ${pct(s.meanPrecision).padStart(9)} | ` +
        `${s.meanToolCalls.toFixed(1).padStart(5)} ${s.meanModelTurns.toFixed(1).padStart(5)} | ` +
        `${s.meanTotalTokens.toFixed(0).padStart(6)} | ${s.meanDurationMs.toFixed(0)}`,
    );
  }
  return lines.join("\n");
}
