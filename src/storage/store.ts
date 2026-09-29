// Store：所有 SQLite 读写的唯一入口。
//
// 不做"每张表一个仓库类"的机械抽象；按聚合把方法集中在这里，调用方拿到的是领域对象。
// 所有涉及代次（generation）的写操作都必须带 generation 守卫，过期执行者的提交会被拒绝。
import { randomUUID } from "node:crypto";
import type { InboundMessage, InvestigationStatus, ReportCompleteness, RunErrorCode, RunStatus } from "../domain/types.ts";
import type { EvidenceItem, EvidenceRef } from "../evidence/types.ts";
import { evidencePayloadHash, evidenceSourceOf } from "../evidence/util.ts";
import { asNumber, transaction, type Db } from "./db.ts";

export interface InvestigationRow {
  id: string;
  session_code: string;
  provider: string;
  account_id: string;
  chat_id: string;
  root_message_id: string | null;
  thread_id: string | null;
  status: InvestigationStatus;
  title: string | null;
  service: string | null;
  environment: string | null;
  created_by: string | null;
  context_summary: string | null;
  total_rounds: number;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  investigation_id: string;
  /** 本轮来源入口：feishu | web | …（决定回复是否回 IM）。 */
  provider: string;
  account_id: string;
  external_message_id: string;
  root_id: string | null;
  thread_id: string | null;
  sender_id: string | null;
  sender_name: string | null;
  text: string;
  received_at: number;
}

export interface RunRow {
  id: string;
  investigation_id: string;
  message_id: string;
  /** 调查内单调轮次号（Host 分配，调度只认它）。 */
  round: number;
  /** 本轮来源入口：feishu | web | …（决定回复是否回 IM）。 */
  source: string;
  status: RunStatus;
  generation: number;
  attempt_count: number;
  max_attempts: number;
  available_at: number;
  lease_expires_at: number | null;
  cancel_requested: number;
  error_code: string | null;
  error_message: string | null;
  report_id: string | null;
  session_file: string | null;
  session_seq: number;
  usage_input_tokens: number;
  usage_output_tokens: number;
  usage_cache_tokens: number;
  usage_total_tokens: number;
  created_at: number;
}

export interface AttemptRow {
  id: string;
  run_id: string;
  generation: number;
  worker_id: string;
  status: string;
  lease_expires_at: number;
  heartbeat_at: number;
  error_code: string | null;
  error_message: string | null;
  started_at: number;
  finished_at: number | null;
  session_file: string | null;
  session_seq: number;
  usage_input_tokens: number;
  usage_output_tokens: number;
  usage_cache_tokens: number;
  usage_total_tokens: number;
}

export interface ClaimedRun {
  run: RunRow;
  attemptId: string;
  generation: number;
}

/** 入站消息的处理计划：由 intake 层算出，由 acceptInbound 在同一事务里落库。 */
export type InboundPlan =
  | {
      decision: "new_investigation";
      newInvestigation: {
        sessionCode: string;
        provider: string;
        accountId: string;
        chatId: string;
        rootMessageId?: string;
        threadId?: string;
        title?: string;
        service?: string;
        createdBy?: string;
      };
    }
  | { decision: "continue_investigation"; investigationId: string; servicePatch?: string }
  /** 机械回复（-help）：不建消息、不建轮次、不进投递表；Host 出文案，适配器发送。 */
  | { decision: "mechanical"; text: string };

/** 拒绝落库：unroutable 会提示用户，ignored 静默丢弃。 */
export interface InboundRejection {
  reject: "unroutable" | "ignored";
  reason: string;
}

export interface AcceptInboundResult {
  accepted: boolean;
  decision:
    | { kind: "new_investigation"; sessionCode: string }
    | { kind: "continue_investigation"; investigationId: string }
    | { kind: "mechanical"; text: string }
    | { kind: "duplicate" }
    | { kind: "unroutable"; reason: string }
    | { kind: "ignored"; reason: string };
  investigationId?: string;
  messageId?: string;
  runId?: string;
  round?: number;
  sessionCode?: string;
  /** decision 为 mechanical 时的固定文案。 */
  mechanicalText?: string;
}

export interface EventRow {
  id: number;
  stream: string;
  type: string;
  payload: string | null;
  created_at: number;
}

export interface DeliveryRow {
  id: string;
  investigation_id: string;
  run_id: string;
  report_id: string | null;
  kind: string;
  target_message_id: string | null;
  content: string;
  idempotency_key: string;
  status: string;
  provider_message_id: string | null;
  attempt: number;
  available_at: number;
}

/** evidence 表行（含 006 迁移新增的 UID/批次列；历史行这三列可为 null）。 */
export interface EvidenceRow {
  run_id: string;
  evidence_id: string;
  investigation_id: string;
  kind: string;
  source: string;
  excerpt: string;
  truncated: number;
  time_ms: number | null;
  level: string | null;
  repo_id: string | null;
  sha: string | null;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  created_at: number;
  evidence_uid: string | null;
  batch_id: string | null;
  item_index: number | null;
}

/** evidence_batches 表行：一次工具调用的证据批次（恢复与幂等的查找键）。 */
export interface EvidenceBatchRow {
  batch_id: string;
  investigation_id: string;
  run_id: string;
  attempt_id: string;
  generation: number;
  tool: string;
  tool_call_id: string;
  payload_hash: string;
  result_json: string;
  created_at: number;
}

/** evidence 表行 → 证据 ref（校验解析、恢复重建、幂等返回共用）。 */
export function evidenceRowToRef(row: EvidenceRow): EvidenceRef {
  return {
    kind: row.kind as EvidenceItem["kind"],
    source: row.source,
    excerpt: row.excerpt,
    ...(row.time_ms !== null ? { time: row.time_ms } : {}),
    ...(row.level !== null ? { level: row.level } : {}),
    ...(row.repo_id && row.sha && row.path
      ? {
          codeRef: {
            repoId: row.repo_id,
            sha: row.sha,
            path: row.path,
            startLine: asNumber(row.start_line ?? 0),
            endLine: asNumber(row.end_line ?? 0),
          },
        }
      : {}),
    evidenceUid: row.evidence_uid ?? "",
    evidenceId: row.evidence_id,
    truncated: asNumber(row.truncated) === 1,
  };
}

