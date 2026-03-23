import { homedir } from "os";
import { join } from "path";
import { stat, unlink, rename, mkdir, readdir } from "fs/promises";
import { glob } from "glob";
import { parseJsonl, parseJsonlHead, parseJsonlTail, countLines } from "../utils/jsonl.js";
import { getCached, getListCache, setCache, setListCache, invalidateCache, invalidateListCache } from "../utils/cache.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
  Message,
  ConversationReadOptions,
} from "./types.js";

const IFLOW_LIST_CACHE_VERSION = "v2";

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
  return `${providerName}::${storagePath}::${IFLOW_LIST_CACHE_VERSION}`;
}

async function buildListSignature(files: string[]): Promise<string> {
  let mtimeSum = 0;
  for (const file of files) {
    try {
      const fileStat = await stat(file);
      mtimeSum += fileStat.mtimeMs;
    } catch {
      // 忽略单文件异常，签名仍然变化
    }
  }
  return `${files.length}:${mtimeSum}`;
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

  getStoragePath(): string {
    return join(homedir(), ".iflow", "projects");
  }

  async detect(): Promise<boolean> {
    try {
      await stat(this.getStoragePath());
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<ConversationMeta[]> {
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "*", "session-*.jsonl").replace(/\\/g, "/");
    const files = await glob(pattern);
    const cacheKey = getListCacheKey(this.name, basePath);
    const signature = await buildListSignature(files);
    const cachedList = getListCache(cacheKey, signature);
    if (cachedList) {
      return [...cachedList].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    const results: ConversationMeta[] = [];
    const metas = await Promise.all(
      files.map((f) => this.extractMeta(f).catch(() => null))
    );
    for (const m of metas) {
      if (m) results.push(m);
    }

    const normalizedResults = this.applyProjectDisplayPathHints(results);

    setListCache(cacheKey, signature, normalizedResults);
    return normalizedResults.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private applyProjectDisplayPathHints(items: ConversationMeta[]): ConversationMeta[] {
    const bestProjectByKey = new Map<string, string>();

    for (const item of items) {
      const projectKey = item.projectKey || item.project || "";
      const candidate = item.project || projectKey;
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
      const projectKey = item.projectKey || item.project || "";
      const preferredProject = bestProjectByKey.get(projectKey);
      if (!preferredProject) return item;

      const currentScore = getProjectSpecificity(item.project, projectKey);
      const preferredScore = getProjectSpecificity(preferredProject, projectKey);
      if (preferredScore <= currentScore) return item;

      const updatedMeta = {
        ...item,
        project: preferredProject,
      };
      setCache(item.filePath, item.updatedAt, updatedMeta);
      return updatedMeta;
    });
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
      const msgCount = await countLines(filePath, ['"type":"user"', '"type":"assistant"']);
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

    const messageCount = await countLines(filePath, ['"type":"user"', '"type":"assistant"']);

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
