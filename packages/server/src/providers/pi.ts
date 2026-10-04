import { join } from "path";
import { stat, unlink, rename, mkdir, readdir, writeFile } from "fs/promises";
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
  createProviderDataError,
  isFileSystemNotFoundError,
} from "../utils/errors.js";
import {
  collectGlobFileStates,
  collectIndexedCacheItemsInBatches,
  createIndexedListSourceSignature,
  type IndexedSourceFile,
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
import { runKeyedMutation } from "../utils/mutation-queue.js";
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

interface PiContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  [key: string]: unknown;
}

interface PiMessagePayload {
  role?: string;
  content?: PiContentBlock[] | string;
  timestamp?: number;
  api?: string;
  provider?: string;
  model?: string;
  usage?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

interface PiEntry {
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  type: string;
  customType?: string;
  message?: PiMessagePayload;
  name?: string;
  modelId?: string;
  provider?: string;
  thinkingLevel?: string;
  cwd?: string;
}

function parseTimestamp(value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractTextContent(content: PiContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("\n");
}

function buildMessageRecords(entries: JsonlLine<PiEntry>[]): MessageRecord<PiEntry>[] {
  const records: MessageRecord<PiEntry>[] = [];
  for (const entry of entries) {
    const value = entry.value;
    if (value.type !== "message" || !value.message) continue;
    const payload = value.message;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;

    if (role === "user") {
      const text = extractTextContent(payload.content);
      if (!text.trim()) continue;
      records.push({
        entry: value,
        sourceKey: createStableMessageSourceKey(
          "pi",
          [value.id, value.parentId, value.timestamp, payload.role, Array.isArray(payload.content) ? payload.content.map((block) => block.type).join(",") : "text"],
          entry.rawLine
        ) ?? createMessageSourceKey(entry.rawLine, "pi"),
        lineIndex: entry.lineNumber,
        message: {
          role: "user",
          content: text,
          timestamp: parseTimestamp(value.timestamp) ?? parseTimestamp(payload.timestamp),
        },
      });
      continue;
    }

    // assistant：文本块拼成主消息，toolCall 块拆成 tool 记录
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    const text = extractTextContent(payload.content);
    if (text.trim()) {
      records.push({
        entry: value,
        sourceKey: createStableMessageSourceKey(
          "pi",
          [value.id, value.parentId, value.timestamp, payload.role, "text"],
          entry.rawLine
        ) ?? createMessageSourceKey(entry.rawLine, "pi"),
        lineIndex: entry.lineNumber,
        message: {
          role: "assistant",
          content: text,
          timestamp: parseTimestamp(value.timestamp) ?? parseTimestamp(payload.timestamp),
        },
      });
    }
    for (const block of blocks) {
      if (!block || block.type !== "toolCall") continue;
      records.push({
        entry: value,
        sourceKey: createStableMessageSourceKey(
          "pi",
          [value.id, value.parentId, value.timestamp, "tool", (block as { name?: string }).name],
          entry.rawLine
        ) ?? createMessageSourceKey(entry.rawLine, "pi"),
        lineIndex: entry.lineNumber,
        message: {
          role: "tool",
          content: "",
          toolName: (block as { name?: string }).name || "unknown",
          toolInput: JSON.stringify((block as { arguments?: unknown }).arguments ?? null, null, 2),
        },
      });
    }
    // 空 content 的 assistant 行（如 aborted 占位）不产生记录
  }

  return assignStableMessageIds(records);
}

function appendSearchIndexEntry(
  builder: ConversationSearchIndexBuilder,
  entry: PiEntry
): void {
  if (entry.type !== "message" || !entry.message) return;
  const role = entry.message.role;
  if (role !== "user" && role !== "assistant") return;
  const text = extractTextContent(entry.message.content);
  if (!text.trim()) return;
  builder.addMessage({
    role,
    content: text,
    timestamp: parseTimestamp(entry.timestamp) ?? parseTimestamp(entry.message.timestamp),
  });
}

export class PiProvider implements ConversationProvider {
  name = "pi";
  displayName = "Pi CLI";
  capabilities = {
    titleSyncMode: "native",
    canUpdateTitle: true,
    canGenerateTitle: true,
    canEditMessage: true,
    canDeleteMessage: true,
    canMoveConversation: true,
    canDeleteConversation: true,
    supportsMetadataOnly: false,
  } as const;
  private backgroundRefreshes = new Map<string, Promise<void>>();

  getStoragePath(): string {
    return getProviderPaths("pi").storagePath;
  }

  private async collectSessionFileStates(): Promise<IndexedSourceFile[]> {
    const pattern = join(this.getStoragePath(), "*", "*.jsonl").replace(/\\/g, "/");
    try {
      return await collectGlobFileStates(pattern);
    } catch (error) {
      throw createProviderDataError(this.name, "Pi 会话索引读取失败", error);
    }
  }

  async detect(): Promise<boolean> {
    try {
      await stat(this.getStoragePath());
      return true;
    } catch (error) {
      if (isFileSystemNotFoundError(error)) return false;
      throw createProviderDataError(this.name, "Pi 数据目录检测失败", error);
    }
  }

  async list(options: ConversationListOptions = {}): Promise<ConversationMeta[]> {
    return this.listInternal({
      eagerSearchIndex: options.eagerSearchIndex ?? false,
      allowBackground: true,
    });
  }

  async getListSourceSignature(): Promise<string | null> {
    const fileStates = await this.collectSessionFileStates();
    return createIndexedListSourceSignature(fileStates);
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
    const fileStates = await this.collectSessionFileStates();
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
    const fileName = filePath.split(/[/\\]/).pop()!;
    // 文件名形如 <timestamp>_<sessionId>.jsonl，取下划线后作为会话 ID（与 extractMeta 同口径）
    const sessionId = fileName.includes("_")
      ? fileName.slice(fileName.lastIndexOf("_") + 1).replace(/\.jsonl$/, "")
      : fileName.replace(/\.jsonl$/, "");
    let project = projectFolder;
    let title = "";
    let namedTitle: string | undefined;
    let firstTimestamp: number | undefined;
    let messageCount = 0;
    const searchBuilder = includeSearchIndex ? createConversationSearchIndexBuilder() : null;

    await visitJsonl<PiEntry>(filePath, (entry) => {
      if (entry.type === "session" && entry.cwd) {
        project = normalizePath(entry.cwd);
      }
      if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
        namedTitle = entry.name.trim();
      }
      if (entry.type === "message" && entry.message) {
        const role = entry.message.role;
        if (role === "user" || role === "assistant") {
          const ts = parseTimestamp(entry.timestamp) ?? parseTimestamp(entry.message.timestamp);
          if (!firstTimestamp && ts) firstTimestamp = ts;
          messageCount += 1;
          if (
            !title
            && role === "user"
          ) {
            const text = extractTextContent(entry.message.content);
            if (text.trim() && !text.trim().startsWith("<")) {
              title = text;
            }
          }
        }
      }
      if (searchBuilder) {
        appendSearchIndexEntry(searchBuilder, entry);
      }
    });

    if (messageCount === 0) return null;

    const meta: ConversationMeta = {
      id: `pi:${sessionId}`,
      provider: this.name,
      title: (namedTitle || title).replace(/<[^>]+>/g, "").trim().slice(0, 100) || "未知对话",
      project,
      projectKey: projectFolder,
      projectId: canonicalizeProjectPath(project) || projectFolder,
      createdAt: firstTimestamp ?? fileStat.birthtimeMs,
      updatedAt: fileStat.mtimeMs,
      messageCount,
      fileSize: fileStat.size,
      filePath,
      contentStatus: "full",
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
    await visitJsonl<PiEntry>(filePath, (entry) => {
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

    const headEntries = await parseJsonlHead<PiEntry>(filePath, 30);
    const headMessages = headEntries.filter(
      (e) => e.type === "message" && !!e.message && (e.message.role === "user" || e.message.role === "assistant")
    );

    if (headMessages.length === 0) {
      const msgCount = await countLines(
        filePath,
        (value) => {
          if (!value || typeof value !== "object") return false;
          const entry = value as PiEntry;
          return entry.type === "message" && !!entry.message
            && (entry.message.role === "user" || entry.message.role === "assistant");
        },
        {
          fastIncludes: ['"role":"user"', '"role":"assistant"'],
        }
      );
      if (msgCount === 0) return null;
    }

    const fileName = filePath.split(/[/\\]/).pop()!;
    // 文件名形如 <timestamp>_<sessionId>.jsonl，取下划线后作为会话 ID
    const sessionId = fileName.includes("_")
      ? fileName.slice(fileName.lastIndexOf("_") + 1).replace(/\.jsonl$/, "")
      : fileName.replace(/\.jsonl$/, "");

    const sessionEntry = headEntries.find((e) => e.type === "session" && e.cwd);
    const project = sessionEntry?.cwd
      ? normalizePath(sessionEntry.cwd)
      : projectFolder;
    const projectKey = projectFolder;

    const namedTitle = headEntries.find(
      (e) => e.type === "session_info" && typeof e.name === "string" && e.name.trim()
    )?.name?.trim();

    const firstUserMsg = headMessages.find((e) => {
      if (e.message?.role !== "user") return false;
      const text = extractTextContent(e.message.content);
      if (!text.trim() || text.trim().startsWith("<")) return false;
      return true;
    });
    const title = namedTitle
      ?? (firstUserMsg ? extractTextContent(firstUserMsg.message!.content!).slice(0, 100) : "未知对话");

    const firstEntry = headEntries.find((e) => parseTimestamp(e.timestamp) !== undefined)
      ?? headMessages[0];
    const firstTs = firstEntry && parseTimestamp(firstEntry.timestamp)
      ? parseTimestamp(firstEntry.timestamp)!
      : fileStat.birthtimeMs;

    const messageCount = await countLines(
      filePath,
      (value) => {
        if (!value || typeof value !== "object") return false;
        const entry = value as PiEntry;
        return entry.type === "message" && !!entry.message
          && (entry.message.role === "user" || entry.message.role === "assistant");
      },
      {
        fastIncludes: ['"role":"user"', '"role":"assistant"'],
      }
    );

    const meta: ConversationMeta = {
      id: `pi:${sessionId}`,
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
    // pi 文件名为 <timestamp>_<sessionId>.jsonl，需用 *sessionId.jsonl 匹配后缀
    const pattern = join(basePath, "*", `*${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = [...new Set((await glob(pattern)).map((item) => item.replace(/\\/g, "/")))];
    if (files.length === 0) {
      throw new Error(`对话不存在: pi:${sessionId}`);
    }
    if (files.length > 1) {
      throw new Error(`定位到多个同名对话文件: pi:${sessionId}`);
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

    const entries = await parseJsonlWithMeta<PiEntry>(filePath);
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
    const sessionId = id.replace("pi:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const fileStat = await stat(filePath);

    const limit = options?.limit;
    const before = options?.before ?? 0;
    const shouldWindowRead = !!limit && limit > 0;
    const requiredMessages = shouldWindowRead ? before + limit + 1 : 0;

    const entries = shouldWindowRead
      ? await parseJsonlTailWithMeta<PiEntry>(filePath, {
          bytesHint: Math.max(256 * 1024, fileStat.size > 0 ? Math.min(fileStat.size, (before + limit) * 4096) : 256 * 1024),
          maxBytes: fileStat.size,
          isEnough: (tailEntries) => buildMessageRecords(tailEntries).length >= requiredMessages,
        })
      : await parseJsonlWithMeta<PiEntry>(filePath);
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
    const sessionId = id.replace("pi:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    await unlink(filePath);
    this.invalidateConversationCaches(filePath);
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("pi:", "");
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

  async updateTitle(id: string, title: string): Promise<void> {
    if (!id.startsWith("pi:")) {
      throw new Error("仅支持修改 Pi 对话标题");
    }
    const sessionId = id.replace("pi:", "");
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error("标题不能为空");
    }

    await runKeyedMutation(`pi-title:${sessionId}`, async () => {
      const filePath = await this.findConversationFilePath(sessionId);
      const fileStat = await stat(filePath);
      const entries = await parseJsonlWithMeta<PiEntry>(filePath);
      const infoEntry = entries.find((entry) => entry.value.type === "session_info");

      if (infoEntry?.lineNumber) {
        await rewriteJsonlFileLine(
          filePath,
          infoEntry.lineNumber,
          (line) => {
            const entry = JSON.parse(line) as PiEntry;
            if (entry.type !== "session_info") {
              throw new Error(`标题行已被其他操作修改: ${sessionId}`);
            }
            return JSON.stringify({ ...entry, name: normalizedTitle });
          },
          { mtimeMs: fileStat.mtimeMs, size: fileStat.size }
        );
      } else {
        const line = JSON.stringify({
          type: "session_info",
          id: `title-${Date.now().toString(36)}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          name: normalizedTitle,
        });
        await writeFile(filePath, `\n${line}`, { flag: "a" });
      }

      const verifyEntries = await parseJsonlWithMeta<PiEntry>(filePath);
      const stored = [...verifyEntries].reverse().find((entry) => entry.value.type === "session_info");
      if (!stored || (stored.value.name ?? "").trim() !== normalizedTitle) {
        throw new Error(`Pi 原生标题写入校验失败：期望“${normalizedTitle}”`);
      }
      this.invalidateConversationCaches(filePath);
    });
  }

  async updateMessage(id: string, messageId: string, content: string): Promise<void> {
    const sessionId = id.replace("pi:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const fileStat = await stat(filePath);
    const [lineNumber] = await this.resolveMessageLineNumbers(filePath, fileStat.mtimeMs, [messageId]);
    const normalizedContent = normalizeUpdatedMessageContent(content);
    await rewriteJsonlFileLine(
      filePath,
      lineNumber,
      (line) => {
        const entry = JSON.parse(line) as PiEntry;
        if (entry.type !== "message" || !entry.message || (entry.message.role !== "user" && entry.message.role !== "assistant")) {
          throw new Error(`消息不存在: ${messageId}`);
        }

        const nextContent = entry.message.role === "user"
          ? [{ type: "text", text: normalizedContent }]
          : [
              ...(Array.isArray(entry.message.content) ? entry.message.content.filter((block) => block.type !== "text") : []),
              { type: "text", text: normalizedContent },
            ];
        const nextEntry: PiEntry = {
          ...entry,
          message: {
            ...entry.message,
            content: nextContent,
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
    const sessionId = id.replace("pi:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const fileStat = await stat(filePath);
    const uniqueMessageIds = [...new Set(messageIds.map((item) => (item ?? "").toString().trim()).filter(Boolean))];
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
    } catch (error) {
      if (isFileSystemNotFoundError(error)) return [];
      throw createProviderDataError(this.name, `Pi 项目目录无法读取: ${basePath}`, error);
    }
  }
}
