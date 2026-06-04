import { spawn } from "child_process";
import { accessSync, constants } from "fs";
import { access, mkdir, rm, stat, writeFile } from "fs/promises";
import { delimiter, dirname, isAbsolute, join } from "path";
import type { Message } from "../providers/types.js";
import type { TitleGenerationCli } from "./provider-paths.js";
import { getProviderConfigPath } from "./provider-paths.js";

type CliToolName = TitleGenerationCli;
type CliRunMode = "fresh" | "resume" | "resume-fallback-fresh" | "fresh-fallback-dir" | "resume-fallback-dir";

interface CliTool {
  name: CliToolName;
  command: string;
  freshArgs: string[];
  resumeArgs?: string[];
  healthcheckArgs: string[];
  timeoutMs?: number;
  promptMode?: "stdin" | "args";
  projectDirArg?: string;
}

const CLI_TOOLS: CliTool[] = [
  {
    name: "codex",
    command: "codex",
    freshArgs: ["exec", "--skip-git-repo-check", "--color", "never", "-"],
    resumeArgs: ["exec", "resume", "--last", "--skip-git-repo-check", "-"],
    healthcheckArgs: ["--version"],
    timeoutMs: 30_000,
  },
  {
    name: "claude",
    command: "claude",
    freshArgs: ["-p", ""],
    resumeArgs: ["-c", "-p", ""],
    healthcheckArgs: ["--version"],
    timeoutMs: 30_000,
  },
  {
    name: "opencode",
    command: "opencode",
    freshArgs: ["run", "--format", "json", "--", "__PROMPT__"],
    healthcheckArgs: ["--version"],
    timeoutMs: 45_000,
    promptMode: "args",
    projectDirArg: "--dir",
  },
];

const TITLE_SESSION_DIRNAME = "ai-title-sessions";
const SESSION_MARKER_FILENAME = ".session.json";
const INVALID_GENERATED_TITLE_OUTPUTS = new Set(["default", "build", "plan", "general", "step-start", "step_start"]);
const RESUME_MISS_PATTERNS = [
  /no .*?(conversation|session|chat|thread).*?(found|available|to resume|to continue)/i,
  /(nothing|no previous|no prior).*(resume|continue|conversation|session)/i,
  /(resume|continue).*(not found|missing|available|failed)/i,
  /session id.*not found/i,
  /cannot (resume|continue)/i,
  /can't (resume|continue)/i,
];
const executablePathCache = new Map<string, string>();

function resolveExecutablePath(command: string): string {
  if (process.platform !== "win32" || isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }

  const cacheKey = `${command}\0${process.env.PATH ?? ""}\0${process.env.PATHEXT ?? ""}`;
  const cached = executablePathCache.get(cacheKey);
  if (cached) return cached;

  const pathDirs = (process.env.PATH || "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const pathExts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  const commandCandidates = /\.[^\\/]+$/.test(command)
    ? [command]
    : [...pathExts.map((ext) => `${command}${ext.toLowerCase()}`), ...pathExts.map((ext) => `${command}${ext.toUpperCase()}`), command];

  for (const dir of pathDirs) {
    for (const candidate of commandCandidates) {
      const fullPath = join(dir, candidate);
      try {
        accessSync(fullPath, constants.F_OK);
        executablePathCache.set(cacheKey, fullPath);
        return fullPath;
      } catch {
        // 继续查找 PATH
      }
    }
  }

  return command;
}

function resolveSpawnInvocation(command: string, args: string[]): { command: string; args: string[] } {
  const executablePath = resolveExecutablePath(command);
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(executablePath)) {
    return { command: executablePath, args };
  }

  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/c", executablePath, ...args.map((arg) => arg.replace(/%/g, "%%"))],
  };
}

async function detectAvailableCli(): Promise<CliTool[]> {
  const available: CliTool[] = [];
  for (const tool of CLI_TOOLS) {
    try {
      const isAvailable = await checkCliHealth(tool);
      if (isAvailable) {
        available.push(tool);
      }
    } catch {
      // 不可用
    }
  }
  return available;
}

async function checkCliHealth(tool: CliTool): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const invocation = resolveSpawnInvocation(tool.command, tool.healthcheckArgs);
    const child = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      env: { ...process.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 5_000);

    child.once("error", () => {
      finish(false);
    });
    child.stdout.resume();
    child.stderr.resume();
    child.once("close", (code) => {
      finish(code === 0);
    });
  });
}

