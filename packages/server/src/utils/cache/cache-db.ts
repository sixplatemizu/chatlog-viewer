// cache DB 基础设施层：连接、状态、schema、迁移与维护（prune/compact）。
// 内存缓存与读写 API 见 ./impl.ts，conversation_index 查询层见 ./cache-query.ts。
import { existsSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;

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

let db: BetterSqlite3.Database | null = null;
let dbPath: string | null = null;
let lastPruneAt = 0;
let lastVacuumAt = Date.now();
let supportsConversationFtsSearch = false;
let supportsChunkFtsSearch = false;
let storeDirOverride: string | null = null;

// impl 层注册的内存缓存清理钩子：getDb 检测到存储路径切换时同步清内存，
// 保持与拆分前 resetCacheState 一致的行为。
let memoryResetHook: (() => void) | null = null;

export function setCacheMemoryResetHook(hook: (() => void) | null): void {
  memoryResetHook = hook;
}

export function hasConversationFtsSupport(): boolean {
  return supportsConversationFtsSearch;
}

export function hasChunkFtsSupport(): boolean {
  return supportsChunkFtsSearch;
}

export function setStoreDirOverride(storeDir: string | null): void {
  storeDirOverride = storeDir;
}

function getStoreDir(): string {
  const envOverride = process.env.CHATLOG_VIEWER_STORE_DIR?.trim();
  return storeDirOverride || envOverride || join(homedir(), ".chatlog-viewer");
}

function getDbPath(): string {
  return join(getStoreDir(), "meta-cache.sqlite");
}

export function resetDbState(): void {
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

export function getDb(): BetterSqlite3.Database {
  const nextDbPath = getDbPath();
  if (db && dbPath === nextDbPath) return db;
  if (db && dbPath !== nextDbPath) {
    memoryResetHook?.();
    resetDbState();
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

    CREATE INDEX IF NOT EXISTS idx_conversation_index_cache_updated_at
    ON conversation_index (cache_key, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_conversation_index_cache_created_at
    ON conversation_index (cache_key, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_conversation_index_cache_provider_updated_at
    ON conversation_index (cache_key, provider, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_conversation_index_cache_model_provider
    ON conversation_index (cache_key, model_provider);

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

export function pruneCacheStorage(database: BetterSqlite3.Database): void {
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
