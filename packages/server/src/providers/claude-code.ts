import { readFile, readdir, stat, unlink, rm, mkdir, rename, writeFile } from "fs/promises";
import { join } from "path";
import {
  parseJsonlWithMeta,
  parseJsonlHead,
  parseJsonlTailWithMeta,
  countLines,
  visitJsonl,
} from "../utils/jsonl.js";
import { getCached, getIndexedCacheSnapshot, getIndexedListCache, hasIndexedSearchData, setCache, setIndexedListCache, invalidateCache, invalidateListCache, type IndexedCacheItem } from "../utils/cache/index.js";
import { logProviderError } from "../utils/logger.js";
import { getProviderPaths } from "../utils/provider-paths/index.js";
import { createProviderDataError, isFileSystemNotFoundError } from "../utils/errors.js";
import { runKeyedMutation, runKeyedMutations } from "../utils/mutation-queue.js";
import { collectIndexedCacheItemsInBatches } from "../utils/provider-indexing.js";
import { createConversationSearchIndexBuilder, type ConversationSearchIndex } from "../utils/search-index.js";
import {
  invalidateMessageActionIndex,
  normalizeUpdatedMessageContent,
  primeMessageActionIndex,
  resolveMessageLineNumbers,
  rewriteJsonlFileLine,
  rewriteJsonlFileLines,
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
  getListCacheKey,
  sliceWindow,
  resolveProjectDirectory,
  applyProjectDisplayPathHints,
  removeEmptyParentDirs,
} from "./shared/provider-utils.js";
import {
  appendTranscriptNativeTitle,
  buildClaudeTitleGenerationBadges,
  buildConversationTitle,
  isClaudeTitleGenerationProject,
  mergeClaudeBadges,
  normalizeTitleCandidate,
  readTranscriptNativeTitle,
} from "./claude-code-title.js";
import {
  appendSearchIndexEntry,
  buildHistoryFallbackMessages,
  buildMessageRecords,
  extractTextContent,
} from "./claude-code-messages.js";
import {
  readClaudeSessionIndexFile,
  removeClaudeSessionIndexEntry,
  removeClaudeSessionIndexEntryUnlocked,
  upsertClaudeSessionIndexEntry,
  upsertClaudeSessionIndexEntryUnlocked,
  writeClaudeSessionIndexFile,
} from "./claude-code-session-index.js";
import {
  buildClaudeHintBadges,
  collectClaudeSessionSources,
  CLAUDE_CODE_LIST_SOURCE_VERSION,
  isClaudeCleanupCandidate,
} from "./claude-code-source.js";
import type {
  ClaudeCodeEntry,
  ClaudeCodeSessionIndexFile,
  ClaudeCodeSessionSource,
} from "./claude-code-types.js";

export class ClaudeCodeProvider implements ConversationProvider {
  name = "claude-code";
  displayName = "Claude Code";
  capabilities = {
    titleSyncMode: "native",
    canUpdateTitle: true,
    canGenerateTitle: true,
    canEditMessage: true,
    canDeleteMessage: true,
    canMoveConversation: true,
    canDeleteConversation: true,
    supportsMetadataOnly: true,
  } as const;
  private backgroundRefreshes = new Map<string, Promise<void>>();

  getStoragePath(): string {
    return getProviderPaths("claude-code").storagePath;
  }

  async detect(): Promise<boolean> {
    try {
      await stat(this.getStoragePath());
      return true;
    } catch (error) {
      if (isFileSystemNotFoundError(error)) return false;
      throw createProviderDataError(this.name, "Claude Code 数据目录检测失败", error);
    }
  }

  async list(options: ConversationListOptions = {}): Promise<ConversationMeta[]> {
    return this.listInternal({
      eagerSearchIndex: options.eagerSearchIndex ?? false,
      allowBackground: true,
    });
  }

  async getListSourceSignature(): Promise<string | null> {
    const { sourceSignature } = await this.collectSessionSources();
    return sourceSignature;
  }

  private getBackgroundRefreshKey(): string {
    return `${this.getStoragePath()}::${CLAUDE_CODE_LIST_SOURCE_VERSION}`;
  }

