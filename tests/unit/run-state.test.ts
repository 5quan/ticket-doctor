import assert from "node:assert/strict";
import { test } from "node:test";
import { onFailure } from "../../src/domain/run-state.ts";

test("可重试错误在额度内回到 queued", () => {
  assert.deepEqual(onFailure("interrupted", 1, 2), { status: "queued", reason: "retry" });
  assert.deepEqual(onFailure("timeout", 1, 2), { status: "queued", reason: "retry" });
});

test("额度耗尽后判失败", () => {
  assert.deepEqual(onFailure("interrupted", 2, 2), { status: "failed", reason: "attempts_exhausted" });
});

test("权限/输入类错误不重试", () => {
  assert.deepEqual(onFailure("auth", 1, 2), { status: "failed", reason: "not_retryable" });
  assert.deepEqual(onFailure("invalid_input", 1, 2), { status: "failed", reason: "not_retryable" });
});
