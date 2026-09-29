// Runner 路径的证据 Sink：evidence_commit 写 stdout，等待 Host 的 ack/reject（§5.1/§5.4）。
//
// 重试策略（D9）：每次 commit 最多 EVIDENCE_COMMIT_MAX_ATTEMPTS 次，指数退避 200ms 起；
// 重发必须同 batchId + 同 payload（Host 幂等返回原映射）。lease_lost/conflict/content_conflict
// 不可重试（重试结果确定）；ack 超时与 internal（Host DB 故障）可重试。超限抛 EvidenceCommitError
// → 工具失败 → 本轮失败。绝不把未确认材料交给模型。
import type { RunnerControl } from "../runner/protocol.ts";
import { EvidenceCommitError } from "./errors.ts";
import type { EvidenceCommitRequest, EvidenceCommitResult, EvidenceRef, EvidenceSink } from "./types.ts";

export const EVIDENCE_COMMIT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 200;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;

interface Pending {
  resolve: (refs: EvidenceRef[]) => void;
  reject: (err: EvidenceCommitError) => void;
  timer: NodeJS.Timeout;
}

export interface IpcEvidenceSinkOptions {
  /** 把 evidence_commit 写到 stdout（runner.ts 注入 encodeMessage+process.stdout.write）。 */
  emit: (message: { type: "evidence_commit" } & EvidenceCommitRequest) => void;
  /** 本轮取消信号：取消时立即失败，不再等待/重试。 */
  signal: AbortSignal;
  maxAttempts?: number;
  ackTimeoutMs?: number;
  backoffMs?: number;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new EvidenceCommitError("cancelled", "运行已取消，证据提交中止"));
      },
      { once: true },
    );
  });
}

export class IpcEvidenceSink implements EvidenceSink {
  private readonly pending = new Map<string, Pending>();
  private readonly emit: IpcEvidenceSinkOptions["emit"];
  private readonly signal: AbortSignal;
  private readonly maxAttempts: number;
  private readonly ackTimeoutMs: number;
  private readonly backoffMs: number;

  constructor(opts: IpcEvidenceSinkOptions) {
    this.emit = opts.emit;
    this.signal = opts.signal;
    this.maxAttempts = opts.maxAttempts ?? EVIDENCE_COMMIT_MAX_ATTEMPTS;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  /** stdin 控制消息分发入口（runner.ts 主循环调用）；返回是否为证据回执。 */
  handleControl(control: RunnerControl): boolean {
    if (control.type === "evidence_ack") {
      const pending = this.pending.get(control.batchId);
      if (pending) {
        this.pending.delete(control.batchId);
        clearTimeout(pending.timer);
        pending.resolve(control.refs);
      }
      return true;
    }
    if (control.type === "evidence_reject") {
      const pending = this.pending.get(control.batchId);
      if (pending) {
        this.pending.delete(control.batchId);
        clearTimeout(pending.timer);
        pending.reject(new EvidenceCommitError(control.code, control.message));
      }
      return true;
    }
    return false;
  }

  async commit(req: EvidenceCommitRequest): Promise<EvidenceCommitResult> {
    const message = { type: "evidence_commit" as const, ...req };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (this.signal.aborted) throw new EvidenceCommitError("cancelled", "运行已取消，证据提交中止");
      try {
        const refs = await new Promise<EvidenceRef[]>((resolve, reject) => {
          const pending: Pending = {
            resolve,
            reject,
            timer: setTimeout(() => {
              this.pending.delete(req.batchId);
              reject(new EvidenceCommitError("ack_timeout", "等待 evidence_ack 超时"));
            }, this.ackTimeoutMs),
          };
          // 覆盖同名 pending（前次超时后迟到的 ack 会 resolve 本次等待，等价且无害：同批次同映射）
          this.pending.set(req.batchId, pending);
          this.emit(message);
        });
        return { refs };
      } catch (err) {
        const e =
          err instanceof EvidenceCommitError ? err : new EvidenceCommitError("internal", String(err));
        const retryable = e.code === "ack_timeout" || e.code === "internal";
        if (!retryable || attempt >= this.maxAttempts || this.signal.aborted) throw e;
        await delay(this.backoffMs * 2 ** (attempt - 1), this.signal);
      }
    }
    throw new EvidenceCommitError("internal", "证据提交重试耗尽");
  }
}
