// 工程自测 case 生成器（方案 §3.5 "工程自测" 车道 / §12.2 交付 3）。
//
// 这些 case 全部是 synthetic_engineering：材料合成、脚本引擎驱动，只用于验证
// harness/可见性/评分/隔离/回写工程能力，不用于声称真实诊断质量。
// data/ 在 .gitignore 中，因此用代码生成器落盘，保证可重建、可复现。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseDescriptorV2, TruthFileV2 } from "./types.ts";

const T0 = Date.parse("2026-09-06T10:00:00+08:00");
const REPO_DIR = "fixtures/evals/checkout-timeout/repo";

const REDIS_WARN_LINES = [
  "2026-09-06T10:01:57.900+08:00\tWARN\tRedisPool 连接池使用率 92% pool=checkout-cache active=46/50",
  "2026-09-06T10:01:58.310+08:00\tWARN\tRedisPool 获取连接超时(2000ms) pool=checkout-cache active=50/50 等待队列=7",
  "2026-09-06T10:01:59.700+08:00\tWARN\tRedisPool 获取连接超时(2000ms) pool=checkout-cache active=50/50 等待队列=12",
];

const FULL_CHECKOUT_LOG = [
  "2026-09-06T09:58:12.100+08:00\tINFO\tOrderController 接收下单请求 orderId=ord_88090 userId=u_3092",
  ...REDIS_WARN_LINES,
  "2026-09-06T10:01:58.312+08:00\tERROR\tInventoryClient 调用库存服务失败 timeout after 3000ms traceId=tr_9f2c81",
  "2026-09-06T10:01:58.700+08:00\tWARN\tRedisPool 获取连接超时(2000ms) pool=checkout-cache active=50/50 等待队列=12",
  "2026-09-06T10:01:59.001+08:00\tERROR\tOrderController 下单接口返回 500 orderId=ord_88121 traceId=tr_9f2c81",
  "2026-09-06T10:02:20.000+08:00\tINFO\tHealthCheck /actuator/health status=UP",
].join("\n");

const WARN_ONLY_LOG = [
  "2026-09-06T09:58:12.100+08:00\tINFO\tOrderController 接收下单请求 orderId=ord_88090 userId=u_3092",
  ...REDIS_WARN_LINES,
  "2026-09-06T10:02:20.000+08:00\tINFO\tHealthCheck /actuator/health status=UP",
].join("\n");

function pad(n: number, len: number): string {
  return `${n}`.padEnd(len, "x");
}

function bigLog(): string {
  const lines: string[] = [];
  for (let i = 0; i < 22; i++) {
    const t = new Date(T0 + i * 1000).toISOString();
    const gold = i === 2 ? " GOLD-TRUNCATION-MARKER-XYZ" : "";
    lines.push(`${t}\tWARN\tbig-service slow call seq=${i} payload=${pad(i, 330)}${gold}`);
  }
  return lines.join("\n");
}

