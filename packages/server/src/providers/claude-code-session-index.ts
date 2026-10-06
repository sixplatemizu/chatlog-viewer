import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { runKeyedMutation } from "../utils/mutation-queue.js";
import {
  ProviderDataError,
  createProviderDataError,
  isFileSystemNotFoundError,
} from "../utils/errors.js";
import { normalizePath } from "./shared/provider-utils.js";
import type {
  ClaudeCodeSessionIndexEntry,
  ClaudeCodeSessionIndexFile,
  ClaudeCodeSessionSource,
} from "./claude-code-types.js";

// Claude Code sessions-index.json 的读取与原子写入（含跨进程 mutation 锁）。
// providerName 仅用于错误诊断信息。

export function parseJsonObjectPrefix<T>(content: string): T | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let startIndex = -1;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (startIndex < 0) {
      if (/\s/.test(char ?? "")) continue;
      if (char !== "{") return null;
      startIndex = index;
      depth = 1;
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = inString;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(content.slice(startIndex, index + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function formatClaudeStoredPath(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = normalizePath(value);
  if (/^[A-Za-z]:\//.test(normalized)) {
    return normalized.replace(/\//g, "\\");
  }
  return normalized;
}

export async function readClaudeSessionIndexFile(
  providerName: string,
  indexPath: string
): Promise<ClaudeCodeSessionIndexFile> {
  try {
    const content = await readFile(indexPath, "utf-8");
    let parsed: ClaudeCodeSessionIndexFile | null = null;
    try {
      parsed = JSON.parse(content) as ClaudeCodeSessionIndexFile;
    } catch {
      parsed = parseJsonObjectPrefix<ClaudeCodeSessionIndexFile>(content);
    }

    if (parsed) {
      return {
        version: parsed.version ?? 1,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        originalPath: parsed.originalPath,
      };
    }
  } catch (error) {
    if (!isFileSystemNotFoundError(error)) {
      throw createProviderDataError(providerName, `Claude Code session index 无法读取: ${indexPath}`, error);
    }

    return {
      version: 1,
      entries: [],
    };
  }

  throw new ProviderDataError(
    providerName,
    "corrupt",
    `Claude Code session index 已损坏且无法恢复: ${indexPath}`
  );
}

export async function writeClaudeSessionIndexFile(
  indexPath: string,
  indexFile: ClaudeCodeSessionIndexFile
): Promise<void> {
  const temporaryPath = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(indexPath), { recursive: true });
  try {
    await writeFile(temporaryPath, JSON.stringify(indexFile, null, 2), "utf-8");
    await rename(temporaryPath, indexPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function removeClaudeSessionIndexEntry(indexPath: string, sessionId: string): Promise<void> {
  await runKeyedMutation(`claude-index:${indexPath}`, async () => {
    await removeClaudeSessionIndexEntryUnlocked(indexPath, sessionId);
  });
}

export async function removeClaudeSessionIndexEntryUnlocked(indexPath: string, sessionId: string): Promise<void> {
  const indexFile = await readClaudeSessionIndexFile("claude-code", indexPath);
  const entries = (indexFile.entries ?? []).filter((entry) => entry.sessionId !== sessionId);
  if ((indexFile.entries ?? []).length === entries.length) return;
  indexFile.entries = entries;
  await writeClaudeSessionIndexFile(indexPath, indexFile);
}

export async function upsertClaudeSessionIndexEntry(
  source: ClaudeCodeSessionSource,
  overrides: Partial<ClaudeCodeSessionIndexEntry> = {}
): Promise<void> {
  await runKeyedMutation(`claude-index:${source.indexPath}`, async () => {
    await upsertClaudeSessionIndexEntryUnlocked(source, overrides);
  });
}

export async function upsertClaudeSessionIndexEntryUnlocked(
  source: ClaudeCodeSessionSource,
  overrides: Partial<ClaudeCodeSessionIndexEntry> = {},
  deps: {
    writeIndexFile?: (indexPath: string, indexFile: ClaudeCodeSessionIndexFile) => Promise<void>;
  } = {}
): Promise<void> {
  const writeIndexFile = deps.writeIndexFile ?? writeClaudeSessionIndexFile;
  const indexFile = await readClaudeSessionIndexFile("claude-code", source.indexPath);
  const entries = Array.isArray(indexFile.entries) ? indexFile.entries : [];
  const entryIndex = entries.findIndex((entry) => entry.sessionId === source.sessionId);
  const existing = entryIndex >= 0 ? entries[entryIndex] : undefined;

  const defaultProjectPath = source.projectPathHint || indexFile.originalPath;
  const defaultFullPath = source.transcriptPath
    || source.fullPathHint
    || join(source.projectDirPath, `${source.sessionId}.jsonl`);
  const fallbackSummary = source.displayTitleHint
    || source.firstPromptHint
    || existing?.summary
    || existing?.firstPrompt
    || "New Conversation";

  const nextEntry: ClaudeCodeSessionIndexEntry = {
      ...existing,
      sessionId: source.sessionId,
      fullPath: formatClaudeStoredPath(existing?.fullPath || defaultFullPath),
      fileMtime: Math.round(source.updatedAtHint),
      firstPrompt: existing?.firstPrompt || source.firstPromptHint,
      summary: existing?.summary || fallbackSummary,
      messageCount: existing?.messageCount ?? source.messageCountHint ?? source.historySession?.messageCount ?? 0,
      created: existing?.created || new Date(source.createdAtHint ?? source.updatedAtHint).toISOString(),
      modified: new Date().toISOString(),
      gitBranch: existing?.gitBranch ?? "",
      projectPath: formatClaudeStoredPath(existing?.projectPath || defaultProjectPath),
      isSidechain: false,
      ...overrides,
  };

  if (!nextEntry.firstPrompt && source.firstPromptHint) {
    nextEntry.firstPrompt = source.firstPromptHint;
  }

  if (!indexFile.originalPath && nextEntry.projectPath) {
    indexFile.originalPath = nextEntry.projectPath;
  }

  if (entryIndex >= 0) {
    entries[entryIndex] = nextEntry;
  } else {
    entries.unshift(nextEntry);
  }

  indexFile.version = indexFile.version ?? 1;
  indexFile.entries = entries;
  await writeIndexFile(source.indexPath, indexFile);
}
