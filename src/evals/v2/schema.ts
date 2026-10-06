// schema：case-v2 / truth-v2 的严格校验（方案 T2）。
//
// 原则：非法字段、假 SHA、缺文件引用、未接纳 case 直接拒绝；不做宽容修补。
// 占位 SHA（全 0 / 重复段）视为非法，防止"占位值运行成正式 case"（方案 §6.2）。
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CaseDescriptorV2, LocatorV2, TruthFileV2 } from "./types.ts";

const SHA_RE = /^[0-9a-f]{40}$/;

export interface SchemaIssue {
  path: string;
  message: string;
}

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** 占位 SHA：全 0、单字符重复、递增序列（abc…）。 */
export function isPlaceholderSha(sha: string): boolean {
  if (/^0+$/.test(sha)) return true;
  if (/^(.)\1{39}$/.test(sha)) return true;
  const hex = "0123456789abcdef";
  const lower = sha.toLowerCase();
  for (let i = 0; i + 7 < 40; i++) {
    const seg = lower.slice(i, i + 8);
    const idx = hex.indexOf(seg[0]);
    if (idx >= 0 && seg === hex.slice(idx, idx + 8)) return true;
  }
  return false;
}

function checkIso(value: unknown, path: string, errors: SchemaIssue[], nullable = false): void {
  if (nullable && value === null) return;
  if (!isStr(value) || Number.isNaN(Date.parse(value))) errors.push({ path, message: "不是合法 ISO 时间" });
}

export function validateCaseDescriptor(
  raw: unknown,
  opts: { caseDir: string; projectRoot: string },
): { ok: true; value: CaseDescriptorV2 } | { ok: false; errors: SchemaIssue[] } {
  const errors: SchemaIssue[] = [];
  const c = raw as CaseDescriptorV2;
  if (!raw || typeof raw !== "object") return { ok: false, errors: [{ path: "", message: "不是对象" }] };
  if (c.schemaVersion !== "prediagnosis-case-v2") {
    errors.push({ path: "schemaVersion", message: `期望 prediagnosis-case-v2，得到 ${String(c.schemaVersion)}` });
  }
  if (!isStr(c.caseId)) errors.push({ path: "caseId", message: "缺失" });
  if (!isStr(c.familyId)) errors.push({ path: "familyId", message: "缺失" });
  if (!["development", "holdout", "engineering"].includes(c.split)) {
    errors.push({ path: "split", message: `非法 split：${String(c.split)}` });
  }
  if (!["synthetic_engineering", "reproduced_history", "verified_snapshot", "from_issue_only"].includes(c.sourceTier)) {
    errors.push({ path: "sourceTier", message: `非法 sourceTier：${String(c.sourceTier)}` });
  }
  if (!["candidate", "qualified", "admitted", "deferred"].includes(c.admission)) {
    errors.push({ path: "admission", message: `非法 admission：${String(c.admission)}` });
  }
  if (typeof c.publicBenchmark !== "boolean") errors.push({ path: "publicBenchmark", message: "必须是 boolean" });
  if (!Number.isInteger(c.maxRounds) || c.maxRounds < 1 || c.maxRounds > 10) {
    errors.push({ path: "maxRounds", message: "必须是 1~10 的整数" });
  }
  if (!Array.isArray(c.rounds) || c.rounds.length === 0) {
    errors.push({ path: "rounds", message: "至少一轮" });
  } else {
    if (c.rounds.length > c.maxRounds) {
      errors.push({ path: "rounds", message: `轮数 ${c.rounds.length} 超过 maxRounds=${c.maxRounds}` });
    }
    const seenRound = new Set<string>();
    c.rounds.forEach((r, i) => {
      if (!isStr(r.roundId)) errors.push({ path: `rounds[${i}].roundId`, message: "缺失" });
      else if (seenRound.has(r.roundId)) errors.push({ path: `rounds[${i}].roundId`, message: "重复" });
      else seenRound.add(r.roundId);
      if (!isStr(r.messageRef) || !existsSync(join(opts.caseDir, r.messageRef))) {
        errors.push({ path: `rounds[${i}].messageRef`, message: `消息文件不存在：${String(r.messageRef)}` });
      }
      checkIso(r.receivedAt, `rounds[${i}].receivedAt`, errors);
      checkIso(r.occurredAt, `rounds[${i}].occurredAt`, errors, true);
      if (!isStr(r.materialView) || !existsSync(join(opts.caseDir, r.materialView))) {
        errors.push({ path: `rounds[${i}].materialView`, message: `材料视图目录不存在：${String(r.materialView)}` });
      }
      if (!Array.isArray(r.services)) errors.push({ path: `rounds[${i}].services`, message: "必须是数组" });
      if (!Array.isArray(r.repos)) {
        errors.push({ path: `rounds[${i}].repos`, message: "必须是数组" });
      } else if (r.repos.length === 0 && c.sourceTier !== "reproduced_history") {
        // log-only 真实案例（RCAEval 等）允许无代码绑定；其余拆分仍要求至少一个仓库。
        errors.push({ path: `rounds[${i}].repos`, message: "至少一个仓库（log-only 仅允许 sourceTier=reproduced_history）" });
      } else {
        r.repos.forEach((repo, j) => {
          if (!isStr(repo.repoId)) errors.push({ path: `rounds[${i}].repos[${j}].repoId`, message: "缺失" });
          if (repo.expectedSha !== undefined) {
            if (!SHA_RE.test(repo.expectedSha) || isPlaceholderSha(repo.expectedSha)) {
              errors.push({ path: `rounds[${i}].repos[${j}].expectedSha`, message: "非完整 SHA 或占位值" });
            }
          }
          const dir = resolve(opts.projectRoot, repo.dir);
          if (!isStr(repo.dir) || !existsSync(dir)) {
            errors.push({ path: `rounds[${i}].repos[${j}].dir`, message: `仓库目录不存在：${String(repo.dir)}` });
          }
          if (c.split !== "engineering" && !repo.expectedSha) {
            errors.push({
              path: `rounds[${i}].repos[${j}].expectedSha`,
              message: "正式 case（非 engineering）每轮仓库必须声明完整 expectedSha——读取前核验的依据，缺省即拒绝运行",
            });
          }
        });
      }
    });
  }
  if (c.scriptedEngine && c.split !== "engineering") {
    errors.push({ path: "scriptedEngine", message: "脚本引擎只允许 engineering 拆分使用" });
  }
  if (c.split === "engineering" && c.sourceTier !== "synthetic_engineering") {
    errors.push({ path: "sourceTier", message: "engineering 拆分必须是 synthetic_engineering 来源" });
  }
  if (c.split !== "engineering" && c.admission !== "admitted") {
    // 非工程拆分必须走准入门槛；candidate/deferred 允许加载但只能用于制作侧（由调用方约束）。
    errors.push({
      path: "admission",
      message: `split=${c.split} 的 case 必须 admitted 才能进入评测运行（当前 ${String(c.admission)}）`,
    });
  }
  return errors.length === 0 ? { ok: true, value: c } : { ok: false, errors };
}

