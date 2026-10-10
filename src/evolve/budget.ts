// 自改进方案交付 B：预算账本（§8）。
//
// 诚实边界：当前诊断/审计走各引擎自己的模型客户端，没有统一可拒绝的 transport，
// 因此**无法做到请求前硬拦截**。本账本默认 `monitor`（事后累计，不冒充硬限额）；
// `enforce` 也只能在 **trial 之间**停止，不是每次模型请求的硬限。
// 需要真正的请求前拦截时，应先接统一可拒绝的模型 gateway（见方案 §8）。

export interface UsageRecord {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  usd?: number | null;
}

export interface BudgetLimits {
  maxTokens?: number;
  maxUsd?: number;
  maxWallMs?: number;
  maxTrials?: number;
}

export type BudgetMode = "monitor" | "enforce";

export interface BudgetSnapshot {
  mode: BudgetMode;
  enforcedAt: "between-trials" | "none";
  limits: BudgetLimits;
  tokens: number;
  usd: number | null;
  trials: number;
  wallMs: number;
  exhausted: boolean;
  reason?: string;
}

export class BudgetLedger {
  private tokens = 0;
  private usd: number | null = null;
  private usdUnknown = false;
  private trials = 0;
  private startedAt: number;
  private stopped: string | undefined;
  private readonly limits: BudgetLimits;
  private readonly mode: BudgetMode;
  private readonly now: () => number;

  constructor(limits: BudgetLimits = {}, mode: BudgetMode = "monitor", now: () => number = () => Date.now()) {
    this.limits = limits;
    this.mode = mode;
    this.now = now;
    this.startedAt = now();
  }

  /** 记录一个 trial 的用量；缺失字段不猜测（totalTokens=null 计 0 但标记 usd 未知）。 */
  record(usage: UsageRecord): void {
    this.trials += 1;
    this.tokens += usage.totalTokens ?? 0;
    if (usage.usd === undefined || usage.usd === null) {
      this.usdUnknown = true;
    } else {
      this.usd = (this.usd ?? 0) + usage.usd;
    }
  }

  wallMs(): number {
    return this.now() - this.startedAt;
  }

  /** enforce 模式下：是否允许开始下一个 trial。monitor 恒 true。 */
  canStartTrial(): boolean {
    if (this.mode !== "enforce") return true;
    if (this.stopped) return false;
    const { maxTokens, maxUsd, maxWallMs, maxTrials } = this.limits;
    if (maxTrials !== undefined && this.trials >= maxTrials) this.stopped = `maxTrials=${maxTrials}`;
    else if (maxTokens !== undefined && this.tokens >= maxTokens) this.stopped = `maxTokens=${maxTokens}`;
    else if (maxWallMs !== undefined && this.wallMs() >= maxWallMs) this.stopped = `maxWallMs=${maxWallMs}`;
    else if (maxUsd !== undefined) {
      if (this.usdUnknown || this.usd === null) this.stopped = `maxUsd 需要已知美元用量（存在未知 usage）`;
      else if (this.usd >= maxUsd) this.stopped = `maxUsd=${maxUsd}`;
    }
    return this.stopped === undefined;
  }

  snapshot(): BudgetSnapshot {
    return {
      mode: this.mode,
      enforcedAt: this.mode === "enforce" ? "between-trials" : "none",
      limits: this.limits,
      tokens: this.tokens,
      usd: this.usd,
      trials: this.trials,
      wallMs: this.wallMs(),
      exhausted: this.stopped !== undefined,
      ...(this.stopped ? { reason: this.stopped } : {}),
    };
  }
}
