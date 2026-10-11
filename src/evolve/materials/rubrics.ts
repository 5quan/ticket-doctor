// 自改进方案交付 A：首批三例的**暂定**私有 rubric（§7.2）。
//
// 全部由 AI 依据 RootCauseBench oracle 与公开告警字段起草，review.provisional=true；
// 未经人工复核，不得作为质量结论或发布门禁。rubric 只引用公开材料中可见的证据，
// 不要求 Agent 猜私有 commit / diff（首期日志-only，codeVersionEvaluation=n/a）。

import type { LogLocatorV2, RoundTruthV2 } from "../../eval/lf/internals/types.ts";

export interface BootstrapCaseSpec {
  caseId: string;
  familyId: string;
  split: "train" | "validation" | "holdout";
  /** 该例公开日志里出现过的全部服务（本轮可查询白名单）。 */
  services: string[];
  /** 只读日志能达到的判断深度。 */
  allowedClaimDepth: "symptom" | "direct" | "root";
  rootCauseRef: string;
  rootCauseText: string;
  locators: LogLocatorV2[];
  round: Omit<RoundTruthV2, "roundId">;
  /** 制作侧说明（不进 Agent 输入）。 */
  notes: string;
}

const SPEC_001: BootstrapCaseSpec = {
  caseId: "rcb-001",
  familyId: "optional-field-dereference",
  split: "train",
  services: ["checkoutservice", "frontend", "paymentservice"],
  allowedClaimDepth: "direct",
  rootCauseRef: "root-cause.md",
  rootCauseText: [
    "# rcb-001 制作侧根因（私有）",
    "",
    "场景：payment-nil-deref-panic。paymentservice 的 charge 路径解引用一个可选的 3DS 字段而未做空值保护，",
    "每次扣款 panic，5xx 比例飙升；checkoutservice、frontend 是下游受害者（收到上游 500）。",
    "修复方式：回滚。",
    "",
    "注意：本案例为公开模拟材料，应用内 commit 为虚构替身；日志-only 只能判到直接原因，不能核验代码 SHA。",
  ].join("\n"),
  locators: [
    {
      kind: "log",
      locatorId: "loc-pay-panic",
      keyContent: "panic: runtime error: invalid memory address or nil pointer dereference",
      level: "ERROR",
      fileName: "paymentservice.log",
    },
    {
      kind: "log",
      locatorId: "loc-ck-downstream",
      keyContent: "payment call failed: upstream 500 from paymentservice",
      level: "ERROR",
      fileName: "checkoutservice.log",
    },
  ],
  round: {
    allowedOutcomes: ["report", "clarify"],
    allowedClaimDepth: "direct",
    requiredFacts: [
      {
        factId: "fact-pay-panic",
        concepts: [
          ["panic", "nil pointer", "nil deref", "空指针", "崩溃"],
          ["paymentservice", "payment service", "支付服务"],
        ],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
    ],
    forbiddenRules: [
      {
        // 把下游受害者当成**已支持**根因（checkoutservice/frontend 只是收到上游 500）。
        // 仅看 supported 假设：candidate/低置信不算肯定断言。
        ruleId: "forbid-downstream-root",
        where: ["hypotheses"],
        assertAnyOf: [["checkoutservice", "frontend", "checkout service"], ["root cause", "根因", "根本原因", "问题出在", "故障源"]],
        onlyWhenStatus: "supported",
      },
    ],
    forbiddenAssertions: ["不得仅凭 checkoutservice 的 500 就断言 checkoutservice 自身代码是根因。"],
    acceptableClaims: ["paymentservice charge 路径空指针 panic；下游 checkout/frontend 报上游 500。"],
    materialNeeds: [],
    evidenceRequirements: [
      {
        requirementId: "req-pay-panic",
        depth: "direct",
        supportsAnyOf: [{ allOf: ["loc-pay-panic"] }],
      },
    ],
    contradictedClaims: [],
    writebackRequirements: [{ reqId: "wb-pay-panic", concepts: [["paymentservice", "payment"], ["panic", "nil", "空指针"]] }],
  },
  notes: "首轮材料充分（含 panic 与下游 500 日志）。decoy 不在公开材料内。",
};

const SPEC_004: BootstrapCaseSpec = {
  caseId: "rcb-004",
  familyId: "shared-auth-library",
  split: "train",
  services: ["gatewayservice", "orderservice", "paymentservice", "userservice"],
  allowedClaimDepth: "direct",
  rootCauseRef: "root-cause.md",
  rootCauseText: [
    "# rcb-004 制作侧根因（私有）",
    "",
    "场景：auth-jwt-validation-regression。共享认证库删除 clock-skew leeway（120s），",
    "临近过期/时钟偏移的合法 token 被判 expired，凡是引用该库的服务同时 401——",
    "edge 是 gatewayservice，userservice/orderservice/paymentservice 同因受害。",
    "诱饵：gateway_strict_audience_check 开关（10:10 翻转，但拒绝原因是 expiry 不是 audience）；",
    "以及只改 401 响应体、未部署的中间件改动。修复方式：回滚。",
  ].join("\n"),
  locators: [
    { kind: "log", locatorId: "loc-gw-expired", keyContent: "jwt validation failed: token is expired", level: "WARN", fileName: "gatewayservice.log" },
    { kind: "log", locatorId: "loc-user-expired", keyContent: "jwt validation failed: token is expired", level: "WARN", fileName: "userservice.log" },
    { kind: "log", locatorId: "loc-order-expired", keyContent: "jwt validation failed: token is expired", level: "WARN", fileName: "orderservice.log" },
    { kind: "log", locatorId: "loc-pay-expired", keyContent: "jwt validation failed: token is expired", level: "WARN", fileName: "paymentservice.log" },
    { kind: "log", locatorId: "loc-flag-audience", keyContent: "gateway_strict_audience_check", fileName: "gatewayservice.log" },
  ],
  round: {
    allowedOutcomes: ["report", "clarify"],
    allowedClaimDepth: "direct",
    requiredFacts: [
      {
        factId: "fact-token-expired",
        concepts: [["token is expired", "expired token", "expired", "token 过期", "令牌过期", "过期"], ["jwt", "token", "令牌", "认证"]],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
      {
        factId: "fact-multi-service",
        concepts: [
          ["多个服务", "多处", "跨服务", "同时", "各服务", "每个服务", "所有服务", "全部服务", "共同", "一致", "all services", "across services", "multiple services", "several services", "shared"],
          ["jwt", "token", "auth", "认证", "校验"],
        ],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
    ],
    forbiddenRules: [
      {
        // 把 audience 开关当**已支持**根因（拒绝原因是 expiry，不是 audience；candidate/不确定不算）。
        ruleId: "forbid-audience-root",
        where: ["hypotheses"],
        assertAnyOf: [["strict_audience", "audience", "受众"], ["root cause", "根因", "根本原因", "问题出在", "故障源"]],
        onlyWhenStatus: "supported",
      },
    ],
    forbiddenAssertions: ["不得只凭 gatewayservice 单服务的日志把根因归给 gateway 自身的中间件；多服务同时过期指向共享校验逻辑。"],
    acceptableClaims: ["多个服务同时出现 jwt token is expired；共享/统一校验逻辑的过期判定过严是直接原因。"],
    materialNeeds: [],
    evidenceRequirements: [
      { requirementId: "req-cross-service", depth: "direct", supportsAnyOf: [{ allOf: ["loc-gw-expired", "loc-user-expired"] }] },
      { requirementId: "req-edge-expiry", depth: "direct", supportsAnyOf: [{ allOf: ["loc-gw-expired"] }] },
    ],
    contradictedClaims: [],
    writebackRequirements: [{ reqId: "wb-expired", concepts: [["expired", "过期"], ["jwt", "token"]] }],
  },
  notes: "多服务同时 401 是本例的关键；audience 开关是诱饵。仅日志不足以核验共享库 commit。",
};

const SPEC_007: BootstrapCaseSpec = {
  caseId: "rcb-007",
  familyId: "schema-migration",
  split: "validation",
  services: ["dashboard-svc"],
  allowedClaimDepth: "direct",
  rootCauseRef: "root-cause.md",
  rootCauseText: [
    "# rcb-007 制作侧根因（私有）",
    "",
    "场景：dashboard-db-schema-missing-table。新 favorites 端点引用 SELECT ... FROM dashboard_favorites，",
    "但未随部署带上建表迁移，首次请求即 sqlalchemy ProgrammingError: relation does not exist，",
    "dashboard-svc 5xx 上升。诱饵：30s 后同服务的纯前端主题改动（theme.ts），不产生 DB relation 错误。",
    "修复方式：补发迁移（roll-forward）。",
  ].join("\n"),
  locators: [
    {
      kind: "log",
      locatorId: "loc-missing-relation",
      keyContent: 'relation "dashboard_favorites" does not exist',
      level: "ERROR",
      fileName: "dashboard-svc.log",
    },
  ],
  round: {
    allowedOutcomes: ["report", "clarify"],
    allowedClaimDepth: "direct",
    requiredFacts: [
      {
        factId: "fact-missing-relation",
        concepts: [["dashboard_favorites"], ["does not exist", "不存在", "relation", "关系", "表"]],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
    ],
    forbiddenRules: [
      {
        // 把纯前端主题改动当根因。
        ruleId: "forbid-frontend-theme-root",
        where: ["summary", "confirmedFacts", "hypotheses"],
        assertAnyOf: [["palette", "theme", "css", "前端主题", "颜色"], ["root cause", "根因", "根本原因", "问题出在", "故障源"]],
      },
    ],
    forbiddenAssertions: ["不得断言 dashboard_favorites 表存在；错误明确是 relation does not exist。"],
    acceptableClaims: ["dashboard-svc 查询 dashboard_favorites 时关系不存在，疑似缺少建表迁移。"],
    materialNeeds: [],
    evidenceRequirements: [
      { requirementId: "req-missing-relation", depth: "direct", supportsAnyOf: [{ allOf: ["loc-missing-relation"] }] },
    ],
    contradictedClaims: [],
    writebackRequirements: [{ reqId: "wb-relation", concepts: [["dashboard_favorites"], ["不存在", "does not exist", "迁移"]] }],
  },
  notes: "validation 例：验证流程用；前端主题诱饵不要求 Agent 看见部署材料。",
};

const SPEC_002: BootstrapCaseSpec = {
  caseId: "rcb-002",
  familyId: "n-plus-one",
  split: "train",
  services: ["cartservice", "checkoutservice", "frontend", "paymentservice", "productcatalogservice"],
  allowedClaimDepth: "direct",
  rootCauseRef: "root-cause.md",
  rootCauseText: [
    "# rcb-002 制作侧根因（私有）",
    "",
    "场景：checkout-latency-n-plus-one。PlaceOrder 循环内新增按行 catalog 查询",
    "（SELECT * FROM catalog_items WHERE sku = $1），每请求 ~40+ 条查询，p99 飙升；",
    "cartservice/frontend 为下游受害者，productcatalogservice 是被放大的受害方。",
    "修复方式：回滚。",
  ].join("\n"),
  locators: [
    { kind: "log", locatorId: "loc-checkout-slow", keyContent: "slow request: PlaceOrder exceeded", fileName: "checkoutservice.log" },
    { kind: "log", locatorId: "loc-catalog-select", keyContent: "SELECT * FROM catalog_items WHERE sku", fileName: "checkoutservice.log" },
    { kind: "log", locatorId: "loc-cart-upstream", keyContent: "upstream checkoutservice slow", fileName: "cartservice.log" },
  ],
  round: {
    allowedOutcomes: ["report", "clarify"],
    allowedClaimDepth: "direct",
    requiredFacts: [
      {
        factId: "fact-nplus-one",
        concepts: [["SELECT * FROM catalog_items", "catalog_items", "N+1", "n+1", "按行", "逐条", "循环查询", "per-item", "per-line"], ["checkoutservice", "PlaceOrder", "下单"]],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
      {
        factId: "fact-placeorder-slow",
        concepts: [["slow request", "exceeded", "慢请求", "延迟", "超时"], ["checkoutservice", "PlaceOrder"]],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
    ],
    forbiddenRules: [
      { ruleId: "forbid-catalog-root", where: ["hypotheses"], assertAnyOf: [["productcatalogservice", "productcatalog", "catalog service"], ["root cause", "根因", "根本原因", "问题出在"]], onlyWhenStatus: "supported" },
      { ruleId: "forbid-cart-root", where: ["hypotheses"], assertAnyOf: [["cartservice", "cart service"], ["root cause", "根因", "根本原因"]], onlyWhenStatus: "supported" },
    ],
    forbiddenAssertions: ["不得把下游 cartservice/productcatalogservice 当成根因。"],
    acceptableClaims: ["PlaceOrder 在循环内对 catalog 逐条查询（N+1），导致 p99 上升。"],
    materialNeeds: [],
    evidenceRequirements: [
      { requirementId: "req-placeorder-slow", depth: "direct", supportsAnyOf: [{ allOf: ["loc-checkout-slow"] }] },
      { requirementId: "req-nplus-one", depth: "direct", supportsAnyOf: [{ allOf: ["loc-catalog-select"] }] },
    ],
    contradictedClaims: [],
    writebackRequirements: [{ reqId: "wb-nplus-one", concepts: [["catalog_items", "N+1", "逐条", "按行"], ["checkoutservice", "PlaceOrder"]] }],
  },
  notes: "N+1 查询：catalog_items SELECT 在日志中大量重复。productcatalog 是受害方。",
};

const SPEC_003: BootstrapCaseSpec = {
  caseId: "rcb-003",
  familyId: "connection-pool",
  split: "train",
  services: ["cartservice", "frontend", "inventoryservice", "orderservice", "shippingservice"],
  allowedClaimDepth: "direct",
  rootCauseRef: "root-cause.md",
  rootCauseText: [
    "# rcb-003 制作侧根因（私有）",
    "",
    "场景：inventory-connection-pool-exhaustion。共享 db 库把默认连接上限 50 降到 10，",
    "inherits 该默认的 inventoryservice 池很快饱和，acquire 超时；cart/shipping 等上游被拖累。",
    "修复方式：回滚共享库。",
  ].join("\n"),
  locators: [
    { kind: "log", locatorId: "loc-inv-pool-exhausted", keyContent: "pgx pool: context deadline exceeded acquiring connection", fileName: "inventoryservice.log" },
    { kind: "log", locatorId: "loc-inv-pool-wait", keyContent: "pgx pool: waited", fileName: "inventoryservice.log" },
    { kind: "log", locatorId: "loc-inv-upstream", keyContent: "upstream inventoryservice timeout", fileName: "cartservice.log" },
  ],
  round: {
    allowedOutcomes: ["report", "clarify"],
    allowedClaimDepth: "direct",
    requiredFacts: [
      {
        factId: "fact-pool-exhausted",
        concepts: [["pool exhausted", "连接池", "pool", "acquire", "获取连接", "耗尽", "饱和"], ["inventoryservice", "数据库", "db", "pgx"]],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
    ],
    forbiddenRules: [
      { ruleId: "forbid-upstream-root", where: ["hypotheses"], assertAnyOf: [["cartservice", "shippingservice", "shipping service"], ["root cause", "根因", "根本原因", "问题出在"]], onlyWhenStatus: "supported" },
    ],
    forbiddenAssertions: ["不得把上游 cartservice/shippingservice 的超时当成根因（它们是受害者）。"],
    acceptableClaims: ["inventoryservice 的数据库连接池耗尽，acquire 超时，拖累上游。"],
    materialNeeds: [],
    evidenceRequirements: [
      { requirementId: "req-pool-exhausted", depth: "direct", supportsAnyOf: [{ allOf: ["loc-inv-pool-exhausted"] }] },
      { requirementId: "req-upstream-timeout", depth: "direct", supportsAnyOf: [{ allOf: ["loc-inv-upstream"] }] },
    ],
    contradictedClaims: [],
    writebackRequirements: [{ reqId: "wb-pool", concepts: [["inventoryservice"], ["连接池", "pool", "acquire", "连接"]] }],
  },
  notes: "池耗尽：pool exhausted / waited 在 inventoryservice 日志大量出现。",
};

const SPEC_005: BootstrapCaseSpec = {
  caseId: "rcb-005",
  familyId: "memory-leak",
  split: "validation",
  services: ["adservice", "frontend", "productcatalogservice", "recommendationservice"],
  allowedClaimDepth: "direct",
  rootCauseRef: "root-cause.md",
  rootCauseText: [
    "# rcb-005 制作侧根因（私有）",
    "",
    "场景：recommendation-memory-leak。每次 Score() 向包级 slice 追加记录且无上限/淘汰，",
    "RSS 持续增长至超限 OOMKilled；frontend 只是推荐位不可用的受害者。",
    "修复方式：回滚。",
  ].join("\n"),
  locators: [
    { kind: "log", locatorId: "loc-oom", keyContent: "OOMKilled", fileName: "recommendationservice.log" },
    { kind: "log", locatorId: "loc-gc-growth", keyContent: "heap growing, forced GC did not reclaim", fileName: "recommendationservice.log" },
    { kind: "log", locatorId: "loc-frontend-rail", keyContent: "recommendation rail failed to render", fileName: "frontend.log" },
  ],
  round: {
    allowedOutcomes: ["report", "clarify"],
    allowedClaimDepth: "direct",
    requiredFacts: [
      {
        factId: "fact-oom",
        concepts: [["OOMKilled", "memory limit", "内存", "RSS", "oom"], ["recommendationservice", "推荐"]],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
      {
        factId: "fact-gc-growth",
        concepts: [["heap growing", "forced GC", "GC pause", "未回收", "增长", "泄漏", "leak"], ["recommendationservice", "内存", "heap"]],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
    ],
    forbiddenRules: [
      { ruleId: "forbid-frontend-root", where: ["hypotheses"], assertAnyOf: [["frontend"], ["root cause", "根因", "根本原因", "问题出在"]], onlyWhenStatus: "supported" },
    ],
    forbiddenAssertions: ["不得把 frontend 推荐位渲染失败当成根因（它是受害者）。"],
    acceptableClaims: ["recommendationservice 内存持续增长、GC 无法回收，超限被 OOMKilled。"],
    materialNeeds: [],
    evidenceRequirements: [
      { requirementId: "req-oom", depth: "direct", supportsAnyOf: [{ allOf: ["loc-oom"] }] },
      { requirementId: "req-gc-growth", depth: "direct", supportsAnyOf: [{ allOf: ["loc-gc-growth"] }] },
    ],
    contradictedClaims: [],
    writebackRequirements: [{ reqId: "wb-memory", concepts: [["recommendationservice"], ["内存", "OOM", "泄漏", "GC"]] }],
  },
  notes: "延迟发作型内存泄漏：RSS/GC 证据可见；最近一次部署不一定是原因（仅日志时不可判）。",
};

const SPEC_006: BootstrapCaseSpec = {
  caseId: "rcb-006",
  familyId: "grpc-deadline",
  split: "validation",
  services: ["cartservice", "frontend", "paymentservice", "productcatalogservice", "recommendationservice"],
  allowedClaimDepth: "direct",
  rootCauseRef: "root-cause.md",
  rootCauseText: [
    "# rcb-006 制作侧根因（私有）",
    "",
    "场景：grpc-deadline-too-tight。catalog 调用的客户端 deadline 从 5s 收紧到 300ms，",
    "低于 catalog 正常 p99（~400ms），导致 DeadlineExceeded；productcatalogservice 因客户端提前取消",
    "而记录 CANCELLED，是被打断的一方而非变慢的一方。frontend 为下游受害者。修复：回滚。",
  ].join("\n"),
  locators: [
    { kind: "log", locatorId: "loc-reco-deadline", keyContent: "catalog Fetch failed: rpc error: code = DeadlineExceeded", fileName: "recommendationservice.log" },
    { kind: "log", locatorId: "loc-catalog-cancel", keyContent: "context canceled by client before completion", fileName: "productcatalogservice.log" },
    { kind: "log", locatorId: "loc-frontend-rail", keyContent: "recommendation rail unavailable", fileName: "frontend.log" },
  ],
  round: {
    allowedOutcomes: ["report", "clarify"],
    allowedClaimDepth: "direct",
    requiredFacts: [
      {
        factId: "fact-deadline",
        concepts: [["DeadlineExceeded", "deadline exceeded", "deadline", "截止时间", "超时"], ["recommendationservice", "catalog", "推荐"]],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
      {
        factId: "fact-catalog-victim",
        concepts: [["context canceled by client", "canceled", "cancelled", "取消"], ["productcatalogservice", "catalog"]],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
    ],
    forbiddenRules: [
      { ruleId: "forbid-catalog-root", where: ["hypotheses"], assertAnyOf: [["productcatalogservice", "productcatalog", "catalog service"], ["root cause", "根因", "根本原因", "问题出在", "变慢"]], onlyWhenStatus: "supported" },
    ],
    forbiddenAssertions: ["不得把 productcatalogservice 当成根因（它没有变慢，是被调用方提前取消）。"],
    acceptableClaims: ["recommendationservice 调 catalog 命中 DeadlineExceeded；catalog 的 cancel 是被提前取消。"],
    materialNeeds: [],
    evidenceRequirements: [
      { requirementId: "req-reco-deadline", depth: "direct", supportsAnyOf: [{ allOf: ["loc-reco-deadline"] }] },
      { requirementId: "req-catalog-cancel", depth: "direct", supportsAnyOf: [{ allOf: ["loc-catalog-cancel"] }] },
    ],
    contradictedClaims: [],
    writebackRequirements: [{ reqId: "wb-deadline", concepts: [["recommendationservice", "catalog"], ["DeadlineExceeded", "deadline", "超时"]] }],
  },
  notes: "预算过紧：调用方 DeadlineExceeded，被调方 CANCELLED；被调方并非变慢。",
};

const SPEC_008: BootstrapCaseSpec = {
  caseId: "rcb-008",
  familyId: "poison-record",
  split: "holdout",
  services: ["billing-api", "partner-gateway", "payment-refund-svc"],
  allowedClaimDepth: "direct",
  rootCauseRef: "root-cause.md",
  rootCauseText: [
    "# rcb-008 制作侧根因（私有，holdout）",
    "",
    "场景：payment-refund-poison-batch。伙伴批里一条非法记录（currency=XBT、amount 非十进制）被",
    "validator 正确拒绝；消费端无 DLQ，同一条记录无限重投，backlog 上涨；billing-api 轮询超时是受害方。",
    "根因是数据记录，不是任何 commit（root_cause_commit=none）。修复：补 DLQ/跳过隔离。",
  ].join("\n"),
  locators: [
    { kind: "log", locatorId: "loc-invalid-currency", keyContent: "invalid currency code", fileName: "payment-refund-svc.log" },
    { kind: "log", locatorId: "loc-redelivery", keyContent: "redelivery of message offset", fileName: "payment-refund-svc.log" },
    { kind: "log", locatorId: "loc-billing-poll", keyContent: "refund status poll timed out", fileName: "billing-api.log" },
  ],
  round: {
    allowedOutcomes: ["report", "clarify"],
    allowedClaimDepth: "direct",
    requiredFacts: [
      {
        factId: "fact-poison-record",
        concepts: [["invalid currency", "currency code", "XBT", "币种", "货币"], ["refund", "rfnd", "退款"]],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
      {
        factId: "fact-redelivery",
        concepts: [["redelivery", "stalled", "重投", "重复", "offset", "积压", "backlog"], ["consumer", "refund", "消费", "退款"]],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
    ],
    forbiddenRules: [
      { ruleId: "forbid-billing-root", where: ["hypotheses"], assertAnyOf: [["billing-api", "billing"], ["root cause", "根因", "根本原因", "问题出在"]], onlyWhenStatus: "supported" },
    ],
    forbiddenAssertions: ["不得把 billing-api 轮询超时当根因（它是受害方）。"],
    acceptableClaims: ["一条非法退款记录被拒后无 DLQ、同一条无限重投，消费停滞；billing-api 轮询超时是连带。"],
    materialNeeds: [],
    evidenceRequirements: [
      { requirementId: "req-poison", depth: "direct", supportsAnyOf: [{ allOf: ["loc-invalid-currency", "loc-redelivery"] }] },
    ],
    contradictedClaims: [],
    writebackRequirements: [{ reqId: "wb-poison", concepts: [["refund", "退款"], ["redelivery", "invalid currency", "stalled", "重投"]] }],
  },
  notes: "holdout：无代码原因的弃权陷阱（根因是数据记录）。不纳入搜索，留最终验收。",
};

const SPEC_009: BootstrapCaseSpec = {
  caseId: "rcb-009",
  familyId: "tls-cert",
  split: "holdout",
  services: ["checkoutservice", "frontend", "orderservice", "paymentservice", "productcatalogservice"],
  allowedClaimDepth: "direct",
  rootCauseRef: "root-cause.md",
  rootCauseText: [
    "# rcb-009 制作侧根因（私有，holdout）",
    "",
    "场景：tls-cert-expiry。paymentservice 服务端叶证书于 15:04 过期，orderservice->paymentservice",
    "mTLS 握手失败（x509 expired），orderservice 返回 502，checkout/frontend 连带；",
    "paymentservice 本身健康。根因是运维证书，不是 commit（root_cause_commit=none）。修复：轮换证书。",
  ].join("\n"),
  locators: [
    { kind: "log", locatorId: "loc-tls-expired", keyContent: "x509: certificate has expired or is not yet valid", fileName: "orderservice.log" },
    { kind: "log", locatorId: "loc-cert-dates", keyContent: "notAfter=2026-06-18T15:04:00Z", fileName: "orderservice.log" },
    { kind: "log", locatorId: "loc-checkout-502", keyContent: "upstream orderservice returned 502", fileName: "checkoutservice.log" },
  ],
  round: {
    allowedOutcomes: ["report", "clarify"],
    allowedClaimDepth: "direct",
    requiredFacts: [
      {
        factId: "fact-cert-expired",
        concepts: [["certificate has expired", "x509", "证书", "过期", "expired"], ["paymentservice", "tls", "TLS"]],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
      {
        factId: "fact-victim-chain",
        concepts: [["502", "propagating", "下游", "连带"], ["checkoutservice", "orderservice"]],
        where: ["summary", "confirmedFacts", "hypotheses"],
      },
    ],
    forbiddenRules: [
      { ruleId: "forbid-checkout-root", where: ["hypotheses"], assertAnyOf: [["checkoutservice"], ["root cause", "根因", "根本原因", "问题出在"]], onlyWhenStatus: "supported" },
    ],
    forbiddenAssertions: ["不得把 checkoutservice 的 502 当根因（它是下游）。"],
    acceptableClaims: ["paymentservice 服务端证书过期导致 mTLS 握手失败，orderservice 502，checkout/frontend 连带。"],
    materialNeeds: [],
    evidenceRequirements: [
      { requirementId: "req-cert-expired", depth: "direct", supportsAnyOf: [{ allOf: ["loc-tls-expired"] }] },
      { requirementId: "req-victim-chain", depth: "direct", supportsAnyOf: [{ allOf: ["loc-checkout-502"] }] },
    ],
    contradictedClaims: [],
    writebackRequirements: [{ reqId: "wb-cert", concepts: [["paymentservice", "certificate", "证书", "tls"], ["expired", "过期"]] }],
  },
  notes: "holdout：无代码原因的运维问题（证书过期）。不纳入搜索，留最终验收。",
};

export const FIRST_BATCH_SPECS: BootstrapCaseSpec[] = [SPEC_001, SPEC_004, SPEC_007];

export const BOOTSTRAP_SPECS: BootstrapCaseSpec[] = [SPEC_001, SPEC_004, SPEC_007, SPEC_002, SPEC_003, SPEC_005, SPEC_006, SPEC_008, SPEC_009];

export function bootstrapSpec(caseId: string): BootstrapCaseSpec | undefined {
  return BOOTSTRAP_SPECS.find((s) => s.caseId === caseId);
}
