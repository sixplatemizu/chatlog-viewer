import { join } from "path";
import { stat, unlink, rename, mkdir, readdir } from "fs/promises";
import { glob } from "glob";
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

function extractTextContent(
  content: string | Array<{ type: string; text?: string }>
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

function buildMessages(entries: IFlowEntry[]): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    if (entry.isSidechain || !entry.message) continue;

    if (entry.type === "user") {
      const text = extractTextContent(entry.message.content);
      if (!text.trim()) continue;
      messages.push({
        role: "user",
        content: text,
        timestamp: new Date(entry.timestamp).getTime(),
      });
    } else if (entry.type === "assistant") {
      const text = extractTextContent(entry.message.content);
      if (text.trim()) {
        messages.push({
          role: "assistant",
          content: text,
          timestamp: new Date(entry.timestamp).getTime(),
        });
      }
      if (Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === "tool_use") {
            messages.push({
              role: "tool",
              content: "",
              toolName: (block as { name?: string }).name || "unknown",
              toolInput: JSON.stringify((block as { input?: unknown }).input, null, 2),
            });
          }
        }
      }
    }
  }

  return messages;
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

    const metas = await Promise.all(
      filesToRefresh.map(async (f) => {
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

    const normalizedResults = this.applyProjectDisplayPathHints(results);

    const searchReady = options.eagerSearchIndex || filesToRefresh.length === 0;
    setIndexedListCache(cacheKey, normalizedResults, { searchReady });

    if (!searchReady && options.allowBackground) {
      this.scheduleBackgroundIndexRefresh();
    }

    return normalizedResults.map((item) => item.meta).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private applyProjectDisplayPathHints(
    items: Array<{ meta: ConversationMeta; searchText?: string }>
  ): Array<{ meta: ConversationMeta; searchText?: string }> {
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

  private async extractSearchText(filePath: string): Promise<string | undefined> {
    const fileStat = await stat(filePath);
    const entries = fileStat.size > 512 * 1024
      ? await parseJsonlWindow<IFlowEntry>(filePath, getAdaptiveSearchWindowOptions(fileStat.size))
      : await parseJsonl<IFlowEntry>(filePath);
    return buildConversationSearchText(buildMessages(entries));
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

  async read(id: string, options?: ConversationReadOptions): Promise<Conversation> {
    const sessionId = id.replace("iflow:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "*", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);

    if (files.length === 0) throw new Error(`对话不存在: ${id}`);
    const filePath = files[0];
    const fileStat = await stat(filePath);

    const limit = options?.limit;
    const before = options?.before ?? 0;
    const shouldWindowRead = !!limit && limit > 0;
    const requiredMessages = shouldWindowRead ? before + limit + 1 : 0;

    const entries = shouldWindowRead
      ? await parseJsonlTail<IFlowEntry>(filePath, {
          bytesHint: Math.max(256 * 1024, fileStat.size > 0 ? Math.min(fileStat.size, (before + limit) * 4096) : 256 * 1024),
          maxBytes: fileStat.size,
          isEnough: (tailEntries) => buildMessages(tailEntries).length >= requiredMessages,
        })
      : await parseJsonl<IFlowEntry>(filePath);
    const messages = buildMessages(entries);

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
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "*", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    if (files.length === 0) throw new Error(`对话不存在: ${id}`);
    invalidateListCache(getListCacheKey(this.name, basePath));
    invalidateCache(files[0]);
    await unlink(files[0]);
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("iflow:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "*", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    if (files.length === 0) throw new Error(`对话不存在: ${id}`);

    const srcFile = files[0];
    invalidateListCache(getListCacheKey(this.name, basePath));
    invalidateCache(srcFile);
    const fileName = srcFile.split(/[/\\]/).pop()!;
    const targetDir = join(basePath, targetProjectKey);
    await mkdir(targetDir, { recursive: true });
    const destFile = join(targetDir, fileName);

    if (srcFile.replace(/\\/g, "/") === destFile.replace(/\\/g, "/")) return;
    await rename(srcFile, destFile);
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
