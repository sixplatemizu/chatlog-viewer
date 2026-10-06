import { join } from "path";
import { stat, unlink, rename, mkdir, readdir, rm, appendFile } from "fs/promises";
import { glob } from "glob";
import {
  parseJsonlWithMeta,
  parseJsonlHead,
  parseJsonlTailWithMeta,
  countLines,
  visitJsonl,
  type JsonlLine,
} from "../utils/jsonl.js";
import { getCached, getIndexedCacheSnapshot, getIndexedListCache, hasIndexedSearchData, setCache, setIndexedListCache, invalidateCache, invalidateListCache, type IndexedCacheItem } from "../utils/cache/index.js";
import { logProviderError } from "../utils/logger.js";
import { getProviderPaths } from "../utils/provider-paths/index.js";
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
  type ConversationSearchIndexBuilder,
} from "../utils/search-index.js";
import {
  assignStableMessageIds,
  createMessageSourceKey,
  createStableMessageSourceKey,
  invalidateMessageActionIndex,
  normalizeUpdatedMessageContent,
  primeMessageActionIndex,
  resolveMessageLineNumbers,
  rewriteJsonlFileLine,
  rewriteJsonlFileLines,
  type MessageRecord,
} from "../utils/message-actions.js";
import { runKeyedMutation } from "../utils/mutation-queue.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
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
  removeEmptyParentDirs,
} from "./shared/provider-utils.js";

interface CodeBuddyContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface CodeBuddyEntry {
  id?: string;
  parentId?: string | null;
  timestamp?: number;
  type: string;
  role?: string;
  content?: CodeBuddyContentBlock[];
  providerData?: Record<string, unknown>;
  sessionId?: string;
  cwd?: string;
  aiTitle?: string;
  name?: string;
  callId?: string;
  status?: string;
  output?: unknown;
  summary?: string;
}

const SUB_AGENT_FILE_RE = /^agent-([0-9a-f]+)\.jsonl$/i;

function extractTextContent(content: CodeBuddyContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && (block.type === "input_text" || block.type === "output_text") && typeof block.text === "string")
    .map((block) => block.text!)
    .join("\n");
}

function extractOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (record.content !== undefined) return extractOutputText(record.content);
  }
  return "";
}

function buildMessageRecords(entries: JsonlLine<CodeBuddyEntry>[]): MessageRecord<CodeBuddyEntry>[] {
  const records: MessageRecord<CodeBuddyEntry>[] = [];
  for (const entry of entries) {
    const value = entry.value;
    if (value.type === "message" && (value.role === "user" || value.role === "assistant")) {
      const text = extractTextContent(value.content);
      if (!text.trim()) continue;
      records.push({
        entry: value,
        sourceKey: createStableMessageSourceKey(
          "codebuddy",
          [value.id, value.parentId, value.timestamp, value.role, value.sessionId],
          entry.rawLine
        ) ?? createMessageSourceKey(entry.rawLine, "codebuddy"),
        lineIndex: entry.lineNumber,
        message: {
          role: value.role,
          content: text,
          timestamp: typeof value.timestamp === "number" ? value.timestamp : undefined,
        },
      });
      continue;
    }

    if (value.type === "function_call") {
      const args = typeof value.providerData?.arguments === "string"
        ? value.providerData.arguments
        : JSON.stringify(value.providerData?.arguments ?? value.content ?? "");
      records.push({
        entry: value,
        sourceKey: createStableMessageSourceKey(
          "codebuddy",
          [value.id, value.parentId, value.timestamp, "function_call", value.name, value.callId],
          entry.rawLine
        ) ?? createMessageSourceKey(entry.rawLine, "codebuddy"),
        lineIndex: entry.lineNumber,
        message: {
          role: "tool",
          content: args.slice(0, 2000),
          timestamp: typeof value.timestamp === "number" ? value.timestamp : undefined,
          toolName: typeof value.name === "string" && value.name ? value.name : "unknown",
          toolInput: args,
        },
      });
      continue;
    }

    if (value.type === "function_call_result") {
      const text = extractOutputText(value.output);
      if (!text.trim()) continue;
      records.push({
        entry: value,
        sourceKey: createStableMessageSourceKey(
          "codebuddy",
          [value.id, value.parentId, value.timestamp, "function_call_result", value.name, value.callId],
          entry.rawLine
        ) ?? createMessageSourceKey(entry.rawLine, "codebuddy"),
        lineIndex: entry.lineNumber,
        message: {
          role: "tool",
          content: text,
          timestamp: typeof value.timestamp === "number" ? value.timestamp : undefined,
          toolName: typeof value.name === "string" && value.name ? value.name : "unknown",
          toolResult: text,
        },
      });
    }
  }

  return assignStableMessageIds(records);
}

