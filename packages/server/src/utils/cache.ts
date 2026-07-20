import { existsSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import type { ConversationMeta } from "../providers/types.js";
import { SEARCH_INDEX_VERSION } from "./search-index.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;

const INDEX_TTL_MS = 30_000;
const SIGNATURE_CACHE_MAX_AGE_MS = 5 * 60_000;
const CACHE_PRUNE_INTERVAL_MS = 5 * 60_000;
const VACUUM_INTERVAL_MS = 24 * 60 * 60_000;
const META_CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60_000;
const LIST_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const MESSAGE_IDENTITY_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const KEEP_META_ROWS = 50_000;
// meta_cache 中 ConversationMeta 字段语义/抽取逻辑变更时升级此版本号。
// 启动时检测到旧版本会清空 meta_cache + indexed_list_cache + conversation_index
// 等派生 cache，强制下一轮 list 重新从 jsonl/state-db 解析，避免被旧 bug 时期
// 写入的污染 meta 卡住（典型例子：applyProjectDisplayPathHints 曾把同一
// projectKey 下所有 session 的 project 同化为最深路径）。
const META_CACHE_VERSION = 5;

interface CacheEntry {
  mtimeMs: number;
  meta: ConversationMeta;
}

interface ListCacheEntry {
  signature: string;
  items: ConversationMeta[];
}

interface IndexedListCacheEntry {
  items: ConversationMeta[];
  updatedAt: number;
  searchReady: boolean;
  searchVersion: number;
  sourceSignature?: string;
  detailedItems?: IndexedCacheItem[];
  detailedItemsIncludeSearchData?: boolean;
}

export interface IndexedCacheItem {
  meta: ConversationMeta;
  searchText?: string;
  searchChunks?: string[];
}

export interface PersistedMessageIdentityEntry {
  mtimeMs: number;
  orderedMessageIds: string[];
  lineByMessageId: Map<string, number>;
}

interface IndexedListCacheReadOptions {
  requireSearchReady?: boolean;
  sourceSignature?: string;
}

interface IndexedListCacheWriteOptions {
  searchReady?: boolean;
  searchVersion?: number;
  sourceSignature?: string;
  writeSearchData?: boolean;
}

interface IndexedCacheSnapshotOptions {
  includeSearchData?: boolean;
}

// 基于文件 mtime 的元数据缓存
class LRUMap<K, V> {
  private map = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, value);
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  has(key: K): boolean {
    return this.map.has(key);
  }
}

const memoryCache = new LRUMap<string, CacheEntry>(10_000);
const memoryListCache = new LRUMap<string, ListCacheEntry>(200);
const memoryIndexedListCache = new LRUMap<string, IndexedListCacheEntry>(500);
let db: BetterSqlite3.Database | null = null;
let dbPath: string | null = null;
let lastPruneAt = 0;
let lastVacuumAt = Date.now();
let supportsConversationFtsSearch = false;
let supportsChunkFtsSearch = false;
let storeDirOverride: string | null = null;

function getStoreDir(): string {
  const envOverride = process.env.CHATLOG_VIEWER_STORE_DIR?.trim();
  return storeDirOverride || envOverride || join(homedir(), ".chatlog-viewer");
}

function getDbPath(): string {
  return join(getStoreDir(), "meta-cache.sqlite");
}

function resetCacheState(): void {
  memoryCache.clear();
  memoryListCache.clear();
  memoryIndexedListCache.clear();
  supportsConversationFtsSearch = false;
  supportsChunkFtsSearch = false;
  lastPruneAt = 0;
  lastVacuumAt = Date.now();

  if (db) {
    try {
      db.close();
    } catch {
      // 忽略关闭失败
    }
  }

  db = null;
  dbPath = null;
}

export function setCacheStoreDirForTests(storeDir?: string): void {
  storeDirOverride = storeDir?.trim() || null;
  resetCacheState();
}

export function getIndexedListCacheKey(providerName: string, storagePath: string): string {
  return `${providerName}::${storagePath}::indexed`;
}

