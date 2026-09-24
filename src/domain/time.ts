// 从自由文本解析"故障发生时间"。
//
// 原则：宁漏勿错。
//   * 只从输入里"有把握才取"，拿不准就返回 undefined，绝不猜测、绝不回退成上报时间。
//   * 在本地时区下解析，存储统一 epoch ms。
//   * 有多个不同时间（歧义）时返回 undefined（视为没提取到）。
//
// 明确不要求用户按固定格式填写；本函数只从自然语言里尽力识别，识别不到就交给上层按"未知"处理。

export type OccurredTimeSource = "iso" | "datetime" | "zh-date" | "zh-day" | "mmdd" | "relative";

export interface OccurredTime {
  ms: number;
  /** 解析来源，写进报告供人核对。 */
  source: OccurredTimeSource;
}

/** 下午/晚上等时段对小时的修正。 */
function applyPeriod(hour: number, period: string | undefined): number {
  if (!period) return hour;
  if (/下午|晚上|傍晚|夜里|夜间/.test(period) && hour < 12) return hour + 12;
  return hour;
}

/** 用本地时区构造 epoch ms；越界或非法日期返回 undefined。 */
function buildLocal(year: number, month: number, day: number, hour: number, minute: number): number | undefined {
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return undefined;
  return d.getTime();
}

/** 收集某模式命中的全部不同时间。 */
function collect(re: RegExp, text: string, toMs: (m: RegExpMatchArray) => number | undefined): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(re)) {
    const ms = toMs(m as unknown as RegExpMatchArray);
    if (ms !== undefined) out.add(ms);
  }
  return [...out];
}

const DAY_WORDS: Array<[RegExp, number]> = [
  [/^前天$/, -2],
  [/^昨天$/, -1],
  [/^昨晚$/, -1],
  [/^今早$|^今晚$|^今日$|^今天$/, 0],
];

/** 日词自带时段：昨晚/今晚=晚上，今早=早上。 */
function dayPeriod(word: string): string | undefined {
  if (/昨晚|今晚/.test(word)) return "晚上";
  if (/今早/.test(word)) return "早上";
  return undefined;
}

/**
 * 从文本中提取故障发生时间。
 * @param text 用户消息正文（可含标号等噪音）
 * @param referenceMs 参考时间（通常是上报时间，用于相对时间与缺省年份）
 * @returns 有把握时返回唯一时间；否则 undefined（宁漏勿错）
 */
export function extractOccurredAt(text: string, referenceMs: number): OccurredTime | undefined {
  if (!text) return undefined;
  const ref = new Date(referenceMs);
  // 只接受不晚于"上报时间 + 1 分钟"的时间（故障发生在报告之前）。
  const valid = (ms: number | undefined): number | undefined =>
    ms !== undefined && ms <= referenceMs + 60_000 ? ms : undefined;
  const accept = (times: number[], source: OccurredTimeSource): OccurredTime | undefined =>
    times.length === 1 ? { ms: times[0], source } : undefined;

  // 1) 带时区的 ISO8601（最明确）
  {
    const times = collect(
      /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/g,
      text,
      (m) => {
        const ms = Date.parse(m[1]);
        return Number.isNaN(ms) ? undefined : valid(ms);
      },
    );
    if (times.length > 0) return accept(times, "iso");
  }

  // 2) 完整日期时间：2026-09-06 20:00 / 2026/9/6 20:00
  {
    const times = collect(
      /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})/g,
      text,
      (m) => valid(buildLocal(+m[1], +m[2], +m[3], +m[4], +m[5])),
    );
    if (times.length > 0) return accept(times, "datetime");
  }

  // 3) 中文月日：9月6日 20:00 / 9月6号晚上8点
  {
    const times = collect(
      /(\d{1,2})月(\d{1,2})[日号]\s*(上午|下午|中午|晚上|傍晚|凌晨|早上)?\s*(\d{1,2})(?:[点时](?:(\d{1,2})分?)?|:(\d{2}))/g,
      text,
      (m) => {
        const hour = applyPeriod(+m[4], m[3]);
        const minute = m[6] !== undefined ? +m[6] : m[5] ? +m[5] : 0;
        return valid(buildLocal(ref.getFullYear(), +m[1], +m[2], hour, minute));
      },
    );
    if (times.length > 0) return accept(times, "zh-date");
  }

  // 4) 中文日词 + 时刻：今天/昨天/昨晚 晚上8点 / 9月6日 20:00
  {
    const times = collect(
      /(前天|昨天|昨晚|今早|今晚|今日|今天)\s*(上午|下午|中午|晚上|傍晚|凌晨|早上)?\s*(\d{1,2})(?:[点时](?:(\d{1,2})分?)?|:(\d{2}))/g,
      text,
      (m) => {
        const offset = DAY_WORDS.find(([re]) => re.test(m[1]))?.[1];
        if (offset === undefined) return undefined;
        const base = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + offset);
        const hour = applyPeriod(+m[3], m[2] ?? dayPeriod(m[1]));
        const minute = m[5] !== undefined ? +m[5] : m[4] ? +m[4] : 0;
        return valid(buildLocal(base.getFullYear(), base.getMonth() + 1, base.getDate(), hour, minute));
      },
    );
    if (times.length > 0) return accept(times, "zh-day");
  }

  // 5) 月-日 时:分（缺年份，按参考时间当年）
  {
    const times = collect(
      /(?<!\d)(\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})(?!\d)/g,
      text,
      (m) => valid(buildLocal(ref.getFullYear(), +m[1], +m[2], +m[3], +m[4])),
    );
    if (times.length > 0) return accept(times, "mmdd");
  }

  // 6) 相对时间：x 分钟/小时/天前、半小时前、刚刚
  {
    const times = collect(/(\d+)\s*(分钟|小时|个小时|天)前/g, text, (m) => {
      const n = +m[1];
      const delta = m[2] === "分钟" ? n * 60_000 : m[2] === "天" ? n * 86_400_000 : n * 3_600_000;
      return valid(referenceMs - delta);
    });
    if (/半\s*小时前/.test(text)) times.push(valid(referenceMs - 30 * 60_000) as number);
    if (/刚刚|刚才/.test(text)) times.push(referenceMs);
    const distinct = [...new Set(times.filter((t) => t !== undefined))];
    if (distinct.length > 0) return accept(distinct, "relative");
  }

  return undefined;
}