function appendSearchIndexEntry(
  builder: ConversationSearchIndexBuilder,
  entry: CodeBuddyEntry
): void {
  if (entry.type === "message" && (entry.role === "user" || entry.role === "assistant")) {
    const text = extractTextContent(entry.content);
    if (!text.trim()) return;
    builder.addMessage({
      role: entry.role,
      content: text,
      timestamp: typeof entry.timestamp === "number" ? entry.timestamp : undefined,
    });
    return;
  }
  if (entry.type === "function_call_result") {
    const text = extractOutputText(entry.output);
    if (!text.trim()) return;
    builder.addMessage({
      role: "assistant",
      content: text,
      timestamp: typeof entry.timestamp === "number" ? entry.timestamp : undefined,
    });
  }
}

interface SubAgentLink {
  agentId: string;
  filePath: string;
  agentName?: string;
}

async function collectSubAgentLinks(mainFilePath: string): Promise<SubAgentLink[]> {
  const dirPath = mainFilePath.replace(/\.jsonl$/, "");
  const subDir = join(dirPath, "subagents");
  let files: string[];
  try {
    const entries = await readdir(subDir, { withFileTypes: true });
    files = entries.filter((e) => e.isFile() && SUB_AGENT_FILE_RE.test(e.name)).map((e) => e.name).sort();
  } catch (error) {
    if (isFileSystemNotFoundError(error)) return [];
    throw error;
  }

  const links: SubAgentLink[] = [];
  for (const file of files) {
    const agentId = `agent-${SUB_AGENT_FILE_RE.exec(file)![1]!.toLowerCase()}`;
    const filePath = join(subDir, file).replace(/\\/g, "/");
    let agentName: string | undefined;
    try {
      const head = await parseJsonlHead<CodeBuddyEntry>(filePath, 3);
      const first = head[0];
      const agent = first?.providerData?.agent;
      if (typeof agent === "string" && agent.trim()) agentName = agent.trim();
    } catch {
      // 首行解析失败不影响收录，名称缺失而已
    }
    links.push({ agentId, filePath, agentName });
  }
  return links;
}

