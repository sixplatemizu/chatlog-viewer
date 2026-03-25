import { join } from "path";
import { stat, unlink, rename, mkdir, readdir, readFile, writeFile } from "fs/promises";
import { glob } from "glob";
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

interface IFlowEntry {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  type: "user" | "assistant" | "system";
  isSidechain: boolean;
  userType?: string;
  message: {
    role: string;
    content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    id?: string;
    model?: string;
  };
  cwd?: string;
  version?: string;
}

type IFlowContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
};

function extractTextContent(
  content: string | IFlowContentBlock[]
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isWindowsHomePath(path: string): boolean {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts.length === 3 && /^[A-Za-z]:$/.test(parts[0]) && parts[1] === "Users";
}

function getProjectSpecificity(project: string, projectKey: string): number {
  const normalized = normalizePath(project);
  if (!normalized || normalized === projectKey) return 0;

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return 0;
  if (isWindowsHomePath(normalized)) return 1;
  return parts.length + 10;
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

function isPureTextContent(content: string | IFlowContentBlock[]): boolean {
  return typeof content === "string"
    || (Array.isArray(content) && content.every((block) => block.type === "text"));
}

function buildMessageRecords(entries: JsonlLine<IFlowEntry>[]): MessageRecord<IFlowEntry>[] {
  const records: MessageRecord<IFlowEntry>[] = [];
  for (const entry of entries) {
    const value = entry.value;
    if (value.isSidechain || !value.message) continue;

    if (value.type === "user") {
      const text = extractTextContent(value.message.content);
      if (!text.trim()) continue;
      records.push({
        entry: value,
        sourceKey: isPureTextContent(value.message.content)
          ? createMessageSourceKey(entry.rawLine, "user")
          : undefined,
        lineIndex: entry.lineNumber,
        message: {
          role: "user",
          content: text,
          timestamp: new Date(value.timestamp).getTime(),
        },
      });
    } else if (value.type === "assistant") {
      const text = extractTextContent(value.message.content);
      if (text.trim()) {
        records.push({
          entry: value,
          sourceKey: isPureTextContent(value.message.content)
            ? createMessageSourceKey(entry.rawLine, "assistant")
            : undefined,
          lineIndex: entry.lineNumber,
          message: {
            role: "assistant",
            content: text,
            timestamp: new Date(value.timestamp).getTime(),
          },
        });
      }
      if (Array.isArray(value.message.content)) {
        for (const block of value.message.content) {
          if (block.type === "tool_use") {
            records.push({
              entry: value,
              message: {
                role: "tool",
                content: "",
                toolName: (block as { name?: string }).name || "unknown",
                toolInput: JSON.stringify((block as { input?: unknown }).input, null, 2),
              },
            });
          }
        }
      }
    }
  }

  return assignStableMessageIds(records);
}

function appendSearchIndexEntry(
  builder: ConversationSearchIndexBuilder,
  entry: IFlowEntry
): void {
  if (entry.isSidechain || !entry.message) return;

  if (entry.type === "user") {
    const text = extractTextContent(entry.message.content);
    if (!text.trim()) return;

    builder.addMessage({
      role: "user",
      content: text,
      timestamp: new Date(entry.timestamp).getTime(),
    });
    return;
  }

  if (entry.type === "assistant") {
    const text = extractTextContent(entry.message.content);
    if (!text.trim()) return;

    builder.addMessage({
      role: "assistant",
      content: text,
      timestamp: new Date(entry.timestamp).getTime(),
    });
  }
}

export class IFlowProvider implements ConversationProvider {
  name = "iflow";
  displayName = "iFlow CLI";
  private backgroundRefreshes = new Map<string, Promise<void>>();

  getStoragePath(): string {
    return getProviderPaths("iflow").storagePath;
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
    const pattern = join(basePath, "*", "session-*.jsonl").replace(/\\/g, "/");
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

    const normalizedResults = this.applyProjectDisplayPathHints(results);

    const searchReady = options.eagerSearchIndex || filesToRefresh.length === 0;
    setIndexedListCache(cacheKey, normalizedResults, { searchReady });

    if (!searchReady && options.allowBackground) {
      this.scheduleBackgroundIndexRefresh();
    }

    return normalizedResults.map((item) => item.meta).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private applyProjectDisplayPathHints(
    items: Array<{ meta: ConversationMeta; searchText?: string; searchChunks?: string[] }>
  ): Array<{ meta: ConversationMeta; searchText?: string; searchChunks?: string[] }> {
    const bestProjectByKey = new Map<string, string>();

    for (const item of items) {
      const projectKey = item.meta.projectKey || item.meta.project || "";
      const candidate = item.meta.project || projectKey;
      const current = bestProjectByKey.get(projectKey);
      const candidateScore = getProjectSpecificity(candidate, projectKey);
      const currentScore = current ? getProjectSpecificity(current, projectKey) : -1;

      if (
        !current ||
        candidateScore > currentScore ||
        (candidateScore === currentScore && candidate.length > current.length)
      ) {
        bestProjectByKey.set(projectKey, candidate);
      }
    }

    return items.map((item) => {
      const projectKey = item.meta.projectKey || item.meta.project || "";
      const preferredProject = bestProjectByKey.get(projectKey);
      if (!preferredProject) return item;

      const currentScore = getProjectSpecificity(item.meta.project, projectKey);
      const preferredScore = getProjectSpecificity(preferredProject, projectKey);
      if (preferredScore <= currentScore) return item;

      const updatedMeta = {
        ...item.meta,
        project: preferredProject,
      };
      setCache(item.meta.filePath, item.meta.updatedAt, updatedMeta);
      return {
        ...item,
        meta: updatedMeta,
      };
    });
  }

  private async extractSearchIndex(filePath: string): Promise<ConversationSearchIndex> {
    const builder = createConversationSearchIndexBuilder();
    await visitJsonl<IFlowEntry>(filePath, (entry) => {
      appendSearchIndexEntry(builder, entry);
    });
    return builder.build();
  }

  private async extractMeta(filePath: string): Promise<ConversationMeta | null> {
    const fileStat = await stat(filePath);
    const pathParts = filePath.replace(/\\/g, "/").split("/");
    const projectFolder = pathParts[pathParts.length - 2] || "";
    const cached = getCached(filePath, fileStat.mtimeMs);
    if (cached && cached.projectKey === projectFolder) return cached;

    const headEntries = await parseJsonlHead<IFlowEntry>(filePath, 30);
    const headMessages = headEntries.filter(
      (e) => (e.type === "user" || e.type === "assistant") && e.message && !e.isSidechain
    );

    if (headMessages.length === 0) {
      const msgCount = await countLines(
        filePath,
        (value) => {
          if (!value || typeof value !== "object") return false;
          const entry = value as IFlowEntry;
          return !entry.isSidechain
            && !!entry.message
            && (entry.type === "user" || entry.type === "assistant");
        },
        {
          fastIncludes: ['"type":"user"', '"type":"assistant"'],
        }
      );
      if (msgCount === 0) return null;
    }

    const fileName = filePath.split(/[/\\]/).pop()!;
    const sessionId = fileName.replace(".jsonl", "");

    const firstUserEntry = headEntries.find((e) => e.type === "user" && e.cwd);
    const project = firstUserEntry?.cwd
      ? normalizePath(firstUserEntry.cwd)
      : projectFolder;
    const projectKey = projectFolder;

    const firstUserMsg = headMessages.find((e) => {
      if (e.type !== "user" || !e.message) return false;
      const text = extractTextContent(e.message.content);
      if (!text.trim() || text.startsWith("/")) return false;
      return true;
    });
    const title = firstUserMsg
      ? extractTextContent(firstUserMsg.message.content).slice(0, 100)
      : "未知对话";

    const firstTs = headMessages[0]?.timestamp
      ? new Date(headMessages[0].timestamp).getTime()
      : fileStat.birthtimeMs;

    const messageCount = await countLines(
      filePath,
      (value) => {
        if (!value || typeof value !== "object") return false;
        const entry = value as IFlowEntry;
        return !entry.isSidechain
          && !!entry.message
          && (entry.type === "user" || entry.type === "assistant");
      },
      {
        fastIncludes: ['"type":"user"', '"type":"assistant"'],
      }
    );

    const meta: ConversationMeta = {
      id: `iflow:${sessionId}`,
      provider: this.name,
      title: title.replace(/<[^>]+>/g, "").trim() || "未知对话",
      project,
      projectKey,
      createdAt: firstTs,
      updatedAt: fileStat.mtimeMs,
      messageCount,
      fileSize: fileStat.size,
      filePath,
    };

    setCache(filePath, fileStat.mtimeMs, meta);
    return meta;
  }

  private async findConversationFilePath(sessionId: string): Promise<string> {
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "*", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    if (files.length === 0) {
      throw new Error(`对话不存在: iflow:${sessionId}`);
    }
    return files[0];
  }

  private invalidateConversationCaches(filePath: string): void {
    invalidateCache(filePath);
    invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
  }

  async read(id: string, options?: ConversationReadOptions): Promise<Conversation> {
    const sessionId = id.replace("iflow:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const fileStat = await stat(filePath);

    const limit = options?.limit;
    const before = options?.before ?? 0;
    const shouldWindowRead = !!limit && limit > 0;
    const requiredMessages = shouldWindowRead ? before + limit + 1 : 0;

    const entries = shouldWindowRead
      ? await parseJsonlTailWithMeta<IFlowEntry>(filePath, {
          bytesHint: Math.max(256 * 1024, fileStat.size > 0 ? Math.min(fileStat.size, (before + limit) * 4096) : 256 * 1024),
          maxBytes: fileStat.size,
          isEnough: (tailEntries) => buildMessageRecords(tailEntries).length >= requiredMessages,
        })
      : await parseJsonlWithMeta<IFlowEntry>(filePath);
    const messages = buildMessageRecords(entries).map((record) => record.message);

    const meta = await this.extractMeta(filePath);
    if (!meta) throw new Error(`无法解析对话元数据: ${id}`);

    const finalMeta = getProjectSpecificity(meta.project, meta.projectKey) > 1
      ? meta
      : (await this.list()).find((item) => item.id === meta.id) ?? meta;

    const { items: windowedMessages, hasMore } = sliceWindow(messages, options);

    return { ...finalMeta, messages: windowedMessages, hasMore };
  }

  async delete(id: string): Promise<void> {
    const sessionId = id.replace("iflow:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    await unlink(filePath);
    this.invalidateConversationCaches(filePath);
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("iflow:", "");
    const basePath = this.getStoragePath();
    const srcFile = await this.findConversationFilePath(sessionId);
    const fileName = srcFile.split(/[/\\]/).pop()!;
    const targetDir = join(basePath, targetProjectKey);
    await mkdir(targetDir, { recursive: true });
    const destFile = join(targetDir, fileName);

    if (srcFile.replace(/\\/g, "/") === destFile.replace(/\\/g, "/")) return;
    await rename(srcFile, destFile);
    this.invalidateConversationCaches(srcFile);
  }

  async updateMessage(id: string, messageId: string, content: string): Promise<void> {
    const sessionId = id.replace("iflow:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const entries = await parseJsonlWithMeta<IFlowEntry>(filePath);
    const records = buildMessageRecords(entries);
    const record = records.find((item) => item.message.messageId === messageId);

    if (!record?.lineIndex || !record.entry.message) {
      throw new Error(`消息不存在: ${messageId}`);
    }

    const normalizedContent = normalizeUpdatedMessageContent(content);
    const nextEntry: IFlowEntry = {
      ...record.entry,
      message: {
        ...record.entry.message,
        content: typeof record.entry.message.content === "string"
          ? normalizedContent
          : [{ type: "text", text: normalizedContent }],
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
    const sessionId = id.replace("iflow:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const uniqueMessageIds = [...new Set(messageIds.map((item) => item.trim()).filter(Boolean))];
    if (uniqueMessageIds.length === 0) {
      throw new Error("待删除消息不能为空");
    }

    const entries = await parseJsonlWithMeta<IFlowEntry>(filePath);
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
    try {
      const entries = await readdir(basePath, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}