  private scheduleBackgroundIndexRefresh(): void {
    const refreshKey = this.getBackgroundRefreshKey();
    if (this.backgroundRefreshes.has(refreshKey)) {
      return;
    }

    const task = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.getBackgroundRefreshKey() !== refreshKey) {
          this.backgroundRefreshes.delete(refreshKey);
          resolve();
          return;
        }

        this.listInternal({
          eagerSearchIndex: true,
          allowBackground: false,
        })
          .then(() => undefined)
          .catch((error) => {
            logProviderError("conversations.index.background", this.name, error);
          })
          .finally(() => {
            this.backgroundRefreshes.delete(refreshKey);
            resolve();
          });
      }, 250);
    });

    this.backgroundRefreshes.set(refreshKey, task);
  }

  private async listInternal(options: {
    eagerSearchIndex: boolean;
    allowBackground: boolean;
  }): Promise<ConversationMeta[]> {
    const basePath = this.getStoragePath();
    const cacheKey = getListCacheKey(this.name, basePath);
    const { sources, sourceSignature } = await this.collectSessionSources();
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
    const sourcesToRefresh: ClaudeCodeSessionSource[] = [];

    for (const source of sources) {
      const previousMeta = previousByFilePath.get(source.key);
      if (!previousMeta) {
        sourcesToRefresh.push(source);
        continue;
      }

      if (
        source.updatedAtHint === previousMeta.meta.updatedAt
        && source.fileSizeHint === previousMeta.meta.fileSize
        && (!options.eagerSearchIndex || hasIndexedSearchData(previousMeta))
      ) {
        setCache(source.key, source.updatedAtHint, previousMeta.meta);
        results.push(previousMeta);
      } else {
        sourcesToRefresh.push(source);
      }
    }

    const sourceByKey = new Map(sourcesToRefresh.map((source) => [source.key, source]));
    results.push(...await collectIndexedCacheItemsInBatches(
      sourcesToRefresh.map((source) => source.key),
      20,
      async (sourceKey) => {
        const source = sourceByKey.get(sourceKey);
        if (!source) return null;

        return this.buildIndexedCacheItem(source, {
          includeSearchIndex: options.eagerSearchIndex,
          metaHint: previousByFilePath.get(source.key)?.meta,
        });
      }
    ));

    const normalizedResults = applyProjectDisplayPathHints(results);
    const searchReady = options.eagerSearchIndex || sourcesToRefresh.length === 0;
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
    source: ClaudeCodeSessionSource,
    options: {
      includeSearchIndex: boolean;
      metaHint?: ConversationMeta;
    }
  ): Promise<IndexedCacheItem | null> {
    const metaHint = options.metaHint;
    if (
      metaHint
      && metaHint.updatedAt === source.updatedAtHint
      && metaHint.fileSize === source.fileSizeHint
    ) {
      setCache(source.key, source.updatedAtHint, metaHint);
      if (!options.includeSearchIndex) {
        return { meta: metaHint };
      }
      return {
        meta: metaHint,
        ...(await this.extractSearchIndex(source)),
      };
    }

    if (!options.includeSearchIndex) {
      // 即便不需要搜索索引，也走 scanTranscriptSource —— extractMeta 用
      // parseJsonlHead(40) 拿不到出现在文件中后段的 type:"custom-title"
      // 条目（Claude /resume 显示的会话名来自这里）。代价是首次 list 稍慢，
      // 但有 indexed_list_cache 兜底，后续走持久层。
      if (!source.transcriptPath) {
        const meta = await this.extractMeta(source);
        return meta ? { meta } : null;
      }
      const result = await this.scanTranscriptSource(source, false);
      if (!result) return null;
      return { meta: result.meta };
    }

    if (!source.transcriptPath) {
      const meta = await this.buildHintOnlyMeta(source);
      return {
        meta,
        ...(await this.extractSearchIndex(source)),
      };
    }

    return this.scanTranscriptSource(source, true);
  }

  private async scanTranscriptSource(
    source: ClaudeCodeSessionSource,
    includeSearchIndex: boolean
  ): Promise<IndexedCacheItem | null> {
    if (!source.transcriptPath) {
      return null;
    }

    const fileStat = await stat(source.transcriptPath);
    let project = normalizePath(source.projectPathHint || source.projectKey);
    let transcriptTitle: string | undefined;
    let inlineTitleHint: string | undefined;
    let firstTimestamp: number | undefined;
    let messageCount = 0;
    const searchBuilder = includeSearchIndex ? createConversationSearchIndexBuilder() : null;

    await visitJsonl<ClaudeCodeEntry>(source.transcriptPath, (entry) => {
      // Claude /resume 显示的会话名来自 type:"custom-title" / "agent-name"
      // 元条目。它们不是 user/assistant 消息，但需要在主循环外捕获，且取
      // 最后一次出现的（用户可能多次重命名）。
      if (entry.type === "custom-title" && typeof entry.customTitle === "string" && entry.customTitle.trim()) {
        inlineTitleHint = entry.customTitle.trim();
        return;
      }
      if (entry.type === "agent-name" && typeof entry.agentName === "string" && entry.agentName.trim()) {
        inlineTitleHint = entry.agentName.trim();
        return;
      }

      if (
        entry.isMeta
        || entry.isSidechain
        || !entry.message
        || (entry.type !== "user" && entry.type !== "assistant")
      ) {
        return;
      }

      messageCount += 1;

      if (firstTimestamp === undefined && entry.timestamp) {
        const timestamp = Date.parse(entry.timestamp);
        if (Number.isFinite(timestamp)) {
          firstTimestamp = timestamp;
        }
      }

      if (entry.type === "user" && entry.cwd) {
        project = normalizePath(entry.cwd);
      }

      if (!transcriptTitle && entry.type === "user") {
        const text = extractTextContent(entry.message.content);
        if (
          text.trim()
          && !text.startsWith("/")
          && !text.includes("<command-name>")
          && !text.includes("<local-command-")
        ) {
          transcriptTitle = text;
        }
      }

      if (searchBuilder) {
        appendSearchIndexEntry(searchBuilder, entry);
      }
    });

    if (messageCount === 0) {
      if (!source.historySession && !source.displayTitleHint && !source.firstPromptHint) {
        return null;
      }

      const meta = await this.buildHintOnlyMeta({
        ...source,
        displayTitleHint: inlineTitleHint || source.displayTitleHint,
        fileSizeHint: fileStat.size,
        messageCountHint: source.messageCountHint,
      });

      if (!searchBuilder) {
        return { meta };
      }

      return {
        meta,
        ...searchBuilder.build(),
      };
    }

    const isTitleGenerationSession = isClaudeTitleGenerationProject(project);
    const meta: ConversationMeta = {
      id: `claude-code:${source.sessionId}`,
      provider: this.name,
      title: buildConversationTitle(
        inlineTitleHint,
        source.displayTitleHint,
        transcriptTitle,
        source.firstPromptHint
      ),
      project,
      projectKey: source.projectKey,
      projectId: canonicalizeProjectPath(project) || source.projectKey,
      createdAt: firstTimestamp ?? (source.createdAtHint ?? fileStat.birthtimeMs),
      updatedAt: source.updatedAtHint,
      messageCount,
      fileSize: fileStat.size,
      filePath: source.key,
      badges: mergeClaudeBadges(
        isTitleGenerationSession ? buildClaudeTitleGenerationBadges() : undefined
      ),
    };

    setCache(source.key, source.updatedAtHint, meta);

    if (!searchBuilder) {
      return { meta };
    }

    return {
      meta,
      ...searchBuilder.build(),
    };
  }

  private collectSessionSources(): Promise<{ sources: ClaudeCodeSessionSource[]; sourceSignature: string }> {
    return collectClaudeSessionSources({
      storagePath: this.getStoragePath(),
      providerName: this.name,
    });
  }

  private async extractSearchIndex(source: ClaudeCodeSessionSource): Promise<ConversationSearchIndex> {
    const builder = createConversationSearchIndexBuilder();

    if (source.transcriptPath) {
      await visitJsonl<ClaudeCodeEntry>(source.transcriptPath, (entry) => {
        appendSearchIndexEntry(builder, entry);
      });
      return builder.build();
    }

    for (const message of source.historySession?.messages ?? []) {
      if (!message.content.trim()) continue;
      builder.addMessage({
        role: "user",
        content: message.content,
        timestamp: message.timestamp,
      });
    }

    return builder.build();
  }

  private async buildHintOnlyMeta(source: ClaudeCodeSessionSource): Promise<ConversationMeta> {
    const cached = getCached(source.key, source.updatedAtHint);
    if (cached) return cached;

    const project = normalizePath(source.projectPathHint || source.projectKey) || source.projectKey;
    const historyMessageCount = source.historySession?.messages.length ?? 0;
    const isTitleGenerationSession = isClaudeTitleGenerationProject(project);
    const meta: ConversationMeta = {
      id: `claude-code:${source.sessionId}`,
      provider: this.name,
      title: buildConversationTitle(source.displayTitleHint, source.firstPromptHint),
      project,
      projectKey: source.projectKey,
      projectId: canonicalizeProjectPath(project) || source.projectKey,
      createdAt: source.createdAtHint ?? source.updatedAtHint,
      updatedAt: source.updatedAtHint,
      messageCount: source.messageCountHint ?? source.historySession?.messageCount ?? 0,
      fileSize: source.fileSizeHint,
      filePath: source.key,
      contentStatus: historyMessageCount > 0 ? "history-only" : "metadata-only",
      cleanupCandidate: isClaudeCleanupCandidate(source),
      badges: mergeClaudeBadges(
        buildClaudeHintBadges(source, historyMessageCount),
        isTitleGenerationSession ? buildClaudeTitleGenerationBadges() : undefined
      ),
    };

    setCache(source.key, source.updatedAtHint, meta);
    return meta;
  }

  private async extractMeta(source: ClaudeCodeSessionSource): Promise<ConversationMeta | null> {
    if (!source.transcriptPath) {
      return this.buildHintOnlyMeta(source);
    }

    const fileStat = await stat(source.transcriptPath);
    const cached = getCached(source.key, source.updatedAtHint);
    if (cached) return cached;
    const transcriptNativeTitle = await readTranscriptNativeTitle(source.transcriptPath);

    const headEntries = await parseJsonlHead<ClaudeCodeEntry>(source.transcriptPath, 40);
    const headMessages = headEntries.filter(
      (entry) =>
        (entry.type === "user" || entry.type === "assistant") &&
        !entry.isMeta && !entry.isSidechain && entry.message
    );

    if (headMessages.length === 0) {
      const msgCount = await countLines(
        source.transcriptPath,
        (value) => {
          if (!value || typeof value !== "object") return false;
          const entry = value as ClaudeCodeEntry;
          return !entry.isMeta
            && !entry.isSidechain
            && !!entry.message
            && (entry.type === "user" || entry.type === "assistant");
        },
        {
          fastIncludes: ["\"type\":\"user\"", "\"type\":\"assistant\""],
        }
      );
      if (msgCount === 0) {
        if (!source.historySession && !transcriptNativeTitle && !source.displayTitleHint && !source.firstPromptHint) {
          return null;
        }
        return this.buildHintOnlyMeta({
          ...source,
          displayTitleHint: transcriptNativeTitle || source.displayTitleHint,
          fileSizeHint: fileStat.size,
          messageCountHint: msgCount || source.messageCountHint,
        });
      }
    }

    const firstUserEntry = headEntries.find((entry) => entry.type === "user" && entry.cwd);
    const project = firstUserEntry?.cwd
      ? normalizePath(firstUserEntry.cwd)
      : normalizePath(source.projectPathHint || source.projectKey);

    const firstUserMsg = headMessages.find((entry) => {
      if (entry.type !== "user" || !entry.message) return false;
      const text = extractTextContent(entry.message.content);
      if (!text.trim() || text.startsWith("/") || text.includes("<command-name>") || text.includes("<local-command-")) return false;
      return true;
    });
    const transcriptTitle = firstUserMsg
      ? extractTextContent(firstUserMsg.message!.content)
      : undefined;

    const firstTs = headMessages[0]?.timestamp
      ? new Date(headMessages[0].timestamp).getTime()
      : (source.createdAtHint ?? fileStat.birthtimeMs);

    const messageCount = source.messageCountHint ?? await countLines(
      source.transcriptPath,
      (value) => {
        if (!value || typeof value !== "object") return false;
        const entry = value as ClaudeCodeEntry;
        return !entry.isMeta
          && !entry.isSidechain
          && !!entry.message
          && (entry.type === "user" || entry.type === "assistant");
      },
      {
        fastIncludes: ["\"type\":\"user\"", "\"type\":\"assistant\""],
      }
    );

    const isTitleGenerationSession = isClaudeTitleGenerationProject(project);
    const meta: ConversationMeta = {
      id: `claude-code:${source.sessionId}`,
      provider: this.name,
      title: buildConversationTitle(
        transcriptNativeTitle ?? undefined,
        source.displayTitleHint,
        transcriptTitle,
        source.firstPromptHint
      ),
      project,
      projectKey: source.projectKey,
      projectId: canonicalizeProjectPath(project) || source.projectKey,
      createdAt: firstTs,
      updatedAt: source.updatedAtHint,
      messageCount,
      fileSize: fileStat.size,
      filePath: source.key,
      contentStatus: "full",
      badges: mergeClaudeBadges(
        isTitleGenerationSession ? buildClaudeTitleGenerationBadges() : undefined
      ),
    };

    setCache(source.key, source.updatedAtHint, meta);
    return meta;
  }

  private invalidateConversationCaches(filePath: string): void {
    invalidateCache(filePath);
    invalidateMessageActionIndex(filePath);
    invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
  }

  private async writeSessionIndexFile(indexPath: string, indexFile: ClaudeCodeSessionIndexFile): Promise<void> {
    return writeClaudeSessionIndexFile(indexPath, indexFile);
  }

  private async findConversationSource(sessionId: string): Promise<ClaudeCodeSessionSource> {
    const { sources } = await this.collectSessionSources();
    const source = sources.find((item) => item.sessionId === sessionId);
    if (!source) {
      throw new Error(`对话不存在: claude-code:${sessionId}`);
    }
    return source;
  }

  private async findConversationFilePath(sessionId: string, action: string): Promise<string> {
    const source = await this.findConversationSource(sessionId);
    if (!source.transcriptPath) {
      throw new Error(`Claude Code 当前未在本地保留该会话的主 transcript，暂不支持${action}`);
    }
    return source.transcriptPath;
  }

  async read(id: string, options?: ConversationReadOptions): Promise<Conversation> {
    const sessionId = id.replace("claude-code:", "");
    const source = await this.findConversationSource(sessionId);

    if (!source.transcriptPath) {
      const meta = await this.extractMeta(source);
      if (!meta) throw new Error(`无法解析对话元数据: ${id}`);
      const { items, hasMore } = sliceWindow(buildHistoryFallbackMessages(source), options);
      return { ...meta, messages: items, hasMore };
    }

    const fileStat = await stat(source.transcriptPath);

    const limit = options?.limit;
    const before = options?.before ?? 0;
    const shouldWindowRead = !!limit && limit > 0;
    const requiredMessages = shouldWindowRead ? before + limit + 1 : 0;

    // read 时默认全量解析，详情页可通过窗口模式只取最近一段
    const entries = shouldWindowRead
      ? await parseJsonlTailWithMeta<ClaudeCodeEntry>(source.transcriptPath, {
          bytesHint: Math.max(256 * 1024, fileStat.size > 0 ? Math.min(fileStat.size, (before + limit) * 4096) : 256 * 1024),
          maxBytes: fileStat.size,
          isEnough: (tailEntries) => buildMessageRecords(tailEntries).length >= requiredMessages,
        })
      : await parseJsonlWithMeta<ClaudeCodeEntry>(source.transcriptPath);
    const records = buildMessageRecords(entries);
    primeMessageActionIndex(source.transcriptPath, fileStat.mtimeMs, records);
    const messages = records.map((record) => record.message);

    const meta = await this.extractMeta(source);
    if (!meta) throw new Error(`无法解析对话元数据: ${id}`);

    const { items: windowedMessages, hasMore } = sliceWindow(messages, options);

    return { ...meta, messages: windowedMessages, hasMore };
  }

  async delete(id: string): Promise<void> {
    const sessionId = id.replace("claude-code:", "");
    const source = await this.findConversationSource(sessionId);
    let changed = false;

    if (source.transcriptPath) {
      await unlink(source.transcriptPath);
      changed = true;
    }
    if (source.sessionDirPath) {
      await rm(source.sessionDirPath, { recursive: true, force: true });
      changed = true;
    }

    await removeClaudeSessionIndexEntry(source.indexPath, sessionId);

    if (
      !changed
      && !source.historySession
      && !source.displayTitleHint
      && !source.firstPromptHint
      && !source.messageCountHint
    ) {
      throw new Error(`对话不存在: ${id}`);
    }

    this.invalidateConversationCaches(source.key);
    await removeEmptyParentDirs(source.projectDirPath, this.getStoragePath());
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("claude-code:", "");
    const source = await this.findConversationSource(sessionId);
    const basePath = this.getStoragePath();
    const {
      normalizedProjectKey,
      targetProjectDir,
    } = resolveProjectDirectory(basePath, targetProjectKey);
    if (normalizePath(source.projectDirPath) === normalizePath(targetProjectDir)) return;

    const targetIndexPath = normalizePath(join(targetProjectDir, "sessions-index.json"));
    const targetTranscriptPath = source.transcriptPath
      ? normalizePath(join(targetProjectDir, `${sessionId}.jsonl`))
      : undefined;
    const targetSessionDirPath = source.sessionDirPath
      ? normalizePath(join(targetProjectDir, sessionId))
      : undefined;

    await runKeyedMutations([
      `claude-move:${sessionId}`,
      `claude-index:${source.indexPath}`,
      `claude-index:${targetIndexPath}`,
      ...(source.transcriptPath ? [`jsonl:${source.transcriptPath}`] : []),
      ...(source.sessionDirPath ? [`claude-session-dir:${source.sessionDirPath}`] : []),
    ], async () => {
      const sourceIndexSnapshot = await readFile(source.indexPath, "utf-8").catch(() => null);
      const targetIndexSnapshot = source.indexPath === targetIndexPath
        ? sourceIndexSnapshot
        : await readFile(targetIndexPath, "utf-8").catch(() => null);
      let transcriptMoved = false;
      let sessionDirMoved = false;

      try {
        await mkdir(targetProjectDir, { recursive: true });
        if (targetTranscriptPath && await stat(targetTranscriptPath).then(() => true, () => false)) {
          throw new Error(`目标目录已存在同名 transcript: ${targetTranscriptPath}`);
        }
        if (targetSessionDirPath && await stat(targetSessionDirPath).then(() => true, () => false)) {
          throw new Error(`目标目录已存在同名 session 目录: ${targetSessionDirPath}`);
        }

        if (source.transcriptPath && targetTranscriptPath) {
          await rename(source.transcriptPath, targetTranscriptPath);
          transcriptMoved = true;
        }
        if (source.sessionDirPath && targetSessionDirPath) {
          await rename(source.sessionDirPath, targetSessionDirPath);
          sessionDirMoved = true;
        }

        await removeClaudeSessionIndexEntryUnlocked(source.indexPath, sessionId);
        await upsertClaudeSessionIndexEntryUnlocked({
          ...source,
          key: targetTranscriptPath || targetSessionDirPath || normalizePath(join(targetProjectDir, `${sessionId}.session`)),
          projectKey: normalizedProjectKey,
          projectDirPath: targetProjectDir,
          indexPath: targetIndexPath,
          transcriptPath: targetTranscriptPath,
          sessionDirPath: targetSessionDirPath,
          fullPathHint: targetTranscriptPath || source.fullPathHint,
        }, {}, {
          // 经实例方法路由，保留故障注入测试接缝（patch writeSessionIndexFile）
          writeIndexFile: (indexPath, indexFile) => this.writeSessionIndexFile(indexPath, indexFile),
        });
      } catch (error) {
        const rollbackErrors: string[] = [];
        const restoreIndex = async (indexPath: string, snapshot: string | null): Promise<void> => {
          try {
            if (snapshot === null) await rm(indexPath, { force: true });
            else await writeFile(indexPath, snapshot, "utf-8");
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
          }
        };

        if (source.indexPath === targetIndexPath) {
          await restoreIndex(source.indexPath, sourceIndexSnapshot);
        } else {
          await restoreIndex(targetIndexPath, targetIndexSnapshot);
          await restoreIndex(source.indexPath, sourceIndexSnapshot);
        }
        if (sessionDirMoved && source.sessionDirPath && targetSessionDirPath) {
          await rename(targetSessionDirPath, source.sessionDirPath).catch((rollbackError) => {
            rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
          });
        }
        if (transcriptMoved && source.transcriptPath && targetTranscriptPath) {
          await rename(targetTranscriptPath, source.transcriptPath).catch((rollbackError) => {
            rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
          });
        }

        if (rollbackErrors.length > 0) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${message}；回滚失败：${rollbackErrors.join("；")}`);
        }
        throw error;
      }
    });

    this.invalidateConversationCaches(source.key);
  }

  async updateTitle(id: string, title: string): Promise<void> {
    if (!id.startsWith("claude-code:")) {
      throw new Error("仅支持修改 Claude Code 对话标题");
    }

    const sessionId = id.replace("claude-code:", "");
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error("标题不能为空");
    }

    await runKeyedMutation(`claude-title:${sessionId}`, async () => {
      const source = await this.findConversationSource(sessionId);
      if (source.transcriptPath) {
        await appendTranscriptNativeTitle(source.transcriptPath, sessionId, normalizedTitle);
      }
      await upsertClaudeSessionIndexEntry(source, {
        customTitle: normalizedTitle,
        summary: normalizedTitle,
        agentName: normalizedTitle,
      });

      const indexFile = await readClaudeSessionIndexFile(this.name, source.indexPath);
      const indexed = indexFile.entries?.find((entry) => entry.sessionId === sessionId);
      const transcriptTitle = source.transcriptPath
        ? await readTranscriptNativeTitle(source.transcriptPath)
        : normalizedTitle;
      if (
        transcriptTitle !== normalizedTitle
        || normalizeTitleCandidate(indexed?.customTitle) !== normalizedTitle
        || normalizeTitleCandidate(indexed?.summary) !== normalizedTitle
        || normalizeTitleCandidate(indexed?.agentName) !== normalizedTitle
      ) {
        throw new Error(
          `Claude Code 原生标题写入校验失败：期望“${normalizedTitle}”，`
          + `transcript 为“${transcriptTitle || "空"}”，index 为“${
            normalizeTitleCandidate(indexed?.customTitle || indexed?.summary || indexed?.agentName) || "空"
          }”`
        );
      }

      this.invalidateConversationCaches(source.key);
    });
  }

  async updateMessage(id: string, messageId: string, content: string): Promise<void> {
    const sessionId = id.replace("claude-code:", "");
    const filePath = await this.findConversationFilePath(sessionId, "编辑消息");
    const fileStat = await stat(filePath);
    const [lineNumber] = await resolveMessageLineNumbers<ClaudeCodeEntry>(filePath, fileStat.mtimeMs, [messageId], buildMessageRecords);
    const normalizedContent = normalizeUpdatedMessageContent(content);
    await rewriteJsonlFileLine(
      filePath,
      lineNumber,
      (line) => {
        const entry = JSON.parse(line) as ClaudeCodeEntry;
        if (!entry.message || (entry.type !== "user" && entry.type !== "assistant")) {
          throw new Error(`消息不存在: ${messageId}`);
        }

        const nextEntry: ClaudeCodeEntry = {
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
    const sessionId = id.replace("claude-code:", "");
    const filePath = await this.findConversationFilePath(sessionId, "删除消息");
    const fileStat = await stat(filePath);
    const uniqueMessageIds = [...new Set(messageIds.map((item) => item.trim()).filter(Boolean))];
    if (uniqueMessageIds.length === 0) {
      throw new Error("待删除消息不能为空");
    }
    const lineNumbers = await resolveMessageLineNumbers<ClaudeCodeEntry>(filePath, fileStat.mtimeMs, uniqueMessageIds, buildMessageRecords);
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
      throw createProviderDataError(this.name, `Claude Code 项目目录无法读取: ${basePath}`, error);
    }
  }
}
