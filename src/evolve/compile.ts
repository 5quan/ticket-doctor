// 自改进方案交付 B：候选编译器（§6、§6.2）。
//
// GEPA 候选只含一个文本组件 {"diagnosis_rules": "规则全文"}；基础 prompt 固定不在候选里。
// 编译器把固定基础 prompt + 候选规则编译成**完整** systemPrompt，供 runCase 直接注入——
// 绝不把完整 compiledPrompt 当规则再拼一次造成重复注入（§6.1）。
//
// 范围校验（§6.2 护栏）：候选规则不得含具体 case/trace ID、私有路径、虚构 commit 或答案，
// 也不得尝试覆盖系统提示词；命中即拒绝编译（fail-closed）。

import { buildSystemPrompt } from "../agent/pi-engine.ts";
import { sha256Bytes } from "../eval/lf/internals/hash.ts";

export const MAX_RULES_LEN = 20_000;
export const MIN_RULES_LEN = 32;

export interface CandidateScopeIssue {
  code: string;
  message: string;
}

export interface CompiledCandidate {
  /** 候选规则全文（trim 后）。 */
  rulesText: string;
  /** 基础 prompt + 规则的完整系统提示词。 */
  compiledPrompt: string;
  rulesHash: string;
  compiledPromptHash: string;
  /** 供 manifest 记录的基础 prompt hash。 */
  basePromptHash: string;
}

/** 候选规则禁用项（对应方案 §6.2「禁止把具体 case ID、trace ID、虚构 commit 或答案作为查表规则」）。 */
const FORBIDDEN_RULES: Array<{ code: string; re: RegExp; message: string }> = [
  { code: "case_id", re: /\brcb-\d{3}\b/i, message: "不得含具体案例 ID（rcb-###）" },
  { code: "trace_id", re: /\btrace[_ ]?id\s*[:=]?\s*[0-9a-f]{16,}\b/i, message: "不得含具体 trace ID" },
  { code: "commit_id", re: /\bcommit\s*[0-9a-f]{7,40}\b/i, message: "不得含具体 commit ID" },
  { code: "private_path", re: /(private\/|truth\.private|ground_truth|root-cause\.md|\.private\.json)/i, message: "不得引用私有标准/制作侧文件" },
  { code: "prompt_override", re: /(ignore (all )?previous|disregard .*instructions|<\/?system>|you are now|system prompt\s*[:=])/i, message: "不得尝试覆盖系统提示词" },
  { code: "answer_file", re: /\b(answer\.txt|solution\.(py|ts|js|patch)|gold\.json)\b/i, message: "不得引用答案性文件" },
];

/** 返回全部范围问题；空数组表示通过。 */
export function validateCandidateRules(rulesText: string): CandidateScopeIssue[] {
  const text = rulesText.trim();
  const issues: CandidateScopeIssue[] = [];
  if (text.length < MIN_RULES_LEN) issues.push({ code: "too_short", message: `规则过短（${text.length} < ${MIN_RULES_LEN}）` });
  if (text.length > MAX_RULES_LEN) issues.push({ code: "too_long", message: `规则过长（${text.length} > ${MAX_RULES_LEN}）` });
  for (const f of FORBIDDEN_RULES) {
    if (f.re.test(text)) issues.push({ code: f.code, message: f.message });
  }
  return issues;
}

/** 编译候选；范围问题存在即抛错（不产出可运行候选）。 */
export function compileCandidate(rulesText: string): CompiledCandidate {
  const issues = validateCandidateRules(rulesText);
  if (issues.length > 0) {
    throw new Error(`候选规则未通过范围校验：${issues.map((i) => `${i.code}(${i.message})`).join("; ")}`);
  }
  const text = rulesText.trim();
  const compiledPrompt = buildSystemPrompt(text);
  const basePromptHash = sha256Bytes(buildSystemPrompt());
  return {
    rulesText: text,
    compiledPrompt,
    rulesHash: sha256Bytes(text),
    compiledPromptHash: sha256Bytes(compiledPrompt),
    basePromptHash,
  };
}

/**
 * 基线编译：不加任何外部规则，直接用当前生产内置提示词（方案 §8 第 3 步）。
 * 与候选同一执行路径，但 rulesText 为空、无附加段落。
 */
export function compileBaseline(): CompiledCandidate {
  const compiledPrompt = buildSystemPrompt();
  const hash = sha256Bytes(compiledPrompt);
  return { rulesText: "", compiledPrompt, rulesHash: sha256Bytes(""), compiledPromptHash: hash, basePromptHash: hash };
}
