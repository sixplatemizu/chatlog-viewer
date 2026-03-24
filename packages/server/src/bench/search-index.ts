import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Message } from "../providers/types.js";
import { visitJsonl } from "../utils/jsonl.js";
import {
  buildConversationSearchIndex,
  createConversationSearchIndexBuilder,
} from "../utils/search-index.js";

interface BenchJsonlMessage {
  role: Message["role"];
  content: string;
  timestamp: number;
}

function createMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [
      `message-${index + 1}`,
      `section-${index % 12}`,
      "x".repeat(2048),
      index % 17 === 0 ? `needle-${index}` : "body",
      "y".repeat(2048),
    ].join("\n"),
    timestamp: 1_700_000_000_000 + index,
  }));
}

async function measure<T>(label: string, task: () => Promise<T> | T): Promise<{ durationMs: number; value: T }> {
  const startedAt = performance.now();
  const value = await task();
  return {
    durationMs: performance.now() - startedAt,
    value,
  };
}

async function main(): Promise<void> {
  const messages = createMessages(4_000);
  const tempDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-bench-"));
  const filePath = join(tempDir, "messages.jsonl");

  try {
    await writeFile(
      filePath,
      `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
      "utf8"
    );

    const batch = await measure("batch build", () => buildConversationSearchIndex(messages));
    const incremental = await measure("incremental build", () => {
      const builder = createConversationSearchIndexBuilder();
      for (const message of messages) {
        builder.addMessage(message);
      }
      return builder.build();
    });
    const streamed = await measure("jsonl visit + incremental build", async () => {
      const builder = createConversationSearchIndexBuilder();
      await visitJsonl<BenchJsonlMessage>(filePath, async (message) => {
        builder.addMessage(message);
      });
      return builder.build();
    });

    console.log("search-index benchmark");
    console.log(`messages=${messages.length}`);
    console.log(`batch build: ${batch.durationMs.toFixed(2)}ms`);
    console.log(`incremental build: ${incremental.durationMs.toFixed(2)}ms`);
    console.log(`jsonl visit + incremental build: ${streamed.durationMs.toFixed(2)}ms`);
    console.log(`searchText length=${batch.value.searchText?.length ?? 0}`);
    console.log(`searchChunks=${batch.value.searchChunks?.length ?? 0}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main();
