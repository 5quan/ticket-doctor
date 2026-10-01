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
      if (!Array.isArray(r.repos) || r.repos.length === 0) {
        errors.push({ path: `rounds[${i}].repos`, message: "至少一个仓库" });
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
      }
      if (!["symptom", "direct", "root"].includes(r.allowedClaimDepth)) {
        errors.push({ path: `rounds[${i}].allowedClaimDepth`, message: `非法粒度：${String(r.allowedClaimDepth)}` });
      }
      const reqIds = new Set<string>();
      for (const req of r.evidenceRequirements ?? []) {
        if (!isStr(req.requirementId) || reqIds.has(req.requirementId)) {
          errors.push({ path: `rounds[${i}].evidenceRequirements`, message: `requirementId 缺失或重复：${String(req.requirementId)}` });
          continue;
        }
        reqIds.add(req.requirementId);
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
      for (const rule of r.forbiddenRules ?? []) {
        if (!Array.isArray(rule.assertAnyOf) || rule.assertAnyOf.length === 0) {
          errors.push({ path: `rounds[${i}].forbiddenRules.${rule.ruleId}`, message: "assertAnyOf 不能为空" });
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
