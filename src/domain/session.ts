// 会话标号：让"回复机器人消息"能自动路由回原调查。
//
// 设计取舍（参考 miniclaw 的成熟做法，但刻意更简单）：
// - 机器人每条回复都带一个稳定、短、可读的标号 `[TD-<code>]`。
// - 用户在任意线程里回复时，只要正文里带这个标号，就能精确路由，不依赖平台的线程字段是否完整。
// - 标号是"结构化标识"而非正则猜测：解析只认 `TD-` 前缀 + 固定长度 base36。
// - 同时 investigation 保存 rootMessageId / threadId，平台线程字段可用时优先走它。

const CODE_LENGTH = 8;
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
export const SESSION_MARKER_PREFIX = "TD-";

export function newSessionCode(random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
  }
  return out;
}

export function buildSessionMarker(code: string): string {
  return `[${SESSION_MARKER_PREFIX}${code}]`;
}

/** 从任意文本里提取会话标号；找不到返回 undefined。 */
export function extractSessionCode(text: string): string | undefined {
  const match = text.match(/\[TD-([0-9a-z]{8})\]/i);
  return match ? match[1].toLowerCase() : undefined;
}

/** 去掉标号本身，避免它进入模型上下文或问题正文。 */
export function stripSessionMarker(text: string): string {
  return text.replace(/\[TD-[0-9a-z]{8}\]/gi, "").replace(/[ \t]{2,}/g, " ").trim();
}
