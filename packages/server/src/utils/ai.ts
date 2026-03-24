import { exec, spawn } from "child_process";
import { promisify } from "util";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Message } from "../providers/types.js";

const execAsync = promisify(exec);

interface CliTool {
  name: string;
  command: string;
  args: string[];
}

const CLI_TOOLS: CliTool[] = [
  {
    name: "iflow",
    command: "iflow",
    args: ["-p", ""],
  },
  {
    name: "claude",
    command: "claude",
    args: ["-p", ""],
  },
  {
    name: "codex",
    command: "codex",
    args: ["exec", "-"],
  },
];

function getLocateCommand(command: string): string {
  return process.platform === "win32" ? `where ${command}` : `which ${command}`;
}

async function detectAvailableCli(): Promise<CliTool[]> {
  const available: CliTool[] = [];
  for (const tool of CLI_TOOLS) {
    try {
      await execAsync(getLocateCommand(tool.command), { timeout: 5000 });
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

async function runCliTool(tool: CliTool, prompt: string): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-ai-"));

  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(tool.command, tool.args, {
        cwd: workDir,
        env: { ...process.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`${tool.name} 执行超时`));
      }, 60_000);

      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `${tool.name} 执行失败 (${code ?? "unknown"})`));
          return;
        }
        resolve(stdout);
      });

      child.stdin.on("error", () => {
        // 某些 CLI 可能会提前结束 stdin，这里不额外中断主流程。
      });
      child.stdin.end(prompt, "utf-8");
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

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

  for (const tool of tools) {
    try {
      console.log(`[AI] 调用 ${tool.name} (独立会话)`);
      const stdout = await runCliTool(tool, fullPrompt);
      const title = extractCleanOutput(stdout);
      console.log(`[AI] ${tool.name} 输出: "${title}"`);
      if (title && title.length > 0 && title.length < 100) {
        return { title, usedCli: tool.name };
      }
    } catch (e) {
      console.error(`${tool.name} 生成标题失败:`, (e as Error).message);
    }
  }

  throw new Error("所有 AI CLI 工具均未能生成有效标题");
}

export function resetSession(toolName?: string) {
  void toolName;
}

export async function getAvailableClis(): Promise<{ name: string; hasSession: boolean }[]> {
  const tools = await detectAvailableCli();
  return tools.map((t) => ({
    name: t.name,
    hasSession: false,
  }));
}
