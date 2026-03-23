import { homedir } from "os";
import { join } from "path";
import { stat, unlink, readFile, writeFile } from "fs/promises";
import { createRequire } from "module";
import { glob } from "glob";
import type BetterSqlite3 from "better-sqlite3";
import { parseJsonl, parseJsonlHead, parseJsonlTail, countLines } from "../utils/jsonl.js";
import { getCached, getListCache, setCache, setListCache, invalidateCache, invalidateListCache } from "../utils/cache.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
  Message,
  ConversationReadOptions,
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

function buildMessages(entries: CodexEntry[]): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    if (entry.type !== "response_item" || !entry.payload?.role) continue;

    const role = entry.payload.role as "user" | "assistant";
    if (role !== "user" && role !== "assistant") continue;

    const content = entry.payload.content
      ? extractContent(entry.payload.content)
      : "";
    if (content.includes("<environment_context>")) continue;
    if (!content.trim()) continue;

    messages.push({
      role,
      content,
      timestamp: new Date(entry.timestamp).getTime(),
    });
  }

  return messages;
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

export class CodexProvider implements ConversationProvider {
  name = "codex";
  displayName = "Codex";

  private db: BetterSqlite3.Database | null = null;

  private getDb(): BetterSqlite3.Database | null {
    if (this.db) return this.db;
    try {
      const dbPath = join(homedir(), ".codex", "state_5.sqlite");
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
      return this.db;
    } catch {
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
    return join(homedir(), ".codex", "sessions");
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
    const pattern = join(basePath, "**", "*.jsonl").replace(/\\/g, "/");
    const files = await glob(pattern);
    const cacheKey = getListCacheKey(this.name, basePath);
    const signature = await buildListSignature(files);
    const cachedList = getListCache(cacheKey, signature);
    if (cachedList) {
      return [...cachedList].sort((a, b) => b.updatedAt - a.updatedAt);
    }

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
    const messageCount = await countLines(filePath, ['"role":"user"', '"role":"assistant"']);
    if (messageCount === 0 && userMessages.length === 0) return null;

    const firstTs = new Date(headEntries[0].timestamp).getTime();
    const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");

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

  async read(id: string, options?: ConversationReadOptions): Promise<Conversation> {
    const sessionId = id.replace("codex:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "**", `*${sessionId}*.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);

    if (files.length === 0) throw new Error(`对话不存在: ${id}`);
    const filePath = files[0];
    const fileStat = await stat(filePath);

    const limit = options?.limit;
    const before = options?.before ?? 0;
    const shouldWindowRead = !!limit && limit > 0;
    const requiredMessages = shouldWindowRead ? before + limit + 1 : 0;

    const entries = shouldWindowRead
      ? await parseJsonlTail<CodexEntry>(filePath, {
          bytesHint: Math.max(256 * 1024, fileStat.size > 0 ? Math.min(fileStat.size, (before + limit) * 4096) : 256 * 1024),
          maxBytes: fileStat.size,
          isEnough: (tailEntries) => buildMessages(tailEntries).length >= requiredMessages,
        })
      : await parseJsonl<CodexEntry>(filePath);
    const messages = buildMessages(entries);

    const meta = await this.extractMeta(filePath);
    if (!meta) throw new Error(`无法解析对话元数据: ${id}`);

    const { items: windowedMessages, hasMore } = sliceWindow(messages, options);

    return { ...meta, messages: windowedMessages, hasMore };
  }

  async delete(id: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "**", `*${sessionId}*.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    if (files.length === 0) throw new Error(`对话不存在: ${id}`);
    invalidateListCache(getListCacheKey(this.name, basePath));
    invalidateCache(files[0]);
    await unlink(files[0]);
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "**", `*${sessionId}*.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    if (files.length === 0) throw new Error(`对话不存在: ${id}`);

    const filePath = files[0];
    invalidateListCache(getListCacheKey(this.name, basePath));
    invalidateCache(filePath);
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
        if (cwd) cwds.add(cwd.replace(/\\/g, "/").replace(/\/+$/, ""));
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
    const sessionId = id.replace("codex:", "");
    const dbPath = join(homedir(), ".codex", "state_5.sqlite");
    // 写操作需要新开一个可写连接
    const db = new Database(dbPath);
    try {
      const result = db.prepare("UPDATE threads SET model_provider = ? WHERE id = ?").run(newProvider, sessionId);
      if (result.changes === 0) throw new Error(`SQLite 中未找到对话: ${sessionId}`);
    } finally {
      db.close();
    }

    // 清除文件缓存（缓存 key 是文件路径，不是对话 ID）
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "**", `*${sessionId}*.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    for (const f of files) invalidateCache(f);
    invalidateListCache(getListCacheKey(this.name, basePath));
  }
}