function getDb(): BetterSqlite3.Database {
  const nextDbPath = getDbPath();
  if (db && dbPath === nextDbPath) return db;
  if (db && dbPath !== nextDbPath) {
    resetCacheState();
  }

  const storeDir = getStoreDir();
  if (!existsSync(storeDir)) {
    mkdirSync(storeDir, { recursive: true });
  }

  db = new Database(nextDbPath);
  dbPath = nextDbPath;
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_cache (
      file_path TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL,
      meta_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS list_cache (
      cache_key TEXT PRIMARY KEY,
      signature TEXT NOT NULL,
      list_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS indexed_list_cache (
      cache_key TEXT PRIMARY KEY,
      list_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      search_ready INTEGER NOT NULL DEFAULT 1,
      search_version INTEGER NOT NULL DEFAULT 1,
      source_signature TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation_index (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      title TEXT NOT NULL,
      search_text TEXT,
      project TEXT NOT NULL,
      project_key TEXT NOT NULL,
      project_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      file_size INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      model_provider TEXT,
      meta_json TEXT,
      cache_key TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      search_version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS conversation_search_chunk (
      conversation_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      search_version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (conversation_id, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS codex_message_identity (
      file_path TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL,
      ordered_message_ids_json TEXT NOT NULL,
      line_by_message_id_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  ensureIndexedListCacheSchema(db);
  ensureConversationIndexSchema(db);
  ensureConversationSearchChunkSchema(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversation_index_provider_updated_at
    ON conversation_index (provider, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_conversation_index_provider_created_at
    ON conversation_index (provider, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_conversation_index_cache_key
    ON conversation_index (cache_key);

    CREATE INDEX IF NOT EXISTS idx_conversation_search_chunk_cache_key
    ON conversation_search_chunk (cache_key);

    CREATE INDEX IF NOT EXISTS idx_conversation_search_chunk_conversation_id
    ON conversation_search_chunk (conversation_id);
  `);

  migrateMetaCacheVersion(db);

  return db;
}

// 检测 meta_cache schema 版本。低版本说明可能存在历史 bug 写入的污染条目，
// 清空所有派生 cache 表（meta_cache / list_cache / indexed_list_cache /
// conversation_index / conversation_search_chunk），让下一次 list 重建。
// codex_message_identity 不清，它独立于 ConversationMeta。
function migrateMetaCacheVersion(database: BetterSqlite3.Database): void {
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS cache_schema_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )
    `);
    const row = database
      .prepare("SELECT value FROM cache_schema_meta WHERE key = ?")
      .get("meta_cache_version") as { value: number } | undefined;
    const storedVersion = row?.value ?? 0;
    if (storedVersion === META_CACHE_VERSION) return;

    database.exec(`
      DELETE FROM meta_cache;
      DELETE FROM list_cache;
      DELETE FROM indexed_list_cache;
      DELETE FROM conversation_index;
      DELETE FROM conversation_search_chunk;
    `);
    database
      .prepare("INSERT OR REPLACE INTO cache_schema_meta (key, value) VALUES (?, ?)")
      .run("meta_cache_version", META_CACHE_VERSION);
    console.log(`[cache] meta_cache 版本迁移 ${storedVersion} → ${META_CACHE_VERSION}，已清空派生缓存`);
  } catch {
    // 迁移失败不影响主流程，下一轮 list 自然会重新解析（最坏情况是命中旧值）
  }
}

function ensureIndexedListCacheSchema(database: BetterSqlite3.Database): void {
  const columns = database
    .prepare("PRAGMA table_info(indexed_list_cache)")
    .all() as Array<{ name: string }>;

  if (!columns.some((column) => column.name === "search_ready")) {
    database.exec(
      "ALTER TABLE indexed_list_cache ADD COLUMN search_ready INTEGER NOT NULL DEFAULT 1"
    );
  }

  if (!columns.some((column) => column.name === "search_version")) {
    database.exec(
      "ALTER TABLE indexed_list_cache ADD COLUMN search_version INTEGER NOT NULL DEFAULT 1"
    );
  }

  if (!columns.some((column) => column.name === "source_signature")) {
    database.exec("ALTER TABLE indexed_list_cache ADD COLUMN source_signature TEXT");
  }
}

function ensureConversationIndexSchema(database: BetterSqlite3.Database): void {
  const columns = database
    .prepare("PRAGMA table_info(conversation_index)")
    .all() as Array<{ name: string }>;

  if (!columns.some((column) => column.name === "search_text")) {
    database.exec("ALTER TABLE conversation_index ADD COLUMN search_text TEXT");
  }

  if (!columns.some((column) => column.name === "project_id")) {
    database.exec("ALTER TABLE conversation_index ADD COLUMN project_id TEXT");
  }

  if (!columns.some((column) => column.name === "search_version")) {
    database.exec("ALTER TABLE conversation_index ADD COLUMN search_version INTEGER NOT NULL DEFAULT 1");
  }

  if (!columns.some((column) => column.name === "meta_json")) {
    database.exec("ALTER TABLE conversation_index ADD COLUMN meta_json TEXT");
  }

  supportsConversationFtsSearch = false;

  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_index_fts USING fts5(
        title,
        project,
        search_text,
        content='conversation_index',
        content_rowid='rowid',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS conversation_index_ai AFTER INSERT ON conversation_index BEGIN
        INSERT INTO conversation_index_fts(rowid, title, project, search_text)
        VALUES (new.rowid, new.title, new.project, COALESCE(new.search_text, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS conversation_index_ad AFTER DELETE ON conversation_index BEGIN
        INSERT INTO conversation_index_fts(conversation_index_fts, rowid, title, project, search_text)
        VALUES ('delete', old.rowid, old.title, old.project, COALESCE(old.search_text, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS conversation_index_au AFTER UPDATE ON conversation_index BEGIN
        INSERT INTO conversation_index_fts(conversation_index_fts, rowid, title, project, search_text)
        VALUES ('delete', old.rowid, old.title, old.project, COALESCE(old.search_text, ''));
        INSERT INTO conversation_index_fts(rowid, title, project, search_text)
        VALUES (new.rowid, new.title, new.project, COALESCE(new.search_text, ''));
      END;
    `);

    const indexCount = database
      .prepare("SELECT COUNT(*) as count FROM conversation_index")
      .get() as { count: number };
    const ftsCount = database
      .prepare("SELECT COUNT(*) as count FROM conversation_index_fts")
      .get() as { count: number };

    if (indexCount.count !== ftsCount.count) {
      database.prepare("INSERT INTO conversation_index_fts(conversation_index_fts) VALUES ('rebuild')").run();
    }

    supportsConversationFtsSearch = true;
  } catch {
    supportsConversationFtsSearch = false;
  }
}

function ensureConversationSearchChunkSchema(database: BetterSqlite3.Database): void {
  const columns = database
    .prepare("PRAGMA table_info(conversation_search_chunk)")
    .all() as Array<{ name: string }>;

  if (!columns.some((column) => column.name === "search_version")) {
    database.exec("ALTER TABLE conversation_search_chunk ADD COLUMN search_version INTEGER NOT NULL DEFAULT 1");
  }

  supportsChunkFtsSearch = false;

  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_search_chunk_fts USING fts5(
        content,
        content='conversation_search_chunk',
        content_rowid='rowid',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS conversation_search_chunk_ai AFTER INSERT ON conversation_search_chunk BEGIN
        INSERT INTO conversation_search_chunk_fts(rowid, content)
        VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS conversation_search_chunk_ad AFTER DELETE ON conversation_search_chunk BEGIN
        INSERT INTO conversation_search_chunk_fts(conversation_search_chunk_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS conversation_search_chunk_au AFTER UPDATE ON conversation_search_chunk BEGIN
        INSERT INTO conversation_search_chunk_fts(conversation_search_chunk_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
        INSERT INTO conversation_search_chunk_fts(rowid, content)
        VALUES (new.rowid, new.content);
      END;
    `);

    const chunkCount = database
      .prepare("SELECT COUNT(*) as count FROM conversation_search_chunk")
      .get() as { count: number };
    const chunkFtsCount = database
      .prepare("SELECT COUNT(*) as count FROM conversation_search_chunk_fts")
      .get() as { count: number };

    if (chunkCount.count !== chunkFtsCount.count) {
      database.prepare("INSERT INTO conversation_search_chunk_fts(conversation_search_chunk_fts) VALUES ('rebuild')").run();
    }

    supportsChunkFtsSearch = true;
  } catch {
    supportsChunkFtsSearch = false;
  }
}

function buildLikePattern(search: string): string {
  return `%${search.toLowerCase()}%`;
}

function buildFtsSearchQuery(search: string): string | null {
  const terms = search
    .trim()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  if (terms.length === 0) {
    return null;
  }

  if (terms.some((term) => Array.from(term).length < 3)) {
    return null;
  }

  return terms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" AND ");
}

export function hasIndexedSearchData(item: IndexedCacheItem): boolean {
  return item.searchText !== undefined || (item.searchChunks?.length ?? 0) > 0;
}

interface ConversationIndexRow {
  id: string;
  provider: string;
  title: string;
  search_text: string | null;
  project: string;
  project_key: string;
  project_id: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
  file_size: number;
  file_path: string;
  model_provider: string | null;
  meta_json: string | null;
  search_version?: number;
}

function buildConversationMetaFromIndexRow(row: ConversationIndexRow): ConversationMeta {
  const fallback: ConversationMeta = {
    id: row.id,
    provider: row.provider,
    title: row.title,
    project: row.project,
    projectKey: row.project_key,
    projectId: row.project_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    fileSize: row.file_size,
    filePath: row.file_path,
    modelProvider: row.model_provider ?? undefined,
  };

  if (!row.meta_json) return fallback;

  try {
    const parsed = JSON.parse(row.meta_json) as unknown;
    if (!parsed || typeof parsed !== "object") return fallback;
    const parsedMeta = parsed as Partial<ConversationMeta>;
    const meta = { ...fallback, ...parsedMeta };
    return {
      ...meta,
      id: fallback.id,
      provider: fallback.provider,
      title: fallback.title,
      project: fallback.project,
      projectKey: fallback.projectKey,
      projectId: fallback.projectId,
      createdAt: fallback.createdAt,
      updatedAt: fallback.updatedAt,
      messageCount: fallback.messageCount,
      fileSize: fallback.fileSize,
      filePath: fallback.filePath,
      modelProvider: fallback.modelProvider ?? meta.modelProvider,
    };
  } catch {
    return fallback;
  }
}

function createIndexedItemSignature(item: {
  meta: ConversationMeta;
  searchText?: string;
  searchChunks?: string[];
  searchVersion: number;
}): string {
  return JSON.stringify([
    item.searchVersion,
    item.meta,
    item.searchText ?? null,
    item.searchChunks ?? [],
  ]);
}

export function getCached(filePath: string, mtimeMs: number): ConversationMeta | null {
  const memoryEntry = memoryCache.get(filePath);
  if (memoryEntry && memoryEntry.mtimeMs === mtimeMs) {
    return memoryEntry.meta;
  }

  try {
    const row = getDb()
      .prepare("SELECT mtime_ms, meta_json FROM meta_cache WHERE file_path = ?")
      .get(filePath) as { mtime_ms: number; meta_json: string } | undefined;

    if (!row || row.mtime_ms !== mtimeMs) {
      return null;
    }

    const meta = JSON.parse(row.meta_json) as ConversationMeta;
    memoryCache.set(filePath, { mtimeMs, meta });
    return meta;
  } catch {
    return null;
  }
}

export function setCache(filePath: string, mtimeMs: number, meta: ConversationMeta): void {
  memoryCache.set(filePath, { mtimeMs, meta });

  try {
    getDb()
      .prepare(
        `INSERT INTO meta_cache (file_path, mtime_ms, meta_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(file_path) DO UPDATE SET
           mtime_ms = excluded.mtime_ms,
           meta_json = excluded.meta_json,
           updated_at = excluded.updated_at`
      )
      .run(filePath, mtimeMs, JSON.stringify(meta), Date.now());
  } catch {
    // 持久化失败时退回内存缓存
  }
}

export function getListCache(cacheKey: string, signature: string): ConversationMeta[] | null {
  const memoryEntry = memoryListCache.get(cacheKey);
  if (memoryEntry && memoryEntry.signature === signature) {
    return memoryEntry.items;
  }

  try {
    const row = getDb()
      .prepare("SELECT signature, list_json FROM list_cache WHERE cache_key = ?")
      .get(cacheKey) as { signature: string; list_json: string } | undefined;

    if (!row || row.signature !== signature) {
      return null;
    }

    const items = JSON.parse(row.list_json) as ConversationMeta[];
    memoryListCache.set(cacheKey, { signature, items });
    return items;
  } catch {
    return null;
  }
}

export function setListCache(cacheKey: string, signature: string, items: ConversationMeta[]): void {
  memoryListCache.set(cacheKey, { signature, items });

  try {
    getDb()
      .prepare(
        `INSERT INTO list_cache (cache_key, signature, list_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           signature = excluded.signature,
           list_json = excluded.list_json,
           updated_at = excluded.updated_at`
      )
      .run(cacheKey, signature, JSON.stringify(items), Date.now());
  } catch {
    // 持久化失败时退回内存缓存
  }
}

function isUsableIndexedListCache(
  now: number,
  updatedAt: number,
  ttlMs: number,
  searchReady: boolean,
  searchVersion: number,
  sourceSignature: string | undefined,
  options?: IndexedListCacheReadOptions
): boolean {
  const hasSourceSignature = options?.sourceSignature !== undefined;

  if (hasSourceSignature && now - updatedAt > SIGNATURE_CACHE_MAX_AGE_MS) {
    return false;
  }
  if (!hasSourceSignature && now - updatedAt > ttlMs) {
    return false;
  }

  if (options?.requireSearchReady && !searchReady) {
    return false;
  }

  if (options?.requireSearchReady && searchVersion !== SEARCH_INDEX_VERSION) {
    return false;
  }

  if (hasSourceSignature && sourceSignature !== options.sourceSignature) {
    return false;
  }

  return true;
}

export function getIndexedListCache(
  cacheKey: string,
  ttlMs = INDEX_TTL_MS,
  options?: IndexedListCacheReadOptions
): ConversationMeta[] | null {
  const now = Date.now();
  const memoryEntry = memoryIndexedListCache.get(cacheKey);
  if (
    memoryEntry &&
    isUsableIndexedListCache(
      now,
      memoryEntry.updatedAt,
      ttlMs,
      memoryEntry.searchReady,
      memoryEntry.searchVersion,
      memoryEntry.sourceSignature,
      options
    )
  ) {
    return memoryEntry.items;
  }

  try {
    const row = getDb()
      .prepare("SELECT list_json, updated_at, search_ready, search_version, source_signature FROM indexed_list_cache WHERE cache_key = ?")
      .get(cacheKey) as
      | {
        list_json: string;
        updated_at: number;
        search_ready: number;
        search_version: number;
        source_signature: string | null;
      }
      | undefined;

    if (
      !row ||
      !isUsableIndexedListCache(
        now,
        row.updated_at,
        ttlMs,
        !!row.search_ready,
        row.search_version,
        row.source_signature ?? undefined,
        options
      )
    ) {
      return null;
    }

    const items = JSON.parse(row.list_json) as ConversationMeta[];
    memoryIndexedListCache.set(cacheKey, {
      items,
      updatedAt: row.updated_at,
      searchReady: !!row.search_ready,
      searchVersion: row.search_version,
      sourceSignature: row.source_signature ?? undefined,
    });
    return items;
  } catch {
    return null;
  }
}

export function getIndexedListSnapshot(cacheKey: string): ConversationMeta[] | null {
  const memoryEntry = memoryIndexedListCache.get(cacheKey);
  if (memoryEntry) {
    return memoryEntry.items;
  }

  try {
    const row = getDb()
      .prepare("SELECT list_json, updated_at, search_ready, search_version, source_signature FROM indexed_list_cache WHERE cache_key = ?")
      .get(cacheKey) as
      | {
        list_json: string;
        updated_at: number;
        search_ready: number;
        search_version: number;
        source_signature: string | null;
      }
      | undefined;

    if (!row) {
      return null;
    }

    const items = JSON.parse(row.list_json) as ConversationMeta[];
    memoryIndexedListCache.set(cacheKey, {
      items,
      updatedAt: row.updated_at,
      searchReady: !!row.search_ready,
      searchVersion: row.search_version,
      sourceSignature: row.source_signature ?? undefined,
    });
    return items;
  } catch {
    return null;
  }
}

export function getIndexedCacheSnapshot(
  cacheKey: string,
  options: IndexedCacheSnapshotOptions = {}
): IndexedCacheItem[] | null {
  const includeSearchData = options.includeSearchData ?? true;
  const memoryEntry = memoryIndexedListCache.get(cacheKey);
  if (
    includeSearchData
    && memoryEntry?.detailedItems
    && memoryEntry.detailedItemsIncludeSearchData
    && memoryEntry.searchVersion === SEARCH_INDEX_VERSION
  ) {
    return memoryEntry.detailedItems;
  }
  if (!includeSearchData && memoryEntry) {
    return memoryEntry.items.map((meta) => ({ meta }));
  }

  const baseItems = getIndexedListSnapshot(cacheKey);
  if (!includeSearchData && baseItems) {
    return baseItems.map((meta) => ({ meta }));
  }

  try {
    const database = getDb();
    const rows = database
      .prepare(`
        SELECT
          id,
          provider,
          title,
          search_text,
          project,
          project_key,
          project_id,
          created_at,
          updated_at,
          message_count,
          file_size,
          file_path,
          model_provider,
          meta_json,
          search_version
        FROM conversation_index
        WHERE cache_key = ?
          AND search_version = ?
        ORDER BY updated_at DESC
      `)
      .all(cacheKey, SEARCH_INDEX_VERSION) as Array<{
      id: string;
      provider: string;
      title: string;
      search_text: string | null;
      project: string;
      project_key: string;
      project_id: string | null;
      created_at: number;
      updated_at: number;
      message_count: number;
      file_size: number;
      file_path: string;
      model_provider: string | null;
      meta_json: string | null;
      search_version: number;
    }>;
    const chunkRows = includeSearchData
      ? database
          .prepare(`
            SELECT
              conversation_id,
              chunk_index,
              content
            FROM conversation_search_chunk
            WHERE cache_key = ?
              AND search_version = ?
            ORDER BY conversation_id ASC, chunk_index ASC
          `)
          .all(cacheKey, SEARCH_INDEX_VERSION) as Array<{
          conversation_id: string;
          chunk_index: number;
          content: string;
        }>
      : [];

    if (rows.length === 0) {
      return baseItems?.map((meta) => ({ meta })) ?? null;
    }

    const chunksByConversationId = new Map<string, string[]>();
    for (const row of chunkRows) {
      const chunks = chunksByConversationId.get(row.conversation_id) ?? [];
      chunks.push(row.content);
      chunksByConversationId.set(row.conversation_id, chunks);
    }

    const detailedItems = rows.map((row) => ({
      meta: buildConversationMetaFromIndexRow(row),
      searchText: includeSearchData ? row.search_text ?? undefined : undefined,
      searchChunks: includeSearchData ? chunksByConversationId.get(row.id) : undefined,
    }));

    const refreshedEntry = memoryIndexedListCache.get(cacheKey);
    if (refreshedEntry && includeSearchData) {
      memoryIndexedListCache.set(cacheKey, {
        ...refreshedEntry,
        detailedItems,
        detailedItemsIncludeSearchData: true,
      });
    }

    return detailedItems;
  } catch {
    return baseItems?.map((meta) => ({ meta })) ?? null;
  }
}

export function hasFreshIndexedListCache(
  cacheKey: string,
  ttlMs = INDEX_TTL_MS,
  options?: IndexedListCacheReadOptions
): boolean {
  const now = Date.now();
  const memoryEntry = memoryIndexedListCache.get(cacheKey);
  if (
    memoryEntry &&
    isUsableIndexedListCache(
      now,
      memoryEntry.updatedAt,
      ttlMs,
      memoryEntry.searchReady,
      memoryEntry.searchVersion,
      memoryEntry.sourceSignature,
      options
    )
  ) {
    return true;
  }

  try {
    const row = getDb()
      .prepare("SELECT updated_at, search_ready, search_version, source_signature FROM indexed_list_cache WHERE cache_key = ?")
      .get(cacheKey) as
      | {
        updated_at: number;
        search_ready: number;
        search_version: number;
        source_signature: string | null;
      }
      | undefined;

    return !!row && isUsableIndexedListCache(
      now,
      row.updated_at,
      ttlMs,
      !!row.search_ready,
      row.search_version,
      row.source_signature ?? undefined,
      options
    );
  } catch {
    return false;
  }
}

export function setIndexedListCache(
  cacheKey: string,
  items: ConversationMeta[] | IndexedCacheItem[],
  options?: IndexedListCacheWriteOptions
): void {
  const updatedAt = Date.now();
  const searchReady = options?.searchReady ?? true;
  const searchVersion = options?.searchVersion ?? SEARCH_INDEX_VERSION;
  const sourceSignature = options?.sourceSignature;
  const writeSearchData = options?.writeSearchData ?? true;
  const normalizedDetailedItems = items.map((item) => ("meta" in item ? item : { meta: item }));
  const normalizedItems = normalizedDetailedItems.map((item) => item.meta);
  memoryIndexedListCache.set(cacheKey, {
    items: normalizedItems,
    updatedAt,
    searchReady,
    searchVersion,
    sourceSignature,
    detailedItems: normalizedDetailedItems,
    detailedItemsIncludeSearchData: writeSearchData,
  });

  try {
    const database = getDb();
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO indexed_list_cache (cache_key, list_json, updated_at, search_ready, search_version, source_signature)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET
             list_json = excluded.list_json,
             updated_at = excluded.updated_at,
             search_ready = excluded.search_ready,
             search_version = excluded.search_version,
             source_signature = excluded.source_signature`
        )
        .run(cacheKey, JSON.stringify(normalizedItems), updatedAt, searchReady ? 1 : 0, searchVersion, sourceSignature ?? null);

      const upsertConversation = database.prepare(
        `INSERT INTO conversation_index (
           id,
           provider,
           title,
           search_text,
           project,
           project_key,
           project_id,
           created_at,
           updated_at,
           message_count,
           file_size,
           file_path,
           model_provider,
           meta_json,
           cache_key,
           indexed_at,
           search_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           title = excluded.title,
           search_text = excluded.search_text,
           project = excluded.project,
           project_key = excluded.project_key,
           project_id = excluded.project_id,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           message_count = excluded.message_count,
           file_size = excluded.file_size,
           file_path = excluded.file_path,
           model_provider = excluded.model_provider,
           meta_json = excluded.meta_json,
           cache_key = excluded.cache_key,
           indexed_at = excluded.indexed_at,
           search_version = excluded.search_version`
      );
      const deleteConversationChunks = database.prepare(
        "DELETE FROM conversation_search_chunk WHERE conversation_id = ?"
      );
      const upsertSearchChunk = database.prepare(
        `INSERT INTO conversation_search_chunk (
           conversation_id,
           chunk_index,
           content,
           cache_key,
           indexed_at,
           search_version
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, chunk_index) DO UPDATE SET
           content = excluded.content,
           cache_key = excluded.cache_key,
           indexed_at = excluded.indexed_at,
           search_version = excluded.search_version`
      );

      const existingRows = database.prepare(
        `SELECT
           id,
           provider,
           title,
           search_text,
           project,
           project_key,
           project_id,
           created_at,
           updated_at,
           message_count,
           file_size,
           file_path,
           model_provider,
           meta_json,
           search_version
         FROM conversation_index
         WHERE cache_key = ?`
      ).all(cacheKey) as Array<{
        id: string;
        provider: string;
        title: string;
        search_text: string | null;
        project: string;
        project_key: string;
        project_id: string | null;
        created_at: number;
        updated_at: number;
        message_count: number;
        file_size: number;
        file_path: string;
        model_provider: string | null;
        meta_json: string | null;
        search_version: number;
      }>;
      const existingChunkRows = writeSearchData
        ? database.prepare(
            `SELECT
               conversation_id,
               chunk_index,
               content,
               search_version
             FROM conversation_search_chunk
             WHERE cache_key = ?
             ORDER BY conversation_id ASC, chunk_index ASC`
          ).all(cacheKey) as Array<{
            conversation_id: string;
            chunk_index: number;
            content: string;
            search_version: number;
          }>
        : [];

      const existingChunksById = new Map<string, string[]>();
      for (const row of existingChunkRows) {
        const chunks = existingChunksById.get(row.conversation_id) ?? [];
        chunks.push(row.content);
        existingChunksById.set(row.conversation_id, chunks);
      }

      const existingSignatureById = new Map(
        existingRows.map((row) => [
          row.id,
          createIndexedItemSignature({
            meta: buildConversationMetaFromIndexRow(row),
            searchText: writeSearchData ? row.search_text ?? undefined : undefined,
            searchChunks: writeSearchData ? existingChunksById.get(row.id) : undefined,
            searchVersion: row.search_version,
          }),
        ])
      );
      const nextIds = new Set(normalizedDetailedItems.map((item) => item.meta.id));
      const staleIds = existingRows
        .map((row) => row.id)
        .filter((id) => !nextIds.has(id));

      if (staleIds.length > 0) {
        const chunkSize = 200;
        for (let start = 0; start < staleIds.length; start += chunkSize) {
          const chunk = staleIds.slice(start, start + chunkSize);
          const placeholders = chunk.map(() => "?").join(", ");
          database
            .prepare(`DELETE FROM conversation_index WHERE id IN (${placeholders})`)
            .run(...chunk);
          database
            .prepare(`DELETE FROM conversation_search_chunk WHERE conversation_id IN (${placeholders})`)
            .run(...chunk);
        }
      }

      for (const item of normalizedDetailedItems) {
        const meta = item.meta;
        const nextSignature = createIndexedItemSignature({
          meta,
          searchText: writeSearchData ? item.searchText : undefined,
          searchChunks: writeSearchData ? item.searchChunks : undefined,
          searchVersion,
        });

        if (existingSignatureById.get(meta.id) === nextSignature) {
          continue;
        }

        upsertConversation.run(
          meta.id,
          meta.provider,
          meta.title,
          writeSearchData ? item.searchText ?? null : null,
          meta.project,
          meta.projectKey,
          meta.projectId ?? null,
          meta.createdAt,
          meta.updatedAt,
          meta.messageCount,
          meta.fileSize,
          meta.filePath,
          meta.modelProvider ?? null,
          JSON.stringify(meta),
          cacheKey,
          updatedAt,
          searchVersion
        );

        deleteConversationChunks.run(meta.id);
        if (writeSearchData) {
          item.searchChunks?.forEach((chunk, index) => {
            upsertSearchChunk.run(
              meta.id,
              index,
              chunk,
              cacheKey,
              updatedAt,
              searchVersion
            );
          });
        }
      }
    })();
    pruneCacheStorage(database);
  } catch {
    // 持久化失败时退回内存缓存
  }
}

function serializeLineByMessageId(lineByMessageId: Map<string, number>): string {
  return JSON.stringify([...lineByMessageId.entries()]);
}

function deserializeLineByMessageId(rawValue: string): Map<string, number> {
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) {
      return new Map();
    }

    return new Map(
      parsed.filter((item): item is [string, number] => (
        Array.isArray(item)
        && typeof item[0] === "string"
        && typeof item[1] === "number"
        && Number.isInteger(item[1])
      ))
    );
  } catch {
    return new Map();
  }
}

export function getPersistedCodexMessageIdentity(
  filePath: string,
  mtimeMs: number
): PersistedMessageIdentityEntry | null {
  try {
    const row = getDb()
      .prepare(`
        SELECT mtime_ms, ordered_message_ids_json, line_by_message_id_json
        FROM codex_message_identity
        WHERE file_path = ? AND mtime_ms = ?
      `)
      .get(filePath, mtimeMs) as {
        mtime_ms: number;
        ordered_message_ids_json: string;
        line_by_message_id_json: string;
      } | undefined;

    if (!row) {
      return null;
    }

    const orderedMessageIds = JSON.parse(row.ordered_message_ids_json) as unknown;
    if (!Array.isArray(orderedMessageIds) || !orderedMessageIds.every((item) => typeof item === "string")) {
      return null;
    }

    return {
      mtimeMs: row.mtime_ms,
      orderedMessageIds,
      lineByMessageId: deserializeLineByMessageId(row.line_by_message_id_json),
    };
  } catch {
    return null;
  }
}

export function setPersistedCodexMessageIdentity(
  filePath: string,
  entry: PersistedMessageIdentityEntry
): void {
  try {
    const database = getDb();
    database.prepare(`
      INSERT INTO codex_message_identity (
        file_path,
        mtime_ms,
        ordered_message_ids_json,
        line_by_message_id_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        mtime_ms = excluded.mtime_ms,
        ordered_message_ids_json = excluded.ordered_message_ids_json,
        line_by_message_id_json = excluded.line_by_message_id_json,
        updated_at = excluded.updated_at
    `).run(
      filePath,
      entry.mtimeMs,
      JSON.stringify(entry.orderedMessageIds),
      serializeLineByMessageId(entry.lineByMessageId),
      Date.now()
    );
    pruneCacheStorage(database);
  } catch {
    // 忽略持久化失败
  }
}

export function deletePersistedCodexMessageIdentity(filePath: string): void {
  try {
    getDb().prepare("DELETE FROM codex_message_identity WHERE file_path = ?").run(filePath);
  } catch {
    // 忽略持久化失败
  }
}

export function queryConversationIndex(options: {
  cacheKeys: string[];
  search?: string;
  sort?: "updatedAt" | "createdAt" | "provider";
}): ConversationMeta[] {
  if (options.cacheKeys.length === 0) return [];

  try {
    const database = getDb();
    const whereClauses: string[] = [];
    const params: Array<string | number> = [];

    const cacheKeyPlaceholders = options.cacheKeys.map(() => "?").join(", ");
    whereClauses.push(`conversation_index.cache_key IN (${cacheKeyPlaceholders})`);
    params.push(...options.cacheKeys);

    if (options.search) {
      whereClauses.push("conversation_index.search_version = ?");
      params.push(SEARCH_INDEX_VERSION);

      const ftsQuery = buildFtsSearchQuery(options.search);
      if (ftsQuery && (supportsConversationFtsSearch || supportsChunkFtsSearch)) {
        const searchClauses: string[] = [];
        if (supportsConversationFtsSearch) {
          searchClauses.push(`
            EXISTS (
              SELECT 1
              FROM conversation_index_fts
              WHERE conversation_index_fts.rowid = conversation_index.rowid
                AND conversation_index_fts MATCH ?
            )
          `);
          params.push(ftsQuery);
        }
        if (supportsChunkFtsSearch) {
          searchClauses.push(`
            EXISTS (
              SELECT 1
              FROM conversation_search_chunk_fts
              JOIN conversation_search_chunk
                ON conversation_search_chunk.rowid = conversation_search_chunk_fts.rowid
              WHERE conversation_search_chunk.conversation_id = conversation_index.id
                AND conversation_search_chunk.cache_key = conversation_index.cache_key
                AND conversation_search_chunk.search_version = conversation_index.search_version
                AND conversation_search_chunk_fts MATCH ?
            )
          `);
          params.push(ftsQuery);
        }

        whereClauses.push(`(${searchClauses.join(" OR ")})`);
      } else {
        const lowerPattern = buildLikePattern(options.search);
        whereClauses.push(`
          (
            LOWER(conversation_index.title) LIKE ?
            OR LOWER(conversation_index.project) LIKE ?
            OR LOWER(COALESCE(conversation_index.search_text, '')) LIKE ?
            OR EXISTS (
              SELECT 1
              FROM conversation_search_chunk
              WHERE conversation_search_chunk.conversation_id = conversation_index.id
                AND conversation_search_chunk.cache_key = conversation_index.cache_key
                AND conversation_search_chunk.search_version = conversation_index.search_version
                AND LOWER(conversation_search_chunk.content) LIKE ?
            )
          )
        `);
        params.push(lowerPattern, lowerPattern, lowerPattern, lowerPattern);
      }
    }

    let orderBy = "conversation_index.updated_at DESC";
    if (options.sort === "createdAt") {
      orderBy = "conversation_index.created_at DESC";
    } else if (options.sort === "provider") {
      orderBy = "conversation_index.provider ASC, conversation_index.updated_at DESC";
    }

    const sql = `
      SELECT
        conversation_index.id,
        conversation_index.provider,
        conversation_index.title,
        conversation_index.search_text,
        conversation_index.project,
        conversation_index.project_key,
        conversation_index.project_id,
        conversation_index.created_at,
        conversation_index.updated_at,
        conversation_index.message_count,
        conversation_index.file_size,
        conversation_index.file_path,
        conversation_index.model_provider,
        conversation_index.meta_json
      FROM conversation_index
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY ${orderBy}
    `;

    const rows = database.prepare(sql).all(...params) as Array<{
      id: string;
      provider: string;
      title: string;
      search_text: string | null;
      project: string;
      project_key: string;
      project_id: string | null;
      created_at: number;
      updated_at: number;
      message_count: number;
      file_size: number;
      file_path: string;
      model_provider: string | null;
      meta_json: string | null;
    }>;

    return rows.map((row) => buildConversationMetaFromIndexRow(row));
  } catch (error) {
    console.error(`[cache] queryConversationIndex error:`, error);
    return [];
  }
}

function pruneCacheStorage(database: BetterSqlite3.Database): void {
  const now = Date.now();
  if (now - lastPruneAt < CACHE_PRUNE_INTERVAL_MS) {
    return;
  }
  lastPruneAt = now;

  database.prepare("DELETE FROM meta_cache WHERE updated_at < ?").run(now - META_CACHE_MAX_AGE_MS);
  database.prepare("DELETE FROM list_cache WHERE updated_at < ?").run(now - LIST_CACHE_MAX_AGE_MS);
  database.prepare("DELETE FROM indexed_list_cache WHERE updated_at < ?").run(now - LIST_CACHE_MAX_AGE_MS);
  database.prepare("DELETE FROM codex_message_identity WHERE updated_at < ?").run(now - MESSAGE_IDENTITY_CACHE_MAX_AGE_MS);
  database.prepare(
    `DELETE FROM meta_cache
     WHERE file_path IN (
       SELECT file_path FROM meta_cache
       ORDER BY updated_at DESC
       LIMIT -1 OFFSET ?
     )`
  ).run(KEEP_META_ROWS);
  database.prepare(
    `DELETE FROM conversation_index
     WHERE cache_key NOT IN (
       SELECT cache_key FROM indexed_list_cache
     )`
  ).run();
  database.prepare(
    `DELETE FROM conversation_search_chunk
     WHERE cache_key NOT IN (
       SELECT cache_key FROM indexed_list_cache
     )`
  ).run();

  if (now - lastVacuumAt >= VACUUM_INTERVAL_MS) {
    lastVacuumAt = now;
    try {
      database.pragma("wal_checkpoint(PASSIVE)");
      database.exec("VACUUM");
    } catch {
      // 忽略压缩失败
    }
  }
}

export function invalidateCache(filePath: string): void {
  memoryCache.delete(filePath);

  try {
    getDb().prepare("DELETE FROM meta_cache WHERE file_path = ?").run(filePath);
  } catch {
    // 忽略持久化层失败
  }
}

export function invalidateListCache(cacheKey: string): void {
  memoryListCache.delete(cacheKey);
  memoryIndexedListCache.delete(cacheKey);

  try {
    const database = getDb();
    database.prepare("DELETE FROM list_cache WHERE cache_key = ?").run(cacheKey);
    database.prepare("DELETE FROM indexed_list_cache WHERE cache_key = ?").run(cacheKey);
    database.prepare("DELETE FROM conversation_index WHERE cache_key = ?").run(cacheKey);
    database.prepare("DELETE FROM conversation_search_chunk WHERE cache_key = ?").run(cacheKey);
  } catch {
    // 忽略持久化层失败
  }
}

// 压缩缓存 DB：回收 FTS5 删除墓碑 + VACUUM。
// FTS5 的 DELETE trigger 只写 tombstone，长期积累会让 *_fts_data 表膨胀到
// 远大于实际内容体积。启动时执行一次 optimize + VACUUM 可以把空间回收到合理水位。
export function compactCacheDb(): { before: number; after: number } | null {
  try {
    const path = getDbPath();
    const statBefore = statSync(path);
    const database = getDb();

    // FTS5 optimize 需要在非事务上下文里执行
    try {
      database.exec("INSERT INTO conversation_index_fts(conversation_index_fts) VALUES('optimize')");
    } catch {
      // FTS 表可能尚未创建（测试 / 首次启动）
    }
    try {
      database.exec("INSERT INTO conversation_search_chunk_fts(conversation_search_chunk_fts) VALUES('optimize')");
    } catch {
      // 同上
    }

    database.exec("VACUUM");

    const statAfter = statSync(path);
    return { before: statBefore.size, after: statAfter.size };
  } catch {
    return null;
  }
}
