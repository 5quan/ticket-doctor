// v2 比较（交付三 C2）：可比性先行——案例集/材料/口径不同就不允许报"质量涨跌"。
//
// 规则：
//   * 兼容性前置：scorerVersion、engine、audit.enabled、repeat、计划 case 集合（caseId +
//     caseHash/truthHash 材料指纹）完全一致才比较；否则拒绝并给出原因。
//   * 成对比较：同 caseId+trialId 配对；列出新增硬失败 / 修复的硬失败 / 关键指标差值 / 成本差。
//   * 只对 deterministic 指标做差；语义指标（claimSupport）为 null 时不报差值（缺测不参与）。
import type { CaseScoreV2, SuiteSummaryV2 } from "./types.ts";
import type { SuiteManifestV2 } from "./manifest.ts";

export interface CompatibilityIssue {
  reason: string;
}

export function checkCompatibility(base: { summary: SuiteSummaryV2; manifest: SuiteManifestV2 | null }, cand: { summary: SuiteSummaryV2; manifest: SuiteManifestV2 | null }): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (!base.manifest || !cand.manifest) {
    issues.push({ reason: "缺少 manifest（无法核对材料/口径指纹）" });
    return issues;
  }
  if (base.summary.schemaVersion !== cand.summary.schemaVersion) {
    issues.push({ reason: `schemaVersion 不一致：${base.summary.schemaVersion} vs ${cand.summary.schemaVersion}` });
  }
  if (base.manifest.scorerVersion !== cand.manifest.scorerVersion) {
    issues.push({ reason: `评分口径不一致：${base.manifest.scorerVersion} vs ${cand.manifest.scorerVersion}（改口径须另建结果目录，禁止跨版本比较）` });
  }
  if (base.summary.engine !== cand.summary.engine) {
    issues.push({ reason: `引擎不一致：${base.summary.engine} vs ${cand.summary.engine}` });
  }
  if (base.summary.repeat !== cand.summary.repeat) {
    issues.push({ reason: `repeat 不一致：${base.summary.repeat} vs ${cand.summary.repeat}` });
  }
  const a = base.manifest.diagnosis.audit;
  const b = cand.manifest.diagnosis.audit;
  if (a.enabled !== b.enabled || a.maxRounds !== b.maxRounds) {
    issues.push({ reason: `审计口径不一致：${a.enabled}/maxRounds=${a.maxRounds} vs ${b.enabled}/maxRounds=${b.maxRounds}` });
  }
  // 计划案例集合与材料指纹必须一致（固定基线不得静默缩放）。
  const baseCases = new Map(base.manifest.cases.map((c) => [c.caseId, c]));
  const candCases = new Map(cand.manifest.cases.map((c) => [c.caseId, c]));
  for (const [caseId, bc] of baseCases) {
    const cc = candCases.get(caseId);
    if (!cc) {
      issues.push({ reason: `候选实验缺少基线案例：${caseId}（分母不得静默缩小）` });
      continue;
    }
    if (bc.caseHash !== cc.caseHash) issues.push({ reason: `案例 ${caseId} 题面/描述已变更（caseHash 不一致）` });
    if (bc.truthHash !== cc.truthHash) issues.push({ reason: `案例 ${caseId} 私有标准已变更（truthHash 不一致）` });
  }
  for (const caseId of candCases.keys()) {
    if (!baseCases.has(caseId)) issues.push({ reason: `候选实验新增了基线没有的案例：${caseId}` });
  }
  return issues;
}

export interface PairedTrial {
  caseId: string;
  trialId: string;
  /** 硬失败差：+ 新增 / - 修复（按 code+roundId 对账）。 */
  newFailures: Array<{ code: string; roundId?: string }>;
  fixedFailures: Array<{ code: string; roundId?: string }>;
  /** 关键确定性指标差（cand − base）；null = 任一侧缺测，不报差值。 */
  metricDelta: Record<string, number | null>;
  /** 成本差（tokens）。 */
  tokenDelta: number | null;
}

export interface CompareResult {
  compatible: boolean;
  issues: CompatibilityIssue[];
  pairs: PairedTrial[];
  summary: {
    baseSuiteRunId: string;
    candidateSuiteRunId: string;
    scorerVersion: string;
    newFailuresTotal: number;
    fixedFailuresTotal: number;
  };
}

const DELTA_METRICS = ["citationValidity", "requiredFactCoverage", "clarificationSuccess", "contradictionUpdateSuccess", "writebackSuccess"] as const;

function failKey(f: { code: string; roundId?: string }): string {
  return `${f.code}@${f.roundId ?? "-"}`;
}

function deltaOf(base: CaseScoreV2, cand: CaseScoreV2, key: "recall.C1" | "recall.D" | (typeof DELTA_METRICS)[number]): number | null {
  const pick = (t: CaseScoreV2): number | null => {
    if (key.startsWith("recall.")) {
      const layer = key.split(".")[1] as "A" | "B" | "C1" | "C2" | "D";
      const m = t.recall[layer];
      return m && m.value !== null ? m.value : null;
    }
    const m = (t as unknown as Record<string, { value: number | null }>)[key];
    return m && m.value !== null ? m.value : null;
  };
  const b = pick(base);
  const c = pick(cand);
  return b === null || c === null ? null : c - b;
}

export function compareSuites(
  base: { summary: SuiteSummaryV2; manifest: SuiteManifestV2 | null },
  cand: { summary: SuiteSummaryV2; manifest: SuiteManifestV2 | null },
): CompareResult {
  const issues = checkCompatibility(base, cand);
  const pairs: PairedTrial[] = [];
  if (issues.length === 0) {
    const baseTrials = new Map<string, CaseScoreV2>();
    for (const c of base.summary.cases) for (const t of c.trials) baseTrials.set(`${c.caseId}/${t.trialId}`, t);
    for (const c of cand.summary.cases) {
      for (const t of c.trials) {
        const key = `${c.caseId}/${t.trialId}`;
        const b = baseTrials.get(key);
        if (!b) continue;
        const bKeys = new Set(b.hardFailures.map(failKey));
        const cKeys = new Set(t.hardFailures.map(failKey));
        const metricDelta: Record<string, number | null> = {
          "recall.C1": deltaOf(b, t, "recall.C1"),
          "recall.D": deltaOf(b, t, "recall.D"),
        };
        for (const m of DELTA_METRICS) metricDelta[m] = deltaOf(b, t, m);
        pairs.push({
          caseId: c.caseId,
          trialId: t.trialId,
          newFailures: t.hardFailures.filter((f) => !bKeys.has(failKey(f))).map((f) => ({ code: f.code, roundId: f.roundId })),
          fixedFailures: b.hardFailures.filter((f) => !cKeys.has(failKey(f))).map((f) => ({ code: f.code, roundId: f.roundId })),
          metricDelta,
          tokenDelta: null,
        });
      }
    }
  }
  return {
    compatible: issues.length === 0,
    issues,
    pairs,
    summary: {
      baseSuiteRunId: base.summary.suiteRunId,
      candidateSuiteRunId: cand.summary.suiteRunId,
      scorerVersion: cand.manifest?.scorerVersion ?? "unknown",
      newFailuresTotal: pairs.reduce((n, p) => n + p.newFailures.length, 0),
      fixedFailuresTotal: pairs.reduce((n, p) => n + p.fixedFailures.length, 0),
    },
  };
}
