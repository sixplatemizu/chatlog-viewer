import type { Message } from "../providers/types.js";

const SEARCH_TEXT_MAX_LENGTH = 256 * 1024;
const SEARCH_PART_MAX_LENGTH = 12 * 1024;
const SEARCH_PART_SAMPLE_WINDOW_COUNT = 3;
const SEARCH_PART_DISTRIBUTION_LIMIT = 48;
const LARGE_MESSAGE_TEXT_THRESHOLD = 512 * 1024;
const SEARCH_WINDOW_SEPARATOR = "\n\n...\n\n";
const SEARCH_PRIORITY_RATIOS = [0, 0.5, 1, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875];

function collectUniqueParts(messages: Message[]): string[] {
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const message of messages) {
    const content = message.content.trim();
    if (!content) continue;

    const key = `${message.role}:${message.timestamp ?? ""}:${content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(content);
  }

  return parts;
}

function clampWindowLength(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const headLength = Math.floor(maxLength / 2);
  const tailLength = maxLength - headLength;
  return `${text.slice(0, headLength)}\n\n...\n\n${text.slice(-tailLength)}`;
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

export function buildConversationSearchText(messages: Message[]): string | undefined {
  const parts = collectUniqueParts(messages);
  if (parts.length === 0) {
    return undefined;
  }

  const text = parts.join("\n\n").trim();
  if (!text) {
    return undefined;
  }

  if (text.length <= LARGE_MESSAGE_TEXT_THRESHOLD) {
    return buildBudgetedSearchText(parts);
  }

  return buildBudgetedSearchText(parts);
}
