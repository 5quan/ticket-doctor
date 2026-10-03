// 默认禁用实现（观测方案 §8）：不产生任何观测、不发任何网络请求。
// 引擎的计数包装仍然安装（逻辑模型调用计数与开关无关），只是事件落入这里被丢弃。
import type { ObservationSink } from "./types.ts";

export const noopObservationSink: ObservationSink = {
  record(): void {
    // best-effort 观测关闭：刻意丢弃全部事件。
  },
};
