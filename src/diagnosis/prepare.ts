// 诊断前的材料准备：从输入推导时间窗、按发生时间钉版本、组装材料范围与工具箱。
//
// 生产编排（orchestrator）与离线评测（evals）**共用这一条路径**——否则评测测的就不是线上行为。
// 这里只做纯准备，不碰数据库、不碰投递、不做租约。
import type { AppConfig } from "../config/index.ts";
import { stripSessionMarker } from "../domain/session.ts";
import { extractOccurredAt } from "../domain/time.ts";
import type { DiagnosisInput, MaterialScope, RepositoryRef } from "../domain/types.ts";
import { buildCodeSource, type MultiRepoCodeSource } from "../sources/code.ts";
import { FileLogSource } from "../sources/logs.ts";
import type { RunSessionLog } from "../agent/types.ts";
import { DiagnosisToolbox } from "../agent/toolbox.ts";
import { EvidenceRegistry } from "./evidence.ts";

export interface PrepareParams {
  investigationId: string;
  runId: string;
  /** 本轮原始输入文本（可含会话标号，内部会剥掉）。 */
  text: string;
  /** 上报时间（平台事实）。 */
  receivedAt: number;
  service?: string;
  environment?: string;
  contextSummary?: string;
  /** 本轮取消信号，穿透到工具查询。 */
  signal: AbortSignal;
  /** 会话日志：工具调用事件落这里；评测可选、生产必传。 */
  log?: RunSessionLog;
  /** 让测试注入假日志源；缺省用配置文件日志源。 */
  logSource?: FileLogSource;
}

export interface PreparedDiagnosis {
  input: DiagnosisInput;
  scope: MaterialScope;
  registry: EvidenceRegistry;
  toolbox: DiagnosisToolbox;
  /** 程序判定的缺失材料（版本未钉到、发生时间缺失等）。 */
  missingMaterial: string[];
}

/** 从输入组装"一次诊断"所需的全部材料与工具。 */
export async function prepareDiagnosis(config: AppConfig, params: PrepareParams): Promise<PreparedDiagnosis> {
  const question = stripSessionMarker(params.text);
  const receivedAt = params.receivedAt;
  // 宁漏勿错：只信从输入提取到的发生时间；提取不到就是未知，绝不回退成上报时间。
  const parsed = extractOccurredAt(params.text, receivedAt);
  const occurredAt = parsed?.ms;
  const timeWindowBasis: "occurred" | "reported" = occurredAt !== undefined ? "occurred" : "reported";
  const anchor = occurredAt ?? receivedAt;
  const windowMs =
    occurredAt !== undefined ? config.diagnosis.defaultTimeWindowMs : config.diagnosis.fallbackTimeWindowMs;
  const from = anchor - windowMs;
  const to = anchor + 60 * 60 * 1000;
  const repositories: RepositoryRef[] = config.sources.repos.map((r) => ({
    repoId: r.repoId,
    // 未显式给 rev 时，按事件发生时间钉版本；未获取到发生时间则回退当前 HEAD（在报告标注）。
    ...(occurredAt !== undefined ? { at: occurredAt } : {}),
  }));

  const repoDirs = new Map(config.sources.repos.map((r) => [r.repoId, r.dir]));
  const { source: codeSource, missing: codeMissing } = await buildCodeSource(repositories, repoDirs);
  // 解析后的实际版本（含按时间钉的 SHA），供模型上下文使用。
  const resolvedRepos: RepositoryRef[] = codeSource
    ? codeSource.scopes().map((s) => ({ repoId: s.repoId, rev: s.sha }))
    : repositories;

  const scope: MaterialScope = {
    services: params.service ? [params.service] : [],
    environment: params.environment ?? undefined,
    reportedAt: receivedAt,
    occurredAt,
    timeWindowBasis,
    timeWindow: { from, to },
    repos: codeSource
      ? codeSource
          .scopes()
          .map((s) => ({ repoId: s.repoId, rev: s.sha, sha: s.sha, resolved: true, pinnedBy: s.pinnedBy }))
      : repositories.map((r) => ({
          repoId: r.repoId,
          rev: r.rev ?? "HEAD",
          resolved: false,
          pinnedBy: "unresolved" as const,
        })),
  };

  const missingMaterial = [...codeMissing];
  if (occurredAt === undefined) {
    missingMaterial.push(
      `未从输入获取具体发生时间，已按上报时间回溯 ${Math.round(config.diagnosis.fallbackTimeWindowMs / 3_600_000)} 小时检索（可能遗漏）`,
    );
  }

  const input: DiagnosisInput = {
    investigationId: params.investigationId,
    runId: params.runId,
    question,
    contextSummary: params.contextSummary,
    service: params.service,
    environment: params.environment,
    receivedAt,
    occurredAt,
    occurredSource: parsed?.source,
    repositories: resolvedRepos,
    allowedServices: config.sources.allowedServices,
    allowedRepos: config.sources.allowedRepos,
  };

  const registry = new EvidenceRegistry(params.runId, config.diagnosis.maxResultChars);
  const logSource =
    params.logSource ??
    new FileLogSource({ dir: config.sources.logDir, allowedServices: config.sources.allowedServices });
  const toolbox = new DiagnosisToolbox({
    logs: logSource,
    code: codeSource as MultiRepoCodeSource | undefined,
    evidence: registry,
    scope,
    maxToolCalls: config.diagnosis.maxToolCalls,
    maxToolResultChars: config.diagnosis.maxToolResultChars,
    signal: params.signal,
    log: params.log,
  });

  return { input, scope, registry, toolbox, missingMaterial };
}
