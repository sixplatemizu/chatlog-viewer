import { createHash } from "node:crypto";
import type { Message } from "../providers/types.js";

export interface MessageRecord<TEntry> {
  entry: TEntry;
  message: Message;
  sourceKey?: string;
  lineIndex?: number;
}

export function createMessageSourceKey(rawLine: string, suffix = "text"): string {
  const normalized = rawLine.trim();
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 16);
  return `${suffix}:${hash}`;
}

export function assignStableMessageIds<TEntry>(
  records: MessageRecord<TEntry>[]
): MessageRecord<TEntry>[] {
  const counters = new Map<string, number>();

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const sourceKey = records[index]?.sourceKey;
    if (!sourceKey) continue;

    const nextCount = (counters.get(sourceKey) ?? 0) + 1;
    counters.set(sourceKey, nextCount);

    const message = records[index]?.message;
    if (!message) continue;

    message.messageId = `${sourceKey}:${nextCount}`;
    message.editable = true;
    message.deletable = true;
  }

  return records;
}

export function normalizeUpdatedMessageContent(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    throw new Error("消息内容不能为空");
  }
  return normalized;
}

export function rewriteJsonlLine(
  content: string,
  lineNumber: number,
  nextLine: string | null
): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);

  if (trailingNewline && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const lineIndex = lineNumber - 1;
  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error(`无效的消息行号: ${lineNumber}`);
  }

  if (nextLine === null) {
    lines.splice(lineIndex, 1);
  } else {
    lines[lineIndex] = nextLine;
  }

  if (lines.length === 0) {
    return "";
  }

  const rewritten = lines.join(newline);
  return trailingNewline ? `${rewritten}${newline}` : rewritten;
}

export function rewriteJsonlLines(
  content: string,
  lineNumbers: number[]
): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);

  if (trailingNewline && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const uniqueLineIndexes = [...new Set(lineNumbers)]
    .map((lineNumber) => {
      const lineIndex = lineNumber - 1;
      if (lineIndex < 0 || lineIndex >= lines.length) {
        throw new Error(`无效的消息行号: ${lineNumber}`);
      }
      return lineIndex;
    })
    .sort((a, b) => b - a);

  for (const lineIndex of uniqueLineIndexes) {
    lines.splice(lineIndex, 1);
  }

  if (lines.length === 0) {
    return "";
  }

  const rewritten = lines.join(newline);
  return trailingNewline ? `${rewritten}${newline}` : rewritten;
}
