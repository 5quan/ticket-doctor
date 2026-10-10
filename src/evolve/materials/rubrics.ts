// 自改进方案交付 A：首批三例的**暂定**私有 rubric（§7.2）。
//
// 全部由 AI 依据 RootCauseBench oracle 与公开告警字段起草，review.provisional=true；
// 未经人工复核，不得作为质量结论或发布门禁。rubric 只引用公开材料中可见的证据，
// 不要求 Agent 猜私有 commit / diff（首期日志-only，codeVersionEvaluation=n/a）。

import type { LogLocatorV2, RoundTruthV2 } from "../../eval/lf/internals/types.ts";

export interface BootstrapCaseSpec {
  caseId: string;
  familyId: string;
  split: "train" | "validation";
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
        // 把下游受害者当成根因（checkoutservice/frontend 只是收到上游 500）。
        ruleId: "forbid-downstream-root",
        where: ["summary", "confirmedFacts", "hypotheses"],
        assertAnyOf: [["checkoutservice", "frontend", "checkout service"], ["root cause", "根因", "根本原因", "问题出在", "故障源"]],
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
        // 把 audience 开关当根因（拒绝原因是 expiry，不是 audience）。
        ruleId: "forbid-audience-root",
        where: ["summary", "confirmedFacts", "hypotheses"],
        assertAnyOf: [["strict_audience", "audience", "受众"], ["root cause", "根因", "根本原因", "问题出在", "故障源"]],
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

export const BOOTSTRAP_SPECS: BootstrapCaseSpec[] = [SPEC_001, SPEC_004, SPEC_007];

export function bootstrapSpec(caseId: string): BootstrapCaseSpec | undefined {
  return BOOTSTRAP_SPECS.find((s) => s.caseId === caseId);
}