export class Store {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  // ---------- inbound 去重 ----------

  recordInbound(msg: InboundMessage): { created: boolean; id: string } {
    const id = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbound_events
           (id, provider, account_id, external_message_id, chat_id, status, payload, received_at)
         VALUES (?, ?, ?, ?, ?, 'received', ?, ?)`,
      )
      .run(
        id,
        msg.provider,
        msg.accountId,
        msg.externalMessageId,
        msg.chatId,
        JSON.stringify(msg),
        msg.receivedAt,
      );
    return { created: asNumber(result.changes) === 1, id };
  }

  finishInbound(id: string, status: "processed" | "ignored" | "failed", error?: string): void {
    this.db
      .prepare("UPDATE inbound_events SET status = ?, error = ?, processed_at = ? WHERE id = ?")
      .run(status, error ?? null, Date.now(), id);
  }

  /**
   * 原子接收：去重 + 计划 + 关联/新建调查 + 存消息 + 建轮次 + 入站状态，全部在一个事务里。
   * 计划由 intake 层算出（纯路由规则），这里只负责按计划落库，避免"去重与建轮次"分事务。
   */
  acceptInbound(
    msg: InboundMessage,
    opts: { maxAttempts: number; plan: (msg: InboundMessage) => InboundPlan | InboundRejection },
  ): AcceptInboundResult {
    return transaction(this.db, () => {
      const inboundId = randomUUID();
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO inbound_events
             (id, provider, account_id, external_message_id, chat_id, status, payload, received_at)
           VALUES (?, ?, ?, ?, ?, 'received', ?, ?)`,
        )
        .run(
          inboundId,
          msg.provider,
          msg.accountId,
          msg.externalMessageId,
          msg.chatId,
          JSON.stringify(msg),
          msg.receivedAt,
        );
      if (asNumber(inserted.changes) !== 1) {
        return { accepted: false, decision: { kind: "duplicate" } };
      }

      const planned = opts.plan(msg);
      if ("reject" in planned) {
        this.finishInbound(inboundId, "ignored", planned.reason);
        return {
          accepted: false,
          decision:
            planned.reject === "unroutable"
              ? { kind: "unroutable", reason: planned.reason }
              : { kind: "ignored", reason: planned.reason },
        };
      }

      // 机械回复（-help）：去重照旧，不建消息、不建轮次、不进投递表
      if (planned.decision === "mechanical") {
        this.finishInbound(inboundId, "processed");
        return {
          accepted: false,
          decision: { kind: "mechanical", text: planned.text },
          mechanicalText: planned.text,
        };
      }

      let investigationId: string;
      let sessionCode: string;
      if (planned.decision === "new_investigation") {
        const investigation = this.createInvestigation(planned.newInvestigation);
        investigationId = investigation.id;
        sessionCode = investigation.session_code;
      } else {
        const investigation = this.getInvestigation(planned.investigationId);
        if (!investigation) {
          this.finishInbound(inboundId, "failed", "调查不存在");
          return { accepted: false, decision: { kind: "unroutable", reason: "调查不存在" } };
        }
        investigationId = investigation.id;
        sessionCode = investigation.session_code;
        if (planned.servicePatch && !investigation.service) {
          this.setInvestigationService(investigationId, planned.servicePatch);
        }
      }

      const message = this.insertMessage({
        investigationId,
        provider: msg.provider,
        accountId: msg.accountId,
        externalMessageId: msg.externalMessageId,
        rootId: msg.rootId,
        threadId: msg.threadId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        text: msg.text,
        receivedAt: msg.receivedAt,
      });
      const run = this.createRun({
        investigationId,
        messageId: message.id,
        maxAttempts: opts.maxAttempts,
        source: msg.provider,
      });
      this.finishInbound(inboundId, "processed");

