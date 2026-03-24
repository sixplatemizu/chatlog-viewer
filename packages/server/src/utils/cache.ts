import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import type { ConversationMeta } from "../providers/types.js";
import { SEARCH_INDEX_VERSION } from "./search-index.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;

const STORE_DIR = join(homedir(), ".chatlog-viewer");
const DB_PATH = join(STORE_DIR, "meta-cache.sqlite");
const INDEX_TTL_MS = 30_000;
const CACHE_PRUNE_INTERVAL_MS = 5 * 60_000;
const VACUUM_INTERVAL_MS = 24 * 60 * 60_000;
const META_CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60_000;
const LIST_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const KEEP_META_ROWS = 50_000;

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
  detailedItems?: IndexedCacheItem[];
}

export interface IndexedCacheItem {
  meta: ConversationMeta;
  searchText?: string;
  searchChunks?: string[];
}

interface IndexedListCacheReadOptions {
  requireSearchReady?: boolean;
}

interface IndexedListCacheWriteOptions {
  searchReady?: boolean;
  searchVersion?: number;
}

// 基于文件 mtime 的元数据缓存
const memoryCache = new Map<string, CacheEntry>();
const memoryListCache = new Map<string, ListCacheEntry>();
const memoryIndexedListCache = new Map<string, IndexedListCacheEntry>();
let db: BetterSqlite3.Database | null = null;
let lastPruneAt = 0;
let lastVacuumAt = 0;
let supportsConversationFtsSearch = false;
let supportsChunkFtsSearch = false;

export function getIndexedListCacheKey(providerName: string, storagePath: string): string {
  return `${providerName}::${storagePath}::indexed`;
}

