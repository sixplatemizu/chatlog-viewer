import { homedir } from "os";
import { join } from "path";
import { stat, unlink, rename, mkdir, readdir } from "fs/promises";
import { glob } from "glob";
import { parseJsonl } from "../utils/jsonl.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
  Message,
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

    const results: ConversationMeta[] = [];
    for (const filePath of files) {
      try {
        const meta = await this.extractMeta(filePath);
        if (meta) results.push(meta);
      } catch {
        // 跳过
      }
    }
    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async extractMeta(filePath: string): Promise<ConversationMeta | null> {
    const entries = await parseJsonl<IFlowEntry>(filePath);
    const messages = entries.filter(
      (e) => (e.type === "user" || e.type === "assistant") && e.message && !e.isSidechain
    );

    if (messages.length === 0) return null;

    const fileName = filePath.split(/[/\\]/).pop()!;
    const sessionId = fileName.replace(".jsonl", "");

    // 项目分组 key：文件夹名
    const pathParts = filePath.replace(/\\/g, "/").split("/");
    const projectFolder = pathParts[pathParts.length - 2] || "";

    // 显示路径：优先用第一条 user entry 的 cwd
    const firstUserEntry = entries.find((e) => e.type === "user" && e.cwd);
    const project = firstUserEntry?.cwd
      ? normalizePath(firstUserEntry.cwd)
      : projectFolder;

    const firstUserMsg = messages.find((e) => {
      if (e.type !== "user" || !e.message) return false;
      const text = extractTextContent(e.message.content);
      if (!text.trim() || text.startsWith("/")) return false;
      return true;
    });
    const title = firstUserMsg
      ? extractTextContent(firstUserMsg.message.content).slice(0, 100)
      : "未知对话";

    const firstTs = new Date(messages[0].timestamp).getTime();
    const lastTs = new Date(messages[messages.length - 1].timestamp).getTime();

    return {
      id: `iflow:${sessionId}`,
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
    const sessionId = id.replace("iflow:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "*", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);

    if (files.length === 0) throw new Error(`对话不存在: ${id}`);
    const filePath = files[0];

    const entries = await parseJsonl<IFlowEntry>(filePath);
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
        // tool calls
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

    const meta = await this.extractMeta(filePath);
    if (!meta) throw new Error(`无法解析对话元数据: ${id}`);

    return { ...meta, messages };
  }

  async delete(id: string): Promise<void> {
    const sessionId = id.replace("iflow:", "");
    const basePath = this.getStoragePath();
    const pattern = join(basePath, "*", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = await glob(pattern);
    if (files.length === 0) throw new Error(`对话不存在: ${id}`);
    await unlink(files[0]);
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("iflow:", "");
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
