import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getAdaptiveSearchWindowOptions,
  parseJsonlTail,
  parseJsonlWindow,
} from "../../utils/jsonl.js";

test("parseJsonlTail 会在 bytesHint 不足时自动扩容直到读够目标消息", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-viewer-jsonl-"));
  const filePath = join(dir, "large.jsonl");

  try {
    const largeText = "x".repeat(12_000);
    const lines = Array.from({ length: 6 }, (_, index) =>
      JSON.stringify({
        id: index + 1,
        type: "message",
        content: `${index + 1}-${largeText}`,
      })
    );
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

    const items = await parseJsonlTail<{ id: number }>(filePath, {
      bytesHint: 1024,
      isEnough: (parsed) => parsed.length >= 4,
    });

    assert.ok(items.length >= 4);
    assert.deepEqual(items.slice(-4).map((item) => item.id), [3, 4, 5, 6]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseJsonlWindow 会采样头部中部尾部窗口", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-viewer-jsonl-window-"));
  const filePath = join(dir, "sampled.jsonl");

  try {
    const lines = Array.from({ length: 120 }, (_, index) =>
      JSON.stringify({
        id: index + 1,
        content: `message-${index + 1}-${"x".repeat(4096)}`,
      })
    );
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

    const items = await parseJsonlWindow<{ id: number }>(filePath, {
      headBytes: 16 * 1024,
      tailBytes: 16 * 1024,
      sampleWindowCount: 5,
    });
    const ids = items.map((item) => item.id);

    assert.ok(ids.some((id) => id <= 4));
    assert.ok(ids.some((id) => id >= 118));
    assert.ok(ids.some((id) => id > 40 && id < 80));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("自适应搜索窗口会在超大文件上增加采样点并缩小单窗口体积", () => {
  const medium = getAdaptiveSearchWindowOptions(4 * 1024 * 1024);
  const huge = getAdaptiveSearchWindowOptions(64 * 1024 * 1024);

  assert.deepEqual(medium, {
    headBytes: 80 * 1024,
    middleBytes: 48 * 1024,
    tailBytes: 80 * 1024,
    sampleWindowCount: 7,
  });
  assert.deepEqual(huge, {
    headBytes: 48 * 1024,
    middleBytes: 24 * 1024,
    tailBytes: 48 * 1024,
    sampleWindowCount: 13,
  });
});
