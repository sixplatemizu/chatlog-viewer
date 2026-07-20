import { join } from "path";
import { stat, unlink, rename, mkdir, readdir } from "fs/promises";
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
import {
  collectGlobFileStates,
  collectIndexedCacheItemsInBatches,
  createIndexedListSourceSignature,
} from "../utils/provider-indexing.js";
import {
  createConversationSearchIndexBuilder,
  type ConversationSearchIndex,
  type ConversationSearchIndexBuilder,
} from "../utils/search-index.js";
import {
  assignStableMessageIds,
  createMessageSourceKey,
  createStableMessageSourceKey,
  getMessageActionLineNumbers,
  invalidateMessageActionIndex,
  normalizeUpdatedMessageContent,
  primeMessageActionIndex,
  rewriteJsonlFileLine,
  rewriteJsonlFileLines,
  type MessageRecord,
} from "../utils/message-actions.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
  ConversationReadOptions,
  ConversationListOptions,
} from "./types.js";
import {
  normalizePath,
  canonicalizeProjectPath,
  getProjectSpecificity,
  getListCacheKey,
  sliceWindow,
  resolveProjectDirectory,
  applyProjectDisplayPathHints,
} from "./shared/provider-utils.js";

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
          ? createStableMessageSourceKey(
            "iflow",
            [
              value.uuid,
              value.message.id,
              value.sessionId,
              value.timestamp,
              value.type,
              Array.isArray(value.message.content)
                ? value.message.content.map((block) => block.type).join(",")
                : "text",
            ],
            entry.rawLine
          ) ?? createMessageSourceKey(entry.rawLine, "iflow")
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
            ? createStableMessageSourceKey(
              "iflow",
              [
                value.uuid,
                value.message.id,
                value.sessionId,
                value.timestamp,
                value.type,
                Array.isArray(value.message.content)
                  ? value.message.content.map((block) => block.type).join(",")
                  : "text",
              ],
              entry.rawLine
            ) ?? createMessageSourceKey(entry.rawLine, "iflow")
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
  capabilities = {
    titleSyncMode: "overlay",
    canUpdateTitle: false,
    canGenerateTitle: false,
    canEditMessage: true,
    canDeleteMessage: true,
    canMoveConversation: true,
    canDeleteConversation: true,
    supportsMetadataOnly: false,
    updateTitleDisabledReason: "iFlow 当前没有稳定的原生标题字段，已禁用修改标题",
    generateTitleDisabledReason: "iFlow 当前没有稳定的原生标题字段，已禁用修改标题",
  } as const;
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

  async getListSourceSignature(): Promise<string | null> {
    try {
      const pattern = join(this.getStoragePath(), "*", "session-*.jsonl").replace(/\\/g, "/");
      const fileStates = await collectGlobFileStates(pattern);
      return createIndexedListSourceSignature(fileStates);
    } catch {
      return null;
    }
  }

  private scheduleBackgroundIndexRefresh(): void {
    const cacheKey = getListCacheKey(this.name, this.getStoragePath());
    if (this.backgroundRefreshes.has(cacheKey)) {
      return;
    }

    const task = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.listInternal({
          eagerSearchIndex: true,
          allowBackground: false,
        })
          .then(() => undefined)
          .catch((error) => {
            logProviderError("conversations.index.background", this.name, error);
          })
          .finally(() => {
            this.backgroundRefreshes.delete(cacheKey);
            resolve();
          });
      }, 250);
    });

    this.backgroundRefreshes.set(cacheKey, task);
  }

  private async listInternal(options: {
    eagerSearchIndex: boolean;
    allowBackground: boolean;
  }): Promise<ConversationMeta[]> {
    const basePath = this.getStoragePath();
    const cacheKey = getListCacheKey(this.name, basePath);
    const pattern = join(basePath, "*", "session-*.jsonl").replace(/\\/g, "/");
    const fileStates = await collectGlobFileStates(pattern);
    const sourceSignature = createIndexedListSourceSignature(fileStates);
    const cachedList = getIndexedListCache(cacheKey, undefined, {
      requireSearchReady: options.eagerSearchIndex,
      sourceSignature,
    });
    if (cachedList) {
      return [...cachedList].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    const previousItems = getIndexedCacheSnapshot(cacheKey, {
      includeSearchData: options.eagerSearchIndex,
    }) ?? [];
    const previousByFilePath = new Map(previousItems.map((item) => [item.meta.filePath, item]));

    const results: IndexedCacheItem[] = [];
    const filesToRefresh: string[] = [];

    for (const fileState of fileStates) {
      const filePath = fileState.path;
      const previousMeta = previousByFilePath.get(filePath);
      if (!previousMeta) {
        filesToRefresh.push(filePath);
        continue;
      }

      if (
        fileState.mtimeMs === previousMeta.meta.updatedAt
        && fileState.size === previousMeta.meta.fileSize
        && (!options.eagerSearchIndex || hasIndexedSearchData(previousMeta))
      ) {
        setCache(filePath, fileState.mtimeMs, previousMeta.meta);
        results.push(previousMeta);
      } else {
        filesToRefresh.push(filePath);
      }
    }

    results.push(...await collectIndexedCacheItemsInBatches(filesToRefresh, 20, async (filePath) => (
      this.buildIndexedCacheItem(filePath, {
        includeSearchIndex: options.eagerSearchIndex,
        metaHint: previousByFilePath.get(filePath)?.meta,
      })
    )));

    const normalizedResults = applyProjectDisplayPathHints(results);

    const searchReady = options.eagerSearchIndex || filesToRefresh.length === 0;
    setIndexedListCache(cacheKey, normalizedResults, {
      searchReady,
      sourceSignature,
      writeSearchData: options.eagerSearchIndex || searchReady,
    });

    if (!searchReady && options.allowBackground) {
      this.scheduleBackgroundIndexRefresh();
    }

    return normalizedResults.map((item) => item.meta).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async buildIndexedCacheItem(
    filePath: string,
    options: {
      includeSearchIndex: boolean;
      metaHint?: ConversationMeta;
    }
  ): Promise<IndexedCacheItem | null> {
    const fileStat = await stat(filePath);
    const metaHint = options.metaHint;

    if (metaHint && metaHint.updatedAt === fileStat.mtimeMs && metaHint.fileSize === fileStat.size) {
      setCache(filePath, fileStat.mtimeMs, metaHint);
      if (!options.includeSearchIndex) {
        return { meta: metaHint };
      }
      return {
        meta: metaHint,
        ...(await this.extractSearchIndex(filePath)),
      };
    }

    if (!options.includeSearchIndex) {
      const meta = await this.extractMeta(filePath);
      return meta ? { meta } : null;
    }

    return this.scanConversationFile(filePath, fileStat, true);
  }

  private async scanConversationFile(
    filePath: string,
    fileStat: {
      mtimeMs: number;
      size: number;
      birthtimeMs: number;
    },
    includeSearchIndex: boolean
  ): Promise<IndexedCacheItem | null> {
    const pathParts = filePath.replace(/\\/g, "/").split("/");
    const projectFolder = pathParts[pathParts.length - 2] || "";
    const sessionId = filePath.split(/[/\\]/).pop()!.replace(".jsonl", "");
    let project = projectFolder;
    let title = "";
    let firstTimestamp: number | undefined;
    let messageCount = 0;
    const searchBuilder = includeSearchIndex ? createConversationSearchIndexBuilder() : null;

    await visitJsonl<IFlowEntry>(filePath, (entry) => {
      if (
        entry.isSidechain
        || !entry.message
        || (entry.type !== "user" && entry.type !== "assistant")
      ) {
        return;
      }

      messageCount += 1;

      if (firstTimestamp === undefined) {
        const timestamp = Date.parse(entry.timestamp);
        if (Number.isFinite(timestamp)) {
          firstTimestamp = timestamp;
        }
      }

      if (entry.type === "user" && entry.cwd) {
        project = normalizePath(entry.cwd);
      }

      if (!title && entry.type === "user") {
        const text = extractTextContent(entry.message.content);
        if (text.trim() && !text.startsWith("/")) {
          title = text.slice(0, 100);
        }
      }

      if (searchBuilder) {
        appendSearchIndexEntry(searchBuilder, entry);
      }
    });

    if (messageCount === 0) {
      return null;
    }

    const meta: ConversationMeta = {
      id: `iflow:${sessionId}`,
      provider: this.name,
      title: title.replace(/<[^>]+>/g, "").trim() || "未知对话",
      project,
      projectKey: projectFolder,
      projectId: canonicalizeProjectPath(project) || projectFolder,
      createdAt: firstTimestamp ?? fileStat.birthtimeMs,
      updatedAt: fileStat.mtimeMs,
      messageCount,
      fileSize: fileStat.size,
      filePath,
    };

    setCache(filePath, fileStat.mtimeMs, meta);

    if (!searchBuilder) {
      return { meta };
    }

    return {
      meta,
      ...searchBuilder.build(),
    };
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
      projectId: canonicalizeProjectPath(project) || projectKey,
      createdAt: firstTs,
      updatedAt: fileStat.mtimeMs,
      messageCount,
      fileSize: fileStat.size,
      filePath,
      contentStatus: "full",
    };

    setCache(filePath, fileStat.mtimeMs, meta);
    return meta;
  }

  private async findConversationFilePath(sessionId: string): Promise<string> {
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "*", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = [...new Set((await glob(pattern)).map((item) => item.replace(/\\/g, "/")))];
    if (files.length === 0) {
      throw new Error(`对话不存在: iflow:${sessionId}`);
    }
    if (files.length > 1) {
      throw new Error(`定位到多个同名对话文件: iflow:${sessionId}`);
    }
    return files[0]!;
  }

  private invalidateConversationCaches(filePath: string): void {
    invalidateCache(filePath);
    invalidateMessageActionIndex(filePath);
    invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
  }

  private async resolveMessageLineNumbers(
    filePath: string,
    mtimeMs: number,
    messageIds: string[]
  ): Promise<number[]> {
    const cached = getMessageActionLineNumbers(filePath, mtimeMs, messageIds);
    if (cached) return cached;

    const entries = await parseJsonlWithMeta<IFlowEntry>(filePath);
    const records = buildMessageRecords(entries);
    primeMessageActionIndex(filePath, mtimeMs, records);

    const lineByMessageId = new Map<string, number>();
    for (const record of records) {
      if (record.message.messageId && record.lineIndex) {
        lineByMessageId.set(record.message.messageId, record.lineIndex);
      }
    }

    return messageIds.map((messageId) => {
      const lineNumber = lineByMessageId.get(messageId);
      if (!lineNumber) {
        throw new Error(`消息不存在: ${messageId}`);
      }
      return lineNumber;
    });
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
    const records = buildMessageRecords(entries);
    primeMessageActionIndex(filePath, fileStat.mtimeMs, records);
    const messages = records.map((record) => record.message);

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
    const { targetProjectDir } = resolveProjectDirectory(basePath, targetProjectKey);
    await mkdir(targetProjectDir, { recursive: true });
    const destFile = join(targetProjectDir, fileName);

    if (srcFile.replace(/\\/g, "/") === destFile.replace(/\\/g, "/")) return;
    await rename(srcFile, destFile);
    this.invalidateConversationCaches(srcFile);
  }

  async updateMessage(id: string, messageId: string, content: string): Promise<void> {
    const sessionId = id.replace("iflow:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const fileStat = await stat(filePath);
    const [lineNumber] = await this.resolveMessageLineNumbers(filePath, fileStat.mtimeMs, [messageId]);
    const normalizedContent = normalizeUpdatedMessageContent(content);
    await rewriteJsonlFileLine(
      filePath,
      lineNumber,
      (line) => {
        const entry = JSON.parse(line) as IFlowEntry;
        if (!entry.message || (entry.type !== "user" && entry.type !== "assistant")) {
          throw new Error(`消息不存在: ${messageId}`);
        }

        const nextEntry: IFlowEntry = {
          ...entry,
          message: {
            ...entry.message,
            content: typeof entry.message.content === "string"
              ? normalizedContent
              : [{ type: "text", text: normalizedContent }],
          },
        };
        return JSON.stringify(nextEntry);
      },
      { mtimeMs: fileStat.mtimeMs, size: fileStat.size }
    );
    this.invalidateConversationCaches(filePath);
  }

  async deleteMessage(id: string, messageId: string): Promise<void> {
    await this.deleteMessages(id, [messageId]);
  }

  async deleteMessages(id: string, messageIds: string[]): Promise<void> {
    const sessionId = id.replace("iflow:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const fileStat = await stat(filePath);
    const uniqueMessageIds = [...new Set(messageIds.map((item) => item.trim()).filter(Boolean))];
    if (uniqueMessageIds.length === 0) {
      throw new Error("待删除消息不能为空");
    }
    const lineNumbers = await this.resolveMessageLineNumbers(filePath, fileStat.mtimeMs, uniqueMessageIds);
    await rewriteJsonlFileLines(
      filePath,
      lineNumbers,
      { mtimeMs: fileStat.mtimeMs, size: fileStat.size }
    );
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