function repoSha(projectRoot: string): string | undefined {
  try {
    return execFileSync("git", ["-C", join(projectRoot, REPO_DIR), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

interface CaseBuild {
  caseId: string;
  caseDesc: Omit<CaseDescriptorV2, "schemaVersion">;
  messages: Record<string, string>;
  /** 相对 case 公开目录的文件 → 内容（扁平表）。 */
  materials: Record<string, string>;
  truth: TruthFileV2;
  script?: unknown[];
}

const BENCH_REPOS = (sha?: string) => [{ repoId: "app", dir: REPO_DIR, ...(sha ? { expectedSha: sha } : {}) }];

export function engineeringCaseBuilds(projectRoot: string): CaseBuild[] {
  const sha = repoSha(projectRoot);
  return [
    // ---- eng-clarify：首轮缺关键信息 → 补问 → 补证后限定结论（轨迹 2） ----
    {
      caseId: "eng-clarify",
      caseDesc: {
        caseId: "eng-clarify",
        familyId: "eng-checkout",
        split: "engineering",
        sourceTier: "synthetic_engineering",
        publicBenchmark: false,
        admission: "admitted",
        maxRounds: 3,
        scriptedEngine: true,
        rounds: [
          {
            roundId: "r1",
            messageRef: "r1-message.txt",
            receivedAt: "2026-09-06T10:30:00+08:00",
            occurredAt: null,
            materialView: "round-1",
            services: [],
            repos: BENCH_REPOS(sha),
          },
          {
            roundId: "r2",
            messageRef: "r2-message.txt",
            receivedAt: "2026-09-06T10:35:00+08:00",
            occurredAt: "2026-09-06T10:01:00+08:00",
            materialView: "round-2",
            services: ["checkout-service"],
            repos: BENCH_REPOS(sha),
          },
        ],
      },
      messages: {
        "r1-message.txt": "我们收到一个下单失败的反馈，麻烦帮忙看看是什么原因",
        "r2-message.txt": "补充信息：服务: checkout-service，2026-09-06 10:01 开始大量 500，报错里提到 InventoryClient timeout",
      },
      materials: {
        "round-2/checkout-service.log": FULL_CHECKOUT_LOG,
      },
      truth: {
        schemaVersion: "prediagnosis-truth-v2",
        caseId: "eng-clarify",
        locators: [{ kind: "log", locatorId: "loc-timeout-log", keyContent: "InventoryClient 调用库存服务失败 timeout", level: "ERROR" }],
        rounds: [
          {
            roundId: "r1",
            allowedOutcomes: ["clarify"],
            allowedClaimDepth: "symptom",
            requiredFacts: [],
            forbiddenRules: [
              {
                ruleId: "no-root-guess-without-materials",
                where: ["hypotheses"],
                assertAnyOf: [["库存", "redis", "超时", "timeout"]],
                onlyWhenHypothesisUncited: true,
              },
            ],
            materialNeeds: [{ needId: "incident-details", description: "发生时间与服务名", clarifyConcepts: [["时间", "什么时候"], ["服务", "哪个服务"]] }],
            evidenceRequirements: [],
            contradictedClaims: [],
            writebackRequirements: [],
          },
          {
            roundId: "r2",
            allowedOutcomes: ["report"],
            allowedClaimDepth: "root",
            requiredFacts: [{ factId: "root-cause-timeout", concepts: [["库存"], ["超时", "timeout"]], where: ["summary", "hypotheses"] }],
            forbiddenRules: [],
            materialNeeds: [],
            evidenceRequirements: [{ requirementId: "req-timeout-log", depth: "root", supportsAnyOf: [{ allOf: ["loc-timeout-log"] }] }],
            contradictedClaims: [],
            writebackRequirements: [{ reqId: "wb-root-cause", concepts: [["库存"], ["超时", "timeout"]] }],
          },
        ],
        review: { author: "eval-v2-builder", reviewer: "provisional-self", provisional: true, notes: "工程自测标准，仅验证 harness 行为" },
      },
      script: [
        { kind: "reply", reason: "clarify", text: "需要补充关键信息：故障发生时间、所属服务、报错现象或订单号，我再去查日志取证。" },
        {
          kind: "report",
          tools: [{ tool: "queryLogs", args: { service: "checkout-service", from: T0, to: T0 + 2 * 3600_000, keywords: [] } }],
          draft: {
            completeness: "complete",
            summary: "库存服务调用超时导致下单失败（InventoryClient 3000ms 超时）",
            confirmedFacts: ["InventoryClient 调用库存服务失败 timeout after 3000ms"],
            hypotheses: [{ cause: "库存服务调用超时（InventoryClient 3000ms 超时）导致下单失败", confidence: "high", status: "supported" }],
            uncertainties: [],
            nextSteps: ["与库存服务负责人核对超时配置与容量"],
            missingMaterial: [],
          },
        },
      ],
    },

    // ---- eng-counter-evidence：错误假设 → 有效反证 → 降级并换正确原因（轨迹 4） ----
    {
      caseId: "eng-counter-evidence",
      caseDesc: {
        caseId: "eng-counter-evidence",
        familyId: "eng-checkout",
        split: "engineering",
        sourceTier: "synthetic_engineering",
        publicBenchmark: false,
        admission: "admitted",
        maxRounds: 3,
        scriptedEngine: true,
        rounds: [
          {
            roundId: "r1",
            messageRef: "r1-message.txt",
            receivedAt: "2026-09-06T10:20:00+08:00",
            occurredAt: "2026-09-06T10:01:00+08:00",
            materialView: "round-1",
            services: ["checkout-service"],
            repos: BENCH_REPOS(sha),
          },
          {
            roundId: "r2",
            messageRef: "r2-message.txt",
            receivedAt: "2026-09-06T10:40:00+08:00",
            occurredAt: "2026-09-06T10:01:00+08:00",
            materialView: "round-2",
            services: ["checkout-service"],
            repos: BENCH_REPOS(sha),
          },
        ],
      },
      messages: {
        "r1-message.txt": "checkout-service 服务: 2026-09-06 10:01 开始下单大量失败，是不是 Redis 连接池被打满了？",
        "r2-message.txt": "更正一下背景：库存服务当时其他调用方都正常，Redis 上其他业务也没有受影响。请重新查下单时段的完整日志再下判断。",
      },
      materials: {
        "round-1/checkout-service.log": WARN_ONLY_LOG,
        "round-2/checkout-service.log": FULL_CHECKOUT_LOG,
      },
      truth: {
        schemaVersion: "prediagnosis-truth-v2",
        caseId: "eng-counter-evidence",
        locators: [{ kind: "log", locatorId: "loc-inventory-error", keyContent: "InventoryClient 调用库存服务失败 timeout", level: "ERROR" }],
        rounds: [
          {
            roundId: "r1",
            allowedOutcomes: ["report", "clarify"],
            allowedClaimDepth: "root",
            requiredFacts: [{ factId: "pool-alert", concepts: [["RedisPool", "连接池"]], where: ["summary"] }],
            forbiddenRules: [],
            materialNeeds: [],
            evidenceRequirements: [],
            contradictedClaims: [],
            writebackRequirements: [],
          },
          {
            roundId: "r2",
            allowedOutcomes: ["report"],
            allowedClaimDepth: "root",
            requiredFacts: [{ factId: "inventory-root", concepts: [["库存"], ["超时", "timeout"]], where: ["hypotheses"] }],
            forbiddenRules: [
              {
                ruleId: "redis-no-longer-supported",
                where: ["hypotheses"],
                assertAnyOf: [["redis", "redispool", "连接池"]],
                onlyWhenStatus: "supported",
              },
            ],
            materialNeeds: [],
            evidenceRequirements: [{ requirementId: "req-inventory-error", depth: "root", supportsAnyOf: [{ allOf: ["loc-inventory-error"] }] }],
            contradictedClaims: [{ claimId: "redis-cause", concepts: [["redis", "redispool", "连接池"]], allowCandidate: true }],
            writebackRequirements: [{ reqId: "wb-updated-cause", concepts: [["库存", "inventory"]] }],
          },
        ],
        review: { author: "eval-v2-builder", reviewer: "provisional-self", provisional: true, notes: "工程自测标准，仅验证反证更新行为" },
      },
      script: [
        {
          kind: "report",
          tools: [{ tool: "queryLogs", args: { service: "checkout-service", from: T0, to: T0 + 2 * 3600_000, keywords: [] } }],
          draft: {
            completeness: "complete",
            summary: "RedisPool 连接池告警期间下单失败，疑似连接池打满导致",
            confirmedFacts: ["RedisPool 连接池使用率 92%，出现获取连接超时"],
            hypotheses: [{ cause: "Redis 连接池打满导致下单失败", confidence: "high", status: "supported" }],
            uncertainties: ["库存服务侧情况未知"],
            nextSteps: ["观察连接池恢复情况"],
            missingMaterial: [],
          },
        },
        {
          kind: "report",
          tools: [{ tool: "queryLogs", args: { service: "checkout-service", from: T0, to: T0 + 2 * 3600_000, keywords: [] } }],
          draft: {
            completeness: "complete",
            summary: "根据完整日志与用户新背景，判断为库存服务调用超时导致下单失败；Redis 告警为伴随现象",
            confirmedFacts: ["InventoryClient 调用库存服务失败 timeout after 3000ms", "库存服务其他调用方正常（用户背景）"],
            hypotheses: [
              { cause: "Redis 连接池打满导致下单失败", confidence: "low", status: "candidate" },
              { cause: "库存服务调用超时导致下单失败", confidence: "high", status: "supported" },
            ],
            uncertainties: [],
            nextSteps: ["与库存服务负责人核对容量"],
            missingMaterial: [],
          },
        },
      ],
    },

    // ---- eng-truncation：gold 入库但被渲染预算截断 → B\C1 差距可测（§8/§9.4"入库未返回"） ----
    {
      caseId: "eng-truncation",
      caseDesc: {
        caseId: "eng-truncation",
        familyId: "eng-checkout",
        split: "engineering",
        sourceTier: "synthetic_engineering",
        publicBenchmark: false,
        admission: "admitted",
        maxRounds: 1,
        scriptedEngine: true,
        rounds: [
          {
            roundId: "r1",
            messageRef: "r1-message.txt",
            receivedAt: "2026-09-06T10:30:00+08:00",
            occurredAt: "2026-09-06T10:00:00+08:00",
            materialView: "round-1",
            services: ["big-service"],
            repos: BENCH_REPOS(sha),
          },
        ],
      },
      messages: {
        "r1-message.txt": "big-service 服务: 2026-09-06 10:00 前后接口变慢，帮忙看一下日志",
      },
      materials: {
        "round-1/big-service.log": bigLog(),
      },
      truth: {
        schemaVersion: "prediagnosis-truth-v2",
        caseId: "eng-truncation",
        locators: [{ kind: "log", locatorId: "loc-gold-truncated", keyContent: "GOLD-TRUNCATION-MARKER-XYZ" }],
        rounds: [
          {
            roundId: "r1",
            allowedOutcomes: ["report"],
            allowedClaimDepth: "symptom",
            requiredFacts: [{ factId: "slow", concepts: [["变慢", "接口"]], where: ["summary"] }],
            forbiddenRules: [],
            materialNeeds: [],
            evidenceRequirements: [{ requirementId: "req-gold", depth: "direct", supportsAnyOf: [{ allOf: ["loc-gold-truncated"] }] }],
            contradictedClaims: [],
            writebackRequirements: [],
          },
        ],
        review: { author: "eval-v2-builder", reviewer: "provisional-self", provisional: true, notes: "验证入库≠可见的观测反例" },
      },
      script: [
        {
          kind: "report",
          tools: [{ tool: "queryLogs", args: { service: "big-service", from: T0, to: T0 + 2 * 3600_000, keywords: [] } }],
          draft: {
            completeness: "partial",
            summary: "接口变慢，已取到部分日志；结果被截断，需要缩小时间窗继续读取",
            confirmedFacts: ["日志在时间窗内命中多条慢调用记录"],
            hypotheses: [{ cause: "日志量大被截断，尚未定位具体慢调用", confidence: "low", status: "candidate" }],
            uncertainties: ["截断部分是否包含关键记录"],
            nextSteps: ["缩小时间窗或加关键词重查"],
            missingMaterial: ["完整日志（当前返回被截断）"],
          },
        },
      ],
    },
  ];
}

/** 生成工程自测 case 树到 <evalV2Root>（幂等：覆盖写；catalog 与现有条目合并，不覆盖手工 case）。 */
export function materializeEngineeringCases(projectRoot: string, evalV2Root: string): void {
  const builds = engineeringCaseBuilds(projectRoot);
  for (const build of builds) {
    const publicDir = join(evalV2Root, "public", build.caseId);
    const privateDir = join(evalV2Root, "private", build.caseId);
    mkdirSync(join(evalV2Root, "catalog"), { recursive: true });
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    // 材料视图目录必须存在（含空视图轮），schema 与隔离预检都依赖它。
    for (const round of build.caseDesc.rounds) {
      mkdirSync(join(publicDir, round.materialView), { recursive: true });
    }

    const caseJson: CaseDescriptorV2 = { schemaVersion: "prediagnosis-case-v2", ...build.caseDesc };
    writeFileSync(join(publicDir, "case.json"), JSON.stringify(caseJson, null, 2), "utf8");
    for (const [name, content] of Object.entries(build.messages)) {
      writeFileSync(join(publicDir, name), content, "utf8");
    }
    for (const [rel, content] of Object.entries(build.materials)) {
      const p = join(publicDir, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content, "utf8");
    }
    writeFileSync(join(privateDir, "truth.private.json"), JSON.stringify(build.truth, null, 2), "utf8");
    if (build.script) {
      writeFileSync(join(privateDir, "script.json"), JSON.stringify(build.script, null, 2), "utf8");
    }
  }

  // catalog 合并：工程条目 upsert，已有其他条目（历史 case）保留。
  const catalogPath = join(evalV2Root, "catalog", "catalog.json");
  let existing: Array<{ caseId: string; publicDir: string; privateDir?: string }> = [];
  try {
    existing = (JSON.parse(readFileSync(catalogPath, "utf8")) as { cases?: typeof existing }).cases ?? [];
  } catch {
    existing = [];
  }
  const engEntries = builds.map((b) => ({ caseId: b.caseId, publicDir: `public/${b.caseId}`, privateDir: `private/${b.caseId}` }));
  const merged = [...existing.filter((e) => !engEntries.some((g) => g.caseId === e.caseId)), ...engEntries];
  writeFileSync(catalogPath, JSON.stringify({ schemaVersion: "prediagnosis-catalog-v2", cases: merged }, null, 2), "utf8");
}
