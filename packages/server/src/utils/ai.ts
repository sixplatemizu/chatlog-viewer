import { exec, spawn } from "child_process";
import { access, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { promisify } from "util";
import type { Message } from "../providers/types.js";
import { getProviderConfigPath } from "./provider-paths.js";

const execAsync = promisify(exec);

type CliToolName = "codex" | "iflow" | "claude";
type CliRunMode = "fresh" | "resume" | "resume-fallback-fresh";

interface CliTool {
  name: CliToolName;
  command: string;
  freshArgs: string[];
  resumeArgs?: string[];
  timeoutMs?: number;
}

const CLI_TOOLS: CliTool[] = [
  {
    name: "codex",
    command: "codex",
    freshArgs: ["exec", "--skip-git-repo-check", "--color", "never", "-"],
    resumeArgs: ["exec", "resume", "--last", "--skip-git-repo-check", "-"],
    timeoutMs: 30_000,
  },
  {
    name: "iflow",
    command: "iflow",
    freshArgs: ["-p", ""],
    resumeArgs: ["-c", "-p", ""],
    timeoutMs: 30_000,
  },
  {
    name: "claude",
    command: "claude",
    freshArgs: ["-p", ""],
    resumeArgs: ["-c", "-p", ""],
    timeoutMs: 30_000,
  },
];

const TITLE_SESSION_DIRNAME = "ai-title-sessions";
const SESSION_MARKER_FILENAME = ".session.json";
const RESUME_MISS_PATTERNS = [
  /no .*?(conversation|session|chat|thread).*?(found|available|to resume|to continue)/i,
  /(nothing|no previous|no prior).*(resume|continue|conversation|session)/i,
  /(resume|continue).*(not found|missing|available|failed)/i,
  /session id.*not found/i,
  /cannot (resume|continue)/i,
  /can't (resume|continue)/i,
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

function orderToolsByPriority(tools: CliTool[], priority?: readonly string[]): CliTool[] {
  if (!priority || priority.length === 0) return tools;

  const rank = new Map(priority.map((name, index) => [name, index]));
  return [...tools].sort((a, b) => {
    const aRank = rank.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const bRank = rank.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    return aRank - bRank;
  });
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
  clean = clean.replace(/^标题[:：]\s*/m, "");
  clean = clean.replace(/^[\"'「]|[\"'」]$/g, "");
  const firstLine = clean.split("\n")[0]?.trim() || clean;
  return firstLine;
}

const INSTRUCTION = "请为以下AI对话生成一个简短的中文标题（10-20个字），准确概括对话主题，只输出标题本身，不要加引号或其他格式：\n\n";

function getTitleSessionBaseDir(): string {
  return join(dirname(getProviderConfigPath()), TITLE_SESSION_DIRNAME);
}

function getCliSessionDir(toolName: CliToolName): string {
  return join(getTitleSessionBaseDir(), toolName);
}

function getSessionMarkerPath(toolName: CliToolName): string {
  return join(getCliSessionDir(toolName), SESSION_MARKER_FILENAME);
}

async function ensureCliSessionDir(toolName: CliToolName): Promise<string> {
  const sessionDir = getCliSessionDir(toolName);
  await mkdir(sessionDir, { recursive: true });
  return sessionDir;
}

async function hasPersistedSession(toolName: CliToolName): Promise<boolean> {
  try {
    await access(getSessionMarkerPath(toolName));
    return true;
  } catch {
    return false;
  }
}

async function writeSessionMarker(toolName: CliToolName): Promise<void> {
  await ensureCliSessionDir(toolName);
  await writeFile(
    getSessionMarkerPath(toolName),
    `${JSON.stringify({ lastUsedAt: new Date().toISOString() })}\n`,
    "utf-8"
  );
}

async function clearSessionMarker(toolName: CliToolName): Promise<void> {
  await rm(getSessionMarkerPath(toolName), { force: true });
}

function isResumeMissError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RESUME_MISS_PATTERNS.some((pattern) => pattern.test(message));
}

async function executeCli(tool: CliTool, args: string[], prompt: string, workDir: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(tool.command, args, {
      cwd: workDir,
      env: { ...process.env },
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${tool.name} 执行超时`));
    }, tool.timeoutMs ?? 30_000);

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
}

async function runCliTool(
  tool: CliTool,
  prompt: string
): Promise<{ stdout: string; mode: CliRunMode }> {
  const workDir = await ensureCliSessionDir(tool.name);
  const hasSession = await hasPersistedSession(tool.name);

  if (hasSession && tool.resumeArgs) {
    try {
      const stdout = await executeCli(tool, tool.resumeArgs, prompt, workDir);
      await writeSessionMarker(tool.name);
      return { stdout, mode: "resume" };
    } catch (error) {
      if (!isResumeMissError(error)) {
        throw error;
      }

      console.warn(`[AI] ${tool.name} 未找到可复用会话，回退为新建会话`);
      await clearSessionMarker(tool.name);
      const stdout = await executeCli(tool, tool.freshArgs, prompt, workDir);
      await writeSessionMarker(tool.name);
      return { stdout, mode: "resume-fallback-fresh" };
    }
  }

  const stdout = await executeCli(tool, tool.freshArgs, prompt, workDir);
  await writeSessionMarker(tool.name);
  return { stdout, mode: "fresh" };
}

export async function generateTitle(
  messages: Message[],
  options?: { priority?: string[] }
): Promise<{
  title: string;
  usedCli: string;
}> {
  const tools = orderToolsByPriority(
    await detectAvailableCli(),
    options?.priority
  );
  if (tools.length === 0) {
    throw new Error("没有可用的 AI CLI 工具（需要 iflow、claude 或 codex）");
  }

  const context = buildContext(messages);
  const fullPrompt = INSTRUCTION + context;
  const failures: string[] = [];

  for (const tool of tools) {
    try {
      const result = await runCliTool(tool, fullPrompt);
      console.log(`[AI] 调用 ${tool.name} (${result.mode})`);
      const title = extractCleanOutput(result.stdout);
      console.log(`[AI] ${tool.name} 输出: "${title}"`);
      if (title && title.length > 0 && title.length < 100) {
        return { title, usedCli: tool.name };
      }
      failures.push(`${tool.name}: 输出为空或格式无效`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`${tool.name} 生成标题失败:`, message);
      failures.push(`${tool.name}: ${message}`);
    }
  }

  throw new Error(
    failures.length > 0
      ? `所有 AI CLI 工具均未能生成有效标题：${failures.join("；")}`
      : "所有 AI CLI 工具均未能生成有效标题"
  );
}

export async function resetSession(toolName?: CliToolName): Promise<void> {
  if (toolName) {
    await rm(getCliSessionDir(toolName), { recursive: true, force: true });
    return;
  }

  await rm(getTitleSessionBaseDir(), { recursive: true, force: true });
}

export async function getAvailableClis(): Promise<{ name: string; available: boolean; hasSession: boolean }[]> {
  const availableTools = await detectAvailableCli();
  const availableNames = new Set(availableTools.map((tool) => tool.name));

  return await Promise.all(CLI_TOOLS.map(async (tool) => ({
    name: tool.name,
    available: availableNames.has(tool.name),
    hasSession: await hasPersistedSession(tool.name),
  })));
}
