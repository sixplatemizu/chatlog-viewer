import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Message } from "../providers/types.js";

export interface MessageRecord<TEntry> {
  entry: TEntry;
  message: Message;
  sourceKey?: string;
  lineIndex?: number;
}

interface MessageActionIndexEntry {
  mtimeMs: number;
  lineByMessageId: Map<string, number>;
}

type JsonlFileChange = string | null | ((line: string) => string | null);

const messageActionIndexCache = new Map<string, MessageActionIndexEntry>();

export function createMessageSourceKey(value: string, suffix = "text"): string {
  const normalized = value.trim();
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 16);
  return `${suffix}:${hash}`;
}

export function createStableMessageSourceKey(
  prefix: string,
  stableParts: Array<string | number | null | undefined>,
  fallbackValue?: string
): string | undefined {
  const normalized = stableParts
    .map((part) => {
      if (part === null || part === undefined) {
        return "";
      }
      return typeof part === "string" ? part.trim() : String(part);
    })
    .filter(Boolean)
    .join("\u0000");

  if (normalized) {
    return createMessageSourceKey(normalized, prefix);
  }

  if (fallbackValue) {
    return createMessageSourceKey(fallbackValue, prefix);
  }

  return undefined;
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

export function primeMessageActionIndex<TEntry>(
  filePath: string,
  mtimeMs: number,
  records: MessageRecord<TEntry>[]
): void {
  const lineByMessageId = new Map<string, number>();

  for (const record of records) {
    const messageId = record.message.messageId;
    if (!messageId || !record.lineIndex) continue;
    lineByMessageId.set(messageId, record.lineIndex);
  }

  messageActionIndexCache.set(filePath, {
    mtimeMs,
    lineByMessageId,
  });
}

export function getMessageActionLineNumbers(
  filePath: string,
  mtimeMs: number,
  messageIds: string[]
): number[] | null {
  const entry = messageActionIndexCache.get(filePath);
  if (!entry || entry.mtimeMs !== mtimeMs) {
    return null;
  }

  const lineNumbers: number[] = [];
  for (const messageId of messageIds) {
    const lineNumber = entry.lineByMessageId.get(messageId);
    if (!lineNumber) {
      return null;
    }
    lineNumbers.push(lineNumber);
  }

  return lineNumbers;
}

export function invalidateMessageActionIndex(filePath: string): void {
  messageActionIndexCache.delete(filePath);
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

async function inspectJsonlFile(filePath: string): Promise<{ newline: string; trailingNewline: boolean }> {
  const handle = await open(filePath, "r");

  try {
    const stats = await handle.stat();
    const headLength = Math.min(4096, Math.max(stats.size, 0));
    const tailLength = Math.min(4096, Math.max(stats.size, 0));
    const headBuffer = Buffer.alloc(headLength);
    const tailBuffer = Buffer.alloc(tailLength);

    if (headLength > 0) {
      await handle.read(headBuffer, 0, headLength, 0);
    }
    if (tailLength > 0) {
      await handle.read(tailBuffer, 0, tailLength, Math.max(0, stats.size - tailLength));
    }

    const headText = headBuffer.toString("utf-8");
    const tailText = tailBuffer.toString("utf-8");
    return {
      newline: headText.includes("\r\n") ? "\r\n" : "\n",
      trailingNewline: tailText.endsWith("\n"),
    };
  } finally {
    await handle.close();
  }
}

async function replaceJsonlFile(
  filePath: string,
  changes: Map<number, JsonlFileChange>
): Promise<void> {
  const normalizedChanges = new Map<number, JsonlFileChange>();
  for (const [lineNumber, nextLine] of changes) {
    if (!Number.isInteger(lineNumber) || lineNumber <= 0) {
      throw new Error(`无效的消息行号: ${lineNumber}`);
    }
    normalizedChanges.set(lineNumber, nextLine);
  }
  if (normalizedChanges.size === 0) {
    return;
  }

  const { newline, trailingNewline } = await inspectJsonlFile(filePath);
  const tempDir = dirname(filePath);
  const tempFile = join(tempDir, `.rewrite-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await mkdir(tempDir, { recursive: true });

  const reader = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  const writer = createWriteStream(tempFile, { encoding: "utf-8" });

  const matched = new Set<number>();
  let lineNumber = 0;
  let wroteAny = false;

  const writeLine = async (line: string): Promise<void> => {
    const chunk = `${wroteAny ? newline : ""}${line}`;
    if (!writer.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        writer.once("drain", resolve);
        writer.once("error", reject);
      });
    }
    wroteAny = true;
  };

  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (normalizedChanges.has(lineNumber)) {
        matched.add(lineNumber);
        const nextLine = normalizedChanges.get(lineNumber) ?? null;
        const resolvedLine = typeof nextLine === "function"
          ? nextLine(line)
          : nextLine;
        if (resolvedLine !== null) {
          await writeLine(resolvedLine);
        }
        continue;
      }

      await writeLine(line);
    }

    const missingLine = [...normalizedChanges.keys()].find((value) => !matched.has(value));
    if (missingLine !== undefined) {
      throw new Error(`无效的消息行号: ${missingLine}`);
    }

    if (wroteAny && trailingNewline) {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        writer.once("error", onError);
        writer.end(newline, () => {
          writer.off("error", onError);
          resolve();
        });
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        writer.once("error", onError);
        writer.end(() => {
          writer.off("error", onError);
          resolve();
        });
      });
    }

    await copyFile(tempFile, filePath);
  } catch (error) {
    reader.close();
    writer.destroy();
    await rm(tempFile, { force: true });
    throw error;
  }

  await rm(tempFile, { force: true });
}

export async function rewriteJsonlFileLine(
  filePath: string,
  lineNumber: number,
  nextLine: JsonlFileChange
): Promise<void> {
  await replaceJsonlFile(filePath, new Map([[lineNumber, nextLine]]));
}

export async function rewriteJsonlFileLines(
  filePath: string,
  lineNumbers: number[]
): Promise<void> {
  await replaceJsonlFile(
    filePath,
    new Map([...new Set(lineNumbers)].map((lineNumber) => [lineNumber, null]))
  );
}
