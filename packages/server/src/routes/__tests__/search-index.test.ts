import test from "node:test";
import assert from "node:assert/strict";
import { buildConversationSearchText } from "../../utils/search-index.js";

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
