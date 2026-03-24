import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, mkdir } from "fs/promises";
import { homedir } from "os";
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

// 固定的工作目录，确保 -c 能续用同一会话
const WORK_DIR = join(homedir(), ".chatlog-viewer", "ai-work");

// 会话状态
const activeSession = new Map<string, boolean>();

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

function extractCleanOutput(stdout: string): string {
  const ansiEscape = String.fromCharCode(27);
  let clean = stdout.replace(/<Execution Info>[\s\S]*/m, "").trim();
  clean = clean.replace(new RegExp(`${ansiEscape}\\[[0-9;]*m`, "g"), "");
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

  // 使用固定工作目录，确保 -c 能在同一目录下找到最近会话
  await mkdir(WORK_DIR, { recursive: true });
  const promptFile = join(WORK_DIR, "prompt.txt").replace(/\\/g, "/");
  await writeFile(promptFile, fullPrompt, "utf-8");

  try {
    for (const tool of tools) {
      try {
        const hasSession = activeSession.get(tool.name) || false;
        const cmd = tool.buildCmd(promptFile, hasSession);
        console.log(`[AI] 调用 ${tool.name}${hasSession ? " (续用会话)" : " (新建会话)"}`);

        const { stdout } = await execAsync(cmd, {
          timeout: 60000,
          encoding: "utf-8",
          env: { ...process.env },
          cwd: WORK_DIR,  // 关键：固定 cwd 使 -c 能找到最近会话
        });

        const title = extractCleanOutput(stdout);
        console.log(`[AI] ${tool.name} 输出: "${title}"`);
        if (title && title.length > 0 && title.length < 100) {
          activeSession.set(tool.name, true);
          return { title, usedCli: tool.name };
        }
      } catch (e) {
        console.error(`${tool.name} 生成标题失败:`, (e as Error).message);
        activeSession.delete(tool.name);
      }
    }
  } finally {
    try {
      await unlink(promptFile);
    } catch {
      void 0;
    }
  }

  throw new Error("所有 AI CLI 工具均未能生成有效标题");
}

export function resetSession(toolName?: string) {
  if (toolName) {
    activeSession.delete(toolName);
  } else {
    activeSession.clear();
  }
}

export async function getAvailableClis(): Promise<{ name: string; hasSession: boolean }[]> {
  const tools = await detectAvailableCli();
  return tools.map((t) => ({
    name: t.name,
    hasSession: activeSession.get(t.name) || false,
  }));
}
