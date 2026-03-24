import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import type { ConversationMeta } from "../providers/types.js";

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
const KEEP_INDEX_ROWS = 100_000;

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
  detailedItems?: IndexedCacheItem[];
}

export interface IndexedCacheItem {
  meta: ConversationMeta;
  searchText?: string;
}

interface IndexedListCacheReadOptions {
  requireSearchReady?: boolean;
}

interface IndexedListCacheWriteOptions {
  searchReady?: boolean;
}

// 基于文件 mtime 的元数据缓存
const memoryCache = new Map<string, CacheEntry>();
const memoryListCache = new Map<string, ListCacheEntry>();
const memoryIndexedListCache = new Map<string, IndexedListCacheEntry>();
let db: BetterSqlite3.Database | null = null;
let lastPruneAt = 0;
let lastVacuumAt = 0;
let supportsFtsSearch = false;

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
      search_ready INTEGER NOT NULL DEFAULT 1
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
      indexed_at INTEGER NOT NULL
    )
  `);

  ensureIndexedListCacheSchema(db);
  ensureConversationIndexSchema(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversation_index_provider_updated_at
    ON conversation_index (provider, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_conversation_index_provider_created_at
    ON conversation_index (provider, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_conversation_index_cache_key
    ON conversation_index (cache_key);
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
}

function ensureConversationIndexSchema(database: BetterSqlite3.Database): void {
  const columns = database
    .prepare("PRAGMA table_info(conversation_index)")
    .all() as Array<{ name: string }>;

  if (!columns.some((column) => column.name === "search_text")) {
    database.exec("ALTER TABLE conversation_index ADD COLUMN search_text TEXT");
  }

  supportsFtsSearch = false;

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

    supportsFtsSearch = true;
  } catch {
    supportsFtsSearch = false;
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
  options?: IndexedListCacheReadOptions
): boolean {
  if (now - updatedAt > ttlMs) {
    return false;
  }

  if (options?.requireSearchReady && !searchReady) {
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
    isUsableIndexedListCache(now, memoryEntry.updatedAt, ttlMs, memoryEntry.searchReady, options)
  ) {
    return memoryEntry.items;
  }

  try {
    const row = getDb()
      .prepare("SELECT list_json, updated_at, search_ready FROM indexed_list_cache WHERE cache_key = ?")
      .get(cacheKey) as
      | { list_json: string; updated_at: number; search_ready: number }
      | undefined;

    if (
      !row ||
      !isUsableIndexedListCache(now, row.updated_at, ttlMs, !!row.search_ready, options)
    ) {
      return null;
    }

    const items = JSON.parse(row.list_json) as ConversationMeta[];
    memoryIndexedListCache.set(cacheKey, {
      items,
      updatedAt: row.updated_at,
      searchReady: !!row.search_ready,
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
      .prepare("SELECT list_json, updated_at, search_ready FROM indexed_list_cache WHERE cache_key = ?")
      .get(cacheKey) as
      | { list_json: string; updated_at: number; search_ready: number }
      | undefined;

    if (!row) {
      return null;
    }

    const items = JSON.parse(row.list_json) as ConversationMeta[];
    memoryIndexedListCache.set(cacheKey, {
      items,
      updatedAt: row.updated_at,
      searchReady: !!row.search_ready,
    });
    return items;
  } catch {
    return null;
  }
}

export function getIndexedCacheSnapshot(cacheKey: string): IndexedCacheItem[] | null {
  const memoryEntry = memoryIndexedListCache.get(cacheKey);
  if (memoryEntry?.detailedItems) {
    return memoryEntry.detailedItems;
  }

  const baseItems = getIndexedListSnapshot(cacheKey);

  try {
    const rows = getDb()
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
          model_provider
        FROM conversation_index
        WHERE cache_key = ?
        ORDER BY updated_at DESC
      `)
      .all(cacheKey) as Array<{
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

    if (rows.length === 0) {
      return baseItems?.map((meta) => ({ meta })) ?? null;
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
    isUsableIndexedListCache(now, memoryEntry.updatedAt, ttlMs, memoryEntry.searchReady, options)
  ) {
    return true;
  }

  try {
    const row = getDb()
      .prepare("SELECT updated_at, search_ready FROM indexed_list_cache WHERE cache_key = ?")
      .get(cacheKey) as { updated_at: number; search_ready: number } | undefined;

    return !!row && isUsableIndexedListCache(now, row.updated_at, ttlMs, !!row.search_ready, options);
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
  const normalizedDetailedItems = items.map((item) => ("meta" in item ? item : { meta: item }));
  const normalizedItems = normalizedDetailedItems.map((item) => item.meta);
  memoryIndexedListCache.set(cacheKey, {
    items: normalizedItems,
    updatedAt,
    searchReady,
    detailedItems: normalizedDetailedItems,
  });

  try {
    const database = getDb();
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO indexed_list_cache (cache_key, list_json, updated_at, search_ready)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET
             list_json = excluded.list_json,
             updated_at = excluded.updated_at,
             search_ready = excluded.search_ready`
        )
        .run(cacheKey, JSON.stringify(normalizedItems), updatedAt, searchReady ? 1 : 0);

      const upsert = database.prepare(
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
           indexed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           indexed_at = excluded.indexed_at`
      );
      database.prepare("DELETE FROM conversation_index WHERE cache_key = ?").run(cacheKey);
      for (const item of normalizedDetailedItems) {
        const meta = item.meta;
        const searchText = item.searchText;
        upsert.run(
          meta.id,
          meta.provider,
          meta.title,
          searchText ?? null,
          meta.project,
          meta.projectKey,
          meta.createdAt,
          meta.updatedAt,
          meta.messageCount,
          meta.fileSize,
          meta.filePath,
          meta.modelProvider ?? null,
          cacheKey,
          updatedAt
        );
      }
    })();
    pruneCacheStorage(database);
  } catch {
    // 持久化失败时退回内存缓存
  }
}

export function queryConversationIndex(options: {
  providers: string[];
  search?: string;
  sort?: "updatedAt" | "createdAt" | "provider";
  modelProviders?: string[];
}): ConversationMeta[] {
  if (options.providers.length === 0) return [];

  try {
    const database = getDb();
    const whereClauses: string[] = [];
    const params: Array<string | number> = [];
    let joinClause = "";

    const providerPlaceholders = options.providers.map(() => "?").join(", ");
    whereClauses.push(`conversation_index.provider IN (${providerPlaceholders})`);
    params.push(...options.providers);

    if (options.search) {
      const ftsQuery = supportsFtsSearch ? buildFtsSearchQuery(options.search) : null;
      if (ftsQuery) {
        joinClause = "JOIN conversation_index_fts ON conversation_index_fts.rowid = conversation_index.rowid";
        whereClauses.push("conversation_index_fts MATCH ?");
        params.push(ftsQuery);
      } else {
        whereClauses.push("(LOWER(conversation_index.title) LIKE ? OR LOWER(conversation_index.project) LIKE ? OR LOWER(COALESCE(conversation_index.search_text, '')) LIKE ?)");
        const pattern = buildLikePattern(options.search);
        params.push(pattern, pattern, pattern);
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
      ${joinClause}
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
    `DELETE FROM conversation_index
     WHERE id IN (
       SELECT id FROM conversation_index
       ORDER BY indexed_at DESC, updated_at DESC
       LIMIT -1 OFFSET ?
     )`
  ).run(KEEP_INDEX_ROWS);

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
  } catch {
    // 忽略持久化层失败
  }
}
