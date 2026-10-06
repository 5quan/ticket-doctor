// 门禁判定（M10 / A3 / 交付 1.1）：纯函数，便于确定性反例测试。
//
// 判定顺序（全部失败原因都要能单独指认）：
//   1. manifest 缺失 → 无法核对冻结口径；
//   2. freezeCheck=false（材料/项目身份运行中漂移）；
//   3. project.gitState=unknown（git 状态不可读，身份指纹不完整）；
//   4. 遗漏（非 scored 且非准入拒绝的 case，或 trial 缺额）；
//   5. 硬失败超上限。
import type { SuiteSummaryV2 } from "./types.ts";
import type { SuiteManifestV2 } from "./manifest.ts";

export interface GateInput {
  summary: SuiteSummaryV2;
  manifest: SuiteManifestV2 | null;
  /** 已校验的硬失败上限（调用方保证 ≥0 整数）。 */
  maxHard: number;
}

export interface GateVerdict {
  ok: boolean;
  error?: string;
  /** 供日志的门禁概览行。 */
  line: string;
}

export function evaluateGate(input: GateInput): GateVerdict {
  const { summary, manifest, maxHard } = input;
  const trials = summary.cases.flatMap((c) => c.trials);
  const hard = trials.reduce((n, t) => n + t.hardFailures.length, 0);
  const omissions = summary.caseStatuses.filter((s) => s.phase !== "scored" && s.phase !== "admission_rejected");
  const accountedTrials = summary.caseStatuses
    .filter((s) => s.phase === "scored" || s.phase === "run_error")
    .reduce((n, s) => n + s.trials, 0);
  const line =
    `[eval:v2][gate] planned=${summary.planned.trials} trials=${accountedTrials}/${summary.planned.cases} case ` +
    `hardFailures=${hard}（上限 ${maxHard}）blockedExpected=${summary.counts.blockedExpectedTrials} ` +
    `admissionRejected=${summary.counts.admissionRejected} omissions=${omissions.length} ` +
    `freeze=${manifest ? (manifest.freezeCheck.ok ? "ok" : "drift") : "missing"} git=${manifest?.project.gitState ?? "?"}`;

  if (!manifest) return { ok: false, error: "缺少 manifest.json（无法核对冻结口径）", line };
  if (!manifest.freezeCheck.ok) {
    return { ok: false, error: `冻结复核失败（材料/项目身份在运行中漂移）：${JSON.stringify(manifest.freezeCheck.drifts)}`, line };
  }
  if (manifest.project.gitState === "unknown") {
    return { ok: false, error: "项目 git 状态不可读（unknown）：身份指纹不完整，不得作为正式门禁", line };
  }
  if (omissions.length > 0 || accountedTrials !== summary.planned.trials) {
    return {
      ok: false,
      error: `存在遗漏：${omissions.map((s) => `${s.caseId}(${s.phase})`).join(", ") || "trial 数不足"}——全部可评案例必须出分或显式预期阻断`,
      line,
    };
  }
  if (hard > maxHard) return { ok: false, error: `硬失败 ${hard} > 上限 ${maxHard}`, line };
  return { ok: true, line };
}