export class CodeBuddyProvider implements ConversationProvider {
  name = "codebuddy";
  displayName = "CodeBuddy";
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
    return getProviderPaths("codebuddy").storagePath;
  }

  private async collectSessionFileStates(): Promise<IndexedSourceFile[]> {
    const mainPattern = join(this.getStoragePath(), "*", "*.jsonl").replace(/\\/g, "/");
    const subPattern = join(this.getStoragePath(), "*", "*", "subagents", "*.jsonl").replace(/\\/g, "/");
    try {
      const [mains, subs] = await Promise.all([
        collectGlobFileStates(mainPattern),
        collectGlobFileStates(subPattern),
      ]);
      const seen = new Set<string>();
      const merged: IndexedSourceFile[] = [];
      for (const item of [...mains, ...subs]) {
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        merged.push(item);
      }
      return merged.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    } catch (error) {
      throw createProviderDataError(this.name, "CodeBuddy 会话索引读取失败", error);
    }
  }

  async detect(): Promise<boolean> {
    try {
      await stat(this.getStoragePath());
      return true;
    } catch (error) {
      if (isFileSystemNotFoundError(error)) return false;
      throw createProviderDataError(this.name, "CodeBuddy 数据目录检测失败", error);
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

    const merged = this.sortConversationMetasForDisplay(normalizedResults.map((item) => item.meta));
    return merged;
  }

  private sortConversationMetasForDisplay(metas: ConversationMeta[]): ConversationMeta[] {
    // 父子会话通过 projectKey 自然分在一起（子 projectKey = 父 projectKey/父 sessionId）；
    // 同一分组内主会话在前、子会话随后，其余按更新时间倒序。树状展示由前端按 projectKey 分组 + badges 完成。
    const groupKey = (meta: ConversationMeta): string => {
      const key = meta.projectKey || "";
      const slash = key.indexOf("/");
      return slash < 0 ? key : key.slice(0, slash);
    };
    const parentRank = (meta: ConversationMeta): number => (meta.id.startsWith("codebuddy:sub:") ? 1 : 0);
    return [...metas].sort((a, b) => {
      const groupA = groupKey(a);
      const groupB = groupKey(b);
      if (groupA === groupB && a.projectKey !== b.projectKey) {
        return a.projectKey < b.projectKey ? -1 : 1;
      }
      if (groupA === groupB && parentRank(a) !== parentRank(b)) {
        return parentRank(a) - parentRank(b);
      }
      return b.updatedAt - a.updatedAt;
    });
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

  private isSubAgentFile(filePath: string): boolean {
    return filePath.replace(/\\/g, "/").includes("/subagents/");
  }

  private async buildSubAgentBadgeFor(
    subAgentName: string | undefined,
    parentSessionId: string,
    projectFolder: string
  ): Promise<ConversationBadge[]> {
    const parentTitle = await this.readParentTitle(parentSessionId, projectFolder);
    const namePart = subAgentName ? `（${subAgentName}）` : "";
    const parentPart = parentTitle
      ? `父会话：${parentSessionId}（${parentTitle}）`
      : `父会话：${parentSessionId}`;
    return [{ label: "子会话", tone: "indigo" as const, title: `子会话${namePart}，${parentPart}` }];
  }

  private async buildParentBadgeFor(subLinks: SubAgentLink[]): Promise<ConversationBadge[] | undefined> {
    const badges: ConversationBadge[] = [];
    if (subLinks.length > 0) {
      const names = subLinks.map((link) => link.agentName ?? link.agentId);
      badges.push({
        label: `含${subLinks.length}个子会话`,
        tone: "indigo",
        title: `子会话：${names.join("、")}`,
      });
    }
    return badges.length > 0 ? badges : undefined;
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
    const normalized = filePath.replace(/\\/g, "/");
    if (this.isSubAgentFile(filePath)) {
      return this.scanSubAgentFile(filePath, fileStat, includeSearchIndex);
    }

    const pathParts = normalized.split("/");
    const projectFolder = pathParts[pathParts.length - 2] || "";
    const sessionId = filePath.split(/[/\\]/).pop()!.replace(/\.jsonl$/, "");
    let project = projectFolder;
    let title = "";
    let namedTitle: string | undefined;
    let firstTimestamp: number | undefined;
    let messageCount = 0;
    const searchBuilder = includeSearchIndex ? createConversationSearchIndexBuilder() : null;

    await visitJsonl<CodeBuddyEntry>(filePath, (entry) => {
      if (entry.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim() && !namedTitle) {
        namedTitle = entry.aiTitle.trim();
      }
      if (entry.type !== "message" || (entry.role !== "user" && entry.role !== "assistant")) {
        return;
      }
      messageCount += 1;

      if (firstTimestamp === undefined && typeof entry.timestamp === "number") {
        firstTimestamp = entry.timestamp;
      }

      if (entry.role === "user" && entry.cwd) {
        project = normalizePath(entry.cwd);
      }

      if (!title && entry.role === "user") {
        const text = extractTextContent(entry.content);
        if (text.trim() && !text.trim().startsWith("<system-reminder")) {
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

    const subLinks = await collectSubAgentLinks(filePath);
    const parentBadges = await this.buildParentBadgeFor(subLinks);

    const meta: ConversationMeta = {
      id: `codebuddy:${sessionId}`,
      provider: this.name,
      title: (namedTitle ?? title).replace(/<[^>]+>/g, "").trim() || "未知对话",
      project,
      projectKey: projectFolder,
      projectId: canonicalizeProjectPath(project) || projectFolder,
      createdAt: firstTimestamp ?? fileStat.birthtimeMs,
      updatedAt: fileStat.mtimeMs,
      messageCount,
      fileSize: fileStat.size,
      filePath,
      contentStatus: "full",
      badges: parentBadges,
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

  private async readParentTitle(parentSessionId: string, projectFolder: string): Promise<string | undefined> {
    // 父会话标题优先用 ai-title（与 extractMeta 同口径），读不到时返回 undefined。
    try {
      const pattern = join(this.getStoragePath(), projectFolder, `${parentSessionId}.jsonl`).replace(/\\/g, "/");
      const files = (await glob(pattern)).map((item) => item.replace(/\\/g, "/"));
      if (files.length !== 1) return undefined;
      const head = await parseJsonlHead<CodeBuddyEntry>(files[0]!, 30);
      const named = head.find((entry) => entry.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim());
      return named?.aiTitle?.trim();
    } catch {
      return undefined;
    }
  }

  private async scanSubAgentFile(
    filePath: string,
    fileStat: {
      mtimeMs: number;
      size: number;
      birthtimeMs: number;
    },
    includeSearchIndex: boolean
  ): Promise<IndexedCacheItem | null> {
    const normalized = filePath.replace(/\\/g, "/");
    const fileName = normalized.split("/").pop()!;
    const agentId = `agent-${SUB_AGENT_FILE_RE.exec(fileName)?.[1]?.toLowerCase() ?? fileName.replace(/\.jsonl$/, "")}`;
    const parentDir = normalized.split("/").slice(0, -2).join("/");
    const parentSessionId = parentDir.split("/").pop() ?? "";
    const projectFolder = parentDir.split("/").slice(0, -1).pop() ?? "";
    let project = projectFolder;
    let title = "";
    let subAgentName: string | undefined;
    let firstTimestamp: number | undefined;
    let messageCount = 0;
    const searchBuilder = includeSearchIndex ? createConversationSearchIndexBuilder() : null;

    await visitJsonl<CodeBuddyEntry>(filePath, (entry) => {
      if (typeof entry.providerData?.agent === "string" && (entry.providerData.agent as string).trim() && !subAgentName) {
        subAgentName = (entry.providerData.agent as string).trim();
      }
      if (entry.type !== "message" || (entry.role !== "user" && entry.role !== "assistant")) {
        return;
      }
      const text = extractTextContent(entry.content);
      if (!text.trim()) return;
      messageCount += 1;

      if (firstTimestamp === undefined && typeof entry.timestamp === "number") {
        firstTimestamp = entry.timestamp;
      }

      if (entry.role === "user" && entry.cwd) {
        project = normalizePath(entry.cwd);
      }

      if (!title && entry.role === "user") {
        title = text.slice(0, 100);
      }

      if (searchBuilder) {
        appendSearchIndexEntry(searchBuilder, entry);
      }
    });

    if (messageCount === 0) {
      return null;
    }

    const subBadges = await this.buildSubAgentBadgeFor(subAgentName, parentSessionId, projectFolder);
    const meta: ConversationMeta = {
      id: `codebuddy:sub:${agentId.replace(/^agent-/, "")}`,
      provider: this.name,
      title: (subAgentName ? `${subAgentName}：` : "") + (title.replace(/<[^>]+>/g, "").trim() || "子会话"),
      project,
      projectKey: `${projectFolder}/${parentSessionId}`,
      projectId: canonicalizeProjectPath(project) || projectFolder,
      createdAt: firstTimestamp ?? fileStat.birthtimeMs,
      updatedAt: fileStat.mtimeMs,
      messageCount,
      fileSize: fileStat.size,
      filePath,
      contentStatus: "full",
      badges: subBadges,
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

  private async extractSearchIndex(filePath: string): Promise<{ searchText?: string; searchChunks?: string[] }> {
    const builder = createConversationSearchIndexBuilder();
    await visitJsonl<CodeBuddyEntry>(filePath, (entry) => {
      appendSearchIndexEntry(builder, entry);
    });
    return builder.build();
  }

  private async extractMeta(filePath: string): Promise<ConversationMeta | null> {
    const fileStat = await stat(filePath);
    if (this.isSubAgentFile(filePath)) {
      const item = await this.scanSubAgentFile(filePath, fileStat, false);
      return item?.meta ?? null;
    }

    const normalized = filePath.replace(/\\/g, "/");
    const pathParts = normalized.split("/");
    const projectFolder = pathParts[pathParts.length - 2] || "";
    const cached = getCached(filePath, fileStat.mtimeMs);
    if (cached && cached.projectKey === projectFolder) return cached;

    const headEntries = await parseJsonlHead<CodeBuddyEntry>(filePath, 30);
    const headMessages = headEntries.filter(
      (e) => e.type === "message" && (e.role === "user" || e.role === "assistant")
    );

    if (headMessages.length === 0) {
      const msgCount = await countLines(
        filePath,
        (value) => {
          if (!value || typeof value !== "object") return false;
          const entry = value as CodeBuddyEntry;
          return entry.type === "message" && (entry.role === "user" || entry.role === "assistant");
        },
        {
          fastIncludes: ['"type":"message"'],
        }
      );
      if (msgCount === 0) return null;
    }

    const fileName = filePath.split(/[/\\]/).pop()!;
    const sessionId = fileName.replace(/\.jsonl$/, "");

    const namedTitle = headEntries.find(
      (e) => e.type === "ai-title" && typeof e.aiTitle === "string" && e.aiTitle.trim()
    )?.aiTitle?.trim();

    const firstUserEntry = headEntries.find((e) => e.type === "message" && e.role === "user" && e.cwd);
    const project = firstUserEntry?.cwd
      ? normalizePath(firstUserEntry.cwd)
      : projectFolder;
    const projectKey = projectFolder;

    const firstUserMsg = headMessages.find((e) => {
      if (e.role !== "user") return false;
      const text = extractTextContent(e.content);
      if (!text.trim() || text.trim().startsWith("<system-reminder")) return false;
      return true;
    });
    const title = namedTitle
      ?? (firstUserMsg ? extractTextContent(firstUserMsg.content).slice(0, 100) : "未知对话");

    const firstEntry = headEntries.find((e) => typeof e.timestamp === "number")
      ?? headMessages[0];
    const firstTs = (firstEntry && typeof firstEntry.timestamp === "number")
      ? firstEntry.timestamp
      : fileStat.birthtimeMs;

    const messageCount = await countLines(
      filePath,
      (value) => {
        if (!value || typeof value !== "object") return false;
        const entry = value as CodeBuddyEntry;
        return entry.type === "message" && (entry.role === "user" || entry.role === "assistant");
      },
      {
        fastIncludes: ['"type":"message"'],
      }
    );

    const subLinks = await collectSubAgentLinks(filePath);
    const parentBadges = await this.buildParentBadgeFor(subLinks);

    const meta: ConversationMeta = {
      id: `codebuddy:${sessionId}`,
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
      badges: parentBadges,
    };

    setCache(filePath, fileStat.mtimeMs, meta);
    return meta;
  }

  private async findConversationFilePath(sessionId: string): Promise<string> {
    const basePath = this.getStoragePath();
    const subMatch = /^sub:(.+)$/.exec(sessionId);
    if (subMatch?.[1]) {
      const agentHex = subMatch[1].replace(/^agent-/, "");
      const pattern = join(basePath, "*", "*", "subagents", `agent-${agentHex}.jsonl`).replace(/\\/g, "/");
      const files = [...new Set((await glob(pattern)).map((item) => item.replace(/\\/g, "/")))];
      if (files.length === 0) {
        throw new Error(`对话不存在: codebuddy:${sessionId}`);
      }
      if (files.length > 1) {
        throw new Error(`定位到多个同名对话文件: codebuddy:${sessionId}`);
      }
      return files[0]!;
    }
    const pattern = join(basePath, "*", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = [...new Set((await glob(pattern)).map((item) => item.replace(/\\/g, "/")))];
    if (files.length === 0) {
      throw new Error(`对话不存在: codebuddy:${sessionId}`);
    }
    if (files.length > 1) {
      throw new Error(`定位到多个同名对话文件: codebuddy:${sessionId}`);
    }
    return files[0]!;
  }

  private invalidateConversationCaches(filePath: string): void {
    invalidateCache(filePath);
    invalidateMessageActionIndex(filePath);
    invalidateListCache(getListCacheKey(this.name, this.getStoragePath()));
  }

  async read(id: string, options?: ConversationReadOptions): Promise<Conversation> {
    const sessionId = id.replace("codebuddy:", "");
    const filePath = await this.findConversationFilePath(sessionId);
    const fileStat = await stat(filePath);

    const limit = options?.limit;
    const before = options?.before ?? 0;
    const shouldWindowRead = !!limit && limit > 0;
    const requiredMessages = shouldWindowRead ? before + limit + 1 : 0;

    const entries = shouldWindowRead
      ? await parseJsonlTailWithMeta<CodeBuddyEntry>(filePath, {
          bytesHint: Math.max(256 * 1024, fileStat.size > 0 ? Math.min(fileStat.size, (before + limit) * 4096) : 256 * 1024),
          maxBytes: fileStat.size,
          isEnough: (tailEntries) => buildMessageRecords(tailEntries).length >= requiredMessages,
        })
      : await parseJsonlWithMeta<CodeBuddyEntry>(filePath);
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
    const sessionId = id.replace("codebuddy:", "");
    if (sessionId.startsWith("sub:")) {
      // 子会话删除仅删除自身文件，通过主会话列表徽标自然消失
      const filePath = await this.findConversationFilePath(sessionId);
      await unlink(filePath);
      this.invalidateConversationCaches(filePath);
      await removeEmptyParentDirs(filePath, this.getStoragePath());
      return;
    }
    const filePath = await this.findConversationFilePath(sessionId);
    await unlink(filePath);
    // 主会话删除时连带同名子目录（subagents/tool-results）
    const siblingDir = filePath.replace(/\.jsonl$/, "");
    try {
      await rm(siblingDir, { recursive: true, force: true });
    } catch {
      // 同名目录不存在时忽略
    }
    this.invalidateConversationCaches(filePath);
    await removeEmptyParentDirs(siblingDir, this.getStoragePath());
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("codebuddy:", "");
    if (sessionId.startsWith("sub:")) {
      throw new Error("子会话不支持单独移动，请移动其父会话");
    }
    const basePath = this.getStoragePath();
    const srcFile = await this.findConversationFilePath(sessionId);
    const fileName = srcFile.split(/[/\\]/).pop()!;
    const { targetProjectDir } = resolveProjectDirectory(basePath, targetProjectKey);
    await mkdir(targetProjectDir, { recursive: true });
    const destFile = join(targetProjectDir, fileName);
    if (await stat(destFile).then(() => true, () => false)) {
      throw new Error(`目标目录已存在同名 transcript: ${destFile}`);
    }

    if (srcFile.replace(/\\/g, "/") === destFile.replace(/\\/g, "/")) return;
    await rename(srcFile, destFile);
    // 连带移动同名子目录；搬移失败时回滚主文件，避免会话与附属数据分裂
    const srcDir = srcFile.replace(/\.jsonl$/, "");
    const destDir = destFile.replace(/\.jsonl$/, "");
    const hasSideDir = await stat(srcDir).then((entry) => entry.isDirectory(), () => false);
    if (hasSideDir) {
      try {
        await rename(srcDir, destDir);
      } catch (error) {
        await rename(destFile, srcFile).catch(() => {
          // 回滚失败时仍抛出搬移错误，由用户重试恢复
        });
        throw error;
      }
    }
    this.invalidateConversationCaches(srcFile);
  }

  async updateTitle(id: string, title: string): Promise<void> {
    if (!id.startsWith("codebuddy:")) {
      throw new Error("仅支持修改 CodeBuddy 对话标题");
    }
    const sessionId = id.replace("codebuddy:", "");
    if (sessionId.startsWith("sub:")) {
      throw new Error("子会话标题跟随父会话，不支持单独修改");
    }
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error("标题不能为空");
    }

    await runKeyedMutation(`codebuddy-title:${sessionId}`, async () => {
      const filePath = await this.findConversationFilePath(sessionId);
      const fileStat = await stat(filePath);
      const entries = await parseJsonlWithMeta<CodeBuddyEntry>(filePath);
      const titleEntry = entries.find((entry) => entry.value.type === "ai-title");

      if (titleEntry?.lineNumber) {
        await rewriteJsonlFileLine(
          filePath,
          titleEntry.lineNumber,
          (line) => {
            const entry = JSON.parse(line) as CodeBuddyEntry;
            if (entry.type !== "ai-title") {
              throw new Error(`标题行已被其他操作修改: ${sessionId}`);
            }
            return JSON.stringify({ ...entry, aiTitle: normalizedTitle });
          },
          { mtimeMs: fileStat.mtimeMs, size: fileStat.size }
        );
      } else {
        const firstEntry = entries[0]?.value;
        const line = JSON.stringify({
          id: `title-${Date.now().toString(36)}`,
          timestamp: Date.now(),
          type: "ai-title",
          aiTitle: normalizedTitle,
          sessionId,
          cwd: firstEntry?.cwd,
        });
        await appendFile(filePath, `\n${line}`, { encoding: "utf-8" });
      }

      const verifyEntries = await parseJsonlWithMeta<CodeBuddyEntry>(filePath);
      const stored = [...verifyEntries].reverse().find((entry) => entry.value.type === "ai-title");
      if (!stored || (stored.value.aiTitle ?? "").trim() !== normalizedTitle) {
        throw new Error(`CodeBuddy 原生标题写入校验失败：期望“${normalizedTitle}”`);
      }
      this.invalidateConversationCaches(filePath);
    });
  }

  async updateMessage(id: string, messageId: string, content: string): Promise<void> {
    const filePath = await this.findConversationFilePath(id.replace("codebuddy:", ""));
    const fileStat = await stat(filePath);
    const [lineNumber] = await resolveMessageLineNumbers<CodeBuddyEntry>(filePath, fileStat.mtimeMs, [messageId], buildMessageRecords);
    const normalizedContent = normalizeUpdatedMessageContent(content);
    await rewriteJsonlFileLine(
      filePath,
      lineNumber,
      (line) => {
        const entry = JSON.parse(line) as CodeBuddyEntry;
        if (entry.type !== "message" || (entry.role !== "user" && entry.role !== "assistant")) {
          throw new Error(`消息不存在: ${messageId}`);
        }
        const blockType = entry.role === "user" ? "input_text" : "output_text";
        const nextEntry: CodeBuddyEntry = {
          ...entry,
          content: [{ type: blockType, text: normalizedContent }],
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
    const filePath = await this.findConversationFilePath(id.replace("codebuddy:", ""));
    const fileStat = await stat(filePath);
    const uniqueMessageIds = [...new Set(messageIds.map((item) => item.trim()).filter(Boolean))];
    if (uniqueMessageIds.length === 0) {
      throw new Error("待删除消息不能为空");
    }
    const lineNumbers = await resolveMessageLineNumbers<CodeBuddyEntry>(filePath, fileStat.mtimeMs, uniqueMessageIds, buildMessageRecords);
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
      throw createProviderDataError(this.name, `CodeBuddy 项目目录无法读取: ${basePath}`, error);
    }
  }
}
