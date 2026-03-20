import { homedir } from "os";
import { join } from "path";
import { stat, readdir, unlink, rename, mkdir } from "fs/promises";
import { glob } from "glob";
import { parseJsonl } from "../utils/jsonl.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
  Message,
} from "./types.js";

// Claude Code JSONL 行的类型
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
  toolUseID?: string;
  toolResult?: unknown;
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

// 归一化路径：统一为正斜杠，去掉末尾斜杠
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
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

    const results: ConversationMeta[] = [];
    for (const filePath of files) {
      try {
        const meta = await this.extractMeta(filePath);
        if (meta) results.push(meta);
      } catch {
        // 跳过无法解析的文件
      }
    }
    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async extractMeta(filePath: string): Promise<ConversationMeta | null> {
    const entries = await parseJsonl<ClaudeCodeEntry>(filePath);
    const messages = entries.filter(
      (e) =>
        (e.type === "user" || e.type === "assistant") &&
        !e.isMeta &&
        !e.isSidechain &&
        e.message
    );

    if (messages.length === 0) return null;

    // 文件名即 sessionId
    const fileName = filePath.split(/[/\\]/).pop()!;
    const sessionId = fileName.replace(".jsonl", "");

    // 项目分组 key：文件夹名（保证同项目归到一起）
    const pathParts = filePath.replace(/\\/g, "/").split("/");
    const projectFolder = pathParts[pathParts.length - 2] || "";

    // 显示路径：优先用第一条 user entry 的 cwd（精确），fallback 到文件夹名
    const firstUserEntry = entries.find((e) => e.type === "user" && e.cwd);
    const project = firstUserEntry?.cwd
      ? normalizePath(firstUserEntry.cwd)
      : projectFolder;

    // 标题取首条有效用户消息（跳过命令和空消息）
    const firstUserMsg = messages.find((e) => {
      if (e.type !== "user" || !e.message) return false;
      const text = extractTextContent(e.message.content);
      // 跳过斜杠命令、空消息、系统命令标记
      if (!text.trim() || text.startsWith("/") || text.includes("<command-name>") || text.includes("<local-command-")) return false;
      return true;
    });
    const title = firstUserMsg
      ? extractTextContent(firstUserMsg.message!.content).slice(0, 100)
      : "未知对话";

    // 时间
    const fileStat = await stat(filePath);
    const firstTs = messages[0]?.timestamp
      ? new Date(messages[0].timestamp).getTime()
      : fileStat.birthtimeMs;
    const lastTs = messages[messages.length - 1]?.timestamp
      ? new Date(messages[messages.length - 1].timestamp!).getTime()
      : fileStat.mtimeMs;

    return {
      id: `claude-code:${sessionId}`,
      provider: this.name,
      title: title.replace(/<[^>]+>/g, "").trim() || "未知对话",
      project,
      projectKey: projectFolder,
      createdAt: firstTs,
      updatedAt: lastTs,
      messageCount: messages.length,
      filePath,
    };
  }

  async read(id: string): Promise<Conversation> {
    const sessionId = id.replace("claude-code:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "*", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);

    if (files.length === 0) throw new Error(`对话不存在: ${id}`);
    const filePath = files[0];

    const entries = await parseJsonl<ClaudeCodeEntry>(filePath);
    const messages: Message[] = [];

    for (const entry of entries) {
      if (entry.isSidechain || entry.isMeta) continue;
      if (!entry.message) continue;
      // 跳过系统类型消息（local_command 等）
      if (entry.type === "system") continue;

      if (entry.type === "user") {
        const text = extractTextContent(entry.message.content);
        // 跳过空消息、系统命令、斜杠命令
        if (!text.trim() || text.includes("<local-command-") || text.includes("<command-name>") || text.includes("<local-command-stdout>")) continue;
        // 清理 XML 标签
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
        // tool calls
        if (Array.isArray(entry.message.content)) {
          const tools = extractToolCalls(entry.message.content);
          messages.push(...tools);
        }
      }
    }

    const meta = await this.extractMeta(filePath);
    if (!meta) throw new Error(`无法解析对话元数据: ${id}`);

    return { ...meta, messages };
  }

  async delete(id: string): Promise<void> {
    const sessionId = id.replace("claude-code:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "*", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    if (files.length === 0) throw new Error(`对话不存在: ${id}`);
    await unlink(files[0]);
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("claude-code:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "*", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    if (files.length === 0) throw new Error(`对话不存在: ${id}`);

    const srcFile = files[0];
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
