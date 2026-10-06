// 离线评测数据集（MVP）契约与加载器。
//
// 定位：复用正式链路（prepare/引擎/审计/校验），只替换材料来源与注入；不碰编排。
// 版本铁律：打分器版本独立于产品版本；不同 scorerVersion / 不同变量不得同表比（见 fingerprint.ts）。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** 打分器版本：改判定口径/字段语义即递增；与产品 gitRev 解耦。 */
export const EVAL_SCORER_VERSION = "mvp-0.1.0";

/**
 * gold/干扰证据用「源级定位」表达，不用 `E#`（run 局部、跨 case 无意义）：
 *   * 日志：service + level + substring（traceId 在 message 里，用唯一子串定位）；
 *   * 代码：repoId + path + 行区间（与证据 codeRef 区间重叠即命中），可选 sha。
 */
export interface EvidenceLocator {
  kind: "log" | "code";
  level?: string;
  substring?: string;
  repoId?: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  sha?: string;
}

export interface EvalCase {
  id: string;
  question: string;
  /** 故障发生时间（ISO8601）；用于推导检索时间窗与代码钉版本。 */
  occurredAt?: string;
  service?: string;
  environment?: string;
  /** 基准内默认仓库 id（缺省 app）。 */
  repo?: string;
  gold: { answer: string; evidence: EvidenceLocator[] };
  distractors?: EvidenceLocator[];
  labels?: string[];
  /** 这批材料只覆盖日志（无对应代码版本）→ 只能评日志定位，不得声称验证代码根因。 */
  logOnly?: boolean;
}

export interface Benchmark {
  scenario: string;
  /** 期望引擎；CLI 可覆盖。缺省 fake（离线零成本）。 */
  engine?: "fake" | "pi";
  /** 规则文件（相对场景目录）；注入系统提示词，作为唯一迭代对象。 */
  rulesFile?: string;
  /** 相对项目根的路径覆盖；缺省 <scenarioDir>/logs 与 <scenarioDir>/repo。 */
  logsDir?: string;
  repoDir?: string;
  /** 显式仓库引用；缺省 "HEAD"（fixture 仓库静态，fingerprint 记录解析后的 SHA）。 */
  repoRev?: string;
  repoId?: string;
  cases: EvalCase[];
}

export function loadBenchmark(scenarioDir: string): Benchmark {
  const file = join(scenarioDir, "benchmark.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Benchmark;
  if (!raw.scenario || !Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`benchmark.json 非法（缺 scenario 或 cases 为空）：${file}`);
  }
  const ids = new Set<string>();
  for (const c of raw.cases) {
    if (!c.id || !c.question || !c.gold?.answer || !Array.isArray(c.gold?.evidence)) {
      throw new Error(`case 非法（缺 id/question/gold.answer/gold.evidence）：${JSON.stringify(c.id ?? c)}`);
    }
    if (ids.has(c.id)) throw new Error(`case id 重复：${c.id}`);
    ids.add(c.id);
  }
  return raw;
}

/** 场景材料目录：benchmark 覆盖优先，否则场景目录下的 logs/repo。 */
export function resolveMaterialDirs(benchmark: Benchmark, scenarioDir: string, projectRoot: string): { logsDir: string; repoDir: string } {
  const logsDir = benchmark.logsDir ? resolve(projectRoot, benchmark.logsDir) : join(scenarioDir, "logs");
  const repoDir = benchmark.repoDir ? resolve(projectRoot, benchmark.repoDir) : join(scenarioDir, "repo");
  return { logsDir, repoDir };
}
