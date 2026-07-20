import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "fs/promises";
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
import { getProviderConfigPath, getProviderPaths } from "../utils/provider-paths.js";
import { runKeyedMutation, runKeyedMutations } from "../utils/mutation-queue.js";
import {
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
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
  Message,
  ConversationBadge,
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

const CLAUDE_CODE_LIST_SOURCE_VERSION = "claude-code-list-v3-native-title";
const CLAUDE_TITLE_GENERATION_BADGE_LABEL = "标题生成";

interface ClaudeCodeEntry {
  type: string;
  subtype?: string;
  uuid?: string;
  messageId?: string;
  parentUuid?: string | null;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    id?: string;
    model?: string;
  };
  cwd?: string;
  timestamp?: string;
  // 仅在 type==="custom-title" / "agent-name" / "summary" 等元数据条目上出现，
  // Claude /resume 的"会话名"主要来源；UI 也应优先用这个。
  customTitle?: string;
  agentName?: string;
  summary?: string;
}

interface ClaudeCodeSessionIndexEntry {
  sessionId?: string;
  fullPath?: string;
  fileMtime?: number;
  firstPrompt?: string;
  summary?: string;
  customTitle?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
  agentName?: string;
}

interface ClaudeCodeSessionIndexFile {
  version?: number;
  entries?: ClaudeCodeSessionIndexEntry[];
  originalPath?: string;
}

interface ClaudeCodeHistoryEntry {
  display?: string;
  timestamp?: number;
  project?: string;
  sessionId?: string;
}

interface ClaudeHistorySession {
  projectPath?: string;
  firstPrompt?: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount: number;
  messages: Message[];
}

interface ClaudeCodeSessionSource {
  key: string;
  sessionId: string;
  projectKey: string;
  projectDirPath: string;
  indexPath: string;
  transcriptPath?: string;
  sessionDirPath?: string;
  fullPathHint?: string;
  projectPathHint?: string;
  displayTitleHint?: string;
  firstPromptHint?: string;
  createdAtHint?: number;
  updatedAtHint: number;
  fileSizeHint: number;
  messageCountHint?: number;
  historySession?: ClaudeHistorySession;
}

type ClaudeCodeContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
};

function extractTextContent(
  content: string | ClaudeCodeContentBlock[]
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

function extractToolCalls(
  content: ClaudeCodeContentBlock[]
): Message[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      role: "tool" as const,
      content: "",
      toolName: b.name || "unknown",
      toolInput: typeof b.input === "string" ? b.input : JSON.stringify(b.input, null, 2),
    }));
}

function isPureTextContent(content: string | ClaudeCodeContentBlock[]): boolean {
  return typeof content === "string"
    || (Array.isArray(content) && content.every((block) => block.type === "text"));
}

function normalizeTitleCandidate(value?: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

function buildConversationTitle(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const normalized = normalizeTitleCandidate(candidate);
    if (normalized) {
      return normalized.slice(0, 100);
    }
  }
  return "未知对话";
}

