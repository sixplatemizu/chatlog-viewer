import { dirname, join } from "path";
import { mkdir, rename, stat, unlink, readFile, writeFile } from "fs/promises";
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

interface CodexThreadRow {
  id: string;
  rolloutPath: string;
  createdAt: number;
  updatedAt: number;
  source: string;
  modelProvider?: string;
  cwd: string;
  title?: string;
  firstUserMessage?: string;
}

const CODEX_STATE_ONLY_PREFIX = "codex-state://";
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

function normalizeCodexTimestamp(value: number | null | undefined, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value ?? NaN);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
}

function normalizeCodexDisplayText(value?: string | null): string | undefined {
  const normalized = value?.replace(/<[^>]+>/g, "").trim();
  return normalized ? normalized : undefined;
}

function buildCodexStateOnlyFilePath(sessionId: string, rolloutPath?: string): string {
  const normalizedRolloutPath = rolloutPath ? normalizePath(rolloutPath) : "";
  return normalizedRolloutPath || `${CODEX_STATE_ONLY_PREFIX}${sessionId}`;
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

function formatCodexStoredPath(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = normalizePath(value);
  if (/^[A-Za-z]:\//.test(normalized)) {
    return normalized.replace(/\//g, "\\");
  }
  return normalized;
}

function buildCodexProjectStorageKey(projectPath: string): string {
  const normalized = normalizePath(projectPath);
  if (!normalized) return "unknown-project";
  const key = normalized.replace(/[:/\\]/g, "-").replace(/^-+/, "");
  return key || "unknown-project";
}

function buildCodexTranscriptPath(storagePath: string, projectPath: string, sessionId: string): string {
  return normalizePath(join(storagePath, buildCodexProjectStorageKey(projectPath), `${sessionId}.jsonl`));
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
  private writeDb: BetterSqlite3.Database | null = null;
  private writeDbPath: string | null = null;
  private backgroundRefreshes = new Map<string, Promise<void>>();

  private getStateDbPath(): string {
    return getProviderPaths("codex").stateDbPath || join(this.getStoragePath(), "..", "state_5.sqlite");
  }

  private closeDb(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.dbPath = null;
    this.closeWriteDb();
  }

  private closeWriteDb(): void {
    if (this.writeDb) {
      this.writeDb.close();
      this.writeDb = null;
    }
    this.writeDbPath = null;
  }

  // 写入前统一通过该方法获取 writable handle。
  // 同一个 dbPath 会在进程生命周期内复用；切换路径时重建。
  // 打开写连接前关闭 readonly handle 避免锁冲突。
  private getWriteDb(options: { fileMustExist?: boolean } = {}): BetterSqlite3.Database {
    const dbPath = this.getStateDbPath();
    if (this.writeDb && this.writeDbPath === dbPath) return this.writeDb;

    this.closeWriteDb();
    this.closeDb();

    this.writeDb = new Database(dbPath, options.fileMustExist ? { fileMustExist: true } : undefined);
    this.writeDbPath = dbPath;
    return this.writeDb;
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

  private getThreadTableColumns(): Set<string> {
    const db = this.getDb();
    if (!db) return new Set();

    try {
      const rows = db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>;
      return new Set(rows.map((row) => row.name));
    } catch {
      return new Set();
    }
  }

  private getTableColumns(db: BetterSqlite3.Database, tableName: string): Set<string> {
    try {
      const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
      return new Set(rows.map((row) => row.name));
    } catch {
      return new Set();
    }
  }

  private deleteThreadFromStateDb(sessionId: string): boolean {
    let db: BetterSqlite3.Database;
    try {
      db = this.getWriteDb({ fileMustExist: true });
    } catch {
      return false;
    }

    const tableNames = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).
        map((row) => row.name)
    );
    const relatedDeletes = [
      { table: "thread_dynamic_tools", columns: ["thread_id"] },
      { table: "stage1_outputs", columns: ["thread_id"] },
      { table: "thread_spawn_edges", columns: ["child_thread_id", "parent_thread_id"] },
      { table: "agent_job_items", columns: ["assigned_thread_id"] },
      { table: "logs", columns: ["thread_id"] },
    ];

    const deleteTransaction = db.transaction((targetSessionId: string) => {
      let changes = 0;

      for (const item of relatedDeletes) {
        if (!tableNames.has(item.table)) continue;
        const columns = this.getTableColumns(db, item.table);
        for (const column of item.columns) {
          if (!columns.has(column)) continue;
          const result = db.prepare(`DELETE FROM ${item.table} WHERE ${column} = ?`).run(targetSessionId);
          changes += result.changes;
        }
      }

      if (tableNames.has("threads") && this.getTableColumns(db, "threads").has("id")) {
        const result = db.prepare("DELETE FROM threads WHERE id = ?").run(targetSessionId);
        changes += result.changes;
      }

      return changes;
    });

    return deleteTransaction(sessionId) > 0;
  }

  private listThreadsFromStateDb(): CodexThreadRow[] {
    const db = this.getDb();
    if (!db) return [];

    try {
      const columns = this.getThreadTableColumns();
      if (!columns.has("id")) return [];

      const hasRolloutPath = columns.has("rollout_path");
      const hasCreatedAt = columns.has("created_at");
      const hasUpdatedAt = columns.has("updated_at");
      const hasSource = columns.has("source");
      const hasModelProvider = columns.has("model_provider");
      const hasCwd = columns.has("cwd");
      const hasTitle = columns.has("title");
      const hasFirstUserMessage = columns.has("first_user_message");

      const rows = db.prepare(`
        SELECT
          id,
          ${hasRolloutPath ? "rollout_path" : "''"} AS rollout_path,
          ${hasCreatedAt ? "created_at" : "0"} AS created_at,
          ${hasUpdatedAt ? "updated_at" : "0"} AS updated_at,
          ${hasSource ? "source" : "'cli'"} AS source,
          ${hasModelProvider ? "model_provider" : "NULL"} AS model_provider,
          ${hasCwd ? "cwd" : "''"} AS cwd,
          ${hasTitle ? "title" : "NULL"} AS title,
          ${hasFirstUserMessage ? "first_user_message" : "NULL"} AS first_user_message
        FROM threads
      `).all() as Array<{
        id: string;
        rollout_path: string;
        created_at: number | null;
        updated_at: number | null;
        source: string;
        model_provider: string | null;
        cwd: string;
        title: string | null;
        first_user_message: string | null;
      }>;

      return rows.map((row) => {
        const fallbackTimestamp = Date.now();
        const createdAt = normalizeCodexTimestamp(row.created_at, fallbackTimestamp);
        const updatedAt = normalizeCodexTimestamp(row.updated_at, createdAt);

        return {
          id: row.id,
          rolloutPath: normalizePath(row.rollout_path || ""),
          createdAt,
          updatedAt,
          source: row.source || "cli",
          modelProvider: row.model_provider ?? undefined,
          cwd: row.cwd || "",
          title: row.title ?? undefined,
          firstUserMessage: row.first_user_message ?? undefined,
        };
      });
    } catch {
      return [];
    }
  }

  private buildStateOnlyMeta(thread: CodexThreadRow): ConversationMeta | null {
    const normalizedCwd = canonicalizeProjectPath(thread.cwd);
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
    };
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

    const db = this.getWriteDb();
    const result = options?.updateTitleField === false
      ? db.prepare("UPDATE threads SET first_user_message = ? WHERE id = ?").run(normalizedTitle, sessionId)
      : db.prepare("UPDATE threads SET title = ?, first_user_message = ? WHERE id = ?").run(normalizedTitle, normalizedTitle, sessionId);
    if (result.changes === 0) {
      throw new Error(`SQLite 中未找到对话: ${sessionId}`);
    }
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
    const transcriptFileStates = fileStates.filter((fileState) => fileState.path !== this.getNormalizedStateDbPath());

    const results: IndexedCacheItem[] = [];
    const filesToRefresh: string[] = [];
    const transcriptSessionIds = new Set<string>();

    for (const fileState of transcriptFileStates) {
      const filePath = fileState.path;
      const sessionId = filePath.split(/[/\\]/).pop()!.replace(".jsonl", "");
      transcriptSessionIds.add(sessionId);
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

    const seenIds = new Set(results.map((item) => item.meta.id));
    for (const thread of this.listThreadsFromStateDb()) {
      if (transcriptSessionIds.has(thread.id)) {
        continue;
      }

      const filePath = buildCodexStateOnlyFilePath(thread.id, thread.rolloutPath);
      const previousItem = previousByFilePath.get(filePath);
      const previousMeta = previousItem?.meta;
      const rowUpdatedAt = thread.updatedAt;
      const rowCreatedAt = thread.createdAt;
      const previousStillFresh = previousMeta
        && previousMeta.updatedAt === rowUpdatedAt
        && previousMeta.createdAt === rowCreatedAt
        && previousMeta.modelProvider === thread.modelProvider
        && previousMeta.projectKey === canonicalizeProjectPath(thread.cwd)
        && previousMeta.transcriptMissing === true
        && (!options.eagerSearchIndex || hasIndexedSearchData(previousItem));

      if (previousStillFresh && previousItem) {
        results.push(previousItem);
        seenIds.add(previousItem.meta.id);
        continue;
      }

      const meta = this.buildStateOnlyMeta(thread);
      if (!meta || seenIds.has(meta.id)) {
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

    if (!options.includeSearchIndex) {
      const meta = await this.extractMeta(filePath);
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
      if (searchBuilder) {
        appendSearchIndexEntry(searchBuilder, entry);
      }
    });

    if (messageCount === 0 && userMessageCount === 0) {
      return null;
    }

    const normalizedCwd = canonicalizeProjectPath(cwd);
    const threadMetadata = this.getThreadMetadata(sessionId);
    const normalizedThreadTitle = threadMetadata.title?.replace(/<[^>]+>/g, "").trim();

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
      contentStatus: "full",
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
      contentStatus: "full",
    };

    setCache(filePath, fileStat.mtimeMs, meta);
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
    const rolloutPath = this.findThreadFromStateDb(sessionId)?.rolloutPath;
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

  private updateThreadLocation(
    sessionId: string,
    updates: {
      cwd?: string;
      rolloutPath?: string | null;
    }
  ): boolean {
    let db: BetterSqlite3.Database;
    try {
      db = this.getWriteDb({ fileMustExist: true });
    } catch {
      return false;
    }

    const columns = this.getTableColumns(db, "threads");
    if (columns.size === 0) return false;

    const assignments: string[] = [];
    const values: unknown[] = [];

    if (updates.cwd !== undefined && columns.has("cwd")) {
      assignments.push("cwd = ?");
      values.push(formatCodexStoredPath(updates.cwd) ?? updates.cwd);
    }

    if (updates.rolloutPath !== undefined && columns.has("rollout_path")) {
      assignments.push("rollout_path = ?");
      values.push(updates.rolloutPath ? formatCodexStoredPath(updates.rolloutPath) ?? updates.rolloutPath : "");
    }

    if (assignments.length === 0) return false;

    values.push(sessionId);
    const result = db.prepare(`UPDATE threads SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }

  private findThreadFromStateDb(sessionId: string): CodexThreadRow | null {
    return this.listThreadsFromStateDb().find((thread) => thread.id === sessionId) ?? null;
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
      const thread = this.findThreadFromStateDb(sessionId);
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

    const stateDbDeleted = this.deleteThreadFromStateDb(sessionId);
    if (!transcriptDeleted && !stateDbDeleted) {
      throw new Error(`对话不存在: ${id}`);
    }

    if (!filePath) {
      invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
    }
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const normalizedTargetProject = normalizePath(targetProjectKey);
    const canonicalTargetProject = canonicalizeProjectPath(targetProjectKey) || normalizedTargetProject;
    if (!canonicalTargetProject) {
      throw new Error("目标文件夹不能为空");
    }

    const existingThread = this.findThreadFromStateDb(sessionId);
    let filePath: string | null = null;
    try {
      filePath = await this.findConversationFilePath(sessionId);
    } catch (error) {
      if (!existingThread) {
        throw error;
      }
    }

    if (!filePath) {
      const updated = this.updateThreadLocation(sessionId, { cwd: normalizedTargetProject });
      if (existingThread && !updated) {
        throw new Error(`未能同步 Codex state db: ${id}`);
      }
      invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
      return;
    }

    const originalFilePath = filePath;
    const targetFilePath = buildCodexTranscriptPath(this.getStoragePath(), canonicalTargetProject, sessionId);
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

      const updated = this.updateThreadLocation(sessionId, {
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
        invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
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
    let filePath: string | null = null;

    try {
      filePath = await this.findConversationFilePath(sessionId);
    } catch {
      const thread = this.findThreadFromStateDb(sessionId);
      if (!thread) {
        throw new Error(`对话不存在: ${id}`);
      }
    }

    await this.writeThreadDisplayTitle(sessionId, normalizedTitle);
    if (filePath) {
      this.invalidateConversationCaches(filePath);
    } else {
      invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
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

  // 列出 SQLite 中存在的 model_provider 名称（用于迁移目标列表）。
  // 不返回计数：SQLite 会保留大量空 session，估值远高于实际有效对话数。
  listModelProviders(): string[] {
    const db = this.getDb();
    if (!db) return [];
    try {
      const rows = db
        .prepare("SELECT DISTINCT model_provider FROM threads ORDER BY model_provider")
        .all() as { model_provider: string }[];
      return rows.map((r) => r.model_provider);
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

    const filePaths = await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          return await this.findConversationFilePath(sessionId);
        } catch {
          return null;
        }
      })
    );

    const db = this.getWriteDb();
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

    for (const filePath of new Set(filePaths.filter((item): item is string => !!item))) {
      invalidateCache(filePath);
    }
    invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));

    return sessionIds.length;
  }
}