function getDb(): BetterSqlite3.Database {
  if (db) return db;

  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
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
      search_version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS conversation_index (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      title TEXT NOT NULL,
      search_text TEXT,
      project TEXT NOT NULL,
      project_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      file_size INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      model_provider TEXT,
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

  return db;
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
}

function ensureConversationIndexSchema(database: BetterSqlite3.Database): void {
  const columns = database
    .prepare("PRAGMA table_info(conversation_index)")
    .all() as Array<{ name: string }>;

  if (!columns.some((column) => column.name === "search_text")) {
    database.exec("ALTER TABLE conversation_index ADD COLUMN search_text TEXT");
  }

  if (!columns.some((column) => column.name === "search_version")) {
    database.exec("ALTER TABLE conversation_index ADD COLUMN search_version INTEGER NOT NULL DEFAULT 1");
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

function createIndexedItemSignature(item: {
  meta: ConversationMeta;
  searchText?: string;
  searchChunks?: string[];
  searchVersion: number;
}): string {
  return JSON.stringify([
    item.searchVersion,
    item.meta.provider,
    item.meta.title,
    item.searchText ?? null,
    item.searchChunks ?? [],
    item.meta.project,
    item.meta.projectKey,
    item.meta.createdAt,
    item.meta.updatedAt,
    item.meta.messageCount,
    item.meta.fileSize,
    item.meta.filePath,
    item.meta.modelProvider ?? null,
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
  options?: IndexedListCacheReadOptions
): boolean {
  if (now - updatedAt > ttlMs) {
    return false;
  }

  if (options?.requireSearchReady && !searchReady) {
    return false;
  }

  if (options?.requireSearchReady && searchVersion !== SEARCH_INDEX_VERSION) {
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
      options
    )
  ) {
    return memoryEntry.items;
  }

  try {
    const row = getDb()
      .prepare("SELECT list_json, updated_at, search_ready, search_version FROM indexed_list_cache WHERE cache_key = ?")
      .get(cacheKey) as
      | { list_json: string; updated_at: number; search_ready: number; search_version: number }
      | undefined;

    if (
      !row ||
      !isUsableIndexedListCache(
        now,
        row.updated_at,
        ttlMs,
        !!row.search_ready,
        row.search_version,
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
      .prepare("SELECT list_json, updated_at, search_ready, search_version FROM indexed_list_cache WHERE cache_key = ?")
      .get(cacheKey) as
      | { list_json: string; updated_at: number; search_ready: number; search_version: number }
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
    });
    return items;
  } catch {
    return null;
  }
}

export function getIndexedCacheSnapshot(cacheKey: string): IndexedCacheItem[] | null {
  const memoryEntry = memoryIndexedListCache.get(cacheKey);
  if (memoryEntry?.detailedItems && memoryEntry.searchVersion === SEARCH_INDEX_VERSION) {
    return memoryEntry.detailedItems;
  }

  const baseItems = getIndexedListSnapshot(cacheKey);

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
          created_at,
          updated_at,
          message_count,
          file_size,
          file_path,
          model_provider,
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
      created_at: number;
      updated_at: number;
      message_count: number;
      file_size: number;
      file_path: string;
      model_provider: string | null;
      search_version: number;
    }>;
    const chunkRows = database
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
    }>;

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
      meta: {
        id: row.id,
        provider: row.provider,
        title: row.title,
        project: row.project,
        projectKey: row.project_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
        fileSize: row.file_size,
        filePath: row.file_path,
        modelProvider: row.model_provider ?? undefined,
      },
      searchText: row.search_text ?? undefined,
      searchChunks: chunksByConversationId.get(row.id),
    }));

    const refreshedEntry = memoryIndexedListCache.get(cacheKey);
    if (refreshedEntry) {
      memoryIndexedListCache.set(cacheKey, {
        ...refreshedEntry,
        detailedItems,
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
      options
    )
  ) {
    return true;
  }

  try {
    const row = getDb()
      .prepare("SELECT updated_at, search_ready, search_version FROM indexed_list_cache WHERE cache_key = ?")
      .get(cacheKey) as { updated_at: number; search_ready: number; search_version: number } | undefined;

    return !!row && isUsableIndexedListCache(
      now,
      row.updated_at,
      ttlMs,
      !!row.search_ready,
      row.search_version,
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
  const normalizedDetailedItems = items.map((item) => ("meta" in item ? item : { meta: item }));
  const normalizedItems = normalizedDetailedItems.map((item) => item.meta);
  memoryIndexedListCache.set(cacheKey, {
    items: normalizedItems,
    updatedAt,
    searchReady,
    searchVersion,
    detailedItems: normalizedDetailedItems,
  });

  try {
    const database = getDb();
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO indexed_list_cache (cache_key, list_json, updated_at, search_ready, search_version)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET
             list_json = excluded.list_json,
             updated_at = excluded.updated_at,
             search_ready = excluded.search_ready,
             search_version = excluded.search_version`
        )
        .run(cacheKey, JSON.stringify(normalizedItems), updatedAt, searchReady ? 1 : 0, searchVersion);

      const upsertConversation = database.prepare(
        `INSERT INTO conversation_index (
           id,
           provider,
           title,
           search_text,
           project,
           project_key,
           created_at,
           updated_at,
           message_count,
           file_size,
           file_path,
           model_provider,
           cache_key,
           indexed_at,
           search_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           title = excluded.title,
           search_text = excluded.search_text,
           project = excluded.project,
           project_key = excluded.project_key,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           message_count = excluded.message_count,
           file_size = excluded.file_size,
           file_path = excluded.file_path,
           model_provider = excluded.model_provider,
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
           created_at,
           updated_at,
           message_count,
           file_size,
           file_path,
           model_provider,
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
        created_at: number;
        updated_at: number;
        message_count: number;
        file_size: number;
        file_path: string;
        model_provider: string | null;
        search_version: number;
      }>;
      const existingChunkRows = database.prepare(
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
      }>;

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
            meta: {
              id: row.id,
              provider: row.provider,
              title: row.title,
              project: row.project,
              projectKey: row.project_key,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
              messageCount: row.message_count,
              fileSize: row.file_size,
              filePath: row.file_path,
              modelProvider: row.model_provider ?? undefined,
            },
            searchText: row.search_text ?? undefined,
            searchChunks: existingChunksById.get(row.id),
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
          ...item,
          searchVersion,
        });

        if (existingSignatureById.get(meta.id) === nextSignature) {
          continue;
        }

        upsertConversation.run(
          meta.id,
          meta.provider,
          meta.title,
          item.searchText ?? null,
          meta.project,
          meta.projectKey,
          meta.createdAt,
          meta.updatedAt,
          meta.messageCount,
          meta.fileSize,
          meta.filePath,
          meta.modelProvider ?? null,
          cacheKey,
          updatedAt,
          searchVersion
        );

        deleteConversationChunks.run(meta.id);
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
    })();
    pruneCacheStorage(database);
  } catch {
    // 持久化失败时退回内存缓存
  }
}

export function queryConversationIndex(options: {
  cacheKeys: string[];
  search?: string;
  sort?: "updatedAt" | "createdAt" | "provider";
  modelProviders?: string[];
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

    if (options.modelProviders) {
      if (options.modelProviders.length === 0) {
        whereClauses.push("(conversation_index.provider != 'codex' OR conversation_index.model_provider IS NULL OR conversation_index.model_provider = '')");
      } else {
        const mpPlaceholders = options.modelProviders.map(() => "?").join(", ");
        whereClauses.push(`(conversation_index.provider != 'codex' OR conversation_index.model_provider IS NULL OR conversation_index.model_provider = '' OR conversation_index.model_provider IN (${mpPlaceholders}))`);
        params.push(...options.modelProviders);
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
        conversation_index.created_at,
        conversation_index.updated_at,
        conversation_index.message_count,
        conversation_index.file_size,
        conversation_index.file_path,
        conversation_index.model_provider
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
      created_at: number;
      updated_at: number;
      message_count: number;
      file_size: number;
      file_path: string;
      model_provider: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      title: row.title,
      project: row.project,
      projectKey: row.project_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
      fileSize: row.file_size,
      filePath: row.file_path,
      modelProvider: row.model_provider ?? undefined,
    }));
  } catch {
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
