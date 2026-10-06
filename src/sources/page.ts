// 材料源的"返回值域"：把"拿到的条目"与"这次拿得全不全"一起返回。
//
// 背景（backlog T7）：数量上限静默切片会让模型误以为"没有更多"——"返回 20 条"≠"只有 20 条"。
// 因此覆盖信息（是否截断 / 是否还有 / 续查位置 / 命中总数）是端口契约的一部分，不是渲染细节。
import type { LogEntry } from "../domain/types.ts";

export interface SourcePage<T> {
  /** 本页条目。 */
  items: T[];
  /**
   * 命中总数；能精确统计时给出（本地文件日志 / 钉死 SHA 的 git grep 都能）。
   * 为 undefined 时禁止把 items.length 当作总数。
   */
  total?: number;
  /** 本页是否被上限/请求范围截断。 */
  truncated: boolean;
  /** 是否还有未返回的结果。 */
  hasMore: boolean;
  /** 继续查询位置（不透明，原样回传即可）；无更多则为 undefined。 */
  nextCursor?: string;
}

export function emptyPage<T>(): SourcePage<T> {
  return { items: [], total: 0, truncated: false, hasMore: false };
}

/** 由「本页条目 + 已知总数 + 起始偏移」构造一页。 */
export function pageFromWindow<T>(items: T[], total: number, offset: number): SourcePage<T> {
  const hasMore = offset + items.length < total;
  return {
    items,
    total,
    truncated: hasMore,
    hasMore,
    nextCursor: hasMore ? String(offset + items.length) : undefined,
  };
}

/** 便捷构造一页：默认 total = items.length（即本页已取全）；传 total 可声明“还有更多”。 */
export function pageOf<T>(items: T[], total: number = items.length): SourcePage<T> {
  return pageFromWindow(items, total, 0);
}

/** 对已排序/过滤后的全集做偏移分页。 */
export function paginate<T>(all: T[], opts: { offset: number; limit: number }): SourcePage<T> {
  const items = all.slice(opts.offset, opts.offset + opts.limit);
  return pageFromWindow(items, all.length, opts.offset);
}

/** 解析不透明 cursor 为偏移；未提供 → 0；非法 → 报错（由工具上抛，模型可纠正）。 */
export function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.trim() === "") return 0;
  const n = Number(cursor);
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`非法 cursor：${cursor}（应为上一页返回的 nextCursor）`);
  return n;
}

/** 日志条目页码；保留类型别名便于可读性。 */
export type LogPage = SourcePage<LogEntry>;
