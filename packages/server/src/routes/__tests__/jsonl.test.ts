import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  countLines,
  getAdaptiveSearchWindowOptions,
  parseJsonlTail,
  parseJsonlWindow,
  visitJsonl,
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

test("countLines 会基于 JSON 结构匹配，避免正文中的转义片段误计数", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-viewer-jsonl-count-"));
  const filePath = join(dir, "count.jsonl");

  try {
    await writeFile(
      filePath,
      [
        JSON.stringify({ type: "assistant", message: { content: "真实 assistant" } }),
        JSON.stringify({ type: "user", message: { content: "正文里有 \\\"type\\\":\\\"assistant\\\" 字样" } }),
      ].join("\n"),
      "utf8"
    );

    const counted = await countLines(
      filePath,
      (value) => {
        if (!value || typeof value !== "object") return false;
        const entry = value as { type?: string };
        return entry.type === "assistant";
      },
      {
        fastIncludes: ['"type":"assistant"'],
      }
    );

    assert.equal(counted, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visitJsonl 会顺序遍历有效行并跳过坏行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-viewer-jsonl-visit-"));
  const filePath = join(dir, "visit.jsonl");

  try {
    await writeFile(
      filePath,
      [
        JSON.stringify({ id: 1 }),
        "{bad json",
        "",
        JSON.stringify({ id: 2 }),
      ].join("\n"),
      "utf8"
    );

    const visited: number[] = [];
    await visitJsonl<{ id: number }>(filePath, async (value) => {
      visited.push(value.id);
    });

    assert.deepEqual(visited, [1, 2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
