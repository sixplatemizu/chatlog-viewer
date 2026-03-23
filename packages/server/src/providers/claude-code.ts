import { homedir } from "os";
import { join } from "path";
import { stat, readdir, unlink, rename, mkdir } from "fs/promises";
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

interface ClaudeCodeEntry {
  type: string;
  subtype?: string;
  uuid?: string;
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
}

function extractTextContent(
  content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

function extractToolCalls(
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
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

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function getListCacheKey(providerName: string, storagePath: string): string {
  return `${providerName}::${storagePath}`;
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

function buildMessages(entries: ClaudeCodeEntry[]): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    if (entry.isSidechain || entry.isMeta) continue;
    if (!entry.message) continue;
    if (entry.type === "system") continue;

    if (entry.type === "user") {
      const text = extractTextContent(entry.message.content);
      if (!text.trim() || text.includes("<local-command-") || text.includes("<command-name>") || text.includes("<local-command-stdout>")) continue;
      const cleanText = text.replace(/<[^>]+>/g, "").trim();
      if (!cleanText) continue;
      messages.push({
        role: "user",
        content: cleanText,
        timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : undefined,
      });
    } else if (entry.type === "assistant") {
      const text = extractTextContent(entry.message.content);
      if (text.trim() && !text.startsWith("No response requested")) {
        messages.push({
          role: "assistant",
          content: text,
          timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : undefined,
        });
      }
      if (Array.isArray(entry.message.content)) {
        const tools = extractToolCalls(entry.message.content);
        messages.push(...tools);
      }
    }
  }

  return messages;
}

export class ClaudeCodeProvider implements ConversationProvider {
  name = "claude-code";
  displayName = "Claude Code";

  getStoragePath(): string {
    return join(homedir(), ".claude", "projects");
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
    const pattern = join(basePath, "*", "*.jsonl").replace(/\\/g, "/");
    const files = await glob(pattern);
    const cacheKey = getListCacheKey(this.name, basePath);
    const signature = await buildListSignature(files);
    const cachedList = getListCache(cacheKey, signature);
    if (cachedList) {
      return [...cachedList].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    // 并发提取元数据（限制并发数）
    const results: ConversationMeta[] = [];
    const batchSize = 20;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const metas = await Promise.all(
        batch.map((f) => this.extractMeta(f).catch(() => null))
      );
      for (const m of metas) {
        if (m) results.push(m);
      }
    }

    setListCache(cacheKey, signature, results);
    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async extractMeta(filePath: string): Promise<ConversationMeta | null> {
    const fileStat = await stat(filePath);

    // 缓存命中
    const cached = getCached(filePath, fileStat.mtimeMs);
    if (cached) return cached;

    // 只读前 40 行提取标题和 cwd
    const headEntries = await parseJsonlHead<ClaudeCodeEntry>(filePath, 40);
    const headMessages = headEntries.filter(
      (e) =>
        (e.type === "user" || e.type === "assistant") &&
        !e.isMeta && !e.isSidechain && e.message
    );

    // 如果头部完全没有消息，可能是空会话或只有系统消息
    // 用快速行计数确认
    if (headMessages.length === 0) {
      const msgCount = await countLines(filePath, ['"type":"user"', '"type":"assistant"']);
      if (msgCount === 0) return null;
    }

    const fileName = filePath.split(/[/\\]/).pop()!;
    const sessionId = fileName.replace(".jsonl", "");

    const pathParts = filePath.replace(/\\/g, "/").split("/");
    const projectFolder = pathParts[pathParts.length - 2] || "";

    const firstUserEntry = headEntries.find((e) => e.type === "user" && e.cwd);
    const project = firstUserEntry?.cwd
      ? normalizePath(firstUserEntry.cwd)
      : projectFolder;

    // 标题
    const firstUserMsg = headMessages.find((e) => {
      if (e.type !== "user" || !e.message) return false;
      const text = extractTextContent(e.message.content);
      if (!text.trim() || text.startsWith("/") || text.includes("<command-name>") || text.includes("<local-command-")) return false;
      return true;
    });
    const title = firstUserMsg
      ? extractTextContent(firstUserMsg.message!.content).slice(0, 100)
      : "未知对话";

    // 时间：用 stat 代替解析最后一行
    const firstTs = headMessages[0]?.timestamp
      ? new Date(headMessages[0].timestamp).getTime()
      : fileStat.birthtimeMs;

    // 消息数：快速行计数
    const messageCount = await countLines(filePath, ['"type":"user"', '"type":"assistant"']);

    const meta: ConversationMeta = {
      id: `claude-code:${sessionId}`,
      provider: this.name,
      title: title.replace(/<[^>]+>/g, "").trim() || "未知对话",
      project,
      projectKey: projectFolder,
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
    const sessionId = id.replace("claude-code:", "");
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

    // read 时默认全量解析，详情页可通过窗口模式只取最近一段
    const entries = shouldWindowRead
      ? await parseJsonlTail<ClaudeCodeEntry>(filePath, {
          bytesHint: Math.max(256 * 1024, fileStat.size > 0 ? Math.min(fileStat.size, (before + limit) * 4096) : 256 * 1024),
          maxBytes: fileStat.size,
          isEnough: (tailEntries) => buildMessages(tailEntries).length >= requiredMessages,
        })
      : await parseJsonl<ClaudeCodeEntry>(filePath);
    const messages = buildMessages(entries);

    const meta = await this.extractMeta(filePath);
    if (!meta) throw new Error(`无法解析对话元数据: ${id}`);

    const { items: windowedMessages, hasMore } = sliceWindow(messages, options);

    return { ...meta, messages: windowedMessages, hasMore };
  }

  async delete(id: string): Promise<void> {
    const sessionId = id.replace("claude-code:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "*", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    if (files.length === 0) throw new Error(`对话不存在: ${id}`);
    invalidateListCache(getListCacheKey(this.name, basePath));
    invalidateCache(files[0]);
    await unlink(files[0]);
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("claude-code:", "");
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
