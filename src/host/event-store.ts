// Host EventStore：SSE 事件的持久化 + 订阅 + 断线重连 replay。
//
// 约定：
//   * 事件先落库（events 表，全局自增 id），再通知内存订阅者；
//   * id 就是 SSE 的 Last-Event-ID，客户端重连带最后 id 即可补发缺失事件；
//   * stream 当前等于调查 id（按调查订阅）。
import type { EventRow, Store } from "../storage/store.ts";

export interface HostEvent {
  id: number;
  stream: string;
  type: string;
  payload: unknown;
  createdAt: number;
}

export type EventListener = (event: HostEvent) => void;

function toHostEvent(row: EventRow): HostEvent {
  let payload: unknown = null;
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload;
    }
  }
  return { id: row.id, stream: row.stream, type: row.type, payload, createdAt: row.created_at };
}

export class EventStore {
  private readonly subscribers = new Map<string, Set<EventListener>>();
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** 持久化后发布；返回带稳定 id 的事件。 */
  publish(stream: string, type: string, payload?: unknown): HostEvent {
    const id = this.store.appendEvent(stream, type, payload);
    const event: HostEvent = { id, stream, type, payload: payload ?? null, createdAt: Date.now() };
    for (const listener of this.subscribers.get(stream) ?? []) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不影响其他订阅者与主链路
      }
    }
    return event;
  }

  /** 订阅某条流；返回退订函数。 */
  subscribe(stream: string, listener: EventListener): () => void {
    let set = this.subscribers.get(stream);
    if (!set) {
      set = new Set();
      this.subscribers.set(stream, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.subscribers.delete(stream);
    };
  }

  /** 补发 id 之后的已保存事件（断线重连）。 */
  replay(stream: string, afterId = 0, limit = 1000): HostEvent[] {
    return this.store.listEvents(stream, afterId, limit).map(toHostEvent);
  }

  /** 某条流已保存的最大事件 id；无事件返回 0。 */
  latestId(stream: string): number {
    const rows = this.store.listEvents(stream, 0, 1_000_000);
    return rows.length > 0 ? rows[rows.length - 1].id : 0;
  }
}
