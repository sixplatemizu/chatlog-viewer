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
import { getCached, getIndexedCacheSnapshot, getIndexedListCache, hasIndexedSearchData, setCache, setIndexedListCache, invalidateCache, invalidateListCache, type IndexedCacheItem } from "../utils/cache.js";
import { logProviderError } from "../utils/logger.js";
import { getProviderPaths } from "../utils/provider-paths.js";
import { collectIndexedCacheItemsInBatches } from "../utils/provider-indexing.js";
import {
  createConversationSearchIndexBuilder,
  type ConversationSearchIndex,
  type ConversationSearchIndexBuilder,
} from "../utils/search-index.js";
import {
  assignStableMessageIds,
  createMessageSourceKey,
  normalizeUpdatedMessageContent,
  rewriteJsonlLine,
  rewriteJsonlLines,
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

function buildMessageRecords(entries: JsonlLine<CodexEntry>[]): MessageRecord<CodexEntry>[] {
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
      sourceKey: createMessageSourceKey(entry.rawLine, "response_item"),
      lineIndex: entry.lineNumber,
      message: {
        role,
        content,
        timestamp: new Date(value.timestamp).getTime(),
      },
    });
  }

  return assignStableMessageIds(records);
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

    const results: IndexedCacheItem[] = [];
    const filesToRefresh: string[] = [];

    for (const filePath of files) {
      const previousMeta = previousByFilePath.get(filePath);
      if (!previousMeta) {
        filesToRefresh.push(filePath);
        continue;
      }

      try {
        const fileStat = await stat(filePath);
        if (
          fileStat.mtimeMs === previousMeta.meta.updatedAt
          && (!options.eagerSearchIndex || hasIndexedSearchData(previousMeta))
        ) {
          setCache(filePath, fileStat.mtimeMs, previousMeta.meta);
          results.push(previousMeta);
        } else {
          filesToRefresh.push(filePath);
        }
      } catch {
        filesToRefresh.push(filePath);
      }
    }

    results.push(...await collectIndexedCacheItemsInBatches(filesToRefresh, 20, async (filePath) => {
      const meta = await this.extractMeta(filePath);
      if (!meta) return null;
      if (!options.eagerSearchIndex) {
        return { meta };
      }
      return {
        meta,
        ...(await this.extractSearchIndex(filePath)),
      };
    }));

    const searchReady = options.eagerSearchIndex || filesToRefresh.length === 0;
    setIndexedListCache(cacheKey, results, { searchReady });

    if (!searchReady && options.allowBackground) {
      this.scheduleBackgroundIndexRefresh();
    }

    return results.map((item) => item.meta).sort((a, b) => b.updatedAt - a.updatedAt);
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

    const title = userMessages[0]?.payload?.message?.slice(0, 100) || "未知对话";

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
    invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
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
    const messages = buildMessageRecords(entries).map((record) => record.message);

    const meta = await this.extractMeta(filePath);
    if (!meta) throw new Error(`无法解析对话元数据: ${id}`);

    const { items: windowedMessages, hasMore } = sliceWindow(messages, options);

    return { ...meta, messages: windowedMessages, hasMore };
  }

  async delete(id: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    await unlink(filePath);
    this.invalidateConversationCaches(filePath);
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const filePath = await this.findConversationFilePath(sessionId);
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
    this.invalidateConversationCaches(filePath);
  }

  async updateMessage(id: string, messageId: string, content: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const entries = await parseJsonlWithMeta<CodexEntry>(filePath);
    const records = buildMessageRecords(entries);
    const record = records.find((item) => item.message.messageId === messageId);

    if (!record || !record.lineIndex) {
      throw new Error(`消息不存在: ${messageId}`);
    }

    const normalizedContent = normalizeUpdatedMessageContent(content);
    const nextEntry: CodexEntry = {
      ...record.entry,
      payload: {
        ...record.entry.payload,
        content: [{
          type: record.message.role === "user" ? "input_text" : "output_text",
          text: normalizedContent,
        }],
      },
    };

    const originalContent = await readFile(filePath, "utf-8");
    const rewritten = rewriteJsonlLine(
      originalContent,
      record.lineIndex,
      JSON.stringify(nextEntry)
    );
    await writeFile(filePath, rewritten, "utf-8");
    this.invalidateConversationCaches(filePath);
  }

  async deleteMessage(id: string, messageId: string): Promise<void> {
    await this.deleteMessages(id, [messageId]);
  }

  async deleteMessages(id: string, messageIds: string[]): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const uniqueMessageIds = [...new Set(messageIds.map((item) => item.trim()).filter(Boolean))];
    if (uniqueMessageIds.length === 0) {
      throw new Error("待删除消息不能为空");
    }

    const entries = await parseJsonlWithMeta<CodexEntry>(filePath);
    const records = buildMessageRecords(entries);
    const lineNumbers: number[] = [];

    for (const messageId of uniqueMessageIds) {
      const record = records.find((item) => item.message.messageId === messageId);
      if (!record?.lineIndex) {
        throw new Error(`消息不存在: ${messageId}`);
      }
      lineNumbers.push(record.lineIndex);
    }

    const originalContent = await readFile(filePath, "utf-8");
    const rewritten = rewriteJsonlLines(originalContent, lineNumbers);
    await writeFile(filePath, rewritten, "utf-8");
    this.invalidateConversationCaches(filePath);
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
    if (this.db) {
      this.db.close();
      this.db = null;
      this.dbPath = null;
    }

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
