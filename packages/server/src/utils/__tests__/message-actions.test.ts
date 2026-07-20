import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStableMessageSourceKey,
  getMessageActionLineNumbers,
  primeMessageActionIndex,
  rewriteJsonlFileLine,
  rewriteJsonlFileLines,
} from "../message-actions.js";

test("rewriteJsonlFileLine 会流式改写指定行并保留 CRLF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-viewer-message-actions-"));
  const filePath = join(dir, "session.jsonl");

  try {
    await writeFile(filePath, "{\"a\":1}\r\n{\"b\":2}\r\n", "utf-8");
    await rewriteJsonlFileLine(filePath, 2, "{\"b\":3}");

    const content = await readFile(filePath, "utf-8");
    assert.equal(content, "{\"a\":1}\r\n{\"b\":3}\r\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rewriteJsonlFileLines 会删除多行并保留末尾换行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-viewer-message-actions-"));
  const filePath = join(dir, "session.jsonl");

  try {
    await writeFile(filePath, "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n", "utf-8");
    await rewriteJsonlFileLines(filePath, [2, 3]);

    const content = await readFile(filePath, "utf-8");
    assert.equal(content, "{\"a\":1}\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rewriteJsonlFileLine 会拒绝覆盖外部进程已经修改的文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-viewer-message-actions-conflict-"));
  const filePath = join(dir, "session.jsonl");

  try {
    await writeFile(filePath, "{\"a\":1}\n{\"b\":2}\n", "utf-8");
    const revision = await stat(filePath);
    await writeFile(filePath, "{\"a\":1}\n{\"external\":true}\n{\"b\":2}\n", "utf-8");

    await assert.rejects(
      rewriteJsonlFileLine(filePath, 2, "{\"b\":3}", {
        mtimeMs: revision.mtimeMs,
        size: revision.size,
      }),
      /已被其他进程修改/
    );
    assert.equal(
      await readFile(filePath, "utf-8"),
      "{\"a\":1}\n{\"external\":true}\n{\"b\":2}\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("message action index 会按 mtime 命中并返回行号", () => {
  primeMessageActionIndex("/tmp/session.jsonl", 123, [
    {
      entry: {},
      lineIndex: 7,
      message: { role: "user", content: "a", messageId: "user:aaa:1" },
    },
    {
      entry: {},
      lineIndex: 9,
      message: { role: "assistant", content: "b", messageId: "assistant:bbb:1" },
    },
  ]);

  assert.deepEqual(
    getMessageActionLineNumbers("/tmp/session.jsonl", 123, ["assistant:bbb:1", "user:aaa:1"]),
    [9, 7]
  );
  assert.equal(
    getMessageActionLineNumbers("/tmp/session.jsonl", 124, ["assistant:bbb:1"]),
    null
  );
});

test("createStableMessageSourceKey 优先使用稳定字段而不是 fallback 内容", () => {
  const beforeEdit = createStableMessageSourceKey(
    "codex",
    ["2026-03-01T00:00:00.000Z", "assistant", "message", "output_text"],
    "{\"content\":\"before\"}"
  );
  const afterEdit = createStableMessageSourceKey(
    "codex",
    ["2026-03-01T00:00:00.000Z", "assistant", "message", "output_text"],
    "{\"content\":\"after\"}"
  );

  assert.equal(beforeEdit, afterEdit);
});
