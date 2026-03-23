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

interface CacheEntry {
  mtimeMs: number;
  meta: ConversationMeta;
}

interface ListCacheEntry {
  signature: string;
  items: ConversationMeta[];
}

// 基于文件 mtime 的元数据缓存
const memoryCache = new Map<string, CacheEntry>();
const memoryListCache = new Map<string, ListCacheEntry>();
let db: BetterSqlite3.Database | null = null;

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
    )
  `);

  return db;
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

  try {
    getDb().prepare("DELETE FROM list_cache WHERE cache_key = ?").run(cacheKey);
  } catch {
    // 忽略持久化层失败
  }
}