export function validateTruth(
  raw: unknown,
  opts: { caseId: string; privateDir: string },
): { ok: true; value: TruthFileV2 } | { ok: false; errors: SchemaIssue[] } {
  const errors: SchemaIssue[] = [];
  const t = raw as TruthFileV2;
  if (!raw || typeof raw !== "object") return { ok: false, errors: [{ path: "", message: "不是对象" }] };
  if (t.schemaVersion !== "prediagnosis-truth-v2") {
    errors.push({ path: "schemaVersion", message: `期望 prediagnosis-truth-v2，得到 ${String(t.schemaVersion)}` });
  }
  if (t.caseId !== opts.caseId) errors.push({ path: "caseId", message: `与 case 不匹配：${String(t.caseId)}` });
  const locatorIds = new Set<string>();
  if (!Array.isArray(t.locators)) errors.push({ path: "locators", message: "必须是数组" });
  else {
    for (const locRaw of t.locators) {
      const locId = typeof (locRaw as { locatorId?: unknown }).locatorId === "string" ? (locRaw as { locatorId: string }).locatorId : "";
      if (!locId) {
        errors.push({ path: "locators", message: "locatorId 缺失" });
        continue;
      }
      const loc = locRaw as LocatorV2 & { locatorId: string };
      if (locatorIds.has(locId)) errors.push({ path: `locators.${locId}`, message: "重复" });
      locatorIds.add(locId);
      if (loc.kind === "log") {
        if (!isStr(loc.keyContent)) errors.push({ path: `locators.${locId}.keyContent`, message: "缺失" });
      } else if (loc.kind === "code") {
        if (!isStr(loc.repoId)) errors.push({ path: `locators.${locId}.repoId`, message: "缺失" });
        if (loc.sha !== undefined && (!SHA_RE.test(loc.sha) || isPlaceholderSha(loc.sha))) {
          errors.push({ path: `locators.${locId}.sha`, message: "非完整 SHA 或占位值" });
        }
        if (!isStr(loc.path)) errors.push({ path: `locators.${locId}.path`, message: "缺失" });
        if (!Number.isInteger(loc.lineStart) || loc.lineStart < 1) {
          errors.push({ path: `locators.${locId}.lineStart`, message: "必须 ≥1" });
        }
        if (!Number.isInteger(loc.lineEnd) || (loc.lineEnd ?? 0) < loc.lineStart) {
          errors.push({ path: `locators.${locId}.lineEnd`, message: "必须 ≥ lineStart" });
        }
        if (!isStr(loc.keyContent)) errors.push({ path: `locators.${locId}.keyContent`, message: "缺失" });
      } else {
        errors.push({ path: `locators.${locId}.kind`, message: `非法 kind：${String((locRaw as { kind?: string }).kind)}` });
      }
    }
  }
  if (!Array.isArray(t.rounds) || t.rounds.length === 0) {
    errors.push({ path: "rounds", message: "至少一轮标准" });
  } else {
    const seen = new Set<string>();
    t.rounds.forEach((r, i) => {
      if (!isStr(r.roundId)) errors.push({ path: `rounds[${i}].roundId`, message: "缺失" });
      else if (seen.has(r.roundId)) errors.push({ path: `rounds[${i}].roundId`, message: "重复" });
      else seen.add(r.roundId);
      if (!Array.isArray(r.allowedOutcomes) || r.allowedOutcomes.length === 0) {
        errors.push({ path: `rounds[${i}].allowedOutcomes`, message: "至少一种允许产出" });
      } else if (r.allowedOutcomes.some((o) => o !== "report" && o !== "clarify" && o !== "blocked")) {
        errors.push({ path: `rounds[${i}].allowedOutcomes`, message: "只允许 report/clarify/blocked" });
      }
      if (!["symptom", "direct", "root"].includes(r.allowedClaimDepth)) {
        errors.push({ path: `rounds[${i}].allowedClaimDepth`, message: `非法粒度：${String(r.allowedClaimDepth)}` });
      }
      const conceptOk = (groups: unknown): boolean =>
        Array.isArray(groups) &&
        groups.length > 0 &&
        (groups as unknown[]).every((g) => Array.isArray(g) && g.length > 0 && (g as unknown[]).every((w) => typeof w === "string" && w.length > 0));
      const factIds = new Set<string>();
      for (const fact of r.requiredFacts ?? []) {
        if (!isStr(fact.factId) || factIds.has(fact.factId)) {
          errors.push({ path: `rounds[${i}].requiredFacts`, message: `factId 缺失或重复：${String(fact.factId)}` });
          continue;
        }
        factIds.add(fact.factId);
        if (!conceptOk(fact.concepts)) errors.push({ path: `rounds[${i}].${fact.factId}.concepts`, message: "概念组必须是非空字符串数组的数组" });
        const whereOk = Array.isArray(fact.where) && fact.where.every((w) => ["summary", "confirmedFacts", "hypotheses"].includes(w));
        if (!whereOk) errors.push({ path: `rounds[${i}].${fact.factId}.where`, message: "where 只允许 summary/confirmedFacts/hypotheses" });
      }
      const needIds = new Set<string>();
      for (const need of r.materialNeeds ?? []) {
        if (!isStr(need.needId) || needIds.has(need.needId)) {
          errors.push({ path: `rounds[${i}].materialNeeds`, message: `needId 缺失或重复：${String(need.needId)}` });
          continue;
        }
        needIds.add(need.needId);
        if (!conceptOk(need.clarifyConcepts)) errors.push({ path: `rounds[${i}].${need.needId}.clarifyConcepts`, message: "概念组必须是非空字符串数组的数组" });
      }
      const wbIds = new Set<string>();
      for (const wb of r.writebackRequirements ?? []) {
        if (!isStr(wb.reqId) || wbIds.has(wb.reqId)) {
          errors.push({ path: `rounds[${i}].writebackRequirements`, message: `reqId 缺失或重复：${String(wb.reqId)}` });
          continue;
        }
        wbIds.add(wb.reqId);
        if (!conceptOk(wb.concepts)) errors.push({ path: `rounds[${i}].${wb.reqId}.concepts`, message: "概念组必须是非空字符串数组的数组" });
      }
      const claimIds = new Set<string>();
      for (const cc of r.contradictedClaims ?? []) {
        if (!isStr(cc.claimId) || claimIds.has(cc.claimId)) {
          errors.push({ path: `rounds[${i}].contradictedClaims`, message: `claimId 缺失或重复：${String(cc.claimId)}` });
          continue;
        }
        claimIds.add(cc.claimId);
        if (!conceptOk(cc.concepts)) errors.push({ path: `rounds[${i}].${cc.claimId}.concepts`, message: "概念组必须是非空字符串数组的数组" });
      }
      const reqIds = new Set<string>();
      for (const req of r.evidenceRequirements ?? []) {
        if (!isStr(req.requirementId) || reqIds.has(req.requirementId)) {
          errors.push({ path: `rounds[${i}].evidenceRequirements`, message: `requirementId 缺失或重复：${String(req.requirementId)}` });
          continue;
        }
        reqIds.add(req.requirementId);
        if (!["symptom", "direct", "root"].includes(req.depth)) {
          errors.push({ path: `rounds[${i}].${req.requirementId}.depth`, message: `非法粒度：${String(req.depth)}` });
        }
        if (!Array.isArray(req.supportsAnyOf) || req.supportsAnyOf.length === 0) {
          errors.push({ path: `rounds[${i}].${req.requirementId}.supportsAnyOf`, message: "至少一个组合" });
          continue;
        }
        for (const group of req.supportsAnyOf) {
          if (!Array.isArray(group.allOf) || group.allOf.length === 0) {
            errors.push({ path: `rounds[${i}].${req.requirementId}`, message: "组合不能为空" });
            continue;
          }
          for (const id of group.allOf) {
            if (!locatorIds.has(id)) {
              errors.push({ path: `rounds[${i}].${req.requirementId}`, message: `引用未定义的 locator：${id}` });
            }
          }
        }
      }
      const ruleIds = new Set<string>();
      for (const rule of r.forbiddenRules ?? []) {
        if (!isStr(rule.ruleId) || ruleIds.has(rule.ruleId)) {
          errors.push({ path: `rounds[${i}].forbiddenRules`, message: `ruleId 缺失或重复：${String(rule.ruleId)}` });
          continue;
        }
        ruleIds.add(rule.ruleId);
        if (!conceptOk(rule.assertAnyOf)) {
          errors.push({ path: `rounds[${i}].forbiddenRules.${rule.ruleId}`, message: "assertAnyOf 必须是非空字符串数组的数组" });
        }
        if (rule.onlyWhenStatus && !["supported", "candidate", "refuted"].includes(rule.onlyWhenStatus)) {
          errors.push({ path: `rounds[${i}].forbiddenRules.${rule.ruleId}.onlyWhenStatus`, message: "非法状态" });
        }
        if (rule.onlyWhenStatus && !rule.where.every((w) => w === "hypotheses")) {
          errors.push({ path: `rounds[${i}].forbiddenRules.${rule.ruleId}.onlyWhenStatus`, message: "onlyWhenStatus 只适用于 hypotheses 范围" });
        }
      }
    });
  }
  if (!t.review || typeof t.review !== "object") errors.push({ path: "review", message: "缺失复核记录" });
  else if (typeof t.review.provisional !== "boolean") {
    errors.push({ path: "review.provisional", message: "必须是 boolean" });
  }
  if (t.rootCauseRef && !existsSync(join(opts.privateDir, t.rootCauseRef))) {
    errors.push({ path: "rootCauseRef", message: `根因文档不存在：${t.rootCauseRef}` });
  }
  return errors.length === 0 ? { ok: true, value: t } : { ok: false, errors };
}

/** case 与 truth 的轮次必须配对一致（truth 每一轮都有标准，且不出现未知轮）。 */
export function validatePairing(caseDesc: CaseDescriptorV2, truth: TruthFileV2): void {
  const caseRounds = new Set(caseDesc.rounds.map((r) => r.roundId));
  const truthRounds = new Set(truth.rounds.map((r) => r.roundId));
  const missing = [...caseRounds].filter((r) => !truthRounds.has(r));
  const extra = [...truthRounds].filter((r) => !caseRounds.has(r));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `case/truth 轮次不配对：case 缺标准 ${missing.join(",") || "-"}；truth 多出 ${extra.join(",") || "-"}（caseId=${caseDesc.caseId}）`,
    );
  }
}