function normalizeClaudePathForCompare(value?: string | null): string {
  return normalizePath(value ?? "").replace(/^\/\/\?\//, "").toLowerCase();
}

function getClaudeTitleSessionProjectPath(): string {
  return join(dirname(getProviderConfigPath()), "ai-title-sessions", "claude");
}

function isClaudeTitleGenerationProject(value?: string | null): boolean {
  const normalized = normalizeClaudePathForCompare(value);
  return !!normalized && normalized === normalizeClaudePathForCompare(getClaudeTitleSessionProjectPath());
}

function buildClaudeTitleGenerationBadges(): ConversationBadge[] {
  return [{
    label: CLAUDE_TITLE_GENERATION_BADGE_LABEL,
    tone: "cyan",
    title: "ChatLog Viewer AI 标题生成产生的 Claude Code session",
  }];
}

function mergeClaudeBadges(...groups: Array<ConversationBadge[] | undefined>): ConversationBadge[] | undefined {
  const badges = groups.flatMap((group) => group ?? []);
  return badges.length > 0 ? badges : undefined;
}

function toTimestamp(value?: string | number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isClaudeSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function formatClaudeStoredPath(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = normalizePath(value);
  if (/^[A-Za-z]:\//.test(normalized)) {
    return normalized.replace(/\//g, "\\");
  }
  return normalized;
}

function pickMoreSpecificProject(
  current: string | undefined,
  candidate: string | undefined,
  projectKey: string
): string | undefined {
  if (!candidate) return current;
  if (!current) return candidate;

  const currentScore = getProjectSpecificity(current, projectKey);
  const candidateScore = getProjectSpecificity(candidate, projectKey);
  if (candidateScore > currentScore) return candidate;
  if (candidateScore < currentScore) return current;
  return candidate.length > current.length ? candidate : current;
}

function getPreferredSessionKey(source: ClaudeCodeSessionSource): string {
  return source.transcriptPath
    || source.sessionDirPath
    || source.key;
}

function isClaudeCleanupCandidate(source: ClaudeCodeSessionSource): boolean {
  if (source.transcriptPath) {
    return false;
  }

  const historyMessageCount = source.historySession?.messages.length ?? 0;
  return historyMessageCount === 0;
}

function buildClaudeHintBadges(source: ClaudeCodeSessionSource, historyMessageCount: number): ConversationBadge[] {
  const badges: ConversationBadge[] = [];

  if (historyMessageCount > 0) {
    badges.push({
      label: "history 回填",
      tone: "indigo",
      title: "Claude Code 未保留主 transcript，当前记录由 history.jsonl 中的用户输入回填",
    });
  } else {
    badges.push({
      label: "索引空壳",
      tone: "amber",
      title: "Claude Code 仅保留 sessions-index / session 目录元数据，未找到主 transcript 或 history 内容",
    });
  }

  if (!source.transcriptPath) {
    badges.push({
      label: "无 transcript",
      tone: "gray",
      title: "本地未找到 Claude Code 主 transcript，详情无法展示完整消息",
    });
  }

  return badges;
}

function pickHistorySession(
  current: ClaudeHistorySession | undefined,
  candidate: ClaudeHistorySession | undefined
): ClaudeHistorySession | undefined {
  if (!current) return candidate;
  if (!candidate) return current;
  return candidate.messages.length > current.messages.length ? candidate : current;
}

function parseJsonObjectPrefix<T>(content: string): T | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let startIndex = -1;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (startIndex < 0) {
      if (/\s/.test(char ?? "")) continue;
      if (char !== "{") return null;
      startIndex = index;
      depth = 1;
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = inString;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(content.slice(startIndex, index + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function mergeClaudeSessionSource(
  current: ClaudeCodeSessionSource | undefined,
  candidate: ClaudeCodeSessionSource
): ClaudeCodeSessionSource {
  if (!current) {
    return {
      ...candidate,
      key: getPreferredSessionKey(candidate),
    };
  }

  const merged: ClaudeCodeSessionSource = {
    ...current,
    transcriptPath: current.transcriptPath || candidate.transcriptPath,
    sessionDirPath: current.sessionDirPath || candidate.sessionDirPath,
    fullPathHint: current.fullPathHint || candidate.fullPathHint,
    projectPathHint: pickMoreSpecificProject(
      current.projectPathHint,
      candidate.projectPathHint,
      current.projectKey || candidate.projectKey
    ),
    displayTitleHint: current.displayTitleHint || candidate.displayTitleHint,
    firstPromptHint: current.firstPromptHint || candidate.firstPromptHint,
    createdAtHint: current.createdAtHint === undefined
      ? candidate.createdAtHint
      : (candidate.createdAtHint === undefined
        ? current.createdAtHint
        : Math.min(current.createdAtHint, candidate.createdAtHint)),
    updatedAtHint: Math.max(current.updatedAtHint, candidate.updatedAtHint),
    fileSizeHint: Math.max(current.fileSizeHint, candidate.fileSizeHint),
    messageCountHint: Math.max(current.messageCountHint ?? 0, candidate.messageCountHint ?? 0) || undefined,
    historySession: pickHistorySession(current.historySession, candidate.historySession),
  };

  merged.key = getPreferredSessionKey(merged);
  return merged;
}

function buildMessageRecords(entries: JsonlLine<ClaudeCodeEntry>[]): MessageRecord<ClaudeCodeEntry>[] {
  const records: MessageRecord<ClaudeCodeEntry>[] = [];
  for (const entry of entries) {
    const value = entry.value;
    if (value.isSidechain || value.isMeta) continue;
    if (!value.message) continue;
    if (value.type === "system") continue;

    if (value.type === "user") {
      const text = extractTextContent(value.message.content);
      if (!text.trim() || text.includes("<local-command-") || text.includes("<command-name>") || text.includes("<local-command-stdout>")) continue;
      const cleanText = text.replace(/<[^>]+>/g, "").trim();
      if (!cleanText) continue;
      records.push({
        entry: value,
        sourceKey: isPureTextContent(value.message.content)
          ? createStableMessageSourceKey(
            "claude-code",
            [
              value.uuid,
              value.message.id,
              value.messageId,
              value.sessionId,
              value.timestamp,
              value.type,
              Array.isArray(value.message.content)
                ? value.message.content.map((block) => block.type).join(",")
                : "text",
            ],
            entry.rawLine
          ) ?? createMessageSourceKey(entry.rawLine, "claude-code")
          : undefined,
        lineIndex: entry.lineNumber,
        message: {
          role: "user",
          content: cleanText,
          timestamp: value.timestamp ? new Date(value.timestamp).getTime() : undefined,
        },
      });
    } else if (value.type === "assistant") {
      const text = extractTextContent(value.message.content);
      if (text.trim() && !text.startsWith("No response requested")) {
        records.push({
          entry: value,
          sourceKey: isPureTextContent(value.message.content)
            ? createStableMessageSourceKey(
              "claude-code",
              [
                value.uuid,
                value.message.id,
                value.messageId,
                value.sessionId,
                value.timestamp,
                value.type,
                Array.isArray(value.message.content)
                  ? value.message.content.map((block) => block.type).join(",")
                  : "text",
              ],
              entry.rawLine
            ) ?? createMessageSourceKey(entry.rawLine, "claude-code")
            : undefined,
          lineIndex: entry.lineNumber,
          message: {
            role: "assistant",
            content: text,
            timestamp: value.timestamp ? new Date(value.timestamp).getTime() : undefined,
          },
        });
      }
      if (Array.isArray(value.message.content)) {
        const tools = extractToolCalls(value.message.content);
        for (const tool of tools) {
          records.push({
            entry: value,
            message: tool,
          });
        }
      }
    }
  }

  return assignStableMessageIds(records);
}

function appendSearchIndexEntry(
  builder: ConversationSearchIndexBuilder,
  entry: ClaudeCodeEntry
): void {
  if (entry.isSidechain || entry.isMeta) return;
  if (!entry.message) return;
  if (entry.type === "system") return;

  if (entry.type === "user") {
    const text = extractTextContent(entry.message.content);
    if (
      !text.trim()
      || text.includes("<local-command-")
      || text.includes("<command-name>")
      || text.includes("<local-command-stdout>")
    ) {
      return;
    }

    const cleanText = text.replace(/<[^>]+>/g, "").trim();
    if (!cleanText) return;

    builder.addMessage({
      role: "user",
      content: cleanText,
      timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : undefined,
    });
    return;
  }

  if (entry.type === "assistant") {
    const text = extractTextContent(entry.message.content);
    if (text.trim() && !text.startsWith("No response requested")) {
      builder.addMessage({
        role: "assistant",
        content: text,
        timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : undefined,
      });
    }
  }
}

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
      const { sourceSignature } = await this.collectSessionSources();
      return sourceSignature;
    } catch {
      return null;
    }
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

  private async appendTranscriptNativeTitle(
    filePath: string,
    sessionId: string,
    title: string
  ): Promise<void> {
    await runKeyedMutation(`claude-transcript:${filePath}`, async () => {
      const file = await open(filePath, "a+");
      try {
        const fileStat = await file.stat();
        let prefix = "";
        if (fileStat.size > 0) {
          const lastByte = Buffer.alloc(1);
          await file.read(lastByte, 0, 1, fileStat.size - 1);
          if (lastByte[0] !== 0x0a && lastByte[0] !== 0x0d) {
            prefix = "\n";
          }
        }

        const entries: ClaudeCodeEntry[] = [
          {
            type: "custom-title",
            customTitle: title,
            sessionId,
          },
          {
            type: "agent-name",
            agentName: title,
            sessionId,
          },
        ];
        await file.write(`${prefix}${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      } finally {
        await file.close();
      }
    });
  }

  private async readTranscriptNativeTitle(filePath: string): Promise<string | null> {
    let title: string | null = null;
    await visitJsonl<ClaudeCodeEntry>(filePath, (entry) => {
      if (entry.type === "custom-title") {
        title = normalizeTitleCandidate(entry.customTitle) ?? title;
      } else if (entry.type === "agent-name") {
        title = normalizeTitleCandidate(entry.agentName) ?? title;
      }
    });
    return title;
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

  private async readHistorySessions(signatureFiles: IndexedSourceFile[]): Promise<Map<string, ClaudeHistorySession>> {
    const historyPath = normalizePath(join(this.getStoragePath(), "..", "history.jsonl"));
    try {
      const historyStat = await stat(historyPath);
      signatureFiles.push({
        path: historyPath,
        mtimeMs: historyStat.mtimeMs,
        size: historyStat.size,
      });
    } catch {
      return new Map();
    }

    const sessions = new Map<string, ClaudeHistorySession>();
    await visitJsonl<ClaudeCodeHistoryEntry>(historyPath, (entry) => {
      const sessionId = entry.sessionId?.trim();
      const display = entry.display?.trim();
      if (!sessionId || !display) {
        return;
      }

      const current = sessions.get(sessionId) ?? {
        messageCount: 0,
        messages: [],
      };
      const timestamp = typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
        ? entry.timestamp
        : undefined;

      current.projectPath = entry.project ? normalizePath(entry.project) : current.projectPath;
      current.createdAt = current.createdAt === undefined
        ? timestamp
        : (timestamp === undefined ? current.createdAt : Math.min(current.createdAt, timestamp));
      current.updatedAt = current.updatedAt === undefined
        ? timestamp
        : (timestamp === undefined ? current.updatedAt : Math.max(current.updatedAt, timestamp));
      current.messageCount += 1;
      current.messages.push({
        role: "user",
        content: display,
        timestamp,
      });

      if (!display.startsWith("/") && !current.firstPrompt) {
        current.firstPrompt = display;
      }

      sessions.set(sessionId, current);
    });

    return sessions;
  }

  private async readSessionIndexFile(indexPath: string): Promise<ClaudeCodeSessionIndexFile> {
    try {
      const content = await readFile(indexPath, "utf-8");
      let parsed: ClaudeCodeSessionIndexFile | null = null;
      try {
        parsed = JSON.parse(content) as ClaudeCodeSessionIndexFile;
      } catch {
        parsed = parseJsonObjectPrefix<ClaudeCodeSessionIndexFile>(content);
      }

      if (parsed) {
        return {
          version: parsed.version ?? 1,
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          originalPath: parsed.originalPath,
        };
      }
    } catch {
      // 继续返回空索引
    }

    return {
      version: 1,
      entries: [],
    };
  }

  private async collectSessionSources(): Promise<{ sources: ClaudeCodeSessionSource[]; sourceSignature: string }> {
    const basePath = normalizePath(this.getStoragePath());
    const signatureFiles: IndexedSourceFile[] = [];
    const historyBySessionId = await this.readHistorySessions(signatureFiles);
    const sourceBySessionId = new Map<string, ClaudeCodeSessionSource>();

    const projectEntries = await readdir(basePath, { withFileTypes: true });
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) continue;

      const projectKey = projectEntry.name;
      const projectDirPath = normalizePath(join(basePath, projectKey));
      const indexPath = normalizePath(join(projectDirPath, "sessions-index.json"));
      const transcriptBySessionId = new Map<string, IndexedSourceFile>();
      const sessionDirBySessionId = new Map<string, IndexedSourceFile>();

      const projectDirEntries = await readdir(projectDirPath, { withFileTypes: true });
      for (const entry of projectDirEntries) {
        const fullPath = normalizePath(join(projectDirPath, entry.name));
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const fileStat = await stat(fullPath);
          const fileState = {
            path: fullPath,
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
          };
          signatureFiles.push(fileState);

          const sessionId = entry.name.replace(/\.jsonl$/i, "");
          if (sessionId !== "sessions-index" && isClaudeSessionId(sessionId)) {
            transcriptBySessionId.set(sessionId, fileState);
          }
          continue;
        }

        if (entry.isDirectory() && isClaudeSessionId(entry.name)) {
          const dirStat = await stat(fullPath);
          const dirState = {
            path: fullPath,
            mtimeMs: dirStat.mtimeMs,
            size: 0,
          };
          signatureFiles.push(dirState);
          sessionDirBySessionId.set(entry.name, dirState);
        }
      }

      let sessionIndex: ClaudeCodeSessionIndexFile | null = null;
      try {
        const indexStat = await stat(indexPath);
        signatureFiles.push({
          path: indexPath,
          mtimeMs: indexStat.mtimeMs,
          size: indexStat.size,
        });
        sessionIndex = await this.readSessionIndexFile(indexPath);
      } catch {
        sessionIndex = null;
      }

      for (const entry of sessionIndex?.entries ?? []) {
        const sessionId = entry.sessionId?.trim();
        if (!sessionId || !isClaudeSessionId(sessionId) || entry.isSidechain) continue;

        const transcript = transcriptBySessionId.get(sessionId);
        const sessionDir = sessionDirBySessionId.get(sessionId);
        const historySession = historyBySessionId.get(sessionId);
        const updatedAtHint = Math.max(
          toTimestamp(entry.modified) ?? 0,
          entry.fileMtime ?? 0,
          transcript?.mtimeMs ?? 0,
          sessionDir?.mtimeMs ?? 0
        ) || Date.now();

        sourceBySessionId.set(
          sessionId,
          mergeClaudeSessionSource(sourceBySessionId.get(sessionId), {
            key: transcript?.path || sessionDir?.path || normalizePath(join(projectDirPath, `${sessionId}.session`)),
            sessionId,
            projectKey,
            projectDirPath,
            indexPath,
            transcriptPath: transcript?.path,
            sessionDirPath: sessionDir?.path,
            fullPathHint: entry.fullPath ? normalizePath(entry.fullPath) : undefined,
            projectPathHint: entry.projectPath
              ? normalizePath(entry.projectPath)
              : (sessionIndex?.originalPath ? normalizePath(sessionIndex.originalPath) : historySession?.projectPath),
            displayTitleHint: normalizeTitleCandidate(entry.customTitle || entry.summary || entry.agentName),
            firstPromptHint: normalizeTitleCandidate(entry.firstPrompt),
            createdAtHint: toTimestamp(entry.created) ?? historySession?.createdAt,
            updatedAtHint,
            fileSizeHint: transcript?.size ?? 0,
            messageCountHint: entry.messageCount ?? historySession?.messageCount,
            historySession,
          })
        );
      }

      for (const [sessionId, transcript] of transcriptBySessionId) {
        const historySession = historyBySessionId.get(sessionId);
        sourceBySessionId.set(
          sessionId,
          mergeClaudeSessionSource(sourceBySessionId.get(sessionId), {
            key: transcript.path,
            sessionId,
            projectKey,
            projectDirPath,
            indexPath,
            transcriptPath: transcript.path,
            fullPathHint: transcript.path,
            projectPathHint: historySession?.projectPath || sessionIndex?.originalPath,
            firstPromptHint: historySession?.firstPrompt,
            createdAtHint: historySession?.createdAt,
            updatedAtHint: Math.max(transcript.mtimeMs, historySession?.updatedAt ?? 0),
            fileSizeHint: transcript.size,
            messageCountHint: historySession?.messageCount,
            historySession,
          })
        );
      }

      for (const [sessionId, sessionDir] of sessionDirBySessionId) {
        const historySession = historyBySessionId.get(sessionId);
        if (!historySession) continue;

        sourceBySessionId.set(
          sessionId,
          mergeClaudeSessionSource(sourceBySessionId.get(sessionId), {
            key: sessionDir.path,
            sessionId,
            projectKey,
            projectDirPath,
            indexPath,
            sessionDirPath: sessionDir.path,
            projectPathHint: historySession.projectPath || sessionIndex?.originalPath,
            firstPromptHint: historySession.firstPrompt,
            createdAtHint: historySession.createdAt,
            updatedAtHint: Math.max(sessionDir.mtimeMs, historySession.updatedAt ?? 0),
            fileSizeHint: 0,
            messageCountHint: historySession.messageCount,
            historySession,
          })
        );
      }
    }

    const sources = [...sourceBySessionId.values()].sort((a, b) => b.updatedAtHint - a.updatedAtHint);
    const sourceSignature = `${CLAUDE_CODE_LIST_SOURCE_VERSION}:${
      createIndexedListSourceSignature(
        signatureFiles
          .map((item) => ({
            path: normalizePath(item.path),
            mtimeMs: item.mtimeMs,
            size: item.size,
          }))
          .sort((a, b) => a.path.localeCompare(b.path))
      )
    }`;

    return { sources, sourceSignature };
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
    const transcriptNativeTitle = await this.readTranscriptNativeTitle(source.transcriptPath);

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

  private async removeSessionIndexEntry(indexPath: string, sessionId: string): Promise<void> {
    await runKeyedMutation(`claude-index:${indexPath}`, async () => {
      await this.removeSessionIndexEntryUnlocked(indexPath, sessionId);
    });
  }

  private async removeSessionIndexEntryUnlocked(indexPath: string, sessionId: string): Promise<void> {
    const indexFile = await this.readSessionIndexFile(indexPath);
    const entries = (indexFile.entries ?? []).filter((entry) => entry.sessionId !== sessionId);
    if ((indexFile.entries ?? []).length === entries.length) return;
    indexFile.entries = entries;
    await this.writeSessionIndexFile(indexPath, indexFile);
  }

  private async writeSessionIndexFile(
    indexPath: string,
    indexFile: ClaudeCodeSessionIndexFile
  ): Promise<void> {
    const temporaryPath = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(indexPath), { recursive: true });
    try {
      await writeFile(temporaryPath, JSON.stringify(indexFile, null, 2), "utf-8");
      await rename(temporaryPath, indexPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async upsertSessionIndexEntry(
    source: ClaudeCodeSessionSource,
    overrides: Partial<ClaudeCodeSessionIndexEntry> = {}
  ): Promise<void> {
    await runKeyedMutation(`claude-index:${source.indexPath}`, async () => {
      await this.upsertSessionIndexEntryUnlocked(source, overrides);
    });
  }

  private async upsertSessionIndexEntryUnlocked(
    source: ClaudeCodeSessionSource,
    overrides: Partial<ClaudeCodeSessionIndexEntry> = {}
  ): Promise<void> {
    const indexFile = await this.readSessionIndexFile(source.indexPath);
    const entries = Array.isArray(indexFile.entries) ? indexFile.entries : [];
    const entryIndex = entries.findIndex((entry) => entry.sessionId === source.sessionId);
    const existing = entryIndex >= 0 ? entries[entryIndex] : undefined;

    const defaultProjectPath = source.projectPathHint || indexFile.originalPath;
    const defaultFullPath = source.transcriptPath
      || source.fullPathHint
      || join(source.projectDirPath, `${source.sessionId}.jsonl`);
    const fallbackSummary = source.displayTitleHint
      || source.firstPromptHint
      || existing?.summary
      || existing?.firstPrompt
      || "New Conversation";

    const nextEntry: ClaudeCodeSessionIndexEntry = {
        ...existing,
        sessionId: source.sessionId,
        fullPath: formatClaudeStoredPath(existing?.fullPath || defaultFullPath),
        fileMtime: Math.round(source.updatedAtHint),
        firstPrompt: existing?.firstPrompt || source.firstPromptHint,
        summary: existing?.summary || fallbackSummary,
        messageCount: existing?.messageCount ?? source.messageCountHint ?? source.historySession?.messageCount ?? 0,
        created: existing?.created || new Date(source.createdAtHint ?? source.updatedAtHint).toISOString(),
        modified: new Date().toISOString(),
        gitBranch: existing?.gitBranch ?? "",
        projectPath: formatClaudeStoredPath(existing?.projectPath || defaultProjectPath),
        isSidechain: false,
        ...overrides,
    };

    if (!nextEntry.firstPrompt && source.firstPromptHint) {
      nextEntry.firstPrompt = source.firstPromptHint;
    }

    if (!indexFile.originalPath && nextEntry.projectPath) {
      indexFile.originalPath = nextEntry.projectPath;
    }

    if (entryIndex >= 0) {
      entries[entryIndex] = nextEntry;
    } else {
      entries.unshift(nextEntry);
    }

    indexFile.version = indexFile.version ?? 1;
    indexFile.entries = entries;
    await this.writeSessionIndexFile(source.indexPath, indexFile);
  }

  private invalidateConversationCaches(filePath: string): void {
    invalidateCache(filePath);
    invalidateMessageActionIndex(filePath);
    invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
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

  private async resolveMessageLineNumbers(
    filePath: string,
    mtimeMs: number,
    messageIds: string[]
  ): Promise<number[]> {
    const cached = getMessageActionLineNumbers(filePath, mtimeMs, messageIds);
    if (cached) return cached;

    const entries = await parseJsonlWithMeta<ClaudeCodeEntry>(filePath);
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

  private buildHistoryFallbackMessages(source: ClaudeCodeSessionSource): Message[] {
    const messages = source.historySession?.messages ?? [];
    const notice: Message = {
      role: "system",
      content: "当前 Claude Code 会话未在本地保留完整 transcript，以下仅显示 history.jsonl 中记录的用户输入。",
    };

    if (messages.length === 0) {
      return [notice];
    }

    return [notice, ...messages];
  }

  async read(id: string, options?: ConversationReadOptions): Promise<Conversation> {
    const sessionId = id.replace("claude-code:", "");
    const source = await this.findConversationSource(sessionId);

    if (!source.transcriptPath) {
      const meta = await this.extractMeta(source);
      if (!meta) throw new Error(`无法解析对话元数据: ${id}`);
      const { items, hasMore } = sliceWindow(this.buildHistoryFallbackMessages(source), options);
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

    await this.removeSessionIndexEntry(source.indexPath, sessionId);

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

        await this.removeSessionIndexEntryUnlocked(source.indexPath, sessionId);
        await this.upsertSessionIndexEntryUnlocked({
          ...source,
          key: targetTranscriptPath || targetSessionDirPath || normalizePath(join(targetProjectDir, `${sessionId}.session`)),
          projectKey: normalizedProjectKey,
          projectDirPath: targetProjectDir,
          indexPath: targetIndexPath,
          transcriptPath: targetTranscriptPath,
          sessionDirPath: targetSessionDirPath,
          fullPathHint: targetTranscriptPath || source.fullPathHint,
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
        await this.appendTranscriptNativeTitle(source.transcriptPath, sessionId, normalizedTitle);
      }
      await this.upsertSessionIndexEntry(source, {
        customTitle: normalizedTitle,
        summary: normalizedTitle,
        agentName: normalizedTitle,
      });

      const indexFile = await this.readSessionIndexFile(source.indexPath);
      const indexed = indexFile.entries?.find((entry) => entry.sessionId === sessionId);
      const transcriptTitle = source.transcriptPath
        ? await this.readTranscriptNativeTitle(source.transcriptPath)
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
    const [lineNumber] = await this.resolveMessageLineNumbers(filePath, fileStat.mtimeMs, [messageId]);
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
