import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionMarker, extractSessionCode, newSessionCode, stripSessionMarker } from "../../src/domain/session.ts";

test("session code 固定长度且可解析", () => {
  const code = newSessionCode();
  assert.equal(code.length, 8);
  assert.equal(extractSessionCode(`报告如下\n${buildSessionMarker(code)}`), code);
});

test("stripSessionMarker 去掉标号且保持正文", () => {
  assert.equal(stripSessionMarker("补充材料 [TD-ab12cd34] 库存超时"), "补充材料 库存超时");
});

test("普通方括号内容不会被误判为会话标号", () => {
  assert.equal(extractSessionCode("[TD-toolong123] 你好"), undefined);
  assert.equal(extractSessionCode("普通文本"), undefined);
});
