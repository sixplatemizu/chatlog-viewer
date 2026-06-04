import { dirname, join } from "path";
import { mkdir, rename, stat, unlink, readFile, writeFile } from "fs/promises";
import { glob } from "glob";
import {
  parseJsonlWithMeta,
  parseJsonlHead,
  parseJsonlTailWithMeta,
  countLines,
  visitJsonl,
  type JsonlLine,
} from "../utils/jsonl.js";
import {
  deletePersistedCodexMessageIdentity,
  getCached,
  getIndexedCacheSnapshot,
  getIndexedListCache,
  getPersistedCodexMessageIdentity,
  hasIndexedSearchData,
  setCache,
  setIndexedListCache,
  setPersistedCodexMessageIdentity,
  invalidateCache,
  invalidateListCache,
  type IndexedCacheItem,
} from "../utils/cache.js";
import { logProviderError } from "../utils/logger.js";
import { getProviderConfigPath, getProviderPaths } from "../utils/provider-paths.js";
import { isNotFoundError } from "../utils/errors.js";
import {
  collectGlobFileStates,
  collectIndexedCacheItemsInBatches,
  createIndexedListSourceSignature,
} from "../utils/provider-indexing.js";
import {
  createConversationSearchIndexBuilder,
  type ConversationSearchIndex,
  type ConversationSearchIndexBuilder,
} from "../utils/search-index.js";
import { getNativeTitle } from "../utils/title-store.js";
import {
  assignStableMessageIds,
  createMessageSourceKey,
  createStableMessageSourceKey,
  getMessageActionLineNumbers,
  invalidateMessageActionIndex,
  normalizeUpdatedMessageContent,
  primeMessageActionIndex,
  rewriteJsonlFileLine,
  rewriteJsonlFileLines,
  type MessageRecord,
} from "../utils/message-actions.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
  ConversationBadge,
  ConversationReadOptions,
  ConversationListOptions,
} from "./types.js";
import {
  CodexSqliteClient,
  formatCodexStoredPath,
  type CodexThreadMetadata,
  type CodexThreadRow,
} from "./codex-sqlite-client.js";
import { upsertCodexSessionIndexThreadName } from "./codex-session-index.js";
import { normalizePath, canonicalizeProjectPath, canonicalizeProjectPathResolvingSymlinks, getListCacheKey, sliceWindow } from "./shared/provider-utils.js";

interface CodexEntry {
  timestamp: string;
  type: "session_meta" | "response_item" | "event_msg" | "turn_context";
  payload: {
    id?: string;
    cwd?: string;
    type?: string;
    role?: string;
    message?: string;
    kind?: string;
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    [key: string]: unknown;
  };
}

interface CodexMessageIdentityCacheEntry {
  mtimeMs: number;
  orderedMessageIds: string[];
  lineByMessageId: Map<string, number>;
}

const CODEX_STATE_ONLY_PREFIX = "codex-state://";
const CODEX_LIST_SOURCE_VERSION = "codex-list-v12-fork-explicit-title";
const CODEX_TITLE_FALLBACK_BADGE_LABEL = "标题回退";
const CODEX_TITLE_GENERATION_BADGE_LABEL = "标题生成";
const CODEX_WEAK_TITLE_SET = new Set(["hi", "hello", "hey", "你好", "您好", "嗨", "哈喽"]);
const codexMessageIdentityCache = new Map<string, CodexMessageIdentityCacheEntry>();

export function clearCodexMessageIdentityCacheForTests(): void {
  codexMessageIdentityCache.clear();
}

function extractContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => (c.type === "input_text" || c.type === "output_text") && c.text)
    .map((c) => c.text!)
    .join("\n");
}

function getDisplayableCodexResponseContent(entry: CodexEntry): string | null {
  if (entry.type !== "response_item" || !entry.payload?.role) return null;

  const role = entry.payload.role as "user" | "assistant";
  if (role !== "user" && role !== "assistant") return null;

  const content = entry.payload.content
    ? extractContent(entry.payload.content)
    : "";
  if (content.includes("<environment_context>")) return null;
  if (!content.trim()) return null;
  return content;
}

function normalizeCodexDisplayText(value?: string | null): string | undefined {
  const normalized = value?.replace(/<[^>]+>/g, "").trim();
  return normalized ? normalized : undefined;
}

