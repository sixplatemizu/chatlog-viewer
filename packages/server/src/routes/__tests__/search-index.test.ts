import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConversationSearchChunks,
  buildConversationSearchIndex,
  buildConversationSearchText,
  createConversationSearchIndexBuilder,
} from "../../utils/search-index.js";

test("超长单条消息会保留头中尾采样，避免中段关键词完全丢失", () => {
  const middleNeedle = "NEEDLE-IN-THE-MIDDLE";
  const largeMessage = `${"A".repeat(20_000)}${middleNeedle}${"B".repeat(20_000)}`;

  const searchText = buildConversationSearchText([
    {
      role: "user",
      content: largeMessage,
    },
  ]);

  assert.ok(searchText?.includes(middleNeedle));
});

test("超长多消息对话会分布式保留前中后段消息", () => {
  const messages = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `message-${index + 1}-marker-${index === 0 ? "head" : index === 39 ? "middle" : index === 79 ? "tail" : "body"}-${"x".repeat(6000)}`,
  }));

  const searchText = buildConversationSearchText(messages);

  assert.ok(searchText?.includes("message-1-marker-head"));
  assert.ok(searchText?.includes("message-40-marker-middle"));
  assert.ok(searchText?.includes("message-80-marker-tail"));
});

test("超长单条消息会被拆成连续 chunk，避免深层中段关键词丢失", () => {
  const deepNeedle = "DEEP-NEEDLE";
  const largeMessage = `${"A".repeat(80_000)}${deepNeedle}${"B".repeat(90_000)}`;

  const chunks = buildConversationSearchChunks([
    {
      role: "assistant",
      content: largeMessage,
    },
  ]);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.some((chunk) => chunk.includes(deepNeedle)));
});

test("search index 会同时返回摘要文本和完整 chunk 列表", () => {
  const result = buildConversationSearchIndex([
    {
      role: "user",
      content: "first message",
    },
    {
      role: "assistant",
      content: `${"x".repeat(10_000)}middle-marker${"y".repeat(10_000)}`,
    },
  ]);

  assert.ok(result.searchText);
  assert.ok((result.searchChunks?.length ?? 0) >= 2);
  assert.ok(result.searchChunks?.some((chunk) => chunk.includes("middle-marker")));
});

test("流式 search index builder 与批量构建结果保持一致", () => {
  const messages = [
    {
      role: "user" as const,
      content: "first message",
      timestamp: 1,
    },
    {
      role: "assistant" as const,
      content: `${"x".repeat(10_000)}stream-needle${"y".repeat(10_000)}`,
      timestamp: 2,
    },
  ];

  const builder = createConversationSearchIndexBuilder();
  for (const message of messages) {
    builder.addMessage(message);
  }

  assert.deepEqual(builder.build(), buildConversationSearchIndex(messages));
});
