// Langfuse v4（events_only）REST 客户端：评测闭环用到的 Dataset/Experiment 读写面。
//
// 路由可用性对照（本机 4.50.0，LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only，实测+源码）：
//   * 可用写：POST /api/public/datasets、POST /api/public/dataset-items（按 id upsert）、
//     POST /api/public/dataset-run-items（events_only 下不落旧表，返回由
//     (projectId, datasetId, runName) 确定性派生的 datasetRunId=experimentId；
//     trace↔实验关联靠 OTel span 属性 `langfuse.experiment.*`，见服务端
//     OtelIngestionProcessor.extractExperimentFields）。
//   * 可用读：GET /datasets/{name}、GET /dataset-items（Postgres 侧，未被门禁）、
//     GET /v2/observations、GET /v3/scores、GET /experiments、GET /experiment-items（v4 events 表）。
//   * events_only 拒绝（JSON 报错）：v1 traces/observations/scores/sessions/spans/generations、
//     v2 scores、dataset-run-items GET —— 旧 ClickHouse 表已停写，读走 v4 events 面。
// 约定：404 对 getDataset 表示"不存在"（返回 null），其余非 2xx 一律抛错（调用方决定记失败）。
export interface LfApiConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

export class LangfuseApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LfDataset {
  id: string;
  name: string;
  description: string | null;
}

export interface LfDatasetItem {
  id: string;
  datasetId: string;
  datasetName: string;
  status: "ACTIVE" | "ARCHIVED";
}

export interface LfDatasetUpsertItem {
  datasetName: string;
  id: string;
  input: unknown;
  expectedOutput?: unknown;
  metadata?: unknown;
  sourceTraceId?: string;
}

export interface LfExperimentItem {
  id: string;
  traceId: string;
  experimentId: string;
  datasetId: string | null;
  datasetItemId: string | null;
}

export interface LfScore {
  id: string;
  traceId: string;
  name: string;
}

export function createLfApi(config: LfApiConfig): LfApi {
  const base = config.baseUrl.replace(/\/$/, "");
  const auth = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;

  async function request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404) {
      throw new LangfuseApiError(404, `Langfuse ${method} ${path} → 404`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LangfuseApiError(res.status, `Langfuse ${method} ${path} → HTTP ${res.status}：${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  return {
    async getDataset(name): Promise<LfDataset | null> {
      try {
        return await request<LfDataset>("GET", `/api/public/datasets/${encodeURIComponent(name)}`);
      } catch (err) {
        if (err instanceof LangfuseApiError && err.status === 404) return null;
        throw err;
      }
    },
    async upsertDataset(name, description, metadata): Promise<LfDataset> {
      return request<LfDataset>("POST", "/api/public/datasets", {
        name,
        ...(description !== undefined ? { description } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      });
    },
    async upsertDatasetItem(item): Promise<LfDatasetItem> {
      return request<LfDatasetItem>("POST", "/api/public/dataset-items", item);
    },
    async listDatasetItems(datasetName): Promise<LfDatasetItem[]> {
      const out: LfDatasetItem[] = [];
      let page = 1;
      for (;;) {
        const res = await request<{ data: LfDatasetItem[]; meta: { page: number; totalPages: number } }>(
          "GET",
          "/api/public/dataset-items",
          undefined,
          { datasetName, page: String(page), limit: "50" },
        );
        out.push(...res.data);
        if (!res.meta || res.meta.page >= res.meta.totalPages || res.data.length === 0) break;
        page += 1;
      }
      return out;
    },
    // events_only 下此调用不落库：仅换取确定性 experimentId（服务端回显调用方 traceId）。
    // body 不收 datasetId——dataset 由 datasetItemId 反查（PostDatasetRunItemsV1Body strict）。
    async createDatasetRunItem(datasetItemId: string, runName: string, traceId: string): Promise<string> {
      const res = await request<{ datasetRunId: string }>("POST", "/api/public/dataset-run-items", {
        datasetItemId,
        runName,
        traceId,
      });
      return res.datasetRunId;
    },
    async listExperiments(datasetId, fromStartTime): Promise<Array<{ id: string; name: string | null }>> {
      const res = await request<{ data: Array<{ id: string; name: string | null }> }>(
        "GET",
        "/api/public/experiments",
        undefined,
        { datasetId, fromStartTime },
      );
      return res.data ?? [];
    },
    async listExperimentItems(datasetId, fromStartTime): Promise<LfExperimentItem[]> {
      const res = await request<{ data: LfExperimentItem[] }>("GET", "/api/public/experiment-items", undefined, {
        datasetId,
        fromStartTime,
      });
      return res.data ?? [];
    },
    async listScores(traceId): Promise<LfScore[]> {
      const res = await request<{ data: LfScore[] }>("GET", "/api/public/v3/scores", undefined, {
        ...(traceId ? { traceId } : {}),
        limit: "50",
      });
      return res.data ?? [];
    },
    async listObservations(traceId): Promise<Array<{ id: string; traceId: string }>> {
      const res = await request<{ data: Array<{ id: string; traceId: string }> }>(
        "GET",
        "/api/public/v2/observations",
        undefined,
        { traceId, limit: "50" },
      );
      return (res.data ?? []).filter((o) => o.traceId === traceId);
    },
  };
}

export interface LfApi {
  getDataset(name: string): Promise<LfDataset | null>;
  upsertDataset(name: string, description?: string, metadata?: unknown): Promise<LfDataset>;
  upsertDatasetItem(item: LfDatasetUpsertItem): Promise<LfDatasetItem>;
  listDatasetItems(datasetName: string): Promise<LfDatasetItem[]>;
  createDatasetRunItem(datasetItemId: string, runName: string, traceId: string): Promise<string>;
  listExperiments(datasetId: string, fromStartTime: string): Promise<Array<{ id: string; name: string | null }>>;
  listExperimentItems(datasetId: string, fromStartTime: string): Promise<LfExperimentItem[]>;
  listScores(traceId?: string): Promise<LfScore[]>;
  listObservations(traceId: string): Promise<Array<{ id: string; traceId: string }>>;
}