function normalizeCodexPathForCompare(value?: string | null): string {
  return normalizePath(value ?? "").replace(/^\/\/\?\//, "").toLowerCase();
}

function getCodexTitleSessionProjectPath(): string {
  return join(dirname(getProviderConfigPath()), "ai-title-sessions", "codex");
}

function isCodexTitleGenerationProject(value?: string | null): boolean {
  const normalized = normalizeCodexPathForCompare(value);
  return !!normalized && normalized === normalizeCodexPathForCompare(getCodexTitleSessionProjectPath());
}

function isWeakCodexTitle(value?: string | null): boolean {
  const normalized = normalizeCodexDisplayText(value)
    ?.toLowerCase()
    .replace(/[!！.。?？,，~～]+$/g, "");
  return !!normalized && CODEX_WEAK_TITLE_SET.has(normalized);
}

function isUsableCodexTitle(value?: string | null): value is string {
  const normalized = normalizeCodexDisplayText(value);
  return !!normalized && normalized !== "未知对话" && !isWeakCodexTitle(normalized);
}

function pickUsableCodexTitle(values: Array<string | null | undefined>): string | null {
  return values.map((value) => normalizeCodexDisplayText(value)).find(isUsableCodexTitle) ?? null;
}

function hasUsableCodexTitle(values: Array<string | null | undefined>): boolean {
  return pickUsableCodexTitle(values) !== null;
}

function getCodexForkedFromId(entry?: CodexEntry): string {
  const value = entry?.payload?.forked_from_id ?? entry?.payload?.forkedFromId;
  return typeof value === "string" ? value.trim() : "";
}

function pickCodexConversationTitle(options: {
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

function buildCodexTitleFallbackBadges(): ConversationBadge[] {
  return [{
    label: CODEX_TITLE_FALLBACK_BADGE_LABEL,
    tone: "amber",
    title: "Codex 原生 title 是问候语，ChatLog Viewer 改用 transcript 中后续有效用户问题作为展示标题",
  }];
}

function buildCodexTitleGenerationBadges(): ConversationBadge[] {
  return [{
    label: CODEX_TITLE_GENERATION_BADGE_LABEL,
    tone: "cyan",
    title: "ChatLog Viewer AI 标题生成产生的 Codex session",
  }];
}

function mergeCodexBadges(...groups: Array<ConversationBadge[] | undefined>): ConversationBadge[] | undefined {
  const badges = groups.flatMap((group) => group ?? []);
  return badges.length > 0 ? badges : undefined;
}

function hasCodexTitleFallbackBadge(meta?: ConversationMeta): boolean {
  return meta?.badges?.some((badge) => badge.label === CODEX_TITLE_FALLBACK_BADGE_LABEL) ?? false;
}

function hasCodexTitleGenerationBadge(meta?: ConversationMeta): boolean {
  return meta?.badges?.some((badge) => badge.label === CODEX_TITLE_GENERATION_BADGE_LABEL) ?? false;
}

function isCodexNativeOriginalWeakTitle(metadata: CodexThreadMetadata): boolean {
  const nativeTitle = normalizeCodexDisplayText(metadata.title);
  const firstUserMessage = normalizeCodexDisplayText(metadata.firstUserMessage);
  return !!nativeTitle
    && isWeakCodexTitle(nativeTitle)
    && (!firstUserMessage || firstUserMessage === nativeTitle || isWeakCodexTitle(firstUserMessage));
}

function isReusableCodexMetaHint(
  metaHint: ConversationMeta | undefined,
  fileStat: { mtimeMs: number; size: number },
  threadMetadata: CodexThreadMetadata
): metaHint is ConversationMeta {
  if (!metaHint) return false;
  if (isCodexTitleGenerationProject(metaHint.project) && !hasCodexTitleGenerationBadge(metaHint)) return false;
  if (metaHint.updatedAt !== fileStat.mtimeMs || metaHint.fileSize !== fileStat.size) return false;
  if (metaHint.modelProvider !== threadMetadata.modelProvider) return false;

  const nativeTitle = normalizeCodexDisplayText(threadMetadata.title);
  if (!nativeTitle) {
    return !hasCodexTitleFallbackBadge(metaHint);
  }

  if (isCodexNativeOriginalWeakTitle(threadMetadata)) {
    return hasCodexTitleFallbackBadge(metaHint);
  }

  return metaHint.title === nativeTitle;
}

function getCodexUserTitleCandidate(entry?: CodexEntry): string {
  if (!entry) return "";
  if (
    entry.type === "event_msg"
    && entry.payload?.type === "user_message"
    && typeof entry.payload.message === "string"
  ) {
    return entry.payload.message.trim().slice(0, 100);
  }

  if (entry.type === "response_item" && entry.payload?.role === "user" && Array.isArray(entry.payload.content)) {
    const content = extractContent(entry.payload.content).trim();
    if (!content || content.includes("<environment_context>")) return "";
    return content.slice(0, 100);
  }

  return "";
}

async function findCodexFallbackTitle(filePath: string): Promise<string> {
  let fallbackTitle = "";
  await visitJsonl<CodexEntry>(filePath, (entry) => {
    if (fallbackTitle) return;
    const candidateTitle = getCodexUserTitleCandidate(entry);
    if (candidateTitle && !isWeakCodexTitle(candidateTitle)) {
      fallbackTitle = candidateTitle;
    }
  });
  return fallbackTitle;
}

function buildCodexStateOnlyFilePath(sessionId: string, rolloutPath?: string): string {
  const normalizedRolloutPath = rolloutPath ? normalizePath(rolloutPath) : "";
  return normalizedRolloutPath || `${CODEX_STATE_ONLY_PREFIX}${sessionId}`;
}

function buildCodexStateOnlyBadges(): ConversationBadge[] {
  return [
    {
      label: "state db",
      tone: "green",
      title: "Codex state_5.sqlite 中存在 thread metadata，但未找到对应 transcript 文件",
    },
    {
      label: "无 transcript",
      tone: "gray",
      title: "本地未找到 Codex transcript，详情无法展示完整消息",
    },
  ];
}

function buildCodexTitleGenerationHint(thread: CodexThreadRow): string | undefined {
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

function formatCodexTimestampPathParts(timestampMs: number): {
  year: string;
  month: string;
  day: string;
  fileTimestamp: string;
} {
  const date = new Date(Number.isFinite(timestampMs) ? timestampMs : Date.now());
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return {
    year,
    month,
    day,
    fileTimestamp: `${year}-${month}-${day}T${hour}-${minute}-${second}`,
  };
}

function buildCodexTranscriptPath(storagePath: string, sessionId: string, createdAtMs: number): string {
  const timestamp = formatCodexTimestampPathParts(createdAtMs);
  return normalizePath(join(
    storagePath,
    timestamp.year,
    timestamp.month,
    timestamp.day,
    `rollout-${timestamp.fileTimestamp}-${sessionId}.jsonl`
  ));
}

function applyMessageActionFlags(records: MessageRecord<CodexEntry>[]): MessageRecord<CodexEntry>[] {
  for (const record of records) {
    if (!record.message.messageId) continue;
    record.message.editable = true;
    record.message.deletable = true;
  }
  return records;
}

function getCodexMessageIdentityCache(
  filePath: string,
  mtimeMs: number
): CodexMessageIdentityCacheEntry | undefined {
  const cached = codexMessageIdentityCache.get(filePath);
  if (cached?.mtimeMs === mtimeMs) {
    return cached;
  }

  const persisted = getPersistedCodexMessageIdentity(filePath, mtimeMs);
  if (!persisted) {
    return undefined;
  }

  codexMessageIdentityCache.set(filePath, persisted);
  return persisted;
}

function primeCodexMessageIdentityCache(
  filePath: string,
  mtimeMs: number,
  records: MessageRecord<CodexEntry>[]
): void {
  const orderedMessageIds: string[] = [];
  const lineByMessageId = new Map<string, number>();

  for (const record of records) {
    const messageId = record.message.messageId;
    if (!messageId) continue;
    orderedMessageIds.push(messageId);
    if (record.lineIndex) {
      lineByMessageId.set(messageId, record.lineIndex);
    }
  }

  codexMessageIdentityCache.set(filePath, {
    mtimeMs,
    orderedMessageIds,
    lineByMessageId,
  });
  setPersistedCodexMessageIdentity(filePath, {
    mtimeMs,
    orderedMessageIds,
    lineByMessageId,
  });
}

function invalidateCodexMessageIdentityCache(filePath: string): void {
  codexMessageIdentityCache.delete(filePath);
}

function hydrateCodexMessageIdsFromCache(
  filePath: string,
  mtimeMs: number,
  records: MessageRecord<CodexEntry>[]
): boolean {
  if (records.length === 0) return true;

  const cached = getCodexMessageIdentityCache(filePath, mtimeMs);
  if (!cached) {
    return false;
  }

  const allHaveLineNumbers = records.every((record) => record.lineIndex !== undefined);
  const hydratedIds: string[] = [];

  if (allHaveLineNumbers) {
    const messageIdByLineNumber = new Map<number, string>();
    for (const [messageId, lineNumber] of cached.lineByMessageId.entries()) {
      messageIdByLineNumber.set(lineNumber, messageId);
    }

    for (const record of records) {
      const lineIndex = record.lineIndex;
      if (!lineIndex) {
        return false;
      }
      const messageId = messageIdByLineNumber.get(lineIndex);
      if (!messageId) {
        return false;
      }
      hydratedIds.push(messageId);
    }
  } else {
    if (records.length > cached.orderedMessageIds.length) {
      return false;
    }
    hydratedIds.push(...cached.orderedMessageIds.slice(-records.length));
  }

  for (const [index, record] of records.entries()) {
    record.message.messageId = hydratedIds[index];
  }

  applyMessageActionFlags(records);
  return true;
}

function carryCodexMessageIdentityCacheAcrossEdit(
  filePath: string,
  previousMtimeMs: number,
  nextMtimeMs: number
): void {
  const cached = getCodexMessageIdentityCache(filePath, previousMtimeMs);
  if (!cached) {
    return;
  }

  codexMessageIdentityCache.set(filePath, {
    mtimeMs: nextMtimeMs,
    orderedMessageIds: [...cached.orderedMessageIds],
    lineByMessageId: new Map(cached.lineByMessageId),
  });
  setPersistedCodexMessageIdentity(filePath, {
    mtimeMs: nextMtimeMs,
    orderedMessageIds: [...cached.orderedMessageIds],
    lineByMessageId: new Map(cached.lineByMessageId),
  });
}

function carryCodexMessageIdentityCacheAcrossDelete(
  filePath: string,
  previousMtimeMs: number,
  nextMtimeMs: number,
  deletedMessageIds: string[]
): void {
  const cached = getCodexMessageIdentityCache(filePath, previousMtimeMs);
  if (!cached) {
    return;
  }

  const deletedSet = new Set(deletedMessageIds);
  const deletedLineNumbers = deletedMessageIds
    .map((messageId) => cached.lineByMessageId.get(messageId))
    .filter((lineNumber): lineNumber is number => Number.isInteger(lineNumber))
    .sort((a, b) => a - b);

  const nextOrderedMessageIds = cached.orderedMessageIds.filter((messageId) => !deletedSet.has(messageId));
  const nextLineByMessageId = new Map<string, number>();

  for (const messageId of nextOrderedMessageIds) {
    const lineNumber = cached.lineByMessageId.get(messageId);
    if (!lineNumber) continue;
    const shift = deletedLineNumbers.filter((deletedLine) => deletedLine < lineNumber).length;
    nextLineByMessageId.set(messageId, lineNumber - shift);
  }

  codexMessageIdentityCache.set(filePath, {
    mtimeMs: nextMtimeMs,
    orderedMessageIds: nextOrderedMessageIds,
    lineByMessageId: nextLineByMessageId,
  });
  setPersistedCodexMessageIdentity(filePath, {
    mtimeMs: nextMtimeMs,
    orderedMessageIds: nextOrderedMessageIds,
    lineByMessageId: nextLineByMessageId,
  });
}

function buildMessageRecords(
  entries: JsonlLine<CodexEntry>[],
  options?: {
    filePath?: string;
    mtimeMs?: number;
  }
): MessageRecord<CodexEntry>[] {
  const records: MessageRecord<CodexEntry>[] = [];
  for (const entry of entries) {
    const value = entry.value;
    const content = getDisplayableCodexResponseContent(value);
    if (content === null) continue;
    const role = value.payload.role as "user" | "assistant";

    records.push({
      entry: value,
      sourceKey: createStableMessageSourceKey(
        "codex",
        [
          value.payload.id,
          value.timestamp,
          role,
          value.payload.type,
          value.payload.kind,
          value.payload.content?.map((block) => block.type).join(","),
        ],
        entry.rawLine
      ) ?? createMessageSourceKey(entry.rawLine, "codex"),
      lineIndex: entry.lineNumber,
      message: {
        role,
        content,
        timestamp: new Date(value.timestamp).getTime(),
      },
    });
  }

  if (options?.filePath && options.mtimeMs !== undefined) {
    if (hydrateCodexMessageIdsFromCache(options.filePath, options.mtimeMs, records)) {
      return records;
    }
  }

  const assignedRecords = assignStableMessageIds(records);
  if (
    options?.filePath
    && options.mtimeMs !== undefined
    && assignedRecords.every((record) => record.lineIndex !== undefined)
  ) {
    primeCodexMessageIdentityCache(options.filePath, options.mtimeMs, assignedRecords);
  }
  return assignedRecords;
}

function appendSearchIndexEntry(
  builder: ConversationSearchIndexBuilder,
  entry: CodexEntry
): void {
  const content = getDisplayableCodexResponseContent(entry);
  if (content === null) return;
  const role = entry.payload.role as "user" | "assistant";

  builder.addMessage({
    role,
    content,
    timestamp: new Date(entry.timestamp).getTime(),
  });
}

export class CodexProvider implements ConversationProvider {
  name = "codex";
  displayName = "Codex";
  capabilities = {
    titleSyncMode: "native",
    canUpdateTitle: true,
    canGenerateTitle: true,
  } as const;

  private readonly sqliteClient = new CodexSqliteClient(() => this.getStateDbPath());
  private backgroundRefreshes = new Map<string, Promise<void>>();

  private getStateDbPath(): string {
    return getProviderPaths("codex").stateDbPath || join(this.getStoragePath(), "..", "state_5.sqlite");
  }

  // 测试 teardown 调用；关闭所有 SQLite 句柄以便 unlink DB 文件。
  private closeDb(): void {
    this.sqliteClient.close();
  }

  private getNormalizedStateDbPath(): string {
    return this.getStateDbPath().replace(/\\/g, "/");
  }

  private createListSourceSignature(fileStates: Array<{ path: string; mtimeMs: number; size: number }>): string {
    return createIndexedListSourceSignature([
      { path: CODEX_LIST_SOURCE_VERSION, mtimeMs: 0, size: 0 },
      ...fileStates,
    ]);
  }

  private async getListSourceFiles() {
    const pattern = join(this.getStoragePath(), "**", "*.jsonl").replace(/\\/g, "/");
    const fileStates = await collectGlobFileStates(pattern);

    const threadsSignature = this.sqliteClient.getThreadsSignature();
    if (threadsSignature) {
      fileStates.push({
        path: this.getNormalizedStateDbPath(),
        mtimeMs: Number.parseInt(threadsSignature.slice(0, 12), 16),
        size: Number.parseInt(threadsSignature.slice(12, 24), 16),
      });
      return fileStates;
    }

    try {
      const fileStat = await stat(this.getStateDbPath());
      fileStates.push({
        path: this.getNormalizedStateDbPath(),
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
      });
    } catch {
      // 允许缺失 state db，此时仅依赖 jsonl 目录。
    }

    return fileStates;
  }

  private buildStateOnlyMeta(thread: CodexThreadRow): ConversationMeta | null {
    const isTitleGenerationSession = isCodexTitleGenerationProject(thread.cwd);
    const normalizedCwd = canonicalizeProjectPathResolvingSymlinks(thread.cwd);
    const normalizedTitle = normalizeCodexDisplayText(thread.title);
    const normalizedFirstUserMessage = normalizeCodexDisplayText(thread.firstUserMessage);
    const fallbackTitle = normalizedTitle || normalizedFirstUserMessage;

    if (!fallbackTitle && !normalizedCwd) {
      return null;
    }

    const filePath = buildCodexStateOnlyFilePath(thread.id, thread.rolloutPath);
    return {
      id: `codex:${thread.id}`,
      provider: this.name,
      title: fallbackTitle || "未知对话",
      project: normalizedCwd,
      projectKey: normalizedCwd,
      projectId: normalizedCwd,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messageCount: 0,
      fileSize: 0,
      filePath,
      modelProvider: thread.modelProvider,
      transcriptMissing: true,
      contentStatus: "metadata-only",
      titleGenerationHint: buildCodexTitleGenerationHint(thread),
      badges: mergeCodexBadges(
        buildCodexStateOnlyBadges(),
        isTitleGenerationSession ? buildCodexTitleGenerationBadges() : undefined
      ),
    };
  }

  private writeThreadDisplayTitle(
    sessionId: string,
    title: string,
    options?: { updateTitleField?: boolean }
  ): void {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error("标题不能为空");
    }
    this.sqliteClient.writeDisplayTitle(sessionId, normalizedTitle, options);
  }

  private async getManagedTitle(sessionId: string): Promise<string | null> {
    return normalizeCodexDisplayText(await getNativeTitle(`codex:${sessionId}`)) ?? null;
  }

  private async syncThreadDisplayTitleFromManagedTitle(
    sessionId: string,
    managedTitle: string,
    transcriptTitle: string | undefined,
    threadMetadata: CodexThreadMetadata,
    filePath: string
  ): Promise<boolean> {
    const normalizedTitle = managedTitle.trim();
    if (!normalizedTitle) return false;

    if (
      normalizeCodexDisplayText(threadMetadata.title) !== normalizedTitle
      || normalizeCodexDisplayText(threadMetadata.firstUserMessage) !== normalizedTitle
      || normalizeCodexDisplayText(threadMetadata.preview) !== normalizedTitle
    ) {
      try {
        this.writeThreadDisplayTitle(sessionId, normalizedTitle);
      } catch {
        // Codex TUI 可能短暂占用 state db；下一次扫描会继续按 UI 来源修复。
      }
    }

    await upsertCodexSessionIndexThreadName(this.getStoragePath(), sessionId, normalizedTitle);

    if (normalizeCodexDisplayText(transcriptTitle) === normalizedTitle) {
      return false;
    }

    return await this.rewriteTranscriptSessionMeta(filePath, sessionId, (payload) => {
      return {
        ...payload,
        id: payload.id || sessionId,
        title: normalizedTitle,
      };
    });
  }

  private async syncThreadDisplayTitleFromTranscript(
    sessionId: string,
    transcriptTitle: string | undefined,
    threadMetadata: CodexThreadMetadata,
    filePath: string
  ): Promise<boolean> {
    const normalizedTitle = normalizeCodexDisplayText(transcriptTitle);
    const currentDisplayTitle = pickUsableCodexTitle([
      threadMetadata.title,
      threadMetadata.firstUserMessage,
      threadMetadata.preview,
    ]);

    if (currentDisplayTitle) {
      if (!normalizedTitle) return false;

      await upsertCodexSessionIndexThreadName(this.getStoragePath(), sessionId, currentDisplayTitle);
      if (normalizedTitle === currentDisplayTitle) return false;

      return await this.rewriteTranscriptSessionMeta(filePath, sessionId, (payload) => {
        return {
          ...payload,
          id: payload.id || sessionId,
          title: currentDisplayTitle,
        };
      });
    }

    if (!normalizedTitle || isWeakCodexTitle(normalizedTitle)) return false;

    const currentTitle = normalizeCodexDisplayText(threadMetadata.title);
    const currentFirstUserMessage = normalizeCodexDisplayText(threadMetadata.firstUserMessage);
    if (currentTitle !== normalizedTitle || currentFirstUserMessage !== normalizedTitle) {
      try {
        this.writeThreadDisplayTitle(sessionId, normalizedTitle);
      } catch {
        // Codex TUI 可能短暂占用 state db；ChatLog Viewer 仍以 transcript 标题为准。
      }
    }

    await upsertCodexSessionIndexThreadName(this.getStoragePath(), sessionId, normalizedTitle);
    return false;
  }

  private async resolveForkParentTitle(parentSessionId: string): Promise<string | null> {
    const threadMetadata = this.sqliteClient.getThreadMetadata(parentSessionId);
    const metadataTitle = pickUsableCodexTitle([
      threadMetadata.title,
      threadMetadata.firstUserMessage,
      threadMetadata.preview,
    ]);
    if (metadataTitle) return metadataTitle;

    try {
      const filePath = await this.findConversationFilePath(parentSessionId);
      const headEntries = await parseJsonlHead<CodexEntry>(filePath, 20);
      const sessionMeta = headEntries.find((entry) => entry.type === "session_meta");
      return pickUsableCodexTitle([
        typeof sessionMeta?.payload?.title === "string" ? sessionMeta.payload.title : undefined,
        ...headEntries.map((entry) => getCodexUserTitleCandidate(entry)),
      ]);
    } catch {
      return null;
    }
  }

  private async maybeInheritForkTitle(options: {
    sessionId: string;
    filePath: string;
    forkedFromId: string;
    threadMetadata: CodexThreadMetadata;
    transcriptTitle?: string;
    defaultTitle?: string;
    fallbackTitle?: string;
  }): Promise<string | null> {
    const forkedFromId = options.forkedFromId.trim();
    if (!forkedFromId || forkedFromId === options.sessionId) return null;

    const explicitChildTitles = [
      options.transcriptTitle,
      options.threadMetadata.title,
      options.threadMetadata.firstUserMessage,
      options.threadMetadata.preview,
    ];
    if (hasUsableCodexTitle(explicitChildTitles)) return null;

    const parentTitle = await this.resolveForkParentTitle(forkedFromId);
    if (!parentTitle) return null;

    try {
      this.writeThreadDisplayTitle(options.sessionId, parentTitle);
    } catch {
      // Codex TUI 可能短暂占用 state db；仍继续同步 transcript 与 session_index。
    }

    await upsertCodexSessionIndexThreadName(this.getStoragePath(), options.sessionId, parentTitle);
    await this.rewriteTranscriptSessionMeta(options.filePath, options.sessionId, (payload) => {
      return {
        ...payload,
        id: payload.id || options.sessionId,
        forked_from_id: typeof payload.forked_from_id === "string" ? payload.forked_from_id : forkedFromId,
        title: parentTitle,
      };
    });

    return parentTitle;
  }

  private getSessionIdFromMetaOrPath(meta: ConversationMeta | undefined, filePath: string): string {
    return meta?.id.startsWith("codex:")
      ? meta.id.replace("codex:", "")
      : filePath.split(/[/\\]/).pop()!.replace(".jsonl", "");
  }

  private async rewriteTranscriptSessionMeta(
    filePath: string,
    sessionId: string,
    updatePayload: (payload: CodexEntry["payload"]) => CodexEntry["payload"]
  ): Promise<boolean> {
    const fileStat = await stat(filePath);
    const originalContent = await readFile(filePath, "utf-8");
    let matched = false;
    let changed = false;

    const rewrittenContent = originalContent
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        try {
          const entry = JSON.parse(line) as CodexEntry;
          if (entry.type !== "session_meta") return line;
          if (entry.payload?.id && entry.payload.id !== sessionId) return line;

          matched = true;
          const nextEntry: CodexEntry = {
            ...entry,
            payload: updatePayload({ ...entry.payload }),
          };
          const nextLine = JSON.stringify(nextEntry);
          if (nextLine !== line) changed = true;
          return nextLine;
        } catch {
          return line;
        }
      })
      .join("\n");

    if (!matched || !changed) return false;

    await writeFile(filePath, rewrittenContent, "utf-8");
    const nextFileStat = await stat(filePath);
    carryCodexMessageIdentityCacheAcrossEdit(filePath, fileStat.mtimeMs, nextFileStat.mtimeMs);
    invalidateCache(filePath);
    invalidateMessageActionIndex(filePath);
    invalidateListCache(this.getListCacheKey());
    return true;
  }

  getStoragePath(): string {
    return getProviderPaths("codex").storagePath;
  }

  private getListCacheKey(storagePath = this.getStoragePath()): string {
    return getListCacheKey(this.name, `${storagePath}::${CODEX_LIST_SOURCE_VERSION}`);
  }

  async detect(): Promise<boolean> {
    try {
      await stat(this.getStoragePath());
      return true;
    } catch {
      return false;
    }
  }

  async list(options: ConversationListOptions = {}): Promise<ConversationMeta[]> {
    return this.listInternal({
      eagerSearchIndex: options.eagerSearchIndex ?? false,
      allowBackground: true,
    });
  }

  async getListSourceSignature(): Promise<string | null> {
    try {
      const fileStates = await this.getListSourceFiles();
      return this.createListSourceSignature(fileStates);
    } catch {
      return null;
    }
  }

  private scheduleBackgroundIndexRefresh(): void {
    const cacheKey = this.getListCacheKey();
    if (this.backgroundRefreshes.has(cacheKey)) {
      return;
    }

    const task = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.listInternal({
          eagerSearchIndex: true,
          allowBackground: false,
        })
          .then(() => undefined)
          .catch((error) => {
            logProviderError("conversations.index.background", this.name, error);
          })
          .finally(() => {
            this.backgroundRefreshes.delete(cacheKey);
            resolve();
          });
      }, 250);
    });

    this.backgroundRefreshes.set(cacheKey, task);
  }

  private async listInternal(options: {
    eagerSearchIndex: boolean;
    allowBackground: boolean;
  }): Promise<ConversationMeta[]> {
    const basePath = this.getStoragePath();
    const cacheKey = this.getListCacheKey(basePath);
    const fileStates = await this.getListSourceFiles();
    const sourceSignature = this.createListSourceSignature(fileStates);
    const cachedList = getIndexedListCache(cacheKey, undefined, {
      requireSearchReady: options.eagerSearchIndex,
      sourceSignature,
    });
    if (cachedList) {
      return [...cachedList].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    const previousItems = getIndexedCacheSnapshot(cacheKey, {
      includeSearchData: options.eagerSearchIndex,
    }) ?? [];
    const previousByFilePath = new Map(previousItems.map((item) => [item.meta.filePath, item]));
    const transcriptFileStates = fileStates.filter((fileState) => fileState.path !== this.getNormalizedStateDbPath());

    const results: IndexedCacheItem[] = [];
    const filesToRefresh: string[] = [];
    const transcriptSessionIds = new Set<string>();

    for (const fileState of transcriptFileStates) {
      const filePath = fileState.path;
      const previousMeta = previousByFilePath.get(filePath);
      const sessionId = this.getSessionIdFromMetaOrPath(previousMeta?.meta, filePath);
      transcriptSessionIds.add(sessionId);
      if (!previousMeta) {
        filesToRefresh.push(filePath);
        continue;
      }

      const threadMetadata = this.sqliteClient.getThreadMetadata(sessionId);
      if (
        isReusableCodexMetaHint(previousMeta.meta, fileState, threadMetadata)
        && (!options.eagerSearchIndex || hasIndexedSearchData(previousMeta))
      ) {
        setCache(filePath, fileState.mtimeMs, previousMeta.meta);
        results.push(previousMeta);
      } else {
        filesToRefresh.push(filePath);
      }
    }

    results.push(...await collectIndexedCacheItemsInBatches(filesToRefresh, 20, async (filePath) => (
      this.buildIndexedCacheItem(filePath, {
        includeSearchIndex: options.eagerSearchIndex,
        metaHint: previousByFilePath.get(filePath)?.meta,
      })
    )));

    const seenIds = new Set(results.map((item) => item.meta.id));
    for (const thread of this.sqliteClient.listThreads()) {
      if (transcriptSessionIds.has(thread.id)) {
        continue;
      }

      const filePath = buildCodexStateOnlyFilePath(thread.id, thread.rolloutPath);
      const previousItem = previousByFilePath.get(filePath);
      const previousMeta = previousItem?.meta;
      const meta = this.buildStateOnlyMeta(thread);
      if (!meta || seenIds.has(meta.id)) {
        continue;
      }

      const previousStillFresh = previousMeta
        && previousMeta.updatedAt === meta.updatedAt
        && previousMeta.createdAt === meta.createdAt
        && previousMeta.modelProvider === meta.modelProvider
        && previousMeta.projectKey === meta.projectKey
        && previousMeta.title === meta.title
        && previousMeta.titleGenerationHint === meta.titleGenerationHint
        && previousMeta.transcriptMissing === true
        && (!options.eagerSearchIndex || hasIndexedSearchData(previousItem));

      if (previousStillFresh && previousItem) {
        results.push(previousItem);
        seenIds.add(previousItem.meta.id);
        continue;
      }

      const item: IndexedCacheItem = options.eagerSearchIndex
        ? {
            meta,
            searchText: [meta.title, meta.project].filter(Boolean).join("\n"),
            searchChunks: [meta.title, meta.project].filter(Boolean),
          }
        : { meta };
      results.push(item);
      seenIds.add(meta.id);
    }

    const searchReady = options.eagerSearchIndex || filesToRefresh.length === 0;
    setIndexedListCache(cacheKey, results, {
      searchReady,
      sourceSignature,
      writeSearchData: options.eagerSearchIndex || searchReady,
    });

    if (!searchReady && options.allowBackground) {
      this.scheduleBackgroundIndexRefresh();
    }

    return results.map((item) => item.meta).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async buildIndexedCacheItem(
    filePath: string,
    options: {
      includeSearchIndex: boolean;
      metaHint?: ConversationMeta;
    }
  ): Promise<IndexedCacheItem | null> {
    const fileStat = await stat(filePath);
    const metaHint = options.metaHint;
    const sessionId = this.getSessionIdFromMetaOrPath(metaHint, filePath);
    const threadMetadata = this.sqliteClient.getThreadMetadata(sessionId);

    if (isReusableCodexMetaHint(metaHint, fileStat, threadMetadata)) {
      setCache(filePath, fileStat.mtimeMs, metaHint);
      if (!options.includeSearchIndex) {
        return { meta: metaHint };
      }
      return {
        meta: metaHint,
        ...(await this.extractSearchIndex(filePath)),
      };
    }

    if (!options.includeSearchIndex) {
      const meta = await this.extractMeta(filePath, metaHint);
      return meta ? { meta } : null;
    }

    return this.scanConversationFile(filePath, fileStat, true);
  }

  private async scanConversationFile(
    filePath: string,
    fileStat: {
      mtimeMs: number;
      size: number;
      birthtimeMs: number;
    },
    includeSearchIndex: boolean
  ): Promise<IndexedCacheItem | null> {
    let sessionId = filePath.split(/[/\\]/).pop()!.replace(".jsonl", "");
    let cwd = "";
    let transcriptTitle = "";
    let forkedFromId = "";
    let defaultTitle = "";
    let fallbackTitle = "";
    let userMessageCount = 0;
    let messageCount = 0;
    let firstTimestamp: number | undefined;
    let capturedSessionMeta = false;
    const searchBuilder = includeSearchIndex ? createConversationSearchIndexBuilder() : null;

    await visitJsonl<CodexEntry>(filePath, (entry) => {
      if (firstTimestamp === undefined) {
        const timestamp = Date.parse(entry.timestamp);
        if (Number.isFinite(timestamp)) {
          firstTimestamp = timestamp;
        }
      }

      if (entry.type === "session_meta") {
        if (!capturedSessionMeta) {
          sessionId = entry.payload?.id || sessionId;
          cwd = entry.payload?.cwd || cwd;
          forkedFromId = getCodexForkedFromId(entry) || forkedFromId;
          if (typeof entry.payload?.title === "string") {
            transcriptTitle = normalizeCodexDisplayText(entry.payload.title) || transcriptTitle;
          }
          capturedSessionMeta = true;
        }
        return;
      }

      if (
        entry.type === "event_msg"
        && entry.payload?.type === "user_message"
        && typeof entry.payload.message === "string"
      ) {
        userMessageCount += 1;
        const candidateTitle = getCodexUserTitleCandidate(entry);
        if (!defaultTitle) {
          defaultTitle = candidateTitle;
        }
        if (!fallbackTitle && candidateTitle && !isWeakCodexTitle(candidateTitle)) {
          fallbackTitle = candidateTitle;
        }
        return;
      }

      const content = getDisplayableCodexResponseContent(entry);
      if (content === null) {
        return;
      }

      const role = entry.payload.role;
      messageCount += 1;
      if (role === "user") {
        const candidateTitle = getCodexUserTitleCandidate(entry);
        if (!defaultTitle) {
          defaultTitle = candidateTitle;
        }
        if (!fallbackTitle && candidateTitle && !isWeakCodexTitle(candidateTitle)) {
          fallbackTitle = candidateTitle;
        }
      }
      if (searchBuilder) {
        appendSearchIndexEntry(searchBuilder, entry);
      }
    });

    const displayMessageCount = messageCount > 0 ? messageCount : userMessageCount;
    if (displayMessageCount === 0) {
      return null;
    }
    const isTitleGenerationSession = isCodexTitleGenerationProject(cwd);

    const normalizedCwd = canonicalizeProjectPathResolvingSymlinks(cwd);
    const threadMetadata = this.sqliteClient.getThreadMetadata(sessionId);
    if (!fallbackTitle && isCodexNativeOriginalWeakTitle(threadMetadata)) {
      fallbackTitle = await findCodexFallbackTitle(filePath);
    }
    let currentFileStat = fileStat;
    let effectiveTranscriptTitle = transcriptTitle;
    const managedTitle = await this.getManagedTitle(sessionId);
    if (managedTitle) {
      effectiveTranscriptTitle = managedTitle;
      const transcriptRewritten = await this.syncThreadDisplayTitleFromManagedTitle(
        sessionId,
        managedTitle,
        transcriptTitle,
        threadMetadata,
        filePath
      );
      if (transcriptRewritten) {
        currentFileStat = await stat(filePath);
      }
    } else {
      const inheritedForkTitle = await this.maybeInheritForkTitle({
        sessionId,
        filePath,
        forkedFromId,
        threadMetadata,
        transcriptTitle,
        defaultTitle,
        fallbackTitle,
      });
      if (inheritedForkTitle) {
        effectiveTranscriptTitle = inheritedForkTitle;
        currentFileStat = await stat(filePath);
      } else {
        const transcriptRewritten = await this.syncThreadDisplayTitleFromTranscript(sessionId, transcriptTitle, threadMetadata, filePath);
        if (transcriptRewritten) {
          currentFileStat = await stat(filePath);
        }
      }
    }
    const titleChoice = pickCodexConversationTitle({
      managedTitle: managedTitle ?? undefined,
      transcriptTitle: effectiveTranscriptTitle,
      nativeTitle: threadMetadata.title,
      firstUserMessage: threadMetadata.firstUserMessage,
      preview: threadMetadata.preview,
      fallbackTitle: fallbackTitle || defaultTitle,
    });

    const meta: ConversationMeta = {
      id: `codex:${sessionId}`,
      provider: this.name,
      title: titleChoice.title,
      project: normalizedCwd,
      projectKey: normalizedCwd,
      projectId: normalizedCwd,
      createdAt: firstTimestamp ?? fileStat.birthtimeMs,
      updatedAt: currentFileStat.mtimeMs,
      messageCount: displayMessageCount,
      fileSize: currentFileStat.size,
      filePath,
      modelProvider: threadMetadata.modelProvider,
      contentStatus: "full",
      badges: mergeCodexBadges(
        isTitleGenerationSession ? buildCodexTitleGenerationBadges() : undefined,
        titleChoice.usedFallback ? buildCodexTitleFallbackBadges() : undefined
      ),
    };

    setCache(filePath, currentFileStat.mtimeMs, meta);

    if (!searchBuilder) {
      return { meta };
    }

    return {
      meta,
      ...searchBuilder.build(),
    };
  }

  private async extractSearchIndex(filePath: string): Promise<ConversationSearchIndex> {
    const builder = createConversationSearchIndexBuilder();
    await visitJsonl<CodexEntry>(filePath, (entry) => {
      appendSearchIndexEntry(builder, entry);
    });
    return builder.build();
  }

  private async extractMeta(filePath: string, metaHint?: ConversationMeta): Promise<ConversationMeta | null> {
    const fileStat = await stat(filePath);
    const cached = getCached(filePath, fileStat.mtimeMs);
    if (cached) {
      const sessionId = this.getSessionIdFromMetaOrPath(cached, filePath);
      const threadMetadata = this.sqliteClient.getThreadMetadata(sessionId);
      if (isReusableCodexMetaHint(cached, fileStat, threadMetadata)) {
        return cached;
      }
    }

    // 只读前 20 行获取 session_meta 和首条用户消息
    const headEntries = await parseJsonlHead<CodexEntry>(filePath, 20);
    if (headEntries.length === 0) return null;

    const sessionMeta = headEntries.find((e) => e.type === "session_meta");
    const sessionId = sessionMeta?.payload?.id || filePath.split(/[/\\]/).pop()!.replace(".jsonl", "");
    const cwd = sessionMeta?.payload?.cwd || "";
    const forkedFromId = getCodexForkedFromId(sessionMeta);
    const transcriptTitle = typeof sessionMeta?.payload?.title === "string"
      ? normalizeCodexDisplayText(sessionMeta.payload.title)
      : "";
    const isTitleGenerationSession = isCodexTitleGenerationProject(cwd);

    const userMessages = headEntries.filter(
      (e) => e.type === "event_msg" && e.payload?.type === "user_message" && e.payload.message
    );

    const defaultTitleCandidate = getCodexUserTitleCandidate(userMessages[0]);
    const defaultTitle = defaultTitleCandidate || "未知对话";
    let fallbackTitle = userMessages
      .map((entry) => getCodexUserTitleCandidate(entry))
      .find((title) => !!title && !isWeakCodexTitle(title));

    // 快速行计数
    const expectedId = `codex:${sessionId}`;
    const canReuseMessageCount = metaHint?.id === expectedId && metaHint.filePath === filePath;
    const messageCount = canReuseMessageCount
      ? metaHint.messageCount
      : await countLines(
          filePath,
          (value) => {
            if (!value || typeof value !== "object") return false;
            const entry = value as CodexEntry;
            return getDisplayableCodexResponseContent(entry) !== null;
          },
          {
            fastIncludes: ['"type":"response_item"', '"role":"user"', '"role":"assistant"'],
          }
        );
    const displayMessageCount = messageCount > 0 ? messageCount : userMessages.length;
    if (displayMessageCount === 0) return null;

    const firstTs = new Date(headEntries[0].timestamp).getTime();
    const normalizedCwd = canonicalizeProjectPathResolvingSymlinks(cwd);

    const threadMetadata = this.sqliteClient.getThreadMetadata(sessionId);
    if (!fallbackTitle && isCodexNativeOriginalWeakTitle(threadMetadata)) {
      fallbackTitle = await findCodexFallbackTitle(filePath);
    }
    let currentFileStat = fileStat;
    let effectiveTranscriptTitle = transcriptTitle;
    const managedTitle = await this.getManagedTitle(sessionId);
    if (managedTitle) {
      effectiveTranscriptTitle = managedTitle;
      const transcriptRewritten = await this.syncThreadDisplayTitleFromManagedTitle(
        sessionId,
        managedTitle,
        transcriptTitle,
        threadMetadata,
        filePath
      );
      if (transcriptRewritten) {
        currentFileStat = await stat(filePath);
      }
    } else {
      const inheritedForkTitle = await this.maybeInheritForkTitle({
        sessionId,
        filePath,
        forkedFromId,
        threadMetadata,
        transcriptTitle,
        defaultTitle: defaultTitleCandidate,
        fallbackTitle,
      });
      if (inheritedForkTitle) {
        effectiveTranscriptTitle = inheritedForkTitle;
        currentFileStat = await stat(filePath);
      } else {
        const transcriptRewritten = await this.syncThreadDisplayTitleFromTranscript(sessionId, transcriptTitle, threadMetadata, filePath);
        if (transcriptRewritten) {
          currentFileStat = await stat(filePath);
        }
      }
    }
    const titleChoice = pickCodexConversationTitle({
      managedTitle: managedTitle ?? undefined,
      transcriptTitle: effectiveTranscriptTitle,
      nativeTitle: threadMetadata.title,
      firstUserMessage: threadMetadata.firstUserMessage,
      preview: threadMetadata.preview,
      fallbackTitle: fallbackTitle || defaultTitle,
    });

    const meta: ConversationMeta = {
      id: `codex:${sessionId}`,
      provider: this.name,
      title: titleChoice.title,
      project: normalizedCwd,
      projectKey: normalizedCwd,
      projectId: normalizedCwd,
      createdAt: firstTs,
      updatedAt: currentFileStat.mtimeMs,
      messageCount: displayMessageCount,
      fileSize: currentFileStat.size,
      filePath,
      modelProvider: threadMetadata.modelProvider,
      contentStatus: "full",
      badges: mergeCodexBadges(
        titleChoice.usedFallback ? buildCodexTitleFallbackBadges() : undefined,
        isTitleGenerationSession ? buildCodexTitleGenerationBadges() : undefined
      ),
    };

    setCache(filePath, currentFileStat.mtimeMs, meta);
    return meta;
  }

  private async filterMatchingTranscriptPaths(sessionId: string, candidatePaths: string[]): Promise<string[]> {
    const verifiedMatches: string[] = [];

    for (const filePath of candidatePaths) {
      try {
        const headEntries = await parseJsonlHead<CodexEntry>(filePath, 5);
        const sessionMeta = headEntries.find((entry) => entry.type === "session_meta");
        const resolvedSessionId = sessionMeta?.payload?.id || filePath.split(/[/\\]/).pop()!.replace(".jsonl", "");
        if (resolvedSessionId === sessionId) {
          verifiedMatches.push(filePath);
        }
      } catch {
        // 跳过坏文件
      }
    }

    return verifiedMatches;
  }

  private async findConversationFilePath(sessionId: string): Promise<string> {
    const rolloutPath = this.sqliteClient.findThread(sessionId)?.rolloutPath;
    const normalizedRolloutPath = rolloutPath ? normalizePath(rolloutPath) : "";
    if (normalizedRolloutPath) {
      try {
        await stat(normalizedRolloutPath);
        const verifiedRolloutMatches = await this.filterMatchingTranscriptPaths(sessionId, [normalizedRolloutPath]);
        if (verifiedRolloutMatches.length === 1) {
          return verifiedRolloutMatches[0];
        }
      } catch {
        // 允许 rollout_path 失效，继续回退到磁盘扫描。
      }
    }

    const basePath = this.getStoragePath();
    const exactPattern = join(basePath, "**", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const exactMatches = [...new Set((await glob(exactPattern)).map((item) => normalizePath(item)))];
    const verifiedExactMatches = await this.filterMatchingTranscriptPaths(sessionId, exactMatches);
    if (verifiedExactMatches.length === 1) {
      return verifiedExactMatches[0];
    }
    if (verifiedExactMatches.length > 1) {
      throw new Error(`定位到多个同名对话文件: codex:${sessionId}`);
    }

    const fallbackPattern = join(basePath, "**", `*${sessionId}*.jsonl`).replace(/\\/g, "/");
    const fallbackCandidates = [...new Set((await glob(fallbackPattern)).map((item) => normalizePath(item)))];
    const verifiedMatches = await this.filterMatchingTranscriptPaths(sessionId, fallbackCandidates);

    if (verifiedMatches.length === 1) {
      return verifiedMatches[0];
    }
    if (verifiedMatches.length > 1) {
      throw new Error(`定位到多个候选对话文件: codex:${sessionId}`);
    }

    throw new Error(`对话不存在: codex:${sessionId}`);
  }

  private invalidateConversationCaches(filePath: string): void {
    invalidateCache(filePath);
    invalidateMessageActionIndex(filePath);
    invalidateCodexMessageIdentityCache(filePath);
    invalidateListCache(this.getListCacheKey());
  }

  private async resolveMessageLineNumbers(
    filePath: string,
    mtimeMs: number,
    messageIds: string[]
  ): Promise<number[]> {
    const cached = getMessageActionLineNumbers(filePath, mtimeMs, messageIds);
    if (cached) return cached;

    const entries = await parseJsonlWithMeta<CodexEntry>(filePath);
    const records = buildMessageRecords(entries, { filePath, mtimeMs });
    primeMessageActionIndex(filePath, mtimeMs, records);

    const lineByMessageId = new Map<string, number>();
    for (const record of records) {
      if (record.message.messageId && record.lineIndex) {
        lineByMessageId.set(record.message.messageId, record.lineIndex);
      }
    }

    return messageIds.map((messageId) => {
      const lineNumber = lineByMessageId.get(messageId);
      if (!lineNumber) {
        throw new Error(`消息不存在: ${messageId}`);
      }
      return lineNumber;
    });
  }

  async read(id: string, options?: ConversationReadOptions): Promise<Conversation> {
    const sessionId = id.replace("codex:", "");

    try {
      const filePath = await this.findConversationFilePath(sessionId);
      const fileStat = await stat(filePath);

      const limit = options?.limit;
      const before = options?.before ?? 0;
      const shouldWindowRead = !!limit && limit > 0;
      const requiredMessages = shouldWindowRead ? before + limit + 1 : 0;

      const entries = shouldWindowRead
        ? await parseJsonlTailWithMeta<CodexEntry>(filePath, {
            bytesHint: Math.max(256 * 1024, fileStat.size > 0 ? Math.min(fileStat.size, (before + limit) * 4096) : 256 * 1024),
            maxBytes: fileStat.size,
            isEnough: (tailEntries) => buildMessageRecords(tailEntries).length >= requiredMessages,
          })
        : await parseJsonlWithMeta<CodexEntry>(filePath);
      const records = buildMessageRecords(entries, { filePath, mtimeMs: fileStat.mtimeMs });
      primeMessageActionIndex(filePath, fileStat.mtimeMs, records);
      const messages = records.map((record) => record.message);

      const meta = await this.extractMeta(filePath);
      if (!meta) throw new Error(`无法解析对话元数据: ${id}`);

      const { items: windowedMessages, hasMore } = sliceWindow(messages, options);

      return { ...meta, messages: windowedMessages, hasMore };
    } catch (error) {
      const thread = this.sqliteClient.findThread(sessionId);
      if (!thread) {
        throw error;
      }

      const meta = this.buildStateOnlyMeta(thread);
      if (!meta) {
        throw error;
      }

      return {
        ...meta,
        messages: [{
          role: "system",
          content: "当前 Codex 对话仅在本地 state db 中保留 metadata，未找到 transcript 文件，因此无法显示完整消息内容。你仍可查看标题、项目路径并切换 model provider，也可基于 metadata 生成 AI 标题。",
        }],
        hasMore: false,
      };
    }
  }

  async delete(id: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    let transcriptDeleted = false;
    let filePath: string | null = null;

    try {
      filePath = await this.findConversationFilePath(sessionId);
      await unlink(filePath);
      transcriptDeleted = true;
      deletePersistedCodexMessageIdentity(filePath);
      this.invalidateConversationCaches(filePath);
    } catch (error) {
      if (!isNotFoundError(error) && !(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      if (filePath) {
        deletePersistedCodexMessageIdentity(filePath);
        this.invalidateConversationCaches(filePath);
      }
    }

    const stateDbDeleted = this.sqliteClient.deleteThread(sessionId);
    if (!transcriptDeleted && !stateDbDeleted) {
      throw new Error(`对话不存在: ${id}`);
    }

    if (!filePath) {
      invalidateListCache(this.getListCacheKey());
    }
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const normalizedTargetProject = normalizePath(targetProjectKey);
    const canonicalTargetProject = canonicalizeProjectPath(targetProjectKey) || normalizedTargetProject;
    if (!canonicalTargetProject) {
      throw new Error("目标文件夹不能为空");
    }

    const existingThread = this.sqliteClient.findThread(sessionId);
    let filePath: string | null = null;
    try {
      filePath = await this.findConversationFilePath(sessionId);
    } catch (error) {
      if (!existingThread) {
        throw error;
      }
    }

    if (!filePath) {
      const updated = this.sqliteClient.updateThreadLocation(sessionId, { cwd: normalizedTargetProject });
      if (existingThread && !updated) {
        throw new Error(`未能同步 Codex state db: ${id}`);
      }
      invalidateListCache(this.getListCacheKey());
      return;
    }

    const originalFilePath = filePath;
    const originalFileStat = await stat(originalFilePath);
    const createdAtMs = existingThread?.createdAt ?? originalFileStat.birthtimeMs;
    const targetFilePath = buildCodexTranscriptPath(this.getStoragePath(), sessionId, createdAtMs);
    const movedToTarget = normalizePath(originalFilePath) !== targetFilePath;
    const originalContent = await readFile(originalFilePath, "utf-8");
    const newCwd = formatCodexStoredPath(normalizedTargetProject) ?? normalizedTargetProject;
    const rewrittenContent = originalContent
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        try {
          const entry = JSON.parse(line) as CodexEntry;
          if (entry.type === "session_meta") {
            entry.payload = {
              ...entry.payload,
              id: entry.payload?.id || sessionId,
              cwd: newCwd,
            };
            return JSON.stringify(entry);
          }
        } catch {
          // 保持原样
        }
        return line;
      })
      .join("\n");

    let currentFilePath = originalFilePath;
    let preWriteMtimeMs: number | null = null;

    try {
      if (movedToTarget) {
        await mkdir(dirname(targetFilePath), { recursive: true });
        await rename(originalFilePath, targetFilePath);
        currentFilePath = targetFilePath;
      }

      const preWriteStat = await stat(currentFilePath);
      preWriteMtimeMs = preWriteStat.mtimeMs;
      if (rewrittenContent !== originalContent || movedToTarget) {
        await writeFile(currentFilePath, rewrittenContent, "utf-8");
      }

      const updated = this.sqliteClient.updateThreadLocation(sessionId, {
        cwd: normalizedTargetProject,
        rolloutPath: currentFilePath,
      });
      if (existingThread && !updated) {
        throw new Error(`未能同步 Codex state db: ${id}`);
      }
    } catch (error) {
      try {
        await writeFile(currentFilePath, originalContent, "utf-8");
        if (movedToTarget && currentFilePath !== originalFilePath) {
          await mkdir(dirname(originalFilePath), { recursive: true });
          await rename(currentFilePath, originalFilePath);
        }
      } catch (rollbackError) {
        const baseMessage = error instanceof Error ? error.message : String(error);
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`${baseMessage}；回滚失败：${rollbackMessage}`);
      } finally {
        deletePersistedCodexMessageIdentity(currentFilePath);
        invalidateCodexMessageIdentityCache(currentFilePath);
        invalidateCache(currentFilePath);
        invalidateMessageActionIndex(currentFilePath);
        deletePersistedCodexMessageIdentity(originalFilePath);
        invalidateCodexMessageIdentityCache(originalFilePath);
        invalidateCache(originalFilePath);
        invalidateMessageActionIndex(originalFilePath);
        invalidateListCache(this.getListCacheKey());
      }

      throw error;
    }

    const nextFileStat = await stat(currentFilePath);
    if (!movedToTarget && preWriteMtimeMs !== null && nextFileStat.mtimeMs !== preWriteMtimeMs) {
      carryCodexMessageIdentityCacheAcrossEdit(currentFilePath, preWriteMtimeMs, nextFileStat.mtimeMs);
    } else {
      deletePersistedCodexMessageIdentity(currentFilePath);
      invalidateCodexMessageIdentityCache(currentFilePath);
    }

    if (movedToTarget) {
      deletePersistedCodexMessageIdentity(originalFilePath);
      invalidateCodexMessageIdentityCache(originalFilePath);
      invalidateCache(originalFilePath);
      invalidateMessageActionIndex(originalFilePath);
    }

    invalidateCache(currentFilePath);
    invalidateMessageActionIndex(currentFilePath);
    invalidateListCache(this.getListCacheKey());
  }

  async updateTitle(id: string, title: string): Promise<void> {
    if (!id.startsWith("codex:")) {
      throw new Error("仅支持修改 Codex 对话标题");
    }

    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error("标题不能为空");
    }

    const sessionId = id.replace("codex:", "");
    let filePath: string | null = null;

    try {
      filePath = await this.findConversationFilePath(sessionId);
    } catch {
      const thread = this.sqliteClient.findThread(sessionId);
      if (!thread) {
        throw new Error(`对话不存在: ${id}`);
      }
    }

    await this.writeThreadDisplayTitle(sessionId, normalizedTitle);
    await upsertCodexSessionIndexThreadName(this.getStoragePath(), sessionId, normalizedTitle);
    if (filePath) {
      await this.rewriteTranscriptSessionMeta(filePath, sessionId, (payload) => {
        return {
          ...payload,
          id: payload.id || sessionId,
          title: normalizedTitle,
        };
      });
      this.invalidateConversationCaches(filePath);
    } else {
      invalidateListCache(this.getListCacheKey());
    }
  }

  async updateMessage(id: string, messageId: string, content: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const fileStat = await stat(filePath);
    const [lineNumber] = await this.resolveMessageLineNumbers(filePath, fileStat.mtimeMs, [messageId]);
    const normalizedContent = normalizeUpdatedMessageContent(content);
    await rewriteJsonlFileLine(
      filePath,
      lineNumber,
      (line) => {
        const entry = JSON.parse(line) as CodexEntry;
        const role = entry.payload?.role;
        if (entry.type !== "response_item" || (role !== "user" && role !== "assistant")) {
          throw new Error(`消息不存在: ${messageId}`);
        }

        const nextEntry: CodexEntry = {
          ...entry,
          payload: {
            ...entry.payload,
            content: [{
              type: role === "user" ? "input_text" : "output_text",
              text: normalizedContent,
            }],
          },
        };
        return JSON.stringify(nextEntry);
      }
    );
    const nextFileStat = await stat(filePath);
    carryCodexMessageIdentityCacheAcrossEdit(filePath, fileStat.mtimeMs, nextFileStat.mtimeMs);
    invalidateCache(filePath);
    invalidateMessageActionIndex(filePath);
    invalidateListCache(this.getListCacheKey());
  }

  async deleteMessage(id: string, messageId: string): Promise<void> {
    await this.deleteMessages(id, [messageId]);
  }

  async deleteMessages(id: string, messageIds: string[]): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const fileStat = await stat(filePath);
    const uniqueMessageIds = [...new Set(messageIds.map((item) => item.trim()).filter(Boolean))];
    if (uniqueMessageIds.length === 0) {
      throw new Error("待删除消息不能为空");
    }
    const lineNumbers = await this.resolveMessageLineNumbers(filePath, fileStat.mtimeMs, uniqueMessageIds);
    await rewriteJsonlFileLines(filePath, lineNumbers);
    const nextFileStat = await stat(filePath);
    carryCodexMessageIdentityCacheAcrossDelete(filePath, fileStat.mtimeMs, nextFileStat.mtimeMs, uniqueMessageIds);
    invalidateCache(filePath);
    invalidateMessageActionIndex(filePath);
    invalidateListCache(this.getListCacheKey());
  }

  async listProjects(): Promise<string[]> {
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "**", "*.jsonl").replace(/\\/g, "/");
    const files = await glob(pattern);
    const cwds = new Set<string>();

    for (const filePath of files) {
      try {
        const head = await parseJsonlHead<CodexEntry>(filePath, 5);
        const meta = head.find((e) => e.type === "session_meta");
        const cwd = meta?.payload?.cwd;
        if (cwd) cwds.add(canonicalizeProjectPathResolvingSymlinks(cwd));
      } catch {
        // 跳过
      }
    }
    return [...cwds];
  }

  // 列出 SQLite 中存在的 model_provider 名称（用于迁移目标列表）。
  // 不返回计数：SQLite 会保留大量空 session，估值远高于实际有效对话数。
  listModelProviders(): string[] {
    return this.sqliteClient.listModelProviders();
  }

  // 修改对话的 model_provider
  async changeModelProvider(id: string, newProvider: string): Promise<void> {
    await this.changeModelProviders([id], newProvider);
  }

  // 批量修改对话的 model_provider
  async changeModelProviders(ids: string[], newProvider: string): Promise<number> {
    const normalizedProvider = newProvider.trim();
    if (!normalizedProvider) {
      throw new Error("model provider 不能为空");
    }

    const uniqueIds = [...new Set(ids.map((item) => item.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) {
      throw new Error("待修改对话不能为空");
    }

    const sessionIds = uniqueIds.map((id) => {
      if (!id.startsWith("codex:")) {
        throw new Error("仅支持修改 Codex 对话的 model provider");
      }
      return id.replace("codex:", "");
    });

    const transcriptTargets = await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          return {
            sessionId,
            filePath: await this.findConversationFilePath(sessionId),
          };
        } catch {
          return { sessionId, filePath: null };
        }
      })
    );

    this.sqliteClient.changeModelProvidersForSessions(sessionIds, normalizedProvider);

    for (const target of transcriptTargets) {
      if (!target.filePath) continue;
      await this.rewriteTranscriptSessionMeta(target.filePath, target.sessionId, (payload) => ({
        ...payload,
        model_provider: normalizedProvider,
      }));
      invalidateCache(target.filePath);
    }
    invalidateListCache(this.getListCacheKey());

    return sessionIds.length;
  }
}