      return {
        accepted: true,
        decision:
          planned.decision === "new_investigation"
            ? { kind: "new_investigation", sessionCode }
            : { kind: "continue_investigation", investigationId },
        investigationId,
        messageId: message.id,
        runId: run.id,
        round: run.round,
        sessionCode,
      };
    });
  }

  // ---------- investigation ----------

  createInvestigation(input: {
    sessionCode: string;
    provider: string;
    accountId: string;
    chatId: string;
    rootMessageId?: string;
    threadId?: string;
    title?: string;
    service?: string;
    createdBy?: string;
  }): InvestigationRow {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO investigations
           (id, session_code, provider, account_id, chat_id, root_message_id, thread_id,
            status, title, service, created_by, total_rounds, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.sessionCode,
        input.provider,
        input.accountId,
        input.chatId,
        input.rootMessageId ?? null,
        input.threadId ?? null,
        input.title ?? null,
        input.service ?? null,
        input.createdBy ?? null,
        now,
        now,
      );
    return this.getInvestigation(id)!;
  }

  getInvestigation(id: string): InvestigationRow | undefined {
    return this.db.prepare("SELECT * FROM investigations WHERE id = ?").get(id) as
      | InvestigationRow
      | undefined;
  }

  findInvestigationByCode(code: string): InvestigationRow | undefined {
    return this.db.prepare("SELECT * FROM investigations WHERE session_code = ?").get(code) as
      | InvestigationRow
      | undefined;
  }

  findInvestigationByRoute(
    provider: string,
    accountId: string,
    chatId: string,
    rootId?: string,
    threadId?: string,
  ): InvestigationRow | undefined {
    if (rootId) {
      const byRoot = this.db
        .prepare(
          `SELECT * FROM investigations
           WHERE provider = ? AND account_id = ? AND chat_id = ? AND root_message_id = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(provider, accountId, chatId, rootId) as InvestigationRow | undefined;
      if (byRoot) return byRoot;
    }
    if (threadId) {
      return this.db
        .prepare(
          `SELECT * FROM investigations
           WHERE provider = ? AND account_id = ? AND chat_id = ? AND thread_id = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(provider, accountId, chatId, threadId) as InvestigationRow | undefined;
    }
    return undefined;
  }

  setInvestigationService(id: string, service: string): void {
    this.db
      .prepare("UPDATE investigations SET service = ?, updated_at = ? WHERE id = ? AND service IS NULL")
      .run(service, Date.now(), id);
  }

  setContextSummary(id: string, summary: string, totalRounds: number): void {
    this.db
      .prepare(
        "UPDATE investigations SET context_summary = ?, total_rounds = ?, updated_at = ? WHERE id = ?",
      )
      .run(summary, totalRounds, Date.now(), id);
  }

  // ---------- messages ----------

  insertMessage(input: {
    investigationId: string;
    provider: string;
    accountId: string;
    externalMessageId: string;
    rootId?: string;
    threadId?: string;
    senderId?: string;
    senderName?: string;
    text: string;
    receivedAt: number;
  }): MessageRow {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO messages
           (id, investigation_id, provider, account_id, external_message_id, root_id, thread_id,
            sender_id, sender_name, text, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.investigationId,
        input.provider,
        input.accountId,
        input.externalMessageId,
        input.rootId ?? null,
        input.threadId ?? null,
        input.senderId ?? null,
        input.senderName ?? null,
        input.text,
        input.receivedAt,
        now,
      );
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as unknown as MessageRow;
  }

  getMessageById(id: string): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as unknown as MessageRow | undefined;
  }

  findMessageByExternalId(
    provider: string,
    accountId: string,
    externalMessageId: string,
  ): MessageRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE provider = ? AND account_id = ? AND external_message_id = ?",
      )
      .get(provider, accountId, externalMessageId) as MessageRow | undefined;
  }

  // ---------- runs / attempts ----------

  createRun(input: {
    investigationId: string;
    messageId: string;
    maxAttempts: number;
    availableAt?: number;
    source?: string;
    round?: number;
  }): RunRow {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO runs
           (id, investigation_id, message_id, round, source, status, generation, attempt_count,
            max_attempts, available_at, created_at, updated_at)
         VALUES (?, ?, ?,
            COALESCE(?, (SELECT COALESCE(MAX(round), 0) + 1 FROM runs WHERE investigation_id = ?)),
            ?, 'queued', 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.investigationId,
        input.messageId,
        input.round ?? null,
        input.investigationId,
        input.source ?? "feishu",
        input.maxAttempts,
        input.availableAt ?? now,
        now,
        now,
      );
    return this.getRun(id)!;
  }

  getRun(id: string): RunRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
  }

  getRunByMessage(messageId: string): RunRow | undefined {
    return this.db
      .prepare("SELECT * FROM runs WHERE message_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(messageId) as RunRow | undefined;
  }

  getAttempt(attemptId: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as AttemptRow | undefined;
  }

  /** 按时间列出一次 run 的全部尝试（含每次的会话日志指针），供回放/审计使用。 */
  listAttemptsByRun(runId: string): AttemptRow[] {
    return this.db
      .prepare("SELECT * FROM attempts WHERE run_id = ? ORDER BY generation ASC")
      .all(runId) as unknown as AttemptRow[];
  }

  /**
   * 领取一个待执行轮次：同一调查最多一个有效执行者，不同调查可并行。
   * 严格轮次顺序：只有调查内最小未终态轮次可领取（前一轮待重试时后一轮不越过）。
   * 会话间公平：按各调查最早的待执行轮次 FIFO，避免单调查长队列饿死其他调查。
   * 在 BEGIN IMMEDIATE 里完成"选任务 + 占租约 + 建尝试"，不在这里做任何 IO。
   */
  claimNextRun(workerId: string, leaseMs: number, now = Date.now()): ClaimedRun | undefined {
    return transaction(this.db, () => {
      const row = this.db
        .prepare(
          `SELECT r.* FROM runs r
           WHERE r.status = 'queued'
             AND r.available_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM runs other
               WHERE other.investigation_id = r.investigation_id
                 AND other.id <> r.id
                 AND other.status = 'running'
             )
             AND NOT EXISTS (
               SELECT 1 FROM runs prev
               WHERE prev.investigation_id = r.investigation_id
                 AND prev.status IN ('queued', 'running')
                 AND prev.round < r.round
             )
           ORDER BY (
             SELECT MIN(h.created_at) FROM runs h
             WHERE h.investigation_id = r.investigation_id AND h.status = 'queued'
           ) ASC, r.round ASC, r.created_at ASC, r.id ASC
           LIMIT 1`,
        )
        .get(now) as RunRow | undefined;
      if (!row) return undefined;

      const generation = row.generation + 1;
      const attemptId = randomUUID();
      const leaseExpires = now + leaseMs;
      this.db
        .prepare(
          `UPDATE runs
           SET status = 'running', generation = ?, attempt_count = attempt_count + 1,
               started_at = COALESCE(started_at, ?), lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(generation, now, leaseExpires, now, row.id);
      this.db
        .prepare(
          `INSERT INTO attempts
             (id, run_id, generation, worker_id, status, lease_expires_at, heartbeat_at, started_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
        )
        .run(attemptId, row.id, generation, workerId, leaseExpires, now, now);

      return {
        run: { ...row, status: "running", generation, attempt_count: row.attempt_count + 1 },
        attemptId,
        generation,
      };
    });
  }

  /** 用户显式取消一个轮次：queued 直接取消，running 置标志等执行者失租/中止，终态返回现状。 */
  requestCancel(runId: string, now = Date.now()): { status: RunStatus; requested: boolean } {
    return transaction(this.db, () => {
      const run = this.getRun(runId);
      if (!run) return { status: "failed", requested: false };
      if (run.status === "queued") {
        this.db
          .prepare(
            "UPDATE runs SET status = 'cancelled', lease_expires_at = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
          )
          .run(now, now, runId);
        return { status: "cancelled", requested: true };
      }
      if (run.status === "running") {
        this.db
          .prepare("UPDATE runs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status = 'running'")
          .run(now, runId);
        return { status: "running", requested: true };
      }
      return { status: run.status, requested: false };
    });
  }

  /** 执行者检查本轮是否被请求取消（心跳周期调用）。 */
  isCancelRequested(runId: string): boolean {
    const row = this.db.prepare("SELECT cancel_requested FROM runs WHERE id = ?").get(runId) as
      | { cancel_requested: number }
      | undefined;
    return asNumber(row?.cancel_requested ?? 0) === 1;
  }

  /** 取消终态：带代次守卫；不回 queued、不重试。 */
  finishCancelled(runId: string, generation: number, message: string, now = Date.now()): boolean {
    return transaction(this.db, () => {
      const result = this.db
        .prepare(
          `UPDATE runs SET status = 'cancelled', lease_expires_at = NULL,
             error_code = 'cancelled', error_message = ?, finished_at = ?, updated_at = ?
           WHERE id = ? AND generation = ? AND status = 'running'`,
        )
        .run(message, now, now, runId, generation);
      if (asNumber(result.changes) !== 1) return false;
      this.db
        .prepare(
          "UPDATE attempts SET status = 'cancelled', error_code = 'cancelled', error_message = ?, finished_at = ? WHERE run_id = ? AND generation = ?",
        )
        .run(message, now, runId, generation);
      return true;
    });
  }

  /** 人工重试失败/取消的轮次：回到 queued，保留 attempt_count 与 round。 */
  retryRun(runId: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE runs SET status = 'queued', available_at = ?, lease_expires_at = NULL,
           cancel_requested = 0, error_code = NULL, error_message = NULL, finished_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('failed', 'cancelled')`,
      )
      .run(now, now, runId);
    return asNumber(result.changes) === 1;
  }

  /** 续租：只有当前代次的执行者能续。返回 false 表示已失去租约（必须中止）。 */
  heartbeat(runId: string, attemptId: string, generation: number, leaseMs: number, now = Date.now()): boolean {
    return transaction(this.db, () => {
      const leaseExpires = now + leaseMs;
      const runResult = this.db
        .prepare(
          `UPDATE runs SET lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND generation = ? AND status = 'running'`,
        )
        .run(leaseExpires, now, runId, generation);
      if (asNumber(runResult.changes) !== 1) return false;
      const attemptResult = this.db
        .prepare(
          "UPDATE attempts SET heartbeat_at = ? WHERE id = ? AND run_id = ? AND generation = ? AND status = 'running'",
        )
        .run(now, attemptId, runId, generation);
      return asNumber(attemptResult.changes) === 1;
    });
  }

  /** 成功提交：报告、终态、上下文指针在同一事务里落库（调用方负责把报告写入）。 */
  finishSuccess(runId: string, generation: number, reportId: string, now = Date.now()): boolean {
    return transaction(this.db, () => {
      const result = this.db
        .prepare(
          `UPDATE runs SET status = 'succeeded', report_id = ?, lease_expires_at = NULL,
             error_code = NULL, error_message = NULL, finished_at = ?, updated_at = ?
           WHERE id = ? AND generation = ? AND status = 'running'`,
        )
        .run(reportId, now, now, runId, generation);
      if (asNumber(result.changes) !== 1) return false;
      this.db
        .prepare(
          "UPDATE attempts SET status = 'succeeded', finished_at = ? WHERE run_id = ? AND generation = ?",
        )
        .run(now, runId, generation);
      return true;
    });
  }

  /**
   * 成功提交（一个事务）：证据 + 报告 + 终态 + 待发送记录 + 上下文指针。
   * 代次守卫失败（租约已被回收）时不做任何写入，返回 ok=false。
   */
  finalizeSuccess(input: {
    runId: string;
    generation: number;
    attemptId: string;
    investigationId: string;
    round: number;
    completeness: ReportCompleteness;
    reportContent: unknown;
    evidence: Array<{
      evidenceId: string;
      kind: string;
      source: string;
      excerpt: string;
      truncated: boolean;
      time?: number;
      level?: string;
      codeRef?: { repoId: string; sha: string; path: string; startLine: number; endLine: number };
    }>;
    /** 需要回复到 IM 时提供；Web 发起的轮次不提供（结果只进 EventStore/SSE）。 */
    delivery?: { kind: string; targetMessageId?: string; content: string; idempotencyKey: string };
    contextSummary: string;
    /** 报告引用格式版本（D7）：2 = evidenceIds 为 evidence_uid；缺省 1 = 历史 run 级 E#。 */
    referenceFormatVersion?: number;
    now?: number;
  }): { ok: boolean; reportId: string } {
    const now = input.now ?? Date.now();
    return transaction(this.db, () => {
      const guard = this.db
        .prepare("SELECT id FROM runs WHERE id = ? AND generation = ? AND status = 'running'")
        .get(input.runId, input.generation) as { id: string } | undefined;
      if (!guard) return { ok: false, reportId: "" };

      const insertEvidence = this.db.prepare(
        `INSERT OR IGNORE INTO evidence
           (run_id, evidence_id, investigation_id, kind, source, excerpt, truncated, time_ms, level,
            repo_id, sha, path, start_line, end_line, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of input.evidence) {
        insertEvidence.run(
          input.runId,
          item.evidenceId,
          input.investigationId,
          item.kind,
          item.source,
          item.excerpt,
          item.truncated ? 1 : 0,
          item.time ?? null,
          item.level ?? null,
          item.codeRef?.repoId ?? null,
          item.codeRef?.sha ?? null,
          item.codeRef?.path ?? null,
          item.codeRef?.startLine ?? null,
          item.codeRef?.endLine ?? null,
          now,
        );
      }

      const reportId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO reports (id, investigation_id, run_id, completeness, content, created_at, reference_format_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          reportId,
          input.investigationId,
          input.runId,
          input.completeness,
          JSON.stringify(input.reportContent),
          now,
          input.referenceFormatVersion ?? 1,
        );
      this.db
        .prepare(
          `UPDATE runs SET status = 'succeeded', report_id = ?, lease_expires_at = NULL,
             error_code = NULL, error_message = NULL, finished_at = ?, updated_at = ?
           WHERE id = ? AND generation = ? AND status = 'running'`,
        )
        .run(reportId, now, now, input.runId, input.generation);
      this.db
        .prepare(
          "UPDATE attempts SET status = 'succeeded', finished_at = ? WHERE run_id = ? AND generation = ?",
        )
        .run(now, input.runId, input.generation);
      if (input.delivery) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO deliveries
               (id, investigation_id, run_id, report_id, kind, target_message_id, content, idempotency_key,
                status, attempt, available_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            input.investigationId,
            input.runId,
            reportId,
            input.delivery.kind,
            input.delivery.targetMessageId ?? null,
            input.delivery.content,
            input.delivery.idempotencyKey,
            now,
            now,
            now,
          );
      }
      this.db
        .prepare("UPDATE investigations SET context_summary = ?, total_rounds = ?, updated_at = ? WHERE id = ?")
        .run(input.contextSummary, input.round, now, input.investigationId);
      return { ok: true, reportId };
    });
  }

  /**
   * 非诊断回复的成功提交（闲聊 / 向用户追问）：不产生报告，只落一条回复投递，
   * 与诊断路径一样“终态 + 投递”同事务提交，并带代次守卫。
   */
  finalizeReply(input: {
    runId: string;
    generation: number;
    investigationId: string;
    round: number;
    text: string;
    targetMessageId?: string;
    contextSummary: string;
    /** Web 发起的回复不回 IM，只落会话与事件；默认 true 保持 IM 行为。 */
    deliver?: boolean;
    now?: number;
  }): { ok: boolean } {
    const now = input.now ?? Date.now();
    return transaction(this.db, () => {
      const guard = this.db
        .prepare("SELECT id FROM runs WHERE id = ? AND generation = ? AND status = 'running'")
        .get(input.runId, input.generation) as { id: string } | undefined;
      if (!guard) return { ok: false };
      this.db
        .prepare(
          `UPDATE runs SET status = 'succeeded', lease_expires_at = NULL,
             error_code = NULL, error_message = NULL, finished_at = ?, updated_at = ?
           WHERE id = ? AND generation = ? AND status = 'running'`,
        )
        .run(now, now, input.runId, input.generation);
      this.db
        .prepare(
          "UPDATE attempts SET status = 'succeeded', finished_at = ? WHERE run_id = ? AND generation = ?",
        )
        .run(now, input.runId, input.generation);
      if (input.deliver !== false) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO deliveries
               (id, investigation_id, run_id, report_id, kind, target_message_id, content, idempotency_key,
                status, attempt, available_at, created_at, updated_at)
             VALUES (?, ?, ?, NULL, 'reply', ?, ?, ?, 'pending', 0, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            input.investigationId,
            input.runId,
            input.targetMessageId ?? null,
            input.text,
            `reply:${input.runId}`,
            now,
            now,
            now,
          );
      }
      this.db
        .prepare("UPDATE investigations SET context_summary = ?, total_rounds = ?, updated_at = ? WHERE id = ?")
        .run(input.contextSummary, input.round, now, input.investigationId);
      return { ok: true };
    });
  }

  /** 失败/中断提交：由状态机决定回 queued 还是 failed。 */
  finishFailure(
    runId: string,
    generation: number,
    nextStatus: Extract<RunStatus, "queued" | "failed">,
    code: RunErrorCode,
    message: string,
    availableAt: number,
    now = Date.now(),
  ): boolean {
    return transaction(this.db, () => {
      const runResult = this.db
        .prepare(
          `UPDATE runs SET status = ?, available_at = ?, lease_expires_at = NULL,
             error_code = ?, error_message = ?, finished_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
             updated_at = ?
           WHERE id = ? AND generation = ? AND status = 'running'`,
        )
        .run(nextStatus, availableAt, code, message, nextStatus, now, now, runId, generation);
      if (asNumber(runResult.changes) !== 1) return false;
      this.db
        .prepare(
          "UPDATE attempts SET status = ?, error_code = ?, error_message = ?, finished_at = ? WHERE run_id = ? AND generation = ?",
        )
        .run(nextStatus === "queued" ? "interrupted" : "failed", code, message, now, runId, generation);
      return true;
    });
  }

  /** 回收过期租约：把中断的轮次按状态机重排或判失败。返回处理条数。 */
  recoverExpiredLeases(now = Date.now()): number {
    return transaction(this.db, () => {
      const expired = this.db
        .prepare(
          "SELECT id, generation, attempt_count, max_attempts FROM runs WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?",
        )
        .all(now) as Array<{
        id: string;
        generation: number;
        attempt_count: number;
        max_attempts: number;
      }>;
      for (const run of expired) {
        this.db
          .prepare(
            "UPDATE attempts SET status = 'interrupted', error_code = 'interrupted', error_message = '租约过期', finished_at = ? WHERE run_id = ? AND generation = ? AND status = 'running'",
          )
          .run(now, run.id, run.generation);
        const retry = run.attempt_count < run.max_attempts;
        const nextStatus: RunStatus = retry ? "queued" : "failed";
        this.db
          .prepare(
            `UPDATE runs SET status = ?, available_at = ?, lease_expires_at = NULL,
               error_code = 'interrupted', error_message = '租约过期，已回收',
               finished_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END, updated_at = ?
             WHERE id = ? AND status = 'running' AND generation = ?`,
          )
          .run(nextStatus, now, nextStatus, now, now, run.id, run.generation);
      }
      return expired.length;
    });
  }

  // ---------- run events ----------

  appendRunEvent(runId: string, attemptId: string | null, type: string, payload: unknown): number {
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS seq FROM run_events WHERE run_id = ?")
        .get(runId) as { seq: number };
      const sequence = asNumber(row.seq) + 1;
      this.db
        .prepare(
          "INSERT INTO run_events (run_id, attempt_id, sequence, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(runId, attemptId, sequence, type, payload === undefined ? null : JSON.stringify(payload), Date.now());
      return sequence;
    });
  }

  // ---------- session entries（单存储：模型会话进库，取代 JSONL） ----------

  /**
   * 追加一条 pi 会话条目（完整 SessionEntry JSON）。
   * 带代次守卫：只有当前 running 且代次匹配的执行者能写；过期/僵尸写入直接丢弃。
   * seq 按调查单调递增；entry_id 去重。
   */
  appendSessionEntry(input: {
    investigationId: string;
    runId: string;
    attemptId: string;
    generation: number;
    entry: { id: string; parentId: string | null; type: string; timestamp: string };
  }): boolean {
    const now = Date.now();
    return transaction(this.db, () => {
      const guard = this.db
        .prepare("SELECT id FROM runs WHERE id = ? AND generation = ? AND status = 'running'")
        .get(input.runId, input.generation) as { id: string } | undefined;
      if (!guard) return false;
      const row = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM session_entries WHERE investigation_id = ?")
        .get(input.investigationId) as { seq: number | bigint };
      const seq = asNumber(row.seq) + 1;
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO session_entries
             (investigation_id, seq, run_id, attempt_id, entry_id, parent_id, type, time_ms, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.investigationId,
          seq,
          input.runId,
          input.attemptId,
          input.entry.id,
          input.entry.parentId ?? null,
          input.entry.type,
          Date.parse(input.entry.timestamp) || now,
          JSON.stringify(input.entry),
          now,
        );
      if (asNumber(result.changes) !== 1) return false;
      this.db.prepare("UPDATE runs SET session_seq = ?, updated_at = ? WHERE id = ?").run(seq, now, input.runId);
      return true;
    });
  }

  /** 按调查读回全部会话条目（按 seq 升序），供引擎重建会话。 */
  listSessionEntries(investigationId: string): unknown[] {
    const rows = this.db
      .prepare("SELECT data FROM session_entries WHERE investigation_id = ? ORDER BY seq ASC")
      .all(investigationId) as unknown as Array<{ data: string }>;
    const out: unknown[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.data));
      } catch {
        // 损坏行跳过（正常不会发生：写入即 JSON.stringify）
      }
    }
    return out;
  }

  /** 本轮是否已经追加过用户消息：决定新引擎是 prompt（首次）还是 continue（恢复）。 */
  hasSessionEntriesForRun(runId: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM session_entries WHERE run_id = ? LIMIT 1").get(runId) !== undefined;
  }

  /** 工具执行记录（可观测，T3）：入参/结果规模/耗时/成败/pi 调用 ID。 */
  recordToolExecution(input: {
    investigationId: string;
    runId: string;
    attemptId: string;
    callId: string;
    tool: string;
    input: unknown;
    ok: boolean;
    durationMs: number;
    outputChars?: number;
    error?: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tool_executions
           (id, investigation_id, run_id, attempt_id, call_id, tool, input, ok, duration_ms, output_chars, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.investigationId,
        input.runId,
        input.attemptId,
        input.callId,
        input.tool,
        input.input === undefined ? null : JSON.stringify(input.input),
        input.ok ? 1 : 0,
        input.durationMs,
        input.outputChars ?? null,
        input.error ?? null,
        Date.now(),
      );
  }

  /** token 汇总：attempt 维度一份，runs 为该 run 全部尝试之和；带代次守卫。 */
  recordSessionUsage(input: {
    runId: string;
    attemptId: string;
    generation: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    totalTokens: number;
  }): boolean {
    const now = Date.now();
    return transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE attempts SET usage_input_tokens = ?, usage_output_tokens = ?,
             usage_cache_tokens = ?, usage_total_tokens = ?
           WHERE id = ? AND run_id = ? AND generation = ?`,
        )
        .run(
          input.inputTokens,
          input.outputTokens,
          input.cacheTokens,
          input.totalTokens,
          input.attemptId,
          input.runId,
          input.generation,
        );
      const totals = this.db
        .prepare(
          `SELECT COALESCE(SUM(usage_input_tokens), 0) AS i,
                  COALESCE(SUM(usage_output_tokens), 0) AS o,
                  COALESCE(SUM(usage_cache_tokens), 0) AS c,
                  COALESCE(SUM(usage_total_tokens), 0) AS t
             FROM attempts WHERE run_id = ?`,
        )
        .get(input.runId) as { i: number | bigint; o: number | bigint; c: number | bigint; t: number | bigint };
      const runResult = this.db
        .prepare(
          `UPDATE runs SET usage_input_tokens = ?, usage_output_tokens = ?,
             usage_cache_tokens = ?, usage_total_tokens = ?, updated_at = ?
           WHERE id = ? AND generation = ? AND status = 'running'`,
        )
        .run(
          asNumber(totals.i),
          asNumber(totals.o),
          asNumber(totals.c),
          asNumber(totals.t),
          now,
          input.runId,
          input.generation,
        );
      return asNumber(runResult.changes) === 1;
    });
  }

  // ---------- evidence ----------

  /**
   * 工具证据批次提交（两阶段提交的 Host 侧，docs/evidence-uid-design.md §5.2）。
   *
   * 事务内：代次守卫 → payload hash 重算比对 → 批次幂等/冲突判定 → 写批次 →
   * 调查内短号续签（新号从历史最大 n+1 起，> 所有历史行，与旧数据无冲突）→ 逐条分配 uid 落库。
   * 失败路径（lease_lost/conflict）不产生任何半批数据；uid 撞唯一索引（理论不会）→ content_conflict。
   */
  commitEvidenceBatch(input: {
    batchId: string;
    tool: string;
    toolCallId: string;
    payloadHash: string;
    items: EvidenceItem[];
    result: unknown;
    investigationId: string;
    runId: string;
    attemptId: string;
    generation: number;
  }): { ok: true; refs: EvidenceRef[] } | { ok: false; code: "lease_lost" | "conflict" | "content_conflict"; message: string } {
    try {
      return transaction(this.db, () => {
        const guard = this.db
          .prepare("SELECT id FROM runs WHERE id = ? AND generation = ? AND status = 'running'")
          .get(input.runId, input.generation);
        if (!guard) return { ok: false as const, code: "lease_lost" as const, message: "执行租约已失效，证据提交被拒" };

        const hash = evidencePayloadHash(input.items);
        if (hash !== input.payloadHash) {
          return { ok: false as const, code: "conflict" as const, message: "payload 与 payload_hash 不一致" };
        }

        const existing = this.db.prepare("SELECT * FROM evidence_batches WHERE batch_id = ?").get(input.batchId) as
          | EvidenceBatchRow
          | undefined;
        if (existing) {
          if (existing.payload_hash !== hash) {
            return { ok: false as const, code: "conflict" as const, message: "同批次 payload_hash 不一致" };
          }
          return { ok: true as const, refs: this.listEvidenceRefsByBatch(input.batchId) };
        }

        const sameCall = this.db
          .prepare("SELECT batch_id FROM evidence_batches WHERE run_id = ? AND tool_call_id = ?")
          .get(input.runId, input.toolCallId) as { batch_id: string } | undefined;
        if (sameCall) {
          return {
            ok: false as const,
            code: "conflict" as const,
            message: `tool_call ${input.toolCallId} 已绑定批次 ${sameCall.batch_id}`,
          };
        }

        this.db
          .prepare(
            `INSERT INTO evidence_batches
               (batch_id, investigation_id, run_id, attempt_id, generation, tool, tool_call_id, payload_hash, result_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.batchId,
            input.investigationId,
            input.runId,
            input.attemptId,
            input.generation,
            input.tool,
            input.toolCallId,
            hash,
            JSON.stringify(input.result ?? null),
            Date.now(),
          );

        const maxRow = this.db
          .prepare(
            "SELECT MAX(CAST(SUBSTR(evidence_id, 2) AS INTEGER)) AS n FROM evidence WHERE investigation_id = ? AND evidence_id GLOB 'E[0-9]*'",
          )
          .get(input.investigationId) as { n: number | bigint | null };
        let n = asNumber(maxRow.n ?? 0);

        const insert = this.db.prepare(
          `INSERT INTO evidence
             (run_id, evidence_id, investigation_id, kind, source, excerpt, truncated, time_ms, level,
              repo_id, sha, path, start_line, end_line, created_at, evidence_uid, batch_id, item_index)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const refs: EvidenceRef[] = [];
        input.items.forEach((item, index) => {
          n += 1;
          const evidenceId = `E${n}`;
          const uid = randomUUID();
          insert.run(
            input.runId,
            evidenceId,
            input.investigationId,
            item.kind,
            evidenceSourceOf(item),
            item.excerpt,
            (item.truncated ?? false) ? 1 : 0,
            item.time ?? null,
            item.level ?? null,
            item.codeRef?.repoId ?? null,
            item.codeRef?.sha ?? null,
            item.codeRef?.path ?? null,
            item.codeRef?.startLine ?? null,
            item.codeRef?.endLine ?? null,
            Date.now(),
            uid,
            input.batchId,
            index,
          );
          refs.push({ ...item, evidenceUid: uid, evidenceId, truncated: item.truncated ?? false });
        });
        return { ok: true as const, refs };
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        return { ok: false, code: "content_conflict", message: "evidence_uid 冲突（理论不应发生）" };
      }
      throw err;
    }
  }

  /** 调查级证据列表（校验 hydrate 与 Web 展示用）；编号序按数值而非字典序。 */
  listEvidenceByInvestigation(investigationId: string): EvidenceRow[] {
    return this.db
      .prepare(
        "SELECT * FROM evidence WHERE investigation_id = ? ORDER BY created_at ASC, CAST(SUBSTR(evidence_id, 2) AS INTEGER) ASC",
      )
      .all(investigationId) as never;
  }

  /** 按 (runId, toolCallId) 找回已提交批次及其证据（崩溃恢复的查找键，D5）。 */
  getBatchByToolCall(runId: string, toolCallId: string): { batch: EvidenceBatchRow; evidence: EvidenceRow[] } | undefined {
    const batch = this.db
      .prepare("SELECT * FROM evidence_batches WHERE run_id = ? AND tool_call_id = ?")
      .get(runId, toolCallId) as EvidenceBatchRow | undefined;
    if (!batch) return undefined;
    return { batch, evidence: this.evidenceRowsByBatch(batch.batch_id) };
  }

  private evidenceRowsByBatch(batchId: string): EvidenceRow[] {
    return this.db
      .prepare("SELECT * FROM evidence WHERE batch_id = ? ORDER BY item_index ASC")
      .all(batchId) as never;
  }

  /** 批次内证据（按 item_index 序）的 ref 视图：恢复重建与幂等返回共用。 */
  listEvidenceRefsByBatch(batchId: string): EvidenceRef[] {
    return (this.evidenceRowsByBatch(batchId) as EvidenceRow[]).map(evidenceRowToRef);
  }

  /** 按 UID 查调查内证据（报告 v2 引用解析）。 */
  getEvidenceByUid(investigationId: string, evidenceUid: string): EvidenceRow | undefined {
    return this.db
      .prepare("SELECT * FROM evidence WHERE investigation_id = ? AND evidence_uid = ?")
      .get(investigationId, evidenceUid) as EvidenceRow | undefined;
  }

  /** 按 (runId, evidenceId) 查证据（历史报告 v1 引用解析）。 */
  getEvidenceByRunAndId(runId: string, evidenceId: string): EvidenceRow | undefined {
    return this.db
      .prepare("SELECT * FROM evidence WHERE run_id = ? AND evidence_id = ?")
      .get(runId, evidenceId) as EvidenceRow | undefined;
  }

  listEvidence(runId: string): Array<{
    evidence_id: string;
    kind: string;
    source: string;
    excerpt: string;
    truncated: number;
    time_ms: number | null;
    level: string | null;
    repo_id: string | null;
    sha: string | null;
    path: string | null;
    start_line: number | null;
    end_line: number | null;
  }> {
    return this.db
      .prepare("SELECT * FROM evidence WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as never;
  }

  // ---------- reports ----------

  insertReport(input: {
    investigationId: string;
    runId: string;
    completeness: ReportCompleteness;
    content: unknown;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO reports (id, investigation_id, run_id, completeness, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.investigationId, input.runId, input.completeness, JSON.stringify(input.content), Date.now());
    return id;
  }

  getReportByRun(runId: string): { id: string; content: string; completeness: ReportCompleteness } | undefined {
    return this.db
      .prepare("SELECT id, content, completeness FROM reports WHERE run_id = ?")
      .get(runId) as { id: string; content: string; completeness: ReportCompleteness } | undefined;
  }

  // ---------- deliveries ----------

  enqueueDelivery(input: {
    investigationId: string;
    runId: string;
    reportId?: string;
    kind: string;
    targetMessageId?: string;
    content: string;
    idempotencyKey: string;
    availableAt?: number;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO deliveries
           (id, investigation_id, run_id, report_id, kind, target_message_id, content, idempotency_key,
            status, attempt, available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.investigationId,
        input.runId,
        input.reportId ?? null,
        input.kind,
        input.targetMessageId ?? null,
        input.content,
        input.idempotencyKey,
        input.availableAt ?? now,
        now,
        now,
      );
  }

  getDelivery(id: string): DeliveryRow | undefined {
    return this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as DeliveryRow | undefined;
  }

  /**
   * 外部发送者（Go 适配器）上交投递结果。带"仍处于 sending 且 attempt 匹配"守卫，
   * 避免过期发送者覆盖新一次尝试的状态。
   */
  settleDelivery(input: {
    id: string;
    attempt: number;
    outcome: "sent" | "retry" | "uncertain" | "failed";
    providerMessageId?: string;
    error?: string;
    availableAt?: number;
    now?: number;
  }): boolean {
    const now = input.now ?? Date.now();
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT id FROM deliveries WHERE id = ? AND status = 'sending' AND attempt = ?")
        .get(input.id, input.attempt) as { id: string } | undefined;
      if (!row) return false;
      switch (input.outcome) {
        case "sent":
          this.db
            .prepare(
              "UPDATE deliveries SET status = 'sent', provider_message_id = ?, lease_expires_at = NULL, delivered_at = ?, error = NULL, updated_at = ? WHERE id = ?",
            )
            .run(input.providerMessageId ?? null, now, now, input.id);
          break;
        case "retry":
          this.db
            .prepare(
              "UPDATE deliveries SET status = 'pending', available_at = ?, lease_expires_at = NULL, error = ?, updated_at = ? WHERE id = ?",
            )
            .run(input.availableAt ?? now, input.error ?? null, now, input.id);
          break;
        case "uncertain":
          this.db
            .prepare(
              "UPDATE deliveries SET status = 'uncertain', lease_expires_at = NULL, error = ?, updated_at = ? WHERE id = ?",
            )
            .run(input.error ?? null, now, input.id);
          break;
        case "failed":
          this.db
            .prepare(
              "UPDATE deliveries SET status = 'failed', lease_expires_at = NULL, error = ?, updated_at = ? WHERE id = ?",
            )
            .run(input.error ?? null, now, input.id);
          break;
      }
      return true;
    });
  }

  claimNextDelivery(leaseMs: number, now = Date.now()): DeliveryRow | undefined {
    return transaction(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT * FROM deliveries WHERE status = 'pending' AND available_at <= ? ORDER BY created_at ASC LIMIT 1",
        )
        .get(now) as DeliveryRow | undefined;
      if (!row) return undefined;
      this.db
        .prepare(
          "UPDATE deliveries SET status = 'sending', lease_expires_at = ?, attempt = attempt + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(now + leaseMs, now, row.id);
      return { ...row, status: "sending", attempt: row.attempt + 1 };
    });
  }

  /** 回收过期发送租约：状态未知 → uncertain（禁止当作未发送无限重试）。 */
  recoverExpiredDeliveries(now = Date.now()): number {
    const result = this.db
      .prepare(
        "UPDATE deliveries SET status = 'uncertain', error = '发送结果未知（租约过期）', lease_expires_at = NULL, updated_at = ? WHERE status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?",
      )
      .run(now, now);
    return asNumber(result.changes);
  }

  markDeliverySent(id: string, providerMessageId: string | undefined, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE deliveries SET status = 'sent', provider_message_id = ?, lease_expires_at = NULL, delivered_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(providerMessageId ?? null, now, now, id);
  }

  markDeliveryUncertain(id: string, error: string, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE deliveries SET status = 'uncertain', error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(error, now, id);
  }

  markDeliveryRetry(id: string, availableAt: number, error: string, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE deliveries SET status = 'pending', available_at = ?, error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(availableAt, error, now, id);
  }

  markDeliveryFailed(id: string, error: string, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE deliveries SET status = 'failed', error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(error, now, id);
  }

  // ---------- Host EventStore（SSE 事件的持久化与 replay） ----------

  /** 追加一条事件，返回稳定的全局自增 ID（= SSE Last-Event-ID）。 */
  appendEvent(stream: string, type: string, payload: unknown, now = Date.now()): number {
    const result = this.db
      .prepare("INSERT INTO events (stream, type, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(stream, type, payload === undefined ? null : JSON.stringify(payload), now);
    return asNumber(result.lastInsertRowid);
  }

  /** 按流读取 id 之后的事件，供断线重连 replay。 */
  listEvents(stream: string, afterId = 0, limit = 1000): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events WHERE stream = ? AND id > ? ORDER BY id ASC LIMIT ?")
      .all(stream, afterId, limit) as unknown as EventRow[];
  }

  // ---------- 查询辅助（Host Web API） ----------

  /** 调查列表：按更新时间倒序，带最新轮次状态供列表页展示。 */
  listInvestigations(
    limit = 50,
  ): Array<InvestigationRow & { latest_run_status: string | null; latest_round: number | null }> {
    return this.db
      .prepare(
        `SELECT i.*,
                (SELECT r.status FROM runs r WHERE r.investigation_id = i.id ORDER BY r.round DESC LIMIT 1) AS latest_run_status,
                (SELECT r.round FROM runs r WHERE r.investigation_id = i.id ORDER BY r.round DESC LIMIT 1) AS latest_round
           FROM investigations i
          ORDER BY i.updated_at DESC
          LIMIT ?`,
      )
      .all(limit) as unknown as Array<
      InvestigationRow & { latest_run_status: string | null; latest_round: number | null }
    >;
  }

  /** 调查内消息，按接收时间升序（含来源与发送者，供时间线展示）。 */
  listMessages(investigationId: string): MessageRow[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE investigation_id = ? ORDER BY received_at ASC, created_at ASC")
      .all(investigationId) as unknown as MessageRow[];
  }

  /** 调查内轮次，按 round 升序（含来源与状态）。 */
  listRunsByInvestigation(investigationId: string): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE investigation_id = ? ORDER BY round ASC")
      .all(investigationId) as unknown as RunRow[];
  }

  /** 调查内最新一份报告（含所属 run），供详情页展示。 */
  getLatestReportByInvestigation(investigationId: string):
    | { id: string; run_id: string; completeness: ReportCompleteness; content: string; created_at: number }
    | undefined {
    return this.db
      .prepare(
        "SELECT id, run_id, completeness, content, created_at FROM reports WHERE investigation_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(investigationId) as
      | { id: string; run_id: string; completeness: ReportCompleteness; content: string; created_at: number }
      | undefined;
  }
}
