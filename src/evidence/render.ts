// 证据结果的共享渲染器（docs/evidence-uid-design.md §4）。
//
// 工具返回文本与崩溃恢复重建**共用同一函数**，保证模型看到的正文与恢复补记的正文一致。
// 渲染只做展示层截断（maxResultChars 总量预算）；材料本体（item.excerpt）已在 commit 前截断入库。
import type { EvidenceItem, EvidenceRef } from "./types.ts";

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** search_code 有界输出：路径清单最多列多少个文件、预览最多多少处命中（源本身另有 ≤50 上限）。 */
export const SEARCH_MAX_PATHS = 20;
export const SEARCH_PREVIEW_HITS = 8;

/** 按总量预算拼装多行结果，超出即截断并提示（与历史工具输出格式一致）。 */
function assemble(header: string, lines: string[], budget: number): string {
  const kept: string[] = [];
  let used = header.length + 1;
  for (const line of lines) {
    if (kept.length > 0 && used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length === lines.length) return `${header}\n${kept.join("\n")}`;
  return `${header}\n${kept.join("\n")}\n（结果已截断：共 ${lines.length} 条，展示前 ${kept.length} 条；请缩小时间窗/关键词或指定文件范围）`;
}

function renderQueryLogs(items: EvidenceItem[], refs: EvidenceRef[], budget: number): string {
  const lines = refs.map(
    (ref, i) =>
      `[${ref.evidenceId}] ${iso(items[i]!.time ?? 0)}\t${items[i]!.level ?? ""}\t${items[i]!.excerpt}`,
  );
  // 把来源/实际生效的时间窗带回给模型：请求窗被调查范围收窄时必须可见，否则模型误以为查了更大范围。
  const provenance = items[0]?.source ? `（${items[0].source}）` : "";
  return assemble(`命中 ${items.length} 条日志${provenance}：`, lines, budget);
}

function renderListFiles(items: EvidenceItem[], refs: EvidenceRef[], budget: number): string {
  const paths = (items[0]!.excerpt ?? "").split("\n").filter(Boolean);
  return assemble(`[${refs[0]!.evidenceId}] 命中 ${paths.length} 个文件：`, paths.map((p) => `  ${p}`), budget);
}

function renderSearchCode(items: EvidenceItem[], refs: EvidenceRef[], budget: number): string {
  const hitsByPath = new Map<string, number>();
  for (const item of items) {
    const path = item.codeRef?.path ?? "?";
    hitsByPath.set(path, (hitsByPath.get(path) ?? 0) + 1);
  }
  const pathEntries = [...hitsByPath.entries()];
  const pathLines = pathEntries.slice(0, SEARCH_MAX_PATHS).map(([path, count]) => `  ${path}: 命中 ${count} 处`);
  if (pathEntries.length > SEARCH_MAX_PATHS) {
    pathLines.push(`  （其余 ${pathEntries.length - SEARCH_MAX_PATHS} 个文件未列出，请用 glob 缩小范围）`);
  }
  const previewCount = Math.min(SEARCH_PREVIEW_HITS, items.length);
  const previewLines = refs.slice(0, previewCount).map((ref, i) => {
    const item = items[i]!;
    return `[${ref.evidenceId}] ${item.codeRef?.path ?? "?"}:${item.codeRef?.startLine ?? 0}: ${item.excerpt}`;
  });
  const omitted = items.length - previewCount;
  const tail =
    omitted > 0 ? [`（其余 ${omitted} 处未预览：按文件清单用 glob 缩小范围，或用 read_code 读取具体位置）`] : [];
  return assemble(
    `命中 ${items.length} 处代码，分布在 ${pathEntries.length} 个文件；先列文件清单，再预览前 ${previewCount} 处：`,
    [...pathLines, "", ...previewLines, ...tail],
    budget,
  );
}

function renderReadCode(items: EvidenceItem[], refs: EvidenceRef[]): string {
  const item = items[0]!;
  const ref = refs[0]!;
  return `[${ref.evidenceId}] ${item.codeRef?.path ?? "?"}:${item.codeRef?.startLine ?? 0}-${item.codeRef?.endLine ?? 0}\n${item.excerpt}`;
}

/** 工具 → 渲染分支。只有四个采集工具会产生证据批次。 */
export function renderEvidenceResult(
  tool: string,
  items: EvidenceItem[],
  refs: EvidenceRef[],
  opts: { maxResultChars: number },
): string {
  switch (tool) {
    case "query_logs":
      return renderQueryLogs(items, refs, opts.maxResultChars);
    case "list_files":
      return renderListFiles(items, refs, opts.maxResultChars);
    case "search_code":
      return renderSearchCode(items, refs, opts.maxResultChars);
    case "read_code":
      return renderReadCode(items, refs);
    default:
      throw new Error(`未知证据工具：${tool}`);
  }
}
