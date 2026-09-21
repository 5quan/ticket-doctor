// 轮次状态机：纯函数，集中定义"哪些失败可重试、重试几次、终态是什么"。
// 调度层不允许自己写 if 判断重试，必须走这里，避免规则分散。

import type { RunErrorCode, RunStatus } from "./types.ts";

const RETRYABLE: ReadonlySet<RunErrorCode> = new Set<RunErrorCode>([
  "interrupted",
  "timeout",
  "provider_unavailable",
  "rate_limited",
]);

export function isRetryable(code: RunErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed";
}

export type FailureTransition =
  | { status: "queued"; reason: "retry" }
  | { status: "failed"; reason: "not_retryable" | "attempts_exhausted" };

/**
 * 一次失败的落点：可重试且还有额度 → 回到 queued；否则 failed。
 * @param attempts 已经发生的尝试次数（含本次）
 */
export function onFailure(
  code: RunErrorCode,
  attempts: number,
  maxAttempts: number,
): FailureTransition {
  if (!isRetryable(code)) return { status: "failed", reason: "not_retryable" };
  if (attempts >= maxAttempts) return { status: "failed", reason: "attempts_exhausted" };
  return { status: "queued", reason: "retry" };
}
