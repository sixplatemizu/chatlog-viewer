import { homedir } from "os";
import { join } from "path";
import { stat, unlink, readFile, writeFile } from "fs/promises";
import { glob } from "glob";
import { parseJsonl, parseJsonlHead, countLines } from "../utils/jsonl.js";
import { getCached, setCache, invalidateCache } from "../utils/cache.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
  Message,
} from "./types.js";

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

export class CodexProvider implements ConversationProvider {
  name = "codex";
  displayName = "Codex";

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
    };

    setCache(filePath, fileStat.mtimeMs, meta);
    return meta;
  }

  async read(id: string): Promise<Conversation> {
    const sessionId = id.replace("codex:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "**", `*${sessionId}*.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);

    if (files.length === 0) throw new Error(`对话不存在: ${id}`);
    const filePath = files[0];

    const entries = await parseJsonl<CodexEntry>(filePath);
    const messages: Message[] = [];

    for (const entry of entries) {
      if (entry.type === "response_item" && entry.payload?.role) {
        const role = entry.payload.role as "user" | "assistant";
        if (role !== "user" && role !== "assistant") continue;

        const content = entry.payload.content
          ? extractContent(entry.payload.content)
          : "";
        // 跳过 environment_context 等系统消息
        if (content.includes("<environment_context>")) continue;
        if (!content.trim()) continue;

        messages.push({
          role,
          content,
          timestamp: new Date(entry.timestamp).getTime(),
        });
      } else if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
        // event_msg 类型的用户消息 - 避免与 response_item 重复
        // 只在没有对应 response_item 时使用
      }
    }

    const meta = await this.extractMeta(filePath);
    if (!meta) throw new Error(`无法解析对话元数据: ${id}`);

    return { ...meta, messages };
  }

  async delete(id: string): Promise<void> {
    const sessionId = id.replace("codex:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "**", `*${sessionId}*.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    if (files.length === 0) throw new Error(`对话不存在: ${id}`);
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
    invalidateCache(filePath);
    // targetProjectKey 对 Codex 是一个归一化路径（如 C:/Users/mortis097/Desktop/code_area/r-bioinfo）
    // 需要把它还原为 Windows 路径写回 session_meta.payload.cwd
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
    // Codex 按 cwd 分组，从现有对话中收集所有不同的 cwd
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "**", "*.jsonl").replace(/\\/g, "/");
    const files = await glob(pattern);
    const cwds = new Set<string>();

    for (const filePath of files) {
      try {
        const entries = await parseJsonl<CodexEntry>(filePath);
        const meta = entries.find((e) => e.type === "session_meta");
        const cwd = meta?.payload?.cwd;
        if (cwd) cwds.add(cwd.replace(/\\/g, "/").replace(/\/+$/, ""));
      } catch {
        // 跳过
      }
    }
    return [...cwds];
  }
}