function orderToolsByPriority(tools: CliTool[], priority?: readonly string[]): CliTool[] {
  if (!priority || priority.length === 0) return tools;

  const prioritySet = new Set(priority);
  const filtered = tools.filter((tool) => prioritySet.has(tool.name));
  if (filtered.length === 0) return tools;

  const rank = new Map(priority.map((name, index) => [name, index]));
  return [...filtered].sort((a, b) => {
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

function stripTitleQuotes(text: string): string {
  return text
    .replace(/^["'「『《]/, "")
    .replace(/["'」』》][。.!！]?$/, "")
    .trim();
}

function isInvalidGeneratedTitle(text: string): boolean {
  const normalized = text
    .replace(/^>\s*/, "")
    .replace(/[。.!！?？]+$/, "")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  if (INVALID_GENERATED_TITLE_OUTPUTS.has(normalized)) return true;
  return /^(default|build|plan|general)\s*[·•]\s*[\w./:-]+/i.test(normalized);
}

function cleanTitleCandidate(text: string): string {
  const title = stripTitleQuotes(text);
  return isInvalidGeneratedTitle(title) ? "" : title;
}

function extractJsonLineTextOutput(stdout: string): string | null {
  const textParts: string[] = [];
  let hasTextEvent = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        part?: {
          type?: string;
          text?: string;
        };
      };
      if (event.type === "text" && event.part?.type === "text" && typeof event.part.text === "string") {
        hasTextEvent = true;
        textParts.push(event.part.text);
      }
    } catch {
      // 非 JSON 行按普通文本兜底处理。
    }
  }

  const text = textParts.join("\n").trim();
  return hasTextEvent ? cleanTitleCandidate(text) : null;
}

function isCliStatusLine(line: string): boolean {
  const normalized = line.replace(/^>\s*/, "").trim();
  if (!normalized) return true;
  if (/^(default|build|plan|general)$/i.test(normalized)) return true;
  // Windows taskkill 输出（codex v0.130+ 结束时级联杀子进程产生）
  if (/^SUCCESS: The process with PID \d+/i.test(normalized)) return true;
  // codex CLI 自身分节标记
  if (/^(codex|tokens used)$/i.test(normalized)) return true;
  if (/^tokens used\s+[\d,]+$/i.test(normalized)) return true;
  // ISO 时间戳开头的 codex stderr 日志被合并到 stdout 时
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*ERROR /.test(normalized)) return true;
  return /^[\w-]+\s*[·•]\s*[\w./:-]+/i.test(normalized);
}

export function extractCleanOutput(stdout: string): string {
  const jsonLineText = extractJsonLineTextOutput(stdout);
  if (jsonLineText !== null) return jsonLineText;

  // 当输出以"流式 JSON 事件"为主时（多数行以 { 开头），视为 CLI 走了 JSON
  // 输出模式但未产生 text 事件（典型场景：opencode --format json 只回了
  // step_start/step_finish）。此时退回到 regex 抽取没意义，直接返回空。
  // 阈值用半数以上避免误伤偶尔包含一两行 JSON 示例的 claude/codex 输出。
  const trimmedLines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (trimmedLines.length > 0) {
    const jsonLineCount = trimmedLines.filter((line) => line.startsWith("{")).length;
    if (jsonLineCount * 2 >= trimmedLines.length) {
      return "";
    }
  }

  const ansiEscape = String.fromCharCode(27);
  const clean = stdout
    .replace(/<Execution Info>[\s\S]*/m, "")
    .replace(/<environment_details>[\s\S]*<\/environment_details>/m, "")
    .replace(new RegExp(`${ansiEscape}\\[[0-9;]*m`, "g"), "")
    .replace(/^#{1,3}\s*/m, "")
    .replace(/[*_]{1,2}([^*_\n]+)[*_]{1,2}/g, "$1")
    .trim();

  // 按优先级尝试提取：
  // 1. "标题：xxx" / "建议标题为：xxx" 等明确标记
  const titleLabelMatch = clean.match(/(?:标题|建议标题|推荐标题)(?:为|是)?[：:]\s*(.+?)(?:\n|$)/m);
  if (titleLabelMatch) {
    return cleanTitleCandidate(titleLabelMatch[1]);
  }

  // 2. 引号/书名号包裹的短文本（2-50 字），取最后一个作为标题
  const quotedMatches = clean.match(/["'「『《]([^"'」』》\n]{2,50})["'」』》]/g);
  if (quotedMatches) {
    return cleanTitleCandidate(quotedMatches[quotedMatches.length - 1]!);
  }

  // 3. 首个非 CLI 状态行，去掉常见前缀语
  const firstLine = clean
    .split("\n")
    .map((line) => line.trim())
    .find((line) => !isCliStatusLine(line)) ?? "";
  const stripped = firstLine.replace(/^(?:好的|根据对话内容|我认为|建议|标题可以).{0,10}(?:是|为)[：:]\s*/i, "");
  return cleanTitleCandidate(stripped);
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

// 规范化 Windows 长路径前缀 `\\?\` 以及大小写、斜杠方向，用于路径比较。
// 注意：路径换 `/` 后 `\\?\` 变成 `//?/`，要在 normalize 之后再剥离。
function normalizeProjectDirForCompare(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/\/\?\//, "").toLowerCase();
}

function addProjectDirArg(tool: CliTool, args: string[], projectDir?: string): string[] {
  const normalizedProjectDir = projectDir?.trim();
  if (!tool.projectDirArg || !normalizedProjectDir || args.includes(tool.projectDirArg)) {
    return args;
  }

  const [command, ...rest] = args;
  if (!command) {
    return [tool.projectDirArg, normalizedProjectDir];
  }
  return [command, tool.projectDirArg, normalizedProjectDir, ...rest];
}

async function resolveCliProjectDir(projectDir?: string): Promise<string | undefined> {
  const normalizedProjectDir = projectDir?.trim();
  if (!normalizedProjectDir) return undefined;

  try {
    const projectDirStat = await stat(normalizedProjectDir);
    return projectDirStat.isDirectory() ? normalizedProjectDir : undefined;
  } catch {
    return undefined;
  }
}

async function executeCli(
  tool: CliTool,
  args: string[],
  prompt: string,
  workDir: string,
  options: { projectDir?: string } = {}
): Promise<string> {
  const promptViaArgs = tool.promptMode === "args";
  const argsWithProjectDir = addProjectDirArg(tool, args, options.projectDir);
  const resolvedArgs = promptViaArgs
    ? argsWithProjectDir.map((arg) => {
        if (arg !== "__PROMPT__") return arg;
        return prompt.replace(/\s+/g, " ").trim();
      })
    : argsWithProjectDir;

  console.log(`[AI] 执行 ${tool.name} (prompt ${prompt.length} chars, mode=${promptViaArgs ? "args" : "stdin"})`);
  console.debug(`[AI] ${tool.name} argv count=${resolvedArgs.length}`);

  return await new Promise<string>((resolve, reject) => {
    const invocation = resolveSpawnInvocation(tool.command, resolvedArgs);
    const child = spawn(invocation.command, invocation.args, {
      cwd: workDir,
      env: { ...process.env },
      shell: false,
      stdio: promptViaArgs ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${tool.name} 执行超时`));
    }, tool.timeoutMs ?? 30_000);

    child.stdout!.setEncoding("utf-8");
    child.stderr!.setEncoding("utf-8");
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      console.error(`[AI] ${tool.name} spawn 错误:`, error.message);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      console.log(`[AI] ${tool.name} 退出 code=${code} stdout=${stdout.length}B stderr=${stderr.length}B`);
      if (stderr.trim()) {
        console.error(`[AI] ${tool.name} stderr: ${stderr.slice(0, 500)}`);
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${tool.name} 执行失败 (${code ?? "unknown"})`));
        return;
      }
      const output = stdout || stderr;
      if (!output.trim()) {
        const projectDirDetail = options.projectDir ? `, dir=${options.projectDir}` : "";
        reject(new Error(`${tool.name} 未产生输出（cwd=${workDir}${projectDirDetail}）`));
        return;
      }
      resolve(output);
    });

    if (!promptViaArgs) {
      child.stdin!.on("error", () => {
        // 某些 CLI 可能会提前结束 stdin，这里不额外中断主流程。
      });
      child.stdin!.end(prompt, "utf-8");
    }
  });
}

async function runCliTool(
  tool: CliTool,
  prompt: string,
  options?: { reuseSession?: boolean; projectDir?: string }
): Promise<{ stdout: string; mode: CliRunMode }> {
  const workDir = await ensureCliSessionDir(tool.name);
  const allowReuseSession = options?.reuseSession ?? false;
  const hasSession = allowReuseSession ? await hasPersistedSession(tool.name) : false;
  const requestedProjectDir = tool.projectDirArg ? options?.projectDir?.trim() || process.cwd() : undefined;
  const projectDir = await resolveCliProjectDir(requestedProjectDir) ?? (tool.projectDirArg ? process.cwd() : undefined);
  const opencodeFallbackProjectDirs = tool.name === "opencode"
    ? [process.cwd(), undefined].filter((candidate, index, candidates) => {
        if (candidate && projectDir && normalizeProjectDirForCompare(candidate) === normalizeProjectDirForCompare(projectDir)) {
          return false;
        }
        return candidates.findIndex((item) => (
          item === undefined && candidate === undefined
            ? true
            : !!item && !!candidate && normalizeProjectDirForCompare(item) === normalizeProjectDirForCompare(candidate)
        )) === index;
      })
    : [];

  const runWithOptionalDirFallback = async (
    args: string[],
    mode: CliRunMode
  ): Promise<{ stdout: string; mode: CliRunMode }> => {
    const stdout = await executeCli(tool, args, prompt, workDir, { projectDir });
    if (tool.name !== "opencode") {
      return { stdout, mode };
    }

    if (extractCleanOutput(stdout).trim().length > 0) {
      return { stdout, mode };
    }

    const failedDirs = [projectDir ? `dir=${projectDir}` : "无 --dir"];
    for (const fallbackProjectDir of opencodeFallbackProjectDirs) {
      const fallbackLabel = fallbackProjectDir ? `dir=${fallbackProjectDir}` : "无 --dir";
      console.warn(`[AI] ${tool.name} 在 ${failedDirs[failedDirs.length - 1]} 下未产生有效标题，回退到 ${fallbackLabel}`);
      const fallbackStdout = await executeCli(tool, args, prompt, workDir, { projectDir: fallbackProjectDir });
      if (extractCleanOutput(fallbackStdout).trim().length > 0) {
        return {
          stdout: fallbackStdout,
          mode: mode === "resume" ? "resume-fallback-dir" : "fresh-fallback-dir",
        };
      }
      failedDirs.push(fallbackLabel);
    }

    throw new Error(`${tool.name} 在 ${failedDirs.join("、")} 下都未产生有效输出`);
  };

  if (hasSession && tool.resumeArgs) {
    try {
      const result = await runWithOptionalDirFallback(tool.resumeArgs, "resume");
      await writeSessionMarker(tool.name);
      return result;
    } catch (error) {
      if (!isResumeMissError(error)) {
        throw error;
      }

      console.warn(`[AI] ${tool.name} 未找到可复用会话，回退为新建会话`);
      await clearSessionMarker(tool.name);
      const result = await runWithOptionalDirFallback(tool.freshArgs, "resume-fallback-fresh");
      await writeSessionMarker(tool.name);
      return result;
    }
  }

  const result = await runWithOptionalDirFallback(tool.freshArgs, "fresh");
  await writeSessionMarker(tool.name);
  return result;
}

export async function generateTitle(
  messages: Message[],
  options?: {
    priority?: string[];
    reuseSession?: boolean | Partial<Record<CliToolName, boolean>>;
    projectDir?: string;
  }
): Promise<{
  title: string;
  usedCli: string;
}> {
  const tools = orderToolsByPriority(
    await detectAvailableCli(),
    options?.priority
  );
  if (tools.length === 0) {
    throw new Error("没有可用的 AI CLI 工具（需要 claude、codex 或 opencode）");
  }

  const context = buildContext(messages);
  const fullPrompt = INSTRUCTION + context;
  const failures: string[] = [];

  for (const tool of tools) {
    try {
      const reuseSession = typeof options?.reuseSession === "object"
        ? options.reuseSession[tool.name] ?? false
        : options?.reuseSession;
      const result = await runCliTool(tool, fullPrompt, {
        reuseSession,
        projectDir: options?.projectDir,
      });
      console.log(`[AI] 调用 ${tool.name} (${result.mode})`);
      const title = extractCleanOutput(result.stdout);
      console.log(`[AI] ${tool.name} 提取标题: "${title}"`);
      if (title && title.length > 0 && title.length < 100) {
        console.log(`[AI] 成功使用 ${tool.name} 生成标题: "${title}"`);
        return { title, usedCli: tool.name };
      }
      console.log(`[AI] ${tool.name} 失败: 输出为空或格式无效`);
      failures.push(`${tool.name}: 输出为空或格式无效`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[AI] ${tool.name} 生成标题失败:`, message);
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

export async function getAvailableClis(): Promise<Array<{
  name: string;
  discoverable: boolean;
  healthy: boolean;
  hasSession: boolean;
}>> {
  const availableTools = await detectAvailableCli();
  const availableByName = new Map(availableTools.map((tool) => [tool.name, tool]));

  return await Promise.all(CLI_TOOLS.map(async (tool) => {
    const availableTool = availableByName.get(tool.name);
    const discoverable = !!availableTool;

    return {
      name: tool.name,
      discoverable,
      healthy: availableTool ? await checkCliHealth(availableTool) : false,
      hasSession: await hasPersistedSession(tool.name),
    };
  }));
}
