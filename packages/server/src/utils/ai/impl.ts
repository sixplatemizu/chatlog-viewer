import { spawn, type ChildProcess } from "child_process";
import { accessSync, constants, readFileSync } from "fs";
import { mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { delimiter, dirname, isAbsolute, join } from "path";
import type { Message } from "../../providers/types.js";
import type { TitleGenerationCli } from "../provider-paths.js";
import { getProviderConfigPath } from "../provider-paths.js";

type CliToolName = TitleGenerationCli;
type CliRunMode = "fresh" | "resume" | "resume-fallback-fresh";

interface CliTool {
  name: CliToolName;
  command: string;
  freshArgs: string[];
  ephemeralArgs?: string[];
  resumeArgs?: string[];
  healthcheckArgs: string[];
  timeoutMs?: number;
  promptMode?: "stdin" | "args";
  projectDirArg?: string;
}

interface TitleSessionMarker {
  lastUsedAt: string;
  sessionId?: string;
}

const CLI_TOOLS: CliTool[] = [
  {
    name: "codex",
    command: "codex",
    freshArgs: ["exec", "--skip-git-repo-check", "--color", "never", "-"],
    ephemeralArgs: ["exec", "--ephemeral", "--skip-git-repo-check", "--color", "never", "-"],
    resumeArgs: ["exec", "resume", "--last", "--skip-git-repo-check", "-"],
    healthcheckArgs: ["--version"],
    timeoutMs: 30_000,
  },
  {
    name: "claude",
    command: "claude",
    freshArgs: ["-p", ""],
    ephemeralArgs: ["--no-session-persistence", "-p", ""],
    resumeArgs: ["-c", "-p", ""],
    healthcheckArgs: ["--version"],
    timeoutMs: 30_000,
  },
  {
    name: "opencode",
    command: "opencode",
    freshArgs: ["run", "--title", "ChatLog Viewer AI Title", "--format", "json", "--", "__PROMPT__"],
    resumeArgs: ["run", "--session", "__SESSION_ID__", "--format", "json", "--", "__PROMPT__"],
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

function logAiDiagnostic(message: string): void {
  process.stderr.write(`${message}\n`);
}

export interface GenerateTitleOptions {
  priority?: string[];
  reuseSession?: boolean | Partial<Record<CliToolName, boolean>>;
  projectDir?: string;
  timeoutMs?: number;
  retries?: number;
  availableCliNames?: CliToolName[];
  beforeToolRun?: (
    toolName: CliToolName,
    run: { sessionWillPersist: boolean }
  ) => Promise<void> | void;
  afterToolRun?: (
    toolName: CliToolName,
    run: {
      sessionRetained: boolean;
      sessionPersisted: boolean;
      generatedSessionId?: string;
    }
  ) => Promise<void> | void;
}

export interface GenerateTitleResult {
  title: string;
  usedCli: string;
  attempts: number;
  sessionRetained: boolean;
  sessionPersisted: boolean;
  generatedSessionId?: string;
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const timeout = setTimeout(() => {
        killer.kill();
        resolve();
      }, 5_000);
      killer.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      killer.once("error", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    return;
  }

  child.kill();
}

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

  const shimTarget = resolvePnpmShimTarget(executablePath);
  if (shimTarget) {
    return /\.(?:c?js|mjs)$/i.test(shimTarget)
      ? { command: process.execPath, args: [shimTarget, ...args] }
      : { command: shimTarget, args };
  }

  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/c", executablePath, ...args.map((arg) => arg.replace(/%/g, "%%"))],
  };
}

function resolvePnpmShimTarget(executablePath: string): string | null {
  const shimMetadataPath = executablePath.replace(/\.(cmd|bat)$/i, "");
  try {
    const content = readFileSync(shimMetadataPath, "utf-8");
    const target = content.match(/^# cmd-shim-target=(.+)$/m)?.[1]?.trim();
    if (!target) return null;
    accessSync(target, constants.F_OK);
    return target;
  } catch {
    return null;
  }
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

function getToolsByName(names: readonly CliToolName[]): CliTool[] {
  const toolsByName = new Map(CLI_TOOLS.map((tool) => [tool.name, tool]));
  return names
    .map((name) => toolsByName.get(name))
    .filter((tool): tool is CliTool => !!tool);
}

export async function detectAvailableTitleGenerationClis(priority?: readonly string[]): Promise<CliToolName[]> {
  return orderToolsByPriority(await detectAvailableCli(), priority).map((tool) => tool.name);
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
      void terminateProcessTree(child).finally(() => finish(false));
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

  const rank = new Map(priority.map((name, index) => [name, index]));
  return [...filtered].sort((a, b) => {
    const aRank = rank.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const bRank = rank.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    return aRank - bRank;
  });
}

const TITLE_CONTEXT_RECENT_MESSAGE_LIMIT = 10;

function pickRecentMessages(messages: Message[]): Message[] {
  return messages
    .filter((message) => message.role !== "tool" && message.content.trim())
    .slice(-TITLE_CONTEXT_RECENT_MESSAGE_LIMIT);
}

function compactContextLinesFromNewest(lines: string[], maxChars: number): string[] {
  // 超长时从旧到新丢弃，优先保留最新消息
  const selected = [...lines];
  let charCount = selected.reduce((total, line) => total + line.length, 0);
  while (charCount > maxChars && selected.length > 0) {
    const [removed] = selected.splice(0, 1);
    charCount -= removed?.length ?? 0;
  }
  return selected;
}

function buildContext(messages: Message[], maxChars = 5000): string {
  const recentMessages = pickRecentMessages(messages);
  const lines = recentMessages.map((msg) => {
    const roleLabel = msg.role === "user" ? "用户" : "助手";
    const text = msg.content.replace(/\s+/g, " ").trim().slice(0, 700);
    return `${roleLabel}: ${text}`;
  });
  return compactContextLinesFromNewest(lines, maxChars).join("\n");
}

export function buildTitlePromptContextForTest(messages: Message[], maxChars?: number): string {
  return buildContext(messages, maxChars);
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

async function readSessionMarker(toolName: CliToolName): Promise<TitleSessionMarker | null> {
  try {
    const content = await readFile(getSessionMarkerPath(toolName), "utf-8");
    const marker = JSON.parse(content) as TitleSessionMarker;
    return marker && typeof marker.lastUsedAt === "string" ? marker : null;
  } catch {
    return null;
  }
}

async function hasPersistedSession(toolName: CliToolName): Promise<boolean> {
  const marker = await readSessionMarker(toolName);
  return !!marker && (toolName !== "opencode" || !!marker.sessionId);
}

async function writeSessionMarker(toolName: CliToolName, sessionId?: string): Promise<void> {
  await ensureCliSessionDir(toolName);
  await writeFile(
    getSessionMarkerPath(toolName),
    `${JSON.stringify({ lastUsedAt: new Date().toISOString(), ...(sessionId ? { sessionId } : {}) })}\n`,
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

export function extractOpenCodeSessionId(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as {
        sessionID?: unknown;
        sessionId?: unknown;
        session_id?: unknown;
        part?: { sessionID?: unknown; sessionId?: unknown; session_id?: unknown };
        properties?: { sessionID?: unknown; sessionId?: unknown; session_id?: unknown };
      };
      const candidates = [
        event.sessionID,
        event.sessionId,
        event.session_id,
        event.part?.sessionID,
        event.part?.sessionId,
        event.part?.session_id,
        event.properties?.sessionID,
        event.properties?.sessionId,
        event.properties?.session_id,
      ];
      const sessionId = candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (sessionId) return sessionId.trim();
    } catch {
      // 忽略非 JSON 行和无效事件。
    }
  }
  return null;
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
  options: { projectDir?: string; timeoutMs?: number } = {}
): Promise<string> {
  const promptViaArgs = tool.promptMode === "args";
  const argsWithProjectDir = addProjectDirArg(tool, args, options.projectDir);
  const resolvedArgs = promptViaArgs
    ? argsWithProjectDir.map((arg) => {
        if (arg !== "__PROMPT__") return arg;
        return prompt.replace(/\s+/g, " ").trim();
      })
    : argsWithProjectDir;

  logAiDiagnostic(`[AI] 执行 ${tool.name} (prompt ${prompt.length} chars, mode=${promptViaArgs ? "args" : "stdin"})`);
  logAiDiagnostic(`[AI] ${tool.name} argv count=${resolvedArgs.length}`);

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
    let settled = false;
    let timedOut = false;
    const resolveOnce = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child).finally(() => {
        rejectOnce(new Error(`${tool.name} 执行超时`));
      });
    }, options.timeoutMs ?? tool.timeoutMs ?? 30_000);

    child.stdout!.setEncoding("utf-8");
    child.stderr!.setEncoding("utf-8");
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      console.error(`[AI] ${tool.name} spawn 错误:`, error.message);
      rejectOnce(error);
    });
    child.once("close", (code) => {
      if (timedOut) return;
      logAiDiagnostic(`[AI] ${tool.name} 退出 code=${code} stdout=${stdout.length}B stderr=${stderr.length}B`);
      if (stderr.trim()) {
        console.error(`[AI] ${tool.name} stderr: ${stderr.slice(0, 500)}`);
      }
      if (code !== 0) {
        rejectOnce(new Error(stderr.trim() || `${tool.name} 执行失败 (${code ?? "unknown"})`));
        return;
      }
      const output = stdout || stderr;
      if (!output.trim()) {
        const projectDirDetail = options.projectDir ? `, dir=${options.projectDir}` : "";
        rejectOnce(new Error(`${tool.name} 未产生输出（cwd=${workDir}${projectDirDetail}）`));
        return;
      }
      resolveOnce(output);
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
  options?: { reuseSession?: boolean; projectDir?: string; timeoutMs?: number }
): Promise<{
  stdout: string;
  mode: CliRunMode;
  sessionRetained: boolean;
  sessionPersisted: boolean;
  generatedSessionId?: string;
}> {
  const workDir = await ensureCliSessionDir(tool.name);
  const allowReuseSession = options?.reuseSession ?? false;
  const sessionMarker = allowReuseSession ? await readSessionMarker(tool.name) : null;
  const hasSession = !!sessionMarker && (tool.name !== "opencode" || !!sessionMarker.sessionId);
  const requestedProjectDir = tool.name === "opencode"
    ? workDir
    : (tool.projectDirArg ? options?.projectDir?.trim() || process.cwd() : undefined);
  const projectDir = await resolveCliProjectDir(requestedProjectDir) ?? (tool.projectDirArg ? process.cwd() : undefined);

  const run = async (args: string[], mode: CliRunMode) => {
    const stdout = await executeCli(tool, args, prompt, workDir, {
      projectDir,
      timeoutMs: options?.timeoutMs,
    });
    return { stdout, mode };
  };

  const finalize = async (
    result: { stdout: string; mode: CliRunMode },
    fallbackSessionId?: string
  ) => {
    const generatedSessionId = tool.name === "opencode"
      ? extractOpenCodeSessionId(result.stdout) ?? fallbackSessionId
      : undefined;
    const sessionRetained = allowReuseSession
      && (tool.name !== "opencode" || !!generatedSessionId);
    const sessionPersisted = allowReuseSession || !tool.ephemeralArgs;

    if (sessionRetained) {
      await writeSessionMarker(tool.name, generatedSessionId);
    }

    return { ...result, sessionRetained, sessionPersisted, generatedSessionId };
  };

  if (hasSession && tool.resumeArgs) {
    try {
      const resumeArgs = tool.resumeArgs.map((arg) => (
        arg === "__SESSION_ID__" ? sessionMarker?.sessionId ?? arg : arg
      ));
      return await finalize(await run(resumeArgs, "resume"), sessionMarker?.sessionId);
    } catch (error) {
      if (!isResumeMissError(error)) {
        throw error;
      }

      logAiDiagnostic(`[AI] ${tool.name} 未找到可复用会话，回退为新建会话`);
      await clearSessionMarker(tool.name);
      return await finalize(await run(tool.freshArgs, "resume-fallback-fresh"));
    }
  }

  const freshArgs = !allowReuseSession && tool.ephemeralArgs
    ? tool.ephemeralArgs
    : tool.freshArgs;
  return await finalize(await run(freshArgs, "fresh"));
}

export async function generateTitle(
  messages: Message[],
  options?: GenerateTitleOptions
): Promise<GenerateTitleResult> {
  const availableTools = options?.availableCliNames
    ? getToolsByName(options.availableCliNames)
    : await detectAvailableCli();
  const tools = orderToolsByPriority(
    availableTools,
    options?.priority
  );
  if (tools.length === 0) {
    throw new Error("没有可用的 AI CLI 工具（需要 claude、codex 或 opencode）");
  }

  const context = buildContext(messages);
  const fullPrompt = INSTRUCTION + context;
  const failures: string[] = [];
  let attempts = 0;
  const maxAttemptsPerTool = Math.max(1, (options?.retries ?? 0) + 1);

  for (const tool of tools) {
    const reuseSession = typeof options?.reuseSession === "object"
      ? options.reuseSession[tool.name] ?? false
      : options?.reuseSession ?? false;
    await options?.beforeToolRun?.(tool.name, {
      sessionWillPersist: reuseSession || !tool.ephemeralArgs,
    });
    for (let attempt = 1; attempt <= maxAttemptsPerTool; attempt += 1) {
      attempts += 1;
      try {
        const result = await runCliTool(tool, fullPrompt, {
          reuseSession,
          projectDir: options?.projectDir,
          timeoutMs: options?.timeoutMs,
        });
        await options?.afterToolRun?.(tool.name, {
          sessionRetained: result.sessionRetained,
          sessionPersisted: result.sessionPersisted,
          generatedSessionId: result.generatedSessionId,
        });
        logAiDiagnostic(`[AI] 调用 ${tool.name} (${result.mode}, attempt=${attempt})`);
        const title = extractCleanOutput(result.stdout);
        logAiDiagnostic(`[AI] ${tool.name} 提取标题: "${title}"`);
        if (title && title.length > 0 && title.length < 100) {
          logAiDiagnostic(`[AI] 成功使用 ${tool.name} 生成标题: "${title}"`);
          return {
            title,
            usedCli: tool.name,
            attempts,
            sessionRetained: result.sessionRetained,
            sessionPersisted: result.sessionPersisted,
            generatedSessionId: result.generatedSessionId,
          };
        }
        logAiDiagnostic(`[AI] ${tool.name} 失败: 输出为空或格式无效`);
        failures.push(`${tool.name}#${attempt}: 输出为空或格式无效`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[AI] ${tool.name} 生成标题失败:`, message);
        failures.push(`${tool.name}#${attempt}: ${message}`);
      }
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
