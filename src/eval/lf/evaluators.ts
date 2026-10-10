// 官方 SDK evaluators（plan §7）：确定性业务检查在 SDK evaluator 里运行，分数保存与
// 展示交给 Langfuse。P0=运行完整性/引用有效性/版本与可见性；P1=预诊断质量（人工标注，
// 不在本文件）；P2=调查成本（自动记录）。首期不合成笼统总分。
// 关键语义：合理追问（outcome=clarify）不是运行失败；未复核=unscored；关键词命中只能
// 作为辅助检查，不命名"语义正确率"。
import type { Evaluation, Evaluator } from "@langfuse/client";
import type { CaseTaskOutput } from "./task.ts";

type EvalParams = { input: unknown; expectedOutput?: unknown; output: unknown; metadata?: unknown };

const bool = (v: boolean): number => (v ? 1 : 0);

function asOutput(output: unknown): CaseTaskOutput {
  return output as CaseTaskOutput;
}

/** P0 运行完整性：计划轮次齐全、每轮持久化终态 succeeded、每轮有捕获产物、报告轮有回写。 */
export function runIntegrityEvaluator(params: EvalParams): Evaluation[] {
  const out = asOutput(params.output);
  if (out.failure) {
    return [{ name: "run_integrity", value: 0, dataType: "BOOLEAN", comment: `任务失败（未丢弃）：${out.failure.slice(0, 400)}` }];
  }
  const expected = (params.expectedOutput as { rounds?: Array<{ roundId: string; allowedOutcomes?: string[] }> } | null)?.rounds ?? [];
  const expectedById = new Map(expected.map((r) => [r.roundId, r]));
  const plannedIds = expected.map((r) => r.roundId);
  const actualIds = out.rounds.map((r) => r.roundId);
  const notes: string[] = [];
  let ok = true;

  const missing = plannedIds.filter((id) => !actualIds.includes(id));
  if (missing.length > 0) {
    ok = false;
    notes.push(`缺轮：${missing.join(",")}`);
  }
  for (const r of out.rounds) {
    const expectsBlocked = (expectedById.get(r.roundId)?.allowedOutcomes ?? []).includes("blocked");
    if (r.blocked) {
      // 预期内阻断（版本/隔离 fail-closed）不是运行缺失——由 expected_blocked 专项校验；非预期阻断才算失败。
      if (!expectsBlocked) {
        ok = false;
        notes.push(`r=${r.roundId} 非预期阻断`);
      }
      continue;
    }
    if (r.status !== "succeeded") {
      ok = false;
      notes.push(`r=${r.roundId} 终态=${r.status}`);
    }
    if (r.engineCalls < 1) {
      ok = false;
      notes.push(`r=${r.roundId} 无引擎调用（捕获产物缺失）`);
    }
    // 合理追问 = outcome clarify（终态 succeeded）——不算失败，不记问题。
    if (r.outcome === "report" && r.writebackText == null) {
      ok = false;
      notes.push(`r=${r.roundId} 报告轮缺回写捕获`);
    }
  }
  return [{ name: "run_integrity", value: bool(ok), dataType: "BOOLEAN", comment: ok ? "全部轮次完整" : notes.join("; ").slice(0, 450) }];
}

/**
 * P0 预期阻断负例（plan §9）：allowedOutcomes 含 blocked 的轮次必须真的取证前阻断，
 * 且**未调用模型、未继续取证**；判定基于**结构化 SHA mismatch**（scopeChecks 的
 * check=expected vs resolvedSha，并与 dataset metadata.materials 的 expectedSha 对齐），
 * 不依赖错误文本关键词。仅该负例携带信号。
 */
