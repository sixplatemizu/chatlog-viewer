import { appendFile, mkdir, readdir, rm, readFile, rename } from "fs/promises";
import { dirname, join, basename } from "path";
import { getProviderConfigPath } from "./provider-paths.js";

const LOG_DIR = join(dirname(getProviderConfigPath()), "logs");
const MAX_LOG_LINES = 10000;
const MAX_LOG_FILES = 7;

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
    
    // 定期清理旧日志
    await rotateLogFiles();
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
  } catch {
    // 日志写入失败不影响主流程
  } finally {
    isWritingDebug = false;
    if (debugQueue.length > 0) {
      void flushDebugQueue();
    }
  }
}

async function rotateLogFiles() {
  try {
    const files = await readdir(LOG_DIR);
    const logFiles = files.filter(f => f.endsWith(".log")).sort();
    
    if (logFiles.length > MAX_LOG_FILES) {
      const toDelete = logFiles.slice(0, logFiles.length - MAX_LOG_FILES);
      for (const file of toDelete) {
        await rm(join(LOG_DIR, file), { force: true });
      }
    }
  } catch {
    // 忽略
  }
}

function createLogInterceptor(level: LogLevel, original: (...args: unknown[]) => void) {
  return (...args: unknown[]) => {
    original(...args);
    const line = formatLogLine(level, args);
    
    if (LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel]) {
      logQueue.push(line);
      if (!isWriting) {
        void flushLogQueue();
      }
    }
    
    if (level === "DEBUG") {
      debugQueue.push(line);
      if (!isWritingDebug) {
        void flushDebugQueue();
      }
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
