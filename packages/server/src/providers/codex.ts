import { join } from "path";
import { stat, unlink, readFile, writeFile } from "fs/promises";
import { createRequire } from "module";
import { glob } from "glob";
import type BetterSqlite3 from "better-sqlite3";
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
import { getProviderPaths } from "../utils/provider-paths.js";
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
  ConversationReadOptions,
  ConversationListOptions,
} from "./types.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;

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

interface CodexThreadMetadata {
  modelProvider?: string;
  title?: string;
  firstUserMessage?: string;
}

interface CodexMessageIdentityCacheEntry {
  mtimeMs: number;
  orderedMessageIds: string[];
  lineByMessageId: Map<string, number>;
}

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

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").trim();
}

function canonicalizeProjectPath(value: string): string {
  const normalized = normalizePath(value);
  if (!normalized) return "";
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
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
    if (value.type !== "response_item" || !value.payload?.role) continue;

    const role = value.payload.role as "user" | "assistant";
    if (role !== "user" && role !== "assistant") continue;

    const content = value.payload.content
      ? extractContent(value.payload.content)
      : "";
    if (content.includes("<environment_context>")) continue;
    if (!content.trim()) continue;

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
  if (entry.type !== "response_item" || !entry.payload?.role) return;

  const role = entry.payload.role as "user" | "assistant";
  if (role !== "user" && role !== "assistant") return;

  const content = entry.payload.content
    ? extractContent(entry.payload.content)
    : "";
  if (content.includes("<environment_context>")) return;
  if (!content.trim()) return;

  builder.addMessage({
    role,
    content,
    timestamp: new Date(entry.timestamp).getTime(),
  });
}

function getListCacheKey(providerName: string, storagePath: string): string {
  return `${providerName}::${storagePath}::indexed`;
}

function sliceWindow<T>(items: T[], options?: ConversationReadOptions): { items: T[]; hasMore: boolean } {
  const limit = options?.limit;
  const before = options?.before ?? 0;

  if (!limit || limit <= 0) {
    return { items, hasMore: false };
  }

  const end = Math.max(0, items.length - before);
  const start = Math.max(0, end - limit);
  return {
    items: items.slice(start, end),
    hasMore: start > 0,
  };
}

export class CodexProvider implements ConversationProvider {
  name = "codex";
  displayName = "Codex";
  capabilities = {
    titleSyncMode: "native",
    canUpdateTitle: true,
    canGenerateTitle: true,
  } as const;

  private db: BetterSqlite3.Database | null = null;
  private dbPath: string | null = null;
  private backgroundRefreshes = new Map<string, Promise<void>>();
  private titleBackfills = new Set<string>();

  private getStateDbPath(): string {
    return getProviderPaths("codex").stateDbPath || join(this.getStoragePath(), "..", "state_5.sqlite");
  }

  private closeDb(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.dbPath = null;
  }

  private getDb(): BetterSqlite3.Database | null {
    const dbPath = this.getStateDbPath();
    if (this.db && this.dbPath === dbPath) return this.db;

    this.closeDb();

    try {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.dbPath = dbPath;
      return this.db;
    } catch {
      this.dbPath = null;
      return null;
    }
  }

  private getNormalizedStateDbPath(): string {
    return this.getStateDbPath().replace(/\\/g, "/");
  }

  private async getListSourceFiles() {
    const pattern = join(this.getStoragePath(), "**", "*.jsonl").replace(/\\/g, "/");
    const fileStates = await collectGlobFileStates(pattern);

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

  private getThreadMetadata(sessionId: string): CodexThreadMetadata {
    const db = this.getDb();
    if (!db) return {};
    try {
      const row = db
        .prepare("SELECT model_provider, title, first_user_message FROM threads WHERE id = ?")
        .get(sessionId) as { model_provider: string; title: string | null; first_user_message: string | null } | undefined;
      return {
        modelProvider: row?.model_provider,
        title: row?.title ?? undefined,
        firstUserMessage: row?.first_user_message ?? undefined,
      };
    } catch {
      return {};
    }
  }

  private async writeThreadDisplayTitle(
    sessionId: string,
    title: string,
    options?: { updateTitleField?: boolean }
  ): Promise<void> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error("标题不能为空");
    }

