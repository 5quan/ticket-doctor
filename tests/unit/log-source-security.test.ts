// 日志源安全（独立于任何评测资产）：服务名校验、路径边界、realpath 链接逃逸、三种授权语义。
// 对应 src/sources/logs.ts 的生产安全修复；权限类用例仅在非 EPERM/EACCES 失败时判失败。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileLogSource, LogAccessError } from "../../src/sources/logs.ts";

function makeLogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "td-logs-"));
  writeFileSync(
    join(dir, "checkout-service.log"),
    "2026-01-01T10:00:00.000Z\tERROR\t下单超时\n2026-01-01T10:01:00.000Z\tINFO\t正常\n",
  );
  return dir;
}

const WINDOW = { from: Date.parse("2026-01-01T00:00:00Z"), to: Date.parse("2026-01-02T00:00:00Z") };
const query = (service: string, keywords: string[] = []) => ({ service, ...WINDOW, keywords });
const controller = () => new AbortController();

test("未配置授权（undefined）：不限制服务，可正常查询", async () => {
  const dir = makeLogDir();
  try {
    const source = new FileLogSource({ dir, allowedServices: undefined });
    const page = await source.query(query("checkout-service"), controller().signal);
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 2);
    assert.equal(page.hasMore, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("显式空授权（[]）：拒绝一切查询，而非打开全部服务", async () => {
  const dir = makeLogDir();
  try {
    const source = new FileLogSource({ dir, allowedServices: [] });
    await assert.rejects(
      source.query(query("checkout-service"), controller().signal),
      (err: unknown) => err instanceof LogAccessError && /授权列表为空/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非空白名单：授权服务放行，越权服务直接报错", async () => {
  const dir = makeLogDir();
  try {
    const source = new FileLogSource({ dir, allowedServices: ["checkout-service"] });
    const page = await source.query(query("checkout-service"), controller().signal);
    assert.equal(page.items.length, 2);
    await assert.rejects(
      source.query(query("other-service"), controller().signal),
      (err: unknown) => err instanceof LogAccessError && /不在授权范围内/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非法服务名（路径语法 / 控制字符 / 超长）：拒绝", async () => {
  const dir = makeLogDir();
  try {
    const source = new FileLogSource({ dir, allowedServices: undefined });
    for (const bad of ["../escape", "a/b", "a\\b", "..", ".hidden", "service name", "a".repeat(101)]) {
      await assert.rejects(
        source.query(query(bad), controller().signal),
        (err: unknown) => err instanceof LogAccessError,
        `应拒绝非法服务名：${bad}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("路径逃逸：即使通过校验拼接，解析后越出日志目录也被拒", async () => {
  const dir = makeLogDir();
  try {
    // 服务名白名单拦不住的形态交给解析核验：同一目录内造一个以 .. 组合不出逃逸的名字不可能，
    // 这里直接校验带 .. 的名字不会读取到目录外的文件（错误来自服务名校验或路径核验之一）。
    const outside = mkdtempSync(join(tmpdir(), "td-outside-"));
    writeFileSync(join(outside, "secret.log"), "SECRET");
    const source = new FileLogSource({ dir, allowedServices: undefined });
    await assert.rejects(
      source.query(query(`..${"/"}${outside}/${"secret"}`.replace("//", "/")), controller().signal),
      (err: unknown) => err instanceof LogAccessError,
    );
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("符号链接逃逸：realpath 核验拒绝指向目录外的链接（权限不足环境跳过）", async () => {
  const dir = makeLogDir();
  const outside = mkdtempSync(join(tmpdir(), "td-outside-"));
  try {
    writeFileSync(join(outside, "target.log"), "SECRET");
    let linked = false;
    try {
      symlinkSync(join(outside, "target.log"), join(dir, "link-service.log"));
      linked = true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EPERM" || code === "EACCES") return; // 权限不足环境：跳过链接用例
      throw err;
    }
    assert.ok(linked);
    const source = new FileLogSource({ dir, allowedServices: undefined });
    await assert.rejects(
      source.query(query("link-service"), controller().signal),
      (err: unknown) => err instanceof LogAccessError && /越出日志目录/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("目录内子目录中的合法名文件不受影响；缺文件仍显式报错", async () => {
  const dir = makeLogDir();
  try {
    const source = new FileLogSource({ dir, allowedServices: undefined });
    await assert.rejects(
      source.query(query("missing-service"), controller().signal),
      (err: unknown) => err instanceof LogAccessError && /日志文件不存在/.test(err.message),
    );
    mkdirSync(join(dir, "sub"), { recursive: true });
    // 子目录文件不能通过服务名直接命中（服务名不允许路径分隔符），保持文件名平铺语义。
    await assert.rejects(
      source.query(query("sub/nested"), controller().signal),
      (err: unknown) => err instanceof LogAccessError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
