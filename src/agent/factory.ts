// 引擎工厂：两个入口共用，避免接线漂移。
import type { AppConfig } from "../config/index.ts";
import { FakeDiagnosisEngine } from "./fake-engine.ts";
import { PiDiagnosisEngine } from "./pi-engine.ts";
import type { DiagnosisEngine } from "./types.ts";

export function buildEngine(config: AppConfig): DiagnosisEngine {
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
    });
  }
  return new FakeDiagnosisEngine({ defaultService: "checkout-service" });
}
