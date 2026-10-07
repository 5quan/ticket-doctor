// Langfuse 客户端初始化与预检（plan §2/§8：环境与部署能力检查，只记录存在状态不打印秘密）。
import { LangfuseClient } from "@langfuse/client";
import type { ObservabilityConfig } from "../../config/index.ts";

export interface LfClientConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

export function lfConfigOf(config: ObservabilityConfig): LfClientConfig | undefined {
  return config.baseUrl && config.publicKey && config.secretKey
    ? { baseUrl: config.baseUrl, publicKey: config.publicKey, secretKey: config.secretKey }
    : undefined;
}

export function createLfClient(cfg: LfClientConfig): LangfuseClient {
  return new LangfuseClient({
    publicKey: cfg.publicKey,
    secretKey: cfg.secretKey,
    baseUrl: cfg.baseUrl,
  });
}

export interface PreflightReport {
  server: { reachable: boolean; version: string | null };
  auth: boolean;
  datasetApi: boolean;
  scoresPost: boolean;
  observationsV2Read: boolean;
  experimentsRead: boolean;
  /** 已知限制：events_only 下分数读 API 恒空，以 UI 为准（见 eval/langfuse 分支结论）。 */
  scoresReadKnownEmpty: boolean;
  issues: string[];
}

const ok = (b: boolean): string => (b ? "✅" : "❌");

/** 预检：部署可达性 + 本方案用到的每个 API 面（写入走 POST，读取走 v2/v3/experiments）。 */
export async function preflight(cfg: LfClientConfig): Promise<PreflightReport> {
  const report: PreflightReport = {
    server: { reachable: false, version: null },
    auth: false,
    datasetApi: false,
    scoresPost: false,
    observationsV2Read: false,
    experimentsRead: false,
    scoresReadKnownEmpty: false,
    issues: [],
  };
  const base = cfg.baseUrl.replace(/\/$/, "");
  const auth = `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64")}`;
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };

  try {
    const health = await call("GET", "/api/public/health");
    report.server.reachable = health.status === 200;
    report.server.version = (health.json as { version?: string } | null)?.version ?? null;
  } catch (err) {
    report.issues.push(`health 不可达：${err instanceof Error ? err.message : err}`);
    return report;
  }

  const projects = await call("GET", "/api/public/projects");
  report.auth = projects.status === 200;

  // dataset API：list（读）+ create 幂等探测（写）。
  const dsList = await call("GET", "/api/public/datasets?limit=1");
  report.datasetApi = dsList.status === 200;

  // scores POST：events_only 下 GET 被拒但 POST 可用（拒收只挂 GET）；用合法空体探测会得 400/422，
  // 只有 404+events_only JSON 报错才算不可用。
  const scoresPost = await call("POST", "/api/public/scores", {});
  report.scoresPost = !(scoresPost.status === 404 && JSON.stringify(scoresPost.json).includes("events_only"));

  const obs = await call("GET", "/api/public/v2/observations?limit=1");
  report.observationsV2Read = obs.status === 200;

  const experiments = await call("GET", "/api/public/experiments?fromStartTime=2026-01-01T00:00:00.000Z&limit=1");
  report.experimentsRead = experiments.status === 200;

  const scoresRead = await call("GET", "/api/public/v3/scores?limit=1");
  report.scoresReadKnownEmpty = scoresRead.status === 200;

  if (!report.auth) report.issues.push("鉴权失败：检查 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY");
  if (!report.datasetApi) report.issues.push("Dataset API 不可用（seed 需要）");
  if (!report.scoresPost) report.issues.push("scores POST 被拒（evaluator 分数无法落库）");
  if (!report.observationsV2Read) report.issues.push("v2/observations 不可读（verify 需要）");
  if (!report.experimentsRead) report.issues.push("experiments 不可读（verify 需要）");
  return report;
}

export function printPreflight(p: PreflightReport): void {
  console.log(`[eval:lf] 服务器 ${p.server.reachable ? ok(true) : ok(false)} version=${p.server.version ?? "?"}`);
  console.log(`[eval:lf] 鉴权 ${ok(p.auth)}  Dataset API ${ok(p.datasetApi)}  scores POST ${ok(p.scoresPost)}`);
  console.log(`[eval:lf] observations v2 读 ${ok(p.observationsV2Read)}  experiments 读 ${ok(p.experimentsRead)}`);
  console.log(`[eval:lf] 分数读 API 恒空（events_only 已知限制，以 UI 为准）${p.scoresReadKnownEmpty ? "已复现" : "未复现（可能已修复，复查）"}`);
  for (const issue of p.issues) console.error(`  ⚠ ${issue}`);
}