export function expectedBlockedEvaluator(params: EvalParams): Evaluation[] {
  const out = asOutput(params.output);
  const expected = (params.expectedOutput as { rounds?: Array<{ roundId: string; allowedOutcomes?: string[] }> } | null)?.rounds ?? [];
  const materials = (params.metadata as { materials?: Array<{ repoId: string; expectedSha: string | null }> } | null)?.materials ?? [];
  const blockedRounds = expected.filter((r) => (r.allowedOutcomes ?? []).includes("blocked"));
  if (blockedRounds.length === 0) {
    return [{ name: "expected_blocked", value: 1, dataType: "BOOLEAN", comment: "本案例无预期阻断轮（该指标对本案例无信号）" }];
  }
  const notes: string[] = [];
  let ok = true;
  for (const er of blockedRounds) {
    const actual = out.rounds.find((r) => r.roundId === er.roundId);
    if (!actual) {
      ok = false;
      notes.push(`${er.roundId} 缺轮`);
      continue;
    }
    if (!actual.blocked) {
      ok = false;
      notes.push(`${er.roundId} 未阻断（outcome=${actual.outcome}）`);
      continue;
    }
    if (actual.engineCalls !== 0) {
      ok = false;
      notes.push(`${er.roundId} 阻断前调用模型 ${actual.engineCalls} 次`);
    }
    if (actual.toolCalls !== 0) {
      ok = false;
      notes.push(`${er.roundId} 阻断前调用工具 ${actual.toolCalls} 次`);
    }
    const checks = actual.scopeChecks ?? [];
    const mismatches = checks.filter((c) => c.check === "mismatch");
    if (mismatches.length === 0) {
      ok = false;
      notes.push(`${er.roundId} 无结构化 SHA mismatch（实际：${checks.map((c) => `${c.repoId}:${c.check}`).join(",") || "无 scope 核对"}）`);
    }
    for (const m of mismatches) {
      if (m.resolvedScanOk === false) {
        ok = false;
        notes.push(`${er.roundId}/${m.repoId} 解析树隔离扫描失败`);
      }
      const declared = materials.find((x) => x.repoId === m.repoId);
      if (!declared) {
        ok = false;
        notes.push(`${er.roundId} mismatch 仓库 ${m.repoId} 不在 dataset 材料清单`);
        continue;
      }
      if (!declared.expectedSha) {
        ok = false;
        notes.push(`${er.roundId}/${m.repoId} 材料未声明 expectedSha`);
        continue;
      }
      if (m.expected !== declared.expectedSha) {
        ok = false;
        notes.push(`${er.roundId}/${m.repoId} 期望 SHA 不一致：scopeCheck=${m.expected ?? "null"} dataset=${declared.expectedSha}`);
      }
      if (!m.resolvedSha) {
        ok = false;
        notes.push(`${er.roundId}/${m.repoId} mismatch 缺 resolvedSha`);
      } else if (m.resolvedSha === declared.expectedSha) {
        ok = false;
        notes.push(`${er.roundId}/${m.repoId} resolvedSha 等于 expected，不应判 mismatch`);
      }
    }
  }
  return [
    {
      name: "expected_blocked",
      value: bool(ok),
      dataType: "BOOLEAN",
      comment: ok
        ? `预期阻断 ${blockedRounds.map((r) => r.roundId).join(",")} 结构化 SHA mismatch 正确，未调用模型/工具`
        : notes.join("; ").slice(0, 450),
    },
  ];
}

/** P0 引用有效性：validated 终稿引用全部可解析且无 wrongSha（raw 阶段单列，供对照）。 */
export function citationValidityEvaluator(params: EvalParams): Evaluation[] {
  const out = asOutput(params.output);
  if (out.failure) {
    return [{ name: "citation_validity", value: 0, dataType: "NUMERIC", comment: `案例失败，无引用可评：${out.failure.slice(0, 300)}` }];
  }
  const validated = out.rounds.flatMap((r) => r.citations.filter((c) => c.stage === "validated"));
  if (validated.length === 0) {
    // 无引用 ≠ 通过：报告轮必须带证据引用；追问轮允许为空。
    const reportRounds = out.rounds.filter((r) => r.outcome === "report").length;
    return [
      { name: "citation_validity", value: reportRounds > 0 ? 0 : 1, dataType: "NUMERIC", comment: reportRounds > 0 ? `${reportRounds} 个报告轮无任何引用` : "本轮均为追问/回复，无报告引用" },
    ];
  }
  const unresolved = validated.filter((c) => !c.resolved);
  const wrongSha = validated.filter((c) => c.wrongSha);
  const rawStage = out.rounds.flatMap((r) => r.citations.filter((c) => c.stage === "raw"));
  const rawUnresolved = rawStage.filter((c) => !c.resolved).length;
  const value = (validated.length - unresolved.length - wrongSha.length) / validated.length;
  return [
    {
      name: "citation_validity",
      value,
      dataType: "NUMERIC",
      comment: `${validated.length - unresolved.length - wrongSha.length}/${validated.length}（unresolved=${unresolved.length}, wrongSha=${wrongSha.length}；raw 初稿未解析=${rawUnresolved}）`,
    },
  ];
}

