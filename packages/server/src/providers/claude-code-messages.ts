import {
  assignStableMessageIds,
  createMessageSourceKey,
  createStableMessageSourceKey,
  type MessageRecord,
} from "../utils/message-actions.js";
import type { ConversationSearchIndexBuilder } from "../utils/search-index.js";
import type { JsonlLine } from "../utils/jsonl.js";
import type { Message } from "./types.js";
import type { ClaudeCodeContentBlock, ClaudeCodeEntry, ClaudeCodeSessionSource } from "./claude-code-types.js";

// Claude Code transcript 的消息层解析：内容块提取、稳定消息记录构建与搜索索引条目。
// 纯函数集合，不持有 provider 状态。

export function extractTextContent(
  content: string | ClaudeCodeContentBlock[]
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

export function extractToolCalls(
  content: ClaudeCodeContentBlock[]
): Message[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      role: "tool" as const,
      content: "",
      toolName: b.name || "unknown",
      toolInput: typeof b.input === "string" ? b.input : JSON.stringify(b.input, null, 2),
    }));
}

export function isPureTextContent(content: string | ClaudeCodeContentBlock[]): boolean {
  return typeof content === "string"
    || (Array.isArray(content) && content.every((block) => block.type === "text"));
}

export function buildMessageRecords(entries: JsonlLine<ClaudeCodeEntry>[]): MessageRecord<ClaudeCodeEntry>[] {
  const records: MessageRecord<ClaudeCodeEntry>[] = [];
  for (const entry of entries) {
    const value = entry.value;
    if (value.isSidechain || value.isMeta) continue;
    if (!value.message) continue;
    if (value.type === "system") continue;

    if (value.type === "user") {
      const text = extractTextContent(value.message.content);
      if (!text.trim() || text.includes("<local-command-") || text.includes("<command-name>") || text.includes("<local-command-stdout>")) continue;
      const cleanText = text.replace(/<[^>]+>/g, "").trim();
      if (!cleanText) continue;
      records.push({
        entry: value,
        sourceKey: isPureTextContent(value.message.content)
          ? createStableMessageSourceKey(
            "claude-code",
            [
              value.uuid,
              value.message.id,
              value.messageId,
              value.sessionId,
              value.timestamp,
              value.type,
              Array.isArray(value.message.content)
                ? value.message.content.map((block) => block.type).join(",")
                : "text",
            ],
            entry.rawLine
          ) ?? createMessageSourceKey(entry.rawLine, "claude-code")
          : undefined,
        lineIndex: entry.lineNumber,
        message: {
          role: "user",
          content: cleanText,
          timestamp: value.timestamp ? new Date(value.timestamp).getTime() : undefined,
        },
      });
    } else if (value.type === "assistant") {
      const text = extractTextContent(value.message.content);
      if (text.trim() && !text.startsWith("No response requested")) {
        records.push({
          entry: value,
          sourceKey: isPureTextContent(value.message.content)
            ? createStableMessageSourceKey(
              "claude-code",
              [
                value.uuid,
                value.message.id,
                value.messageId,
                value.sessionId,
                value.timestamp,
                value.type,
                Array.isArray(value.message.content)
                  ? value.message.content.map((block) => block.type).join(",")
                  : "text",
              ],
              entry.rawLine
            ) ?? createMessageSourceKey(entry.rawLine, "claude-code")
            : undefined,
          lineIndex: entry.lineNumber,
          message: {
            role: "assistant",
            content: text,
            timestamp: value.timestamp ? new Date(value.timestamp).getTime() : undefined,
          },
        });
      }
      if (Array.isArray(value.message.content)) {
        const tools = extractToolCalls(value.message.content);
        for (const tool of tools) {
          records.push({
            entry: value,
            message: tool,
          });
        }
      }
    }
  }

  return assignStableMessageIds(records);
}

export function appendSearchIndexEntry(
  builder: ConversationSearchIndexBuilder,
  entry: ClaudeCodeEntry
): void {
  if (entry.isSidechain || entry.isMeta) return;
  if (!entry.message) return;
  if (entry.type === "system") return;

  if (entry.type === "user") {
    const text = extractTextContent(entry.message.content);
    if (
      !text.trim()
      || text.includes("<local-command-")
      || text.includes("<command-name>")
      || text.includes("<local-command-stdout>")
    ) {
      return;
    }

    const cleanText = text.replace(/<[^>]+>/g, "").trim();
    if (!cleanText) return;

    builder.addMessage({
      role: "user",
      content: cleanText,
      timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : undefined,
    });
    return;
  }

  if (entry.type === "assistant") {
    const text = extractTextContent(entry.message.content);
    if (text.trim() && !text.startsWith("No response requested")) {
      builder.addMessage({
        role: "assistant",
        content: text,
        timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : undefined,
      });
    }
  }
}

export function buildHistoryFallbackMessages(source: ClaudeCodeSessionSource): Message[] {
  const messages = source.historySession?.messages ?? [];
  const notice: Message = {
    role: "system",
    content: "当前 Claude Code 会话未在本地保留完整 transcript，以下仅显示 history.jsonl 中记录的用户输入。",
  };

  if (messages.length === 0) {
    return [notice];
  }

  return [notice, ...messages];
}
