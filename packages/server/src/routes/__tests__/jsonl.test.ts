import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseJsonlTail } from "../../utils/jsonl.js";

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
