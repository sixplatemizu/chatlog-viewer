import type { ConversationMeta } from "../../providers/types.js";
import { SEARCH_INDEX_VERSION } from "../search-index.js";
import {
  getDb,
  pruneCacheStorage,
  resetDbState,
  setCacheMemoryResetHook,
  setStoreDirOverride,
} from "./cache-db.js";
import { buildConversationMetaFromIndexRow } from "./cache-query.js";

const INDEX_TTL_MS = 30_000;
const SIGNATURE_CACHE_MAX_AGE_MS = 5 * 60_000;

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

function clearMemoryCaches(): void {
  memoryCache.clear();
  memoryListCache.clear();
  memoryIndexedListCache.clear();
}

function resetCacheState(): void {
  clearMemoryCaches();
  resetDbState();
}

// cache-db 的 getDb 检测到存储路径切换时，同步清理内存缓存
setCacheMemoryResetHook(clearMemoryCaches);

export function setCacheStoreDirForTests(storeDir?: string): void {
  setStoreDirOverride(storeDir?.trim() || null);
  resetCacheState();
}

export function getIndexedListCacheKey(providerName: string, storagePath: string): string {
  return `${providerName}::${storagePath}::indexed`;
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

