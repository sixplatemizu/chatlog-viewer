import { join } from "path";
import { stat, unlink, readFile, writeFile } from "fs/promises";
import { createRequire } from "module";
import { glob } from "glob";
import type BetterSqlite3 from "better-sqlite3";
import {
  parseJsonl,
  parseJsonlHead,
  parseJsonlTail,
  parseJsonlWindow,
  countLines,
  getAdaptiveSearchWindowOptions,
} from "../utils/jsonl.js";
import { getCached, getIndexedCacheSnapshot, getIndexedListCache, setCache, setIndexedListCache, invalidateCache, invalidateListCache } from "../utils/cache.js";
import { logProviderError } from "../utils/logger.js";
import { getProviderPaths } from "../utils/provider-paths.js";
import { buildConversationSearchText } from "../utils/search-index.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
  Message,
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

function buildMessages(entries: CodexEntry[]): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    if (entry.type !== "response_item" || !entry.payload?.role) continue;

    const role = entry.payload.role as "user" | "assistant";
    if (role !== "user" && role !== "assistant") continue;

    const content = entry.payload.content
      ? extractContent(entry.payload.content)
      : "";
    if (content.includes("<environment_context>")) continue;
    if (!content.trim()) continue;

    messages.push({
      role,
      content,
      timestamp: new Date(entry.timestamp).getTime(),
    });
  }

  return messages;
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

  private db: BetterSqlite3.Database | null = null;
  private dbPath: string | null = null;
  private backgroundRefreshes = new Map<string, Promise<void>>();

  private getStateDbPath(): string {
    return getProviderPaths("codex").stateDbPath || join(this.getStoragePath(), "..", "state_5.sqlite");
  }

  private getDb(): BetterSqlite3.Database | null {
    const dbPath = this.getStateDbPath();
    if (this.db && this.dbPath === dbPath) return this.db;

    if (this.db) {
      this.db.close();
      this.db = null;
    }

    try {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.dbPath = dbPath;
      return this.db;
    } catch {
      this.dbPath = null;
      return null;
    }
  }

  // 从 SQLite 查询 model_provider
  private getModelProvider(sessionId: string): string | undefined {
    const db = this.getDb();
    if (!db) return undefined;
    try {
      const row = db.prepare("SELECT model_provider FROM threads WHERE id = ?").get(sessionId) as { model_provider: string } | undefined;
      return row?.model_provider;
    } catch {
      return undefined;
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
    const cachedList = getIndexedListCache(cacheKey, undefined, {
      requireSearchReady: options.eagerSearchIndex,
    });
    if (cachedList) {
      return [...cachedList].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    const previousItems = getIndexedCacheSnapshot(cacheKey) ?? [];
    const previousByFilePath = new Map(previousItems.map((item) => [item.meta.filePath, item]));
    const pattern = join(basePath, "**", "*.jsonl").replace(/\\/g, "/");
    const files = await glob(pattern);

    const results: Array<{ meta: ConversationMeta; searchText?: string }> = [];
    const filesToRefresh: string[] = [];

    for (const filePath of files) {
      const previousMeta = previousByFilePath.get(filePath);
      if (!previousMeta) {
        filesToRefresh.push(filePath);
        continue;
      }

      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs === previousMeta.meta.updatedAt && previousMeta.searchText !== undefined) {
          setCache(filePath, fileStat.mtimeMs, previousMeta.meta);
          results.push(previousMeta);
        } else {
          filesToRefresh.push(filePath);
        }
      } catch {
        filesToRefresh.push(filePath);
      }
    }

    const batchSize = 20;
    for (let i = 0; i < filesToRefresh.length; i += batchSize) {
      const batch = filesToRefresh.slice(i, i + batchSize);
      const metas = await Promise.all(
        batch.map(async (f) => {
          const meta = await this.extractMeta(f);
          if (!meta) return null;
          if (!options.eagerSearchIndex) {
            return { meta };
          }
          const searchText = await this.extractSearchText(f);
          return { meta, searchText };
        })
      );
      for (const m of metas) {
        if (m) results.push(m);
      }
    }

    const searchReady = options.eagerSearchIndex || filesToRefresh.length === 0;
    setIndexedListCache(cacheKey, results, { searchReady });

    if (!searchReady && options.allowBackground) {
      this.scheduleBackgroundIndexRefresh();
    }

    return results.map((item) => item.meta).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async extractSearchText(filePath: string): Promise<string | undefined> {
    const fileStat = await stat(filePath);
    const entries = fileStat.size > 512 * 1024
      ? await parseJsonlWindow<CodexEntry>(filePath, getAdaptiveSearchWindowOptions(fileStat.size))
      : await parseJsonl<CodexEntry>(filePath);
    return buildConversationSearchText(buildMessages(entries));
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

    const title = userMessages[0]?.payload?.message?.slice(0, 100) || "未知对话";

    // 快速行计数
    const messageCount = await countLines(filePath, ['"role":"user"', '"role":"assistant"']);
    if (messageCount === 0 && userMessages.length === 0) return null;

    const firstTs = new Date(headEntries[0].timestamp).getTime();
    const normalizedCwd = canonicalizeProjectPath(cwd);

    // 从 SQLite 查询 model_provider
    const modelProvider = this.getModelProvider(sessionId);

    const meta: ConversationMeta = {
      id: `codex:${sessionId}`,
      provider: this.name,
      title: title.replace(/<[^>]+>/g, "").trim() || "未知对话",
      project: normalizedCwd,
      projectKey: normalizedCwd,
      createdAt: firstTs,
      updatedAt: fileStat.mtimeMs,
      messageCount: Math.max(messageCount, userMessages.length),
      fileSize: fileStat.size,
      filePath,
      modelProvider,
    };

    setCache(filePath, fileStat.mtimeMs, meta);
    return meta;
  }

  async read(id: string, options?: ConversationReadOptions): Promise<Conversation> {
    const sessionId = id.replace("codex:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "**", `*${sessionId}*.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);

    if (files.length === 0) throw new Error(`对话不存在: ${id}`);
    const filePath = files[0];
    const fileStat = await stat(filePath);

    const limit = options?.limit;
    const before = options?.before ?? 0;
    const shouldWindowRead = !!limit && limit > 0;
    const requiredMessages = shouldWindowRead ? before + limit + 1 : 0;

    const entries = shouldWindowRead
      ? await parseJsonlTail<CodexEntry>(filePath, {
          bytesHint: Math.max(256 * 1024, fileStat.size > 0 ? Math.min(fileStat.size, (before + limit) * 4096) : 256 * 1024),
          maxBytes: fileStat.size,
          isEnough: (tailEntries) => buildMessages(tailEntries).length >= requiredMessages,
        })
      : await parseJsonl<CodexEntry>(filePath);
    const messages = buildMessages(entries);

    const meta = await this.extractMeta(filePath);
    if (!meta) throw new Error(`无法解析对话元数据: ${id}`);

    const { items: windowedMessages, hasMore } = sliceWindow(messages, options);

    return { ...meta, messages: windowedMessages, hasMore };
  }

  async delete(id: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "**", `*${sessionId}*.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    if (files.length === 0) throw new Error(`对话不存在: ${id}`);
    invalidateListCache(getListCacheKey(this.name, basePath));
    invalidateCache(files[0]);
    await unlink(files[0]);
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "**", `*${sessionId}*.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    if (files.length === 0) throw new Error(`对话不存在: ${id}`);

    const filePath = files[0];
    invalidateListCache(getListCacheKey(this.name, basePath));
    invalidateCache(filePath);
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
    const sessionId = id.replace("codex:", "");
    const dbPath = this.getStateDbPath();
    if (this.db) {
      this.db.close();
      this.db = null;
      this.dbPath = null;
    }
    // 写操作需要新开一个可写连接
    const db = new Database(dbPath);
    try {
      const result = db.prepare("UPDATE threads SET model_provider = ? WHERE id = ?").run(newProvider, sessionId);
      if (result.changes === 0) throw new Error(`SQLite 中未找到对话: ${sessionId}`);
    } finally {
      db.close();
    }

    // 清除文件缓存（缓存 key 是文件路径，不是对话 ID）
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "**", `*${sessionId}*.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    for (const f of files) invalidateCache(f);
    invalidateListCache(getListCacheKey(this.name, basePath));
  }
}
