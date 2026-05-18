import { appendFile, mkdir, readdir, rm, readFile, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { getProviderConfigPath } from "./provider-paths.js";

const LOG_DIR = join(dirname(getProviderConfigPath()), "logs");
// 单文件超过此行数后整体保留尾部 MAX_LOG_LINES 行，避免无限增长。
const MAX_LOG_LINES = 10000;
// 保留最新 N 个日志文件（按文件名字典序，ISO 日期天然有序）。
const MAX_LOG_FILES = 7;
// 文件 size 估算行数的最小步长（每 1MB 检查一次截尾），避免每次写入都 stat。
const TRUNCATE_CHECK_MIN_BYTES = 1 << 20;
const ROTATE_INTERVAL_MS = 60_000;

let originalConsoleLog: typeof console.log;
let originalConsoleError: typeof console.error;
let originalConsoleWarn: typeof console.warn;
let originalConsoleInfo: typeof console.info;
let originalConsoleDebug: typeof console.debug;

let logQueue: string[] = [];
let debugQueue: string[] = [];
let isWriting = false;
let isWritingDebug = false;

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

let currentLogLevel: LogLevel = (process.env.CHATLOG_VIEWER_LOG_LEVEL as LogLevel) ?? "INFO";

function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function getLogFile(level: LogLevel): string {
  const today = getToday();
  if (level === "DEBUG") {
    return join(LOG_DIR, `debug-${today}.log`);
  }
  return join(LOG_DIR, `server-${today}.log`);
}

function formatLogLine(level: LogLevel, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const message = args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return `${arg.message}\n${arg.stack}`;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(" ");
  return `[${timestamp}] [${level}] ${message}`;
}

async function flushLogQueue() {
  if (isWriting || logQueue.length === 0) return;

  isWriting = true;
  const lines = [...logQueue];
  logQueue = [];

  try {
    await mkdir(LOG_DIR, { recursive: true });
    const logFile = getLogFile("INFO");
    await appendFile(logFile, lines.join("\n") + "\n", "utf-8");
    await maybeRotate(logFile);
  } catch {
    // 日志写入失败不影响主流程
  } finally {
    isWriting = false;
    if (logQueue.length > 0) {
      void flushLogQueue();
    }
  }
}

async function flushDebugQueue() {
  if (isWritingDebug || debugQueue.length === 0) return;

  isWritingDebug = true;
  const lines = [...debugQueue];
  debugQueue = [];

  try {
    await mkdir(LOG_DIR, { recursive: true });
    const logFile = getLogFile("DEBUG");
    await appendFile(logFile, lines.join("\n") + "\n", "utf-8");
    await maybeRotate(logFile);
  } catch {
    // 日志写入失败不影响主流程
  } finally {
    isWritingDebug = false;
    if (debugQueue.length > 0) {
      void flushDebugQueue();
    }
  }
}

let lastRotateAt = 0;
let rotateInFlight: Promise<void> | null = null;

// rotate 节流 + 互斥：
// - 通过 in-flight Promise 防止两次并发 truncate 竞争同一文件
// - 时间窗口节流避免每条日志都 stat/readdir
async function maybeRotate(currentFile: string): Promise<void> {
  if (rotateInFlight) {
    await rotateInFlight;
    return;
  }
  const now = Date.now();
  if (now - lastRotateAt < ROTATE_INTERVAL_MS) return;
  lastRotateAt = now;

  rotateInFlight = (async () => {
    // 1. 文件数 rotate
    try {
      const files = await readdir(LOG_DIR);
      const logFiles = files.filter((f) => f.endsWith(".log")).sort();
      if (logFiles.length > MAX_LOG_FILES) {
        const toDelete = logFiles.slice(0, logFiles.length - MAX_LOG_FILES);
        await Promise.all(toDelete.map((file) => rm(join(LOG_DIR, file), { force: true })));
      }
    } catch {
      // 忽略
    }

    // 2. 行数 rotate：仅对超过阈值的单文件抽样
    try {
      const fileStat = await stat(currentFile);
      if (fileStat.size < TRUNCATE_CHECK_MIN_BYTES) return;
      const content = await readFile(currentFile, "utf-8");
      const lines = content.split("\n");
      if (lines.length <= MAX_LOG_LINES) return;
      const truncated = lines.slice(-MAX_LOG_LINES).join("\n");
      await writeFile(currentFile, truncated, "utf-8");
    } catch {
      // 忽略
    }
  })();

  try {
    await rotateInFlight;
  } finally {
    rotateInFlight = null;
  }
}

function createLogInterceptor(level: LogLevel, original: (...args: unknown[]) => void) {
  return (...args: unknown[]) => {
    original(...args);
    if (LOG_LEVELS[level] < LOG_LEVELS[currentLogLevel]) return;

    const line = formatLogLine(level, args);

    if (level === "DEBUG") {
      // DEBUG 仅写 debug-*.log，避免污染主日志
      debugQueue.push(line);
      if (!isWritingDebug) void flushDebugQueue();
    } else {
      logQueue.push(line);
      if (!isWriting) void flushLogQueue();
    }
  };
}

export function initFileLogger() {
  originalConsoleLog = console.log;
  originalConsoleError = console.error;
  originalConsoleWarn = console.warn;
  originalConsoleInfo = console.info;
  originalConsoleDebug = console.debug;
  
  console.log = createLogInterceptor("INFO", originalConsoleLog);
  console.error = createLogInterceptor("ERROR", originalConsoleError);
  console.warn = createLogInterceptor("WARN", originalConsoleWarn);
  console.info = createLogInterceptor("INFO", originalConsoleInfo);
  console.debug = createLogInterceptor("DEBUG", originalConsoleDebug);
  
  process.on("uncaughtException", (error) => {
    console.error("未捕获的异常:", error);
  });
  
  process.on("unhandledRejection", (reason) => {
    console.error("未处理的 Promise 拒绝:", reason);
  });
  
  console.log("文件日志系统已初始化，日志目录:", LOG_DIR);
}

export async function getServerLog(): Promise<string> {
  try {
    const logFile = getLogFile("INFO");
    const content = await readFile(logFile, "utf-8");
    return content;
  } catch {
    return "";
  }
}

export async function getDebugLog(): Promise<string> {
  try {
    const logFile = getLogFile("DEBUG");
    const content = await readFile(logFile, "utf-8");
    return content;
  } catch {
    return "";
  }
}

export async function clearServerLog(): Promise<void> {
  try {
    const logFile = getLogFile("INFO");
    await rm(logFile, { force: true });
  } catch {
    // 忽略
  }
}

export async function clearDebugLog(): Promise<void> {
  try {
    const logFile = getLogFile("DEBUG");
    await rm(logFile, { force: true });
  } catch {
    // 忽略
  }
}

export async function clearAllLogs(): Promise<void> {
  try {
    await rm(LOG_DIR, { recursive: true, force: true });
  } catch {
    // 忽略
  }
}

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function restoreConsole() {
  if (originalConsoleLog) console.log = originalConsoleLog;
  if (originalConsoleError) console.error = originalConsoleError;
  if (originalConsoleWarn) console.warn = originalConsoleWarn;
  if (originalConsoleInfo) console.info = originalConsoleInfo;
  if (originalConsoleDebug) console.debug = originalConsoleDebug;
}
