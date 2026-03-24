import type { Message } from "../providers/types.js";

export const SEARCH_INDEX_VERSION = 3;

const SEARCH_TEXT_MAX_LENGTH = 256 * 1024;
const SEARCH_PART_MAX_LENGTH = 12 * 1024;
const SEARCH_PART_SAMPLE_WINDOW_COUNT = 3;
const SEARCH_PART_DISTRIBUTION_LIMIT = 48;
const SEARCH_WINDOW_SEPARATOR = "\n\n...\n\n";
const SEARCH_PRIORITY_RATIOS = [0, 0.5, 1, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875];
const SEARCH_CHUNK_MAX_LENGTH = 4096;
const SEARCH_CHUNK_OVERLAP = 256;

export interface ConversationSearchIndex {
  searchText?: string;
  searchChunks?: string[];
}

export interface ConversationSearchIndexBuilder {
  addMessage(message: Message): void;
  build(): ConversationSearchIndex;
}

function appendUniqueMessagePart(parts: string[], seen: Set<string>, message: Message): void {
  const content = message.content.trim();
  if (!content) return;

  const key = `${message.role}:${message.timestamp ?? ""}:${content}`;
  if (seen.has(key)) return;

  seen.add(key);
  parts.push(content);
}

function collectUniqueParts(messages: Message[]): string[] {
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const message of messages) {
    appendUniqueMessagePart(parts, seen, message);
  }

  return parts;
}

function clampWindowLength(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const headLength = Math.floor(maxLength / 2);
  const tailLength = maxLength - headLength;
  return `${text.slice(0, headLength)}${SEARCH_WINDOW_SEPARATOR}${text.slice(-tailLength)}`;
}

function sampleTextWindows(text: string, maxLength: number, windowCount: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const separatorBudget = SEARCH_WINDOW_SEPARATOR.length * Math.max(0, windowCount - 1);
  const segmentLength = Math.max(1, Math.floor((maxLength - separatorBudget) / windowCount));
  const windows: string[] = [];
  const maxStart = Math.max(0, text.length - segmentLength);

  for (let index = 0; index < windowCount; index++) {
    const ratio = windowCount === 1 ? 0 : index / (windowCount - 1);
    const start = Math.floor(maxStart * ratio);
    const chunk = text.slice(start, start + segmentLength).trim();
    if (!chunk) continue;
    windows.push(chunk);
  }

  const sampledText = windows.join(SEARCH_WINDOW_SEPARATOR).trim();
  return sampledText || clampWindowLength(text, maxLength);
}

function normalizeSearchPart(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.length <= SEARCH_PART_MAX_LENGTH) {
    return trimmed;
  }

  return sampleTextWindows(trimmed, SEARCH_PART_MAX_LENGTH, SEARCH_PART_SAMPLE_WINDOW_COUNT);
}

function buildDistributedIndices(length: number): number[] {
  const indices: number[] = [];
  const push = (index: number) => {
    if (index < 0 || index >= length || indices.includes(index)) return;
    indices.push(index);
  };

  for (const ratio of SEARCH_PRIORITY_RATIOS) {
    push(Math.floor((length - 1) * ratio));
  }

  const edgeCount = Math.min(4, length);
  for (let index = 0; index < edgeCount; index++) {
    push(index);
  }
  for (let index = edgeCount; index > 0; index--) {
    push(length - index);
  }

  const middleSlots = Math.max(0, Math.min(length, SEARCH_PART_DISTRIBUTION_LIMIT) - indices.length);
  for (let slot = 0; slot < middleSlots; slot++) {
    const index = Math.floor(((slot + 1) * (length - 1)) / (middleSlots + 1));
    push(index);
  }

  for (let index = 0; index < length; index++) {
    push(index);
  }

  return indices;
}

function buildBudgetedSearchText(parts: string[]): string {
  const normalizedParts = parts
    .map(normalizeSearchPart)
    .filter(Boolean);

  if (normalizedParts.length === 0) {
    return "";
  }

  const fullText = normalizedParts.join("\n\n").trim();
  if (fullText.length <= SEARCH_TEXT_MAX_LENGTH) {
    return fullText;
  }

  let totalLength = 0;
  const selectedParts: string[] = [];

  for (const index of buildDistributedIndices(normalizedParts.length)) {
    const part = normalizedParts[index];
    const separatorLength = selectedParts.length > 0 ? 2 : 0;
    const nextLength = totalLength + separatorLength + part.length;

    if (nextLength > SEARCH_TEXT_MAX_LENGTH) {
      continue;
    }

    selectedParts.push(part);
    totalLength = nextLength;

    if (totalLength >= SEARCH_TEXT_MAX_LENGTH) {
      break;
    }
  }

  return clampWindowLength(selectedParts.join("\n\n").trim() || fullText, SEARCH_TEXT_MAX_LENGTH);
}

function splitIntoChunks(text: string, maxLength: number, overlap: number): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }

  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  const step = Math.max(1, maxLength - overlap);
  for (let start = 0; start < normalized.length; start += step) {
    const chunk = normalized.slice(start, start + maxLength).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (start + maxLength >= normalized.length) {
      break;
    }
  }

  return chunks;
}

function buildConversationSearchChunksFromParts(parts: string[]): string[] {
  if (parts.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const chunks: string[] = [];

  for (const part of parts) {
    for (const chunk of splitIntoChunks(part, SEARCH_CHUNK_MAX_LENGTH, SEARCH_CHUNK_OVERLAP)) {
      if (seen.has(chunk)) continue;
      seen.add(chunk);
      chunks.push(chunk);
    }
  }

  return chunks;
}

export function buildConversationSearchChunks(messages: Message[]): string[] {
  return buildConversationSearchChunksFromParts(collectUniqueParts(messages));
}

class SearchIndexBuilderImpl implements ConversationSearchIndexBuilder {
  private readonly seen = new Set<string>();
  private readonly parts: string[] = [];

  addMessage(message: Message): void {
    appendUniqueMessagePart(this.parts, this.seen, message);
  }

  build(): ConversationSearchIndex {
    if (this.parts.length === 0) {
      return {};
    }

    const searchText = buildBudgetedSearchText(this.parts).trim() || undefined;
    const searchChunks = buildConversationSearchChunksFromParts(this.parts);

    return {
      searchText,
      searchChunks: searchChunks.length > 0 ? searchChunks : undefined,
    };
  }
}

export function createConversationSearchIndexBuilder(): ConversationSearchIndexBuilder {
  return new SearchIndexBuilderImpl();
}

export function buildConversationSearchIndex(messages: Message[]): ConversationSearchIndex {
  const builder = createConversationSearchIndexBuilder();
  for (const message of messages) {
    builder.addMessage(message);
  }
  return builder.build();
}

export function buildConversationSearchText(messages: Message[]): string | undefined {
  return buildConversationSearchIndex(messages).searchText;
}
