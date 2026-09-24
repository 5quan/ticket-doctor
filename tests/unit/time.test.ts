// 发生时间提取：宁漏勿错。
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractOccurredAt } from "../../src/domain/time.ts";

// 参考时间：2026-09-07 09:00（本地时区）
const REF = new Date(2026, 8, 7, 9, 0, 0).getTime();
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0).getTime();

test("完整日期时间", () => {
  const r = extractOccurredAt("checkout-service 2026-09-06 20:00 开始 500", REF);
  assert.equal(r?.ms, at(2026, 9, 6, 20, 0));
  assert.equal(r?.source, "datetime");
});

test("带时区 ISO", () => {
  const r = extractOccurredAt("发生在 2026-09-06T20:00:00+08:00", REF);
  assert.equal(r?.ms, Date.parse("2026-09-06T20:00:00+08:00"));
  assert.equal(r?.source, "iso");
});

test("中文日词：昨晚8点 = 20:00", () => {
  const r = extractOccurredAt("昨晚8点开始下单失败", REF);
  assert.equal(r?.ms, at(2026, 9, 6, 20, 0));
  assert.equal(r?.source, "zh-day");
});

test("中文日词：昨天下午3点30分", () => {
  const r = extractOccurredAt("昨天下午3点30分出现", REF);
  assert.equal(r?.ms, at(2026, 9, 6, 15, 30));
});

test("中文月日：9月6日 20:00", () => {
  const r = extractOccurredAt("9月6日 20:00 开始", REF);
  assert.equal(r?.ms, at(2026, 9, 6, 20, 0));
  assert.equal(r?.source, "zh-date");
});

test("相对时间：半小时前 / 2小时前", () => {
  assert.equal(extractOccurredAt("半小时前开始的", REF)?.ms, REF - 30 * 60_000);
  assert.equal(extractOccurredAt("2小时前开始", REF)?.ms, REF - 2 * 3_600_000);
});

test("宁漏勿错：没有明确时间返回 undefined", () => {
  assert.equal(extractOccurredAt("你好，请问有什么问题", REF), undefined);
  assert.equal(extractOccurredAt("下单报 500", REF), undefined);
});

test("宁漏勿错：多个不同时间视为歧义", () => {
  assert.equal(extractOccurredAt("2026-09-06 20:00 和 2026-09-06 21:00 都复现过", REF), undefined);
});

test("宁漏勿错：未来时间不接受", () => {
  assert.equal(extractOccurredAt("预计 2026-09-08 20:00", REF), undefined);
});
