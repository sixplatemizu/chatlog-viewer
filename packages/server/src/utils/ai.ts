import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Message } from "../providers/types.js";

const execAsync = promisify(exec);

interface CliTool {
  name: string;
  command: string;
  buildCmd: (promptFile: string, continueSession: boolean) => string;
}

const CLI_TOOLS: CliTool[] = [
  {
    name: "iflow",
    command: "iflow",
    buildCmd: (f, c) => `cat "${f}" | iflow${c ? " -c" : ""} -p ""`,
  },
  {
    name: "claude",
    command: "claude",
    buildCmd: (f, c) => `cat "${f}" | claude${c ? " -c" : ""} -p ""`,
  },
  {
    name: "codex",
    command: "codex",
    buildCmd: (f, _c) => `cat "${f}" | codex exec -`,
  },
];

// 会话状态：记录每个 CLI 工具是否已有活跃会话
const activeSession = new Map<string, boolean>();

// 检测哪些 CLI 可用
async function detectAvailableCli(): Promise<CliTool[]> {
  const available: CliTool[] = [];
  for (const tool of CLI_TOOLS) {
    try {
      await execAsync(`where ${tool.command}`, { timeout: 5000 });
      available.push(tool);
    } catch {
      // 不可用
    }
  }
  return available;
}

// 从消息中构建摘要上下文（取最新的几轮对话）
function buildContext(messages: Message[], maxChars = 2000): string {
  const lines: string[] = [];
  let charCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "tool") continue;
    const roleLabel = msg.role === "user" ? "用户" : "助手";
    const text = msg.content.slice(0, 500);
    const line = `${roleLabel}: ${text}`;

    if (charCount + line.length > maxChars) break;
    lines.unshift(line);
    charCount += line.length;
  }

  return lines.join("\n");
}

// 从 CLI 输出中提取纯文本
function extractCleanOutput(stdout: string): string {
  let clean = stdout.replace(/<Execution Info>[\s\S]*/m, "").trim();
  clean = clean.replace(/\x1b\[[0-9;]*m/g, "");
  clean = clean.replace(/^["'「]|["'」]$/g, "");
  const firstLine = clean.split("\n")[0]?.trim() || clean;
  return firstLine;
}

const INSTRUCTION = "请为以下AI对话生成一个简短的中文标题（10-20个字），准确概括对话主题，只输出标题本身，不要加引号或其他格式：\n\n";

export async function generateTitle(messages: Message[]): Promise<{
  title: string;
  usedCli: string;
}> {
  const tools = await detectAvailableCli();
  if (tools.length === 0) {
    throw new Error("没有可用的 AI CLI 工具（需要 iflow、claude 或 codex）");
  }

  const context = buildContext(messages);
  const fullPrompt = INSTRUCTION + context;

  const tmpDir = await mkdtemp(join(tmpdir(), "chatlog-"));
  const promptFile = join(tmpDir, "prompt.txt").replace(/\\/g, "/");
  await writeFile(promptFile, fullPrompt, "utf-8");

  try {
    for (const tool of tools) {
      try {
        const hasSession = activeSession.get(tool.name) || false;
        const cmd = tool.buildCmd(promptFile, hasSession);
        console.log(`[AI] 调用 ${tool.name}${hasSession ? " (续用会话)" : " (新建会话)"}: ${cmd.slice(0, 80)}...`);

        const { stdout } = await execAsync(cmd, {
          timeout: 60000,
          encoding: "utf-8",
          env: { ...process.env },
        });

        const title = extractCleanOutput(stdout);
        console.log(`[AI] ${tool.name} 输出: "${title}"`);
        if (title && title.length > 0 && title.length < 100) {
          // 标记会话已建立
          activeSession.set(tool.name, true);
          return { title, usedCli: tool.name };
        }
      } catch (e) {
        console.error(`${tool.name} 生成标题失败:`, (e as Error).message);
        // 失败后重置会话状态，下次新建
        activeSession.delete(tool.name);
      }
    }
  } finally {
    try { await unlink(promptFile); } catch {}
  }

  throw new Error("所有 AI CLI 工具均未能生成有效标题");
}

// 重置会话（允许前端在需要时调用）
export function resetSession(toolName?: string) {
  if (toolName) {
    activeSession.delete(toolName);
  } else {
    activeSession.clear();
  }
}

// 获取可用的 CLI 列表和会话状态
export async function getAvailableClis(): Promise<{ name: string; hasSession: boolean }[]> {
  const tools = await detectAvailableCli();
  return tools.map((t) => ({
    name: t.name,
    hasSession: activeSession.get(t.name) || false,
  }));
}
