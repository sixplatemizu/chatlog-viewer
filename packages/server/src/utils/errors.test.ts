import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProviderDataError,
  createProviderDataError,
  isFileSystemNotFoundError,
} from "./errors.js";

test("provider 数据错误会按 code 和消息分类", () => {
  assert.equal(classifyProviderDataError(Object.assign(new Error("访问失败"), { code: "EACCES" })), "permission-denied");
  assert.equal(classifyProviderDataError(Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" })), "locked");
  assert.equal(classifyProviderDataError(new Error("database disk image is malformed")), "corrupt");
  assert.equal(classifyProviderDataError(new Error("no such table: threads")), "schema-incompatible");
  assert.equal(classifyProviderDataError(new Error("unable to open database file")), "unavailable");
});

test("provider 数据错误保留分类、上下文和 cause", () => {
  const cause = Object.assign(new Error("permission denied"), { code: "EPERM" });
  const error = createProviderDataError("codex", "读取 State DB 失败", cause);

  assert.equal(error.providerName, "codex");
  assert.equal(error.kind, "permission-denied");
  assert.equal(error.status, 503);
  assert.match(error.message, /读取 State DB 失败/);
  assert.equal(error.cause, cause);
});

test("只有 ENOENT 会被识别为可选文件不存在", () => {
  assert.equal(isFileSystemNotFoundError(Object.assign(new Error("missing"), { code: "ENOENT" })), true);
  assert.equal(isFileSystemNotFoundError(Object.assign(new Error("denied"), { code: "EACCES" })), false);
});
