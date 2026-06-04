import { dirname, join } from "path";
import { getProviderConfigPath } from "../utils/provider-paths.js";
import type { ConversationBadge, ConversationMeta } from "./types.js";
import type { CodexThreadMetadata, CodexThreadRow } from "./codex-sqlite-client.js";
import { normalizePath } from "./shared/provider-utils.js";

export const CODEX_TITLE_FALLBACK_BADGE_LABEL = "标题回退";
export const CODEX_TITLE_GENERATION_BADGE_LABEL = "标题生成";

const CODEX_WEAK_TITLE_SET = new Set(["hi", "hello", "hey", "你好", "您好", "嗨", "哈喽"]);

export function normalizeCodexDisplayText(value?: string | null): string | undefined {
  const normalized = value?.replace(/<[^>]+>/g, "").trim();
  return normalized ? normalized : undefined;
}

function normalizeCodexPathForCompare(value?: string | null): string {
  return normalizePath(value ?? "").replace(/^\/\/\?\//, "").toLowerCase();
}

function getCodexTitleSessionProjectPath(): string {
  return join(dirname(getProviderConfigPath()), "ai-title-sessions", "codex");
}

export function isCodexTitleGenerationProject(value?: string | null): boolean {
  const normalized = normalizeCodexPathForCompare(value);
  return !!normalized && normalized === normalizeCodexPathForCompare(getCodexTitleSessionProjectPath());
}

export function isWeakCodexTitle(value?: string | null): boolean {
  const normalized = normalizeCodexDisplayText(value)
    ?.toLowerCase()
    .replace(/[!！.。?？,，~～]+$/g, "");
  return !!normalized && CODEX_WEAK_TITLE_SET.has(normalized);
}

function isUsableCodexTitle(value?: string | null): value is string {
  const normalized = normalizeCodexDisplayText(value);
  return !!normalized && normalized !== "未知对话" && !isWeakCodexTitle(normalized);
}

export function pickUsableCodexTitle(values: Array<string | null | undefined>): string | null {
  return values.map((value) => normalizeCodexDisplayText(value)).find(isUsableCodexTitle) ?? null;
}

export function hasUsableCodexTitle(values: Array<string | null | undefined>): boolean {
  return pickUsableCodexTitle(values) !== null;
}

export function pickCodexConversationTitle(options: {
  managedTitle?: string;
  transcriptTitle?: string;
  nativeTitle?: string;
  firstUserMessage?: string;
  preview?: string;
  fallbackTitle?: string;
}): { title: string; usedFallback: boolean } {
  const managedTitle = normalizeCodexDisplayText(options.managedTitle);
  if (managedTitle) {
    return { title: managedTitle, usedFallback: false };
  }

  const transcriptTitle = normalizeCodexDisplayText(options.transcriptTitle);
  const nativeTitle = normalizeCodexDisplayText(options.nativeTitle);
  const firstUserMessage = normalizeCodexDisplayText(options.firstUserMessage);
  const preview = normalizeCodexDisplayText(options.preview);
  const fallbackTitle = normalizeCodexDisplayText(options.fallbackTitle);
  const nativeDisplayTitle = pickUsableCodexTitle([nativeTitle, firstUserMessage, preview]);
  if (nativeDisplayTitle) {
    return { title: nativeDisplayTitle, usedFallback: false };
  }

  if (transcriptTitle && !isWeakCodexTitle(transcriptTitle)) {
    return { title: transcriptTitle, usedFallback: false };
  }

  const canUseFallback = !!fallbackTitle && !isWeakCodexTitle(fallbackTitle);
  const nativeTitleIsWeak = !!nativeTitle && isWeakCodexTitle(nativeTitle);
  const nativeLooksOriginal = !firstUserMessage || firstUserMessage === nativeTitle || isWeakCodexTitle(firstUserMessage);

  if (nativeTitle && (!nativeTitleIsWeak || !nativeLooksOriginal || !canUseFallback)) {
    return { title: nativeTitle, usedFallback: false };
  }

  if (canUseFallback) {
    return { title: fallbackTitle, usedFallback: !!nativeTitle };
  }

  return { title: nativeTitle || fallbackTitle || "未知对话", usedFallback: false };
}

export function buildCodexTitleFallbackBadges(): ConversationBadge[] {
  return [{
    label: CODEX_TITLE_FALLBACK_BADGE_LABEL,
    tone: "amber",
    title: "Codex 原生 title 是问候语，ChatLog Viewer 改用 transcript 中后续有效用户问题作为展示标题",
  }];
}

export function buildCodexTitleGenerationBadges(): ConversationBadge[] {
  return [{
    label: CODEX_TITLE_GENERATION_BADGE_LABEL,
    tone: "cyan",
    title: "ChatLog Viewer AI 标题生成产生的 Codex session",
  }];
}

export function mergeCodexBadges(...groups: Array<ConversationBadge[] | undefined>): ConversationBadge[] | undefined {
  const badges = groups.flatMap((group) => group ?? []);
  return badges.length > 0 ? badges : undefined;
}

export function hasCodexTitleFallbackBadge(meta?: ConversationMeta): boolean {
  return meta?.badges?.some((badge) => badge.label === CODEX_TITLE_FALLBACK_BADGE_LABEL) ?? false;
}

export function hasCodexTitleGenerationBadge(meta?: ConversationMeta): boolean {
  return meta?.badges?.some((badge) => badge.label === CODEX_TITLE_GENERATION_BADGE_LABEL) ?? false;
}

export function isCodexNativeOriginalWeakTitle(metadata: CodexThreadMetadata): boolean {
  const nativeTitle = normalizeCodexDisplayText(metadata.title);
  const firstUserMessage = normalizeCodexDisplayText(metadata.firstUserMessage);
  return !!nativeTitle
    && isWeakCodexTitle(nativeTitle)
    && (!firstUserMessage || firstUserMessage === nativeTitle || isWeakCodexTitle(firstUserMessage));
}

export function buildCodexTitleGenerationHint(thread: CodexThreadRow): string | undefined {
  const parts = [
    normalizeCodexDisplayText(thread.title) ? `现有标题: ${normalizeCodexDisplayText(thread.title)}` : undefined,
    normalizeCodexDisplayText(thread.firstUserMessage)
      ? `首条用户消息摘要: ${normalizeCodexDisplayText(thread.firstUserMessage)}`
      : undefined,
    normalizePath(thread.cwd || "") ? `项目目录: ${normalizePath(thread.cwd || "")}` : undefined,
    thread.modelProvider ? `Codex provider: ${thread.modelProvider}` : undefined,
  ].filter((item): item is string => !!item);

  if (parts.length === 0) return undefined;
  return `当前对话缺少 transcript，请仅根据以下 metadata 生成标题：\n${parts.join("\n")}`;
}