    const dbPath = this.getStateDbPath();
    this.closeDb();

    const db = new Database(dbPath);
    try {
      const result = options?.updateTitleField === false
        ? db.prepare("UPDATE threads SET first_user_message = ? WHERE id = ?").run(normalizedTitle, sessionId)
        : db.prepare("UPDATE threads SET title = ?, first_user_message = ? WHERE id = ?").run(normalizedTitle, normalizedTitle, sessionId);
      if (result.changes === 0) {
        throw new Error(`SQLite 中未找到对话: ${sessionId}`);
      }
    } finally {
      db.close();
    }
  }

  private scheduleTitleBackfill(sessionId: string, title: string): void {
    const normalizedTitle = title.trim();
    if (!normalizedTitle || this.titleBackfills.has(sessionId)) {
      return;
    }

    this.titleBackfills.add(sessionId);
    void this.writeThreadDisplayTitle(sessionId, normalizedTitle, { updateTitleField: false })
      .catch((error) => {
        logProviderError("conversations.title.backfill", this.name, error);
      })
      .finally(() => {
        this.titleBackfills.delete(sessionId);
      });
  }

  getStoragePath(): string {
    return getProviderPaths("codex").storagePath;
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
      return createIndexedListSourceSignature(fileStates);
    } catch {
      return null;
    }
  }

  private scheduleBackgroundIndexRefresh(): void {
    const cacheKey = getListCacheKey(this.name, this.getStoragePath());
    if (this.backgroundRefreshes.has(cacheKey)) {
      return;
    }

    const task = this.listInternal({
      eagerSearchIndex: true,
      allowBackground: false,
    })
      .then(() => undefined)
      .catch((error) => {
        logProviderError("conversations.index.background", this.name, error);
      })
      .finally(() => {
        this.backgroundRefreshes.delete(cacheKey);
      });

    this.backgroundRefreshes.set(cacheKey, task);
  }

  private async listInternal(options: {
    eagerSearchIndex: boolean;
    allowBackground: boolean;
  }): Promise<ConversationMeta[]> {
    const basePath = this.getStoragePath();
    const cacheKey = getListCacheKey(this.name, basePath);
    const fileStates = await this.getListSourceFiles();
    const sourceSignature = createIndexedListSourceSignature(fileStates);
    const cachedList = getIndexedListCache(cacheKey, undefined, {
      requireSearchReady: options.eagerSearchIndex,
      sourceSignature,
    });
    if (cachedList) {
      return [...cachedList].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    const previousItems = getIndexedCacheSnapshot(cacheKey) ?? [];
    const previousByFilePath = new Map(previousItems.map((item) => [item.meta.filePath, item]));

    const results: IndexedCacheItem[] = [];
    const filesToRefresh: string[] = [];

    for (const fileState of fileStates) {
      const filePath = fileState.path;
      if (filePath === this.getNormalizedStateDbPath()) {
        continue;
      }
      const previousMeta = previousByFilePath.get(filePath);
      if (!previousMeta) {
        filesToRefresh.push(filePath);
        continue;
      }

      if (
        fileState.mtimeMs === previousMeta.meta.updatedAt
        && fileState.size === previousMeta.meta.fileSize
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

    const searchReady = options.eagerSearchIndex || filesToRefresh.length === 0;
    setIndexedListCache(cacheKey, results, { searchReady, sourceSignature });

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

    if (metaHint && metaHint.updatedAt === fileStat.mtimeMs && metaHint.fileSize === fileStat.size) {
      setCache(filePath, fileStat.mtimeMs, metaHint);
      if (!options.includeSearchIndex) {
        return { meta: metaHint };
      }
      return {
        meta: metaHint,
        ...(await this.extractSearchIndex(filePath)),
      };
    }

    return this.scanConversationFile(filePath, fileStat, options.includeSearchIndex);
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
    let defaultTitle = "";
    let userMessageCount = 0;
    let messageCount = 0;
    let firstTimestamp: number | undefined;
    const searchBuilder = includeSearchIndex ? createConversationSearchIndexBuilder() : null;

    await visitJsonl<CodexEntry>(filePath, (entry) => {
      if (firstTimestamp === undefined) {
        const timestamp = Date.parse(entry.timestamp);
        if (Number.isFinite(timestamp)) {
          firstTimestamp = timestamp;
        }
      }

      if (entry.type === "session_meta") {
        sessionId = entry.payload?.id || sessionId;
        cwd = entry.payload?.cwd || cwd;
        return;
      }

      if (
        entry.type === "event_msg"
        && entry.payload?.type === "user_message"
        && typeof entry.payload.message === "string"
      ) {
        userMessageCount += 1;
        if (!defaultTitle) {
          defaultTitle = entry.payload.message.slice(0, 100);
        }
        return;
      }

      if (entry.type !== "response_item") {
        return;
      }

      const role = entry.payload?.role;
      if (role !== "user" && role !== "assistant") {
        return;
      }

      messageCount += 1;
      searchBuilder && appendSearchIndexEntry(searchBuilder, entry);
    });

    if (messageCount === 0 && userMessageCount === 0) {
      return null;
    }

    const normalizedCwd = canonicalizeProjectPath(cwd);
    const threadMetadata = this.getThreadMetadata(sessionId);
    const normalizedThreadTitle = threadMetadata.title?.replace(/<[^>]+>/g, "").trim();
    if (
      normalizedThreadTitle
      && threadMetadata.firstUserMessage?.trim() !== normalizedThreadTitle
    ) {
      this.scheduleTitleBackfill(sessionId, normalizedThreadTitle);
    }

    const meta: ConversationMeta = {
      id: `codex:${sessionId}`,
      provider: this.name,
      title: normalizedThreadTitle || defaultTitle.replace(/<[^>]+>/g, "").trim() || "未知对话",
      project: normalizedCwd,
      projectKey: normalizedCwd,
      projectId: normalizedCwd,
      createdAt: firstTimestamp ?? fileStat.birthtimeMs,
      updatedAt: fileStat.mtimeMs,
      messageCount: Math.max(messageCount, userMessageCount),
      fileSize: fileStat.size,
      filePath,
      modelProvider: threadMetadata.modelProvider,
    };

    setCache(filePath, fileStat.mtimeMs, meta);

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

  private async extractMeta(filePath: string): Promise<ConversationMeta | null> {
    const fileStat = await stat(filePath);
    const cached = getCached(filePath, fileStat.mtimeMs);
    if (cached) return cached;

    // 只读前 20 行获取 session_meta 和首条用户消息
    const headEntries = await parseJsonlHead<CodexEntry>(filePath, 20);
    if (headEntries.length === 0) return null;

    const sessionMeta = headEntries.find((e) => e.type === "session_meta");
    const sessionId = sessionMeta?.payload?.id || filePath.split(/[/\\]/).pop()!.replace(".jsonl", "");
    const cwd = sessionMeta?.payload?.cwd || "";

    const userMessages = headEntries.filter(
      (e) => e.type === "event_msg" && e.payload?.type === "user_message" && e.payload.message
    );

    const defaultTitle = userMessages[0]?.payload?.message?.slice(0, 100) || "未知对话";

    // 快速行计数
    const messageCount = await countLines(
      filePath,
      (value) => {
        if (!value || typeof value !== "object") return false;
        const entry = value as CodexEntry;
        return entry.type === "response_item"
          && (entry.payload?.role === "user" || entry.payload?.role === "assistant");
      },
      {
        fastIncludes: ['"type":"response_item"', '"role":"user"', '"role":"assistant"'],
      }
    );
    if (messageCount === 0 && userMessages.length === 0) return null;

    const firstTs = new Date(headEntries[0].timestamp).getTime();
    const normalizedCwd = canonicalizeProjectPath(cwd);

    const threadMetadata = this.getThreadMetadata(sessionId);
    const normalizedThreadTitle = threadMetadata.title?.replace(/<[^>]+>/g, "").trim();
    if (
      normalizedThreadTitle
      && threadMetadata.firstUserMessage?.trim() !== normalizedThreadTitle
    ) {
      this.scheduleTitleBackfill(sessionId, normalizedThreadTitle);
    }

    const meta: ConversationMeta = {
      id: `codex:${sessionId}`,
      provider: this.name,
      title: normalizedThreadTitle || defaultTitle.replace(/<[^>]+>/g, "").trim() || "未知对话",
      project: normalizedCwd,
      projectKey: normalizedCwd,
      projectId: normalizedCwd,
      createdAt: firstTs,
      updatedAt: fileStat.mtimeMs,
      messageCount: Math.max(messageCount, userMessages.length),
      fileSize: fileStat.size,
      filePath,
      modelProvider: threadMetadata.modelProvider,
    };

    setCache(filePath, fileStat.mtimeMs, meta);
    return meta;
  }

  private async findConversationFilePath(sessionId: string): Promise<string> {
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "**", `*${sessionId}*.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    if (files.length === 0) {
      throw new Error(`对话不存在: codex:${sessionId}`);
    }
    return files[0];
  }

  private invalidateConversationCaches(filePath: string): void {
    invalidateCache(filePath);
    invalidateMessageActionIndex(filePath);
    invalidateCodexMessageIdentityCache(filePath);
    invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
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
  }

  async delete(id: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    await unlink(filePath);
    deletePersistedCodexMessageIdentity(filePath);
    this.invalidateConversationCaches(filePath);
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const fileStat = await stat(filePath);
    const newCwd = targetProjectKey.replace(/\//g, "\\");

    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const newLines = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const entry = JSON.parse(line) as CodexEntry;
        if (entry.type === "session_meta" && entry.payload?.cwd) {
          entry.payload.cwd = newCwd;
          return JSON.stringify(entry);
        }
      } catch {
        // 保持原样
      }
      return line;
    });
    await writeFile(filePath, newLines.join("\n"), "utf-8");
    const nextFileStat = await stat(filePath);
    carryCodexMessageIdentityCacheAcrossEdit(filePath, fileStat.mtimeMs, nextFileStat.mtimeMs);
    invalidateCache(filePath);
    invalidateMessageActionIndex(filePath);
    invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
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
    const filePath = await this.findConversationFilePath(sessionId);
    await this.writeThreadDisplayTitle(sessionId, normalizedTitle);
    this.invalidateConversationCaches(filePath);
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
    invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
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
    invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
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
        if (cwd) cwds.add(canonicalizeProjectPath(cwd));
      } catch {
        // 跳过
      }
    }
    return [...cwds];
  }

  // 列出所有 model_provider 及对话数
  listModelProviders(): { name: string; count: number }[] {
    const db = this.getDb();
    if (!db) return [];
    try {
      const rows = db.prepare("SELECT model_provider, COUNT(*) as count FROM threads GROUP BY model_provider ORDER BY count DESC").all() as { model_provider: string; count: number }[];
      return rows.map((r) => ({ name: r.model_provider, count: r.count }));
    } catch {
      return [];
    }
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

    // 先确认所有文件都存在，避免 DB 已写入但文件找不到导致状态部分成功。
    const filePaths = await Promise.all(
      sessionIds.map(async (sessionId) => this.findConversationFilePath(sessionId))
    );

    const dbPath = this.getStateDbPath();
    this.closeDb();

    const db = new Database(dbPath);
    try {
      const updateStatement = db.prepare("UPDATE threads SET model_provider = ? WHERE id = ?");
      const updateMany = db.transaction((targetSessionIds: string[]) => {
        for (const sessionId of targetSessionIds) {
          const result = updateStatement.run(normalizedProvider, sessionId);
          if (result.changes === 0) {
            throw new Error(`SQLite 中未找到对话: ${sessionId}`);
          }
        }
      });

      updateMany(sessionIds);
    } finally {
      db.close();
    }

    for (const filePath of new Set(filePaths)) {
      invalidateCache(filePath);
    }
    invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));

    return sessionIds.length;
  }
}
