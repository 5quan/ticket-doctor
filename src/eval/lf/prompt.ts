// 提示词版本管理（plan §5）：Langfuse Prompt Management 为源，评测按数字版本读取、
// 编译并注入。基线 = 当前生产内置提示词完整保存；候选 = 人工准备的明确小修改。
// 只影响评测：生产 buildEngine 缺省仍用内置提示词（factory.ts 的既有规则）。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LangfuseClient } from "@langfuse/client";
import { buildSystemPrompt } from "../../agent/pi-engine.ts";

export const DIAGNOSIS_PROMPT_NAME = "ticket-doctor-diagnosis";

export function compileHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

export interface PromptVersion {
  name: string;
  version: number;
  label?: string;
  compiled: string;
  hash: string;
}

/** 幂等登记基线版本（内容为当前生产内置提示词；同内容重复登记由服务端按内容去重语义兜底）。 */
export async function ensureBaselinePrompt(lf: LangfuseClient): Promise<PromptVersion> {
  const compiled = buildSystemPrompt();
  const existing = await lf.api.prompts.get(DIAGNOSIS_PROMPT_NAME).catch(() => undefined);
  if (existing) {
    const p = existing as { prompt?: string; version?: number };
    if (typeof p.prompt === "string" && p.prompt === compiled) {
      return { name: DIAGNOSIS_PROMPT_NAME, version: p.version ?? 0, compiled, hash: compileHash(compiled) };
    }
  }
  const created = (await lf.api.prompts.create({
    name: DIAGNOSIS_PROMPT_NAME,
    prompt: compiled,
    type: "text",
    labels: ["production"],
    commitMessage: "baseline: 当前生产内置诊断提示词（eval:lf seed 登记）",
  })) as { version?: number };
  return { name: DIAGNOSIS_PROMPT_NAME, version: created.version ?? 0, compiled, hash: compileHash(compiled) };
}

/** 登记候选版本：内容来自人工审阅过的本地文件（明确、可审阅的小修改，plan §5）。 */
export async function registerCandidatePrompt(lf: LangfuseClient, candidateFile: string): Promise<PromptVersion> {
  const compiled = readFileSync(candidateFile, "utf8").trim();
  if (compiled.length < 32) throw new Error(`候选提示词过短（${compiled.length} 字符），疑似误操作：${candidateFile}`);
  if (compiled === buildSystemPrompt()) throw new Error("候选提示词与基线完全相同——候选必须是明确的小修改");
  const created = (await lf.api.prompts.create({
    name: DIAGNOSIS_PROMPT_NAME,
    prompt: compiled,
    type: "text",
    labels: ["candidate"],
    commitMessage: `candidate: ${candidateFile}`,
  })) as { version?: number };
  return { name: DIAGNOSIS_PROMPT_NAME, version: created.version ?? 0, compiled, hash: compileHash(compiled) };
}

/** 按数字版本读取并编译（实验全程固定该版本；一个案例所有轮次同版本，plan §5）。 */
export async function getPromptVersion(lf: LangfuseClient, version: number): Promise<PromptVersion> {
  const res = (await lf.api.prompts.get(DIAGNOSIS_PROMPT_NAME, { version })) as {
    prompt?: string;
    version?: number;
  };
  if (typeof res.prompt !== "string") throw new Error(`提示词 ${DIAGNOSIS_PROMPT_NAME} v${version} 不是 text 类型或不存在`);
  return { name: DIAGNOSIS_PROMPT_NAME, version: res.version ?? version, compiled: res.prompt, hash: compileHash(res.prompt) };
}
