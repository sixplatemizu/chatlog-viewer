import type { ConversationMeta } from "../providers/types.js";

// 基于文件 mtime 的元数据缓存
const cache = new Map<string, { mtimeMs: number; meta: ConversationMeta }>();

export function getCached(filePath: string, mtimeMs: number): ConversationMeta | null {
  const entry = cache.get(filePath);
  if (entry && entry.mtimeMs === mtimeMs) return entry.meta;
  return null;
}

export function setCache(filePath: string, mtimeMs: number, meta: ConversationMeta): void {
  cache.set(filePath, { mtimeMs, meta });
}

export function invalidateCache(filePath: string): void {
  cache.delete(filePath);
}
