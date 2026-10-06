// 入站服务名粗提：标注优先，但必须含字母（拒绝把日期/时间当服务名）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractService } from "../../src/intake/router.ts";

test("extractService：标注优先，但拒绝把日期当服务名", () => {
  assert.equal(extractService("checkout-service 服务: 2026-09-06 10:01 开始下单大量失败"), "checkout-service");
  assert.equal(extractService("服务: payment-service 报错"), "payment-service");
  assert.equal(extractService("service: order-service"), "order-service");
  assert.equal(extractService("服务: 2026-09-06 10:01 开始失败"), undefined, "纯日期不得作为服务名");
});

test("extractService：无标注时按 xxx-service 命名", () => {
  assert.equal(extractService("用户反馈 payment-service 超时"), "payment-service");
  assert.equal(extractService("用户下单失败，无服务线索"), undefined);
});