/** P0 版本与可见性：取证前 SHA 核对全通过 + 解析树隔离扫描无违例；可见性单列辅助分。 */
export function versionVisibilityEvaluator(params: EvalParams): Evaluation[] {
  const out = asOutput(params.output);
  const checks = out.rounds.flatMap((r) => r.scopeChecks);
  const notes: string[] = [];
  let ok = true;
  if (checks.length === 0) {
    ok = false;
    notes.push("无 scope 核对记录（onPrepared 未触发？）");
  }
  for (const c of checks) {
    if (c.check !== "ok" && c.check !== "no-expected") {
      ok = false;
      notes.push(`${c.roundId}/${c.repoId}=${c.check}`);
    }
    if (c.resolvedScanOk === false) {
      ok = false;
      notes.push(`${c.roundId}/${c.repoId} 隔离扫描失败`);
    }
  }
  const evaluated = checks.filter((c) => c.check === "ok").length;
  const visRounds = out.rounds.map((r) => r.visibility);
  const applicable = visRounds.reduce((a, v) => a + v.applicable, 0);
  const satisfied = visRounds.reduce((a, v) => a + v.fullySatisfiedBc1d, 0);
  const scores: Evaluation[] = [
    { name: "version_visibility", value: bool(ok), dataType: "BOOLEAN", comment: ok ? `scope 核对 ${evaluated}/${checks.length} 全通过` : notes.join("; ").slice(0, 450) },
  ];
  // 辅助分（B∧C1∧D 组合满足率；不是语义正确率，关键词命中只能辅助）。
  if (applicable > 0) {
    scores.push({ name: "visibility_bc1d", value: satisfied / applicable, dataType: "NUMERIC", comment: `${satisfied}/${applicable}（四层可见性 B∧C1∧D 辅助指标）` });
  }
  return scores;
}

/** P2 调查成本（自动记录）：工具调用数、耗时、token 用量（缺失记 -1，不冒充 0）。 */
export function costEvaluator(params: EvalParams): Evaluation[] {
  const out = asOutput(params.output);
  const toolCalls = out.rounds.reduce((a, r) => a + r.toolCalls, 0);
  const tokens = out.rounds.reduce((a, r) => a + (r.usage?.totalTokens ?? 0), 0);
  const missingUsage = out.rounds.filter((r) => r.usage?.totalTokens == null).length;
  return [
    { name: "tool_calls", value: toolCalls, dataType: "NUMERIC", comment: `全 ${out.rounds.length} 轮合计` },
    { name: "wall_ms", value: out.wallMs, dataType: "NUMERIC", comment: "整案例耗时" },
    {
      name: "total_tokens",
      value: tokens,
      dataType: "NUMERIC",
      comment: missingUsage > 0 ? `${out.rounds.length - missingUsage}/${out.rounds.length} 轮有 usage 记录；缺失轮不计入` : "全部轮次有 usage",
    },
  ];
}

export const smokeEvaluators: Evaluator[] = [
  async (params) => runIntegrityEvaluator(params),
  async (params) => citationValidityEvaluator(params),
  async (params) => versionVisibilityEvaluator(params),
  async (params) => expectedBlockedEvaluator(params),
  async (params) => promptInjectionEvaluator(params),
  async (params) => costEvaluator(params),
];

/**
 * plan §5：验证目标提示词版本确实进入模型请求。
 * 输出 **CATEGORICAL** 状态，明确区分：
 *   - actual_request_verified：从实际模型请求的 effective context 捕获并匹配目标
 *   - config_only：未捕获实际请求，仅引擎自报配置一致（不视为通过）
 *   - not_called：该案例预期阻断/未调用模型（无请求可验）
 *   - mismatch：捕获到实际请求但与目标不符，或未验证
 */
export type PromptInjectionState = "actual_request_verified" | "config_only" | "not_called" | "mismatch";

export function promptInjectionEvaluator(params: EvalParams): Evaluation[] {
  const out = asOutput(params.output);
  const p = out.prompt;
  const expected = (params.expectedOutput as { rounds?: Array<{ allowedOutcomes?: string[] }> } | null)?.rounds ?? [];
  const blockedExpected = expected.some((r) => (r.allowedOutcomes ?? []).includes("blocked"));
  const modelCalled = out.rounds.some((r) => r.engineCalls > 0);

  let state: PromptInjectionState;
  let detail: string;
  if (p.effectiveVerified) {
    const truncatedNote = p.effectiveTruncated ? "（请求上下文被截断，按包含比对）" : "";
    state = p.effectiveMatches === true ? "actual_request_verified" : "mismatch";
    detail =
      state === "actual_request_verified"
        ? `实际模型请求已包含目标提示词：${p.name}@v${p.version} hash=${p.hash.slice(0, 12)}${truncatedNote}`
        : `实际模型请求的系统提示词与目标不一致：${p.name}@v${p.version} hash=${p.hash.slice(0, 12)}${truncatedNote}`;
  } else if (!modelCalled && blockedExpected) {
    state = "not_called";
    detail = "预期阻断/未调用模型：无请求可验证（非回退通过）";
  } else if (p.injectedVerified && p.injectedMatches === true) {
    state = "config_only";
    detail = `仅配置一致（未捕获实际请求）：${p.name}@v${p.version} hash=${p.hash.slice(0, 12)}`;
  } else {
    state = "mismatch";
    detail = p.injectedVerified
      ? `引擎实际系统提示词与目标不一致：${p.name}@v${p.version} hash=${p.hash.slice(0, 12)}`
      : "未验证注入（scripted/fake 引擎不暴露系统提示词）";
  }
  return [{ name: "prompt_injection", value: state, dataType: "CATEGORICAL", comment: detail }];
}
