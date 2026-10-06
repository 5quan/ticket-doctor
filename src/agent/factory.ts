// 引擎工厂：两个入口共用，避免接线漂移。
import type { AppConfig } from "../config/index.ts";
import { FakeDiagnosisEngine } from "./fake-engine.ts";
import { FakeEvidenceAuditor } from "./fake-auditor.ts";
import { PiDiagnosisEngine } from "./pi-engine.ts";
import { PiEvidenceAuditor } from "./pi-auditor.ts";
import type { EvidenceAuditor } from "./audit-types.ts";
import type { DiagnosisEngine } from "./types.ts";

/** systemPrompt 仅评测/实验注入（规则）；生产缺省用内置提示词。 */
export function buildEngine(config: AppConfig, systemPrompt?: string): DiagnosisEngine {
  if (config.diagnosis.engine === "pi") {
    if (!config.diagnosis.apiKey) {
      throw new Error("TD_ENGINE=pi 但缺少 DEEPSEEK_API_KEY（或对应 provider 的 key）");
    }
    return new PiDiagnosisEngine({
      provider: config.diagnosis.provider,
      modelId: config.diagnosis.modelId,
      apiKey: config.diagnosis.apiKey,
      maxToolCalls: config.diagnosis.maxToolCalls,
      maxModelTurns: config.diagnosis.maxModelTurns,
      compactionEnabled: config.diagnosis.compactionEnabled,
      maxEventBytes: config.observability.maxEventBytes,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
  }
  return new FakeDiagnosisEngine({ defaultService: "checkout-service" });
}

/** 审计器工厂：未启用返回 undefined（执行路径据此跳过审计）。 */
export function buildAuditor(config: AppConfig): EvidenceAuditor | undefined {
  if (!config.diagnosis.audit.enabled) return undefined;
  // 首版策略（OQ-30）：审计只读冻结快照。显式开启主动检索说明选择了未实现能力，宁可报错不静默忽略。
  if (config.diagnosis.audit.allowRetrieval) {
    throw new Error("TD_AUDIT_ALLOW_RETRIEVAL=true 尚未实现：首版审计只读冻结证据快照（见 OQ-30）");
  }
  if (config.diagnosis.engine === "pi") {
    if (!config.diagnosis.apiKey) {
      throw new Error("TD_AUDIT_ENABLED=true 且 TD_ENGINE=pi，但缺少 DEEPSEEK_API_KEY");
    }
    return new PiEvidenceAuditor({
      provider: config.diagnosis.provider,
      modelId: config.diagnosis.modelId,
      apiKey: config.diagnosis.apiKey,
      maxEventBytes: config.observability.maxEventBytes,
    });
  }
  return new FakeEvidenceAuditor();
}
