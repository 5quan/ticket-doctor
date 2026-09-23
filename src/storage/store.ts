// Store：所有 SQLite 读写的唯一入口。
//
// 不做"每张表一个仓库类"的机械抽象；按聚合把方法集中在这里，调用方拿到的是领域对象。
// 所有涉及代次（generation）的写操作都必须带 generation 守卫，过期执行者的提交会被拒绝。
import { randomUUID } from "node:crypto";
import type { InboundMessage, InvestigationStatus, ReportCompleteness, RunErrorCode, RunStatus } from "../domain/types.ts";
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
  external_message_id: string;
  sender_id: string | null;
  sender_name: string | null;
  text: string;
  received_at: number;
}

export interface RunRow {
  id: string;
  investigation_id: string;
  message_id: string;
  status: RunStatus;
  generation: number;
  attempt_count: number;
  max_attempts: number;
  available_at: number;
  lease_expires_at: number | null;
  error_code: string | null;
  error_message: string | null;
  report_id: string | null;
  created_at: number;
}

export interface ClaimedRun {
  run: RunRow;
  attemptId: string;
  generation: number;
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
  }): RunRow {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO runs
           (id, investigation_id, message_id, status, generation, attempt_count, max_attempts,
            available_at, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.investigationId,
        input.messageId,
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

  /**
   * 领取一个待执行轮次：同一调查最多一个有效执行者，不同调查可并行。
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
           ORDER BY r.created_at ASC, r.id ASC
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
    delivery: { kind: string; targetMessageId?: string; content: string; idempotencyKey: string };
    contextSummary: string;
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
          "INSERT INTO reports (id, investigation_id, run_id, completeness, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          reportId,
          input.investigationId,
          input.runId,
          input.completeness,
          JSON.stringify(input.reportContent),
          now,
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

  // ---------- evidence ----------

  insertEvidence(
    runId: string,
    investigationId: string,
    items: Array<{
      evidenceId: string;
      kind: string;
      source: string;
      excerpt: string;
      truncated: boolean;
      time?: number;
      level?: string;
      codeRef?: { repoId: string; sha: string; path: string; startLine: number; endLine: number };
    }>,
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO evidence
         (run_id, evidence_id, investigation_id, kind, source, excerpt, truncated, time_ms, level,
          repo_id, sha, path, start_line, end_line, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    transaction(this.db, () => {
      for (const item of items) {
        stmt.run(
          runId,
          item.evidenceId,
          investigationId,
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
          Date.now(),
        );
      }
    });
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
}
