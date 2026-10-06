import { join } from "path";
import { readdir, stat } from "fs/promises";
import { visitJsonl } from "../utils/jsonl.js";
import {
  createIndexedListSourceSignature,
  type IndexedSourceFile,
} from "../utils/provider-indexing.js";
import {
  createProviderDataError,
  isFileSystemNotFoundError,
} from "../utils/errors.js";
import { getProjectSpecificity, normalizePath } from "./shared/provider-utils.js";
import { normalizeTitleCandidate } from "./claude-code-title.js";
import { readClaudeSessionIndexFile } from "./claude-code-session-index.js";
import type { ConversationBadge } from "./types.js";
import type {
  ClaudeCodeHistoryEntry,
  ClaudeCodeSessionSource,
  ClaudeHistorySession,
} from "./claude-code-types.js";

// Claude Code 会话来源收集：扫描 projects 目录，聚合 transcript / session 目录 /
// sessions-index / history.jsonl 四路线索为统一的 ClaudeCodeSessionSource。

export const CLAUDE_CODE_LIST_SOURCE_VERSION = "claude-code-list-v3-native-title";

export function toTimestamp(value?: string | number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function isClaudeSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function pickMoreSpecificProject(
  current: string | undefined,
  candidate: string | undefined,
  projectKey: string
): string | undefined {
  if (!candidate) return current;
  if (!current) return candidate;

  const currentScore = getProjectSpecificity(current, projectKey);
  const candidateScore = getProjectSpecificity(candidate, projectKey);
  if (candidateScore > currentScore) return candidate;
  if (candidateScore < currentScore) return current;
  return candidate.length > current.length ? candidate : current;
}

function getPreferredSessionKey(source: ClaudeCodeSessionSource): string {
  return source.transcriptPath
    || source.sessionDirPath
    || source.key;
}

export function isClaudeCleanupCandidate(source: ClaudeCodeSessionSource): boolean {
  if (source.transcriptPath) {
    return false;
  }

  const historyMessageCount = source.historySession?.messages.length ?? 0;
  return historyMessageCount === 0;
}

export function buildClaudeHintBadges(source: ClaudeCodeSessionSource, historyMessageCount: number): ConversationBadge[] {
  const badges: ConversationBadge[] = [];

  if (historyMessageCount > 0) {
    badges.push({
      label: "history 回填",
      tone: "indigo",
      title: "Claude Code 未保留主 transcript，当前记录由 history.jsonl 中的用户输入回填",
    });
  } else {
    badges.push({
      label: "索引空壳",
      tone: "amber",
      title: "Claude Code 仅保留 sessions-index / session 目录元数据，未找到主 transcript 或 history 内容",
    });
  }

  if (!source.transcriptPath) {
    badges.push({
      label: "无 transcript",
      tone: "gray",
      title: "本地未找到 Claude Code 主 transcript，详情无法展示完整消息",
    });
  }

  return badges;
}

function pickHistorySession(
  current: ClaudeHistorySession | undefined,
  candidate: ClaudeHistorySession | undefined
): ClaudeHistorySession | undefined {
  if (!current) return candidate;
  if (!candidate) return current;
  return candidate.messages.length > current.messages.length ? candidate : current;
}

function mergeClaudeSessionSource(
  current: ClaudeCodeSessionSource | undefined,
  candidate: ClaudeCodeSessionSource
): ClaudeCodeSessionSource {
  if (!current) {
    return {
      ...candidate,
      key: getPreferredSessionKey(candidate),
    };
  }

  const merged: ClaudeCodeSessionSource = {
    ...current,
    transcriptPath: current.transcriptPath || candidate.transcriptPath,
    sessionDirPath: current.sessionDirPath || candidate.sessionDirPath,
    fullPathHint: current.fullPathHint || candidate.fullPathHint,
    projectPathHint: pickMoreSpecificProject(
      current.projectPathHint,
      candidate.projectPathHint,
      current.projectKey || candidate.projectKey
    ),
    displayTitleHint: current.displayTitleHint || candidate.displayTitleHint,
    firstPromptHint: current.firstPromptHint || candidate.firstPromptHint,
    createdAtHint: current.createdAtHint === undefined
      ? candidate.createdAtHint
      : (candidate.createdAtHint === undefined
        ? current.createdAtHint
        : Math.min(current.createdAtHint, candidate.createdAtHint)),
    updatedAtHint: Math.max(current.updatedAtHint, candidate.updatedAtHint),
    fileSizeHint: Math.max(current.fileSizeHint, candidate.fileSizeHint),
    messageCountHint: Math.max(current.messageCountHint ?? 0, candidate.messageCountHint ?? 0) || undefined,
    historySession: pickHistorySession(current.historySession, candidate.historySession),
  };

  merged.key = getPreferredSessionKey(merged);
  return merged;
}

export async function readClaudeHistorySessions(
  storagePath: string,
  providerName: string,
  signatureFiles: IndexedSourceFile[]
): Promise<Map<string, ClaudeHistorySession>> {
  const historyPath = normalizePath(join(storagePath, "..", "history.jsonl"));
  try {
    const historyStat = await stat(historyPath);
    signatureFiles.push({
      path: historyPath,
      mtimeMs: historyStat.mtimeMs,
      size: historyStat.size,
    });
  } catch (error) {
    if (isFileSystemNotFoundError(error)) return new Map();
    throw createProviderDataError(providerName, `Claude Code history 无法读取: ${historyPath}`, error);
  }

  const sessions = new Map<string, ClaudeHistorySession>();
  try {
    await visitJsonl<ClaudeCodeHistoryEntry>(historyPath, (entry) => {
      const sessionId = entry.sessionId?.trim();
      const display = entry.display?.trim();
      if (!sessionId || !display) {
        return;
      }

      const current = sessions.get(sessionId) ?? {
        messageCount: 0,
        messages: [],
      };
      const timestamp = typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
        ? entry.timestamp
        : undefined;

      current.projectPath = entry.project ? normalizePath(entry.project) : current.projectPath;
      current.createdAt = current.createdAt === undefined
        ? timestamp
        : (timestamp === undefined ? current.createdAt : Math.min(current.createdAt, timestamp));
      current.updatedAt = current.updatedAt === undefined
        ? timestamp
        : (timestamp === undefined ? current.updatedAt : Math.max(current.updatedAt, timestamp));
      current.messageCount += 1;
      current.messages.push({
        role: "user",
        content: display,
        timestamp,
      });

      if (!display.startsWith("/") && !current.firstPrompt) {
        current.firstPrompt = display;
      }

      sessions.set(sessionId, current);
    });
  } catch (error) {
    throw createProviderDataError(providerName, `Claude Code history 解析失败: ${historyPath}`, error);
  }

  return sessions;
}

export async function collectClaudeSessionSources(options: {
  storagePath: string;
  providerName: string;
}): Promise<{ sources: ClaudeCodeSessionSource[]; sourceSignature: string }> {
  const { storagePath, providerName } = options;
  const basePath = normalizePath(storagePath);
  const signatureFiles: IndexedSourceFile[] = [];
  const historyBySessionId = await readClaudeHistorySessions(basePath, providerName, signatureFiles);
  const sourceBySessionId = new Map<string, ClaudeCodeSessionSource>();

  let projectEntries;
  try {
    projectEntries = await readdir(basePath, { withFileTypes: true });
  } catch (error) {
    throw createProviderDataError(providerName, `Claude Code 项目目录无法读取: ${basePath}`, error);
  }
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;

    const projectKey = projectEntry.name;
    const projectDirPath = normalizePath(join(basePath, projectKey));
    const indexPath = normalizePath(join(projectDirPath, "sessions-index.json"));
    const transcriptBySessionId = new Map<string, IndexedSourceFile>();
    const sessionDirBySessionId = new Map<string, IndexedSourceFile>();

    let projectDirEntries;
    try {
      projectDirEntries = await readdir(projectDirPath, { withFileTypes: true });
    } catch (error) {
      throw createProviderDataError(providerName, `Claude Code 项目目录无法读取: ${projectDirPath}`, error);
    }
    for (const entry of projectDirEntries) {
      const fullPath = normalizePath(join(projectDirPath, entry.name));
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const fileStat = await stat(fullPath);
        const fileState = {
          path: fullPath,
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
        };
        signatureFiles.push(fileState);

        const sessionId = entry.name.replace(/\.jsonl$/i, "");
        if (sessionId !== "sessions-index" && isClaudeSessionId(sessionId)) {
          transcriptBySessionId.set(sessionId, fileState);
        }
        continue;
      }

      if (entry.isDirectory() && isClaudeSessionId(entry.name)) {
        const dirStat = await stat(fullPath);
        const dirState = {
          path: fullPath,
          mtimeMs: dirStat.mtimeMs,
          size: 0,
        };
        signatureFiles.push(dirState);
        sessionDirBySessionId.set(entry.name, dirState);
      }
    }

    let sessionIndexFile: Awaited<ReturnType<typeof readClaudeSessionIndexFile>> | null = null;
    try {
      const indexStat = await stat(indexPath);
      signatureFiles.push({
        path: indexPath,
        mtimeMs: indexStat.mtimeMs,
        size: indexStat.size,
      });
      sessionIndexFile = await readClaudeSessionIndexFile(providerName, indexPath);
    } catch (error) {
      if (isFileSystemNotFoundError(error)) {
        sessionIndexFile = null;
      } else {
        throw createProviderDataError(providerName, `Claude Code session index 检测失败: ${indexPath}`, error);
      }
    }

    for (const entry of sessionIndexFile?.entries ?? []) {
      const sessionId = entry.sessionId?.trim();
      if (!sessionId || !isClaudeSessionId(sessionId) || entry.isSidechain) continue;

      const transcript = transcriptBySessionId.get(sessionId);
      const sessionDir = sessionDirBySessionId.get(sessionId);
      const historySession = historyBySessionId.get(sessionId);
      const updatedAtHint = Math.max(
        toTimestamp(entry.modified) ?? 0,
        entry.fileMtime ?? 0,
        transcript?.mtimeMs ?? 0,
        sessionDir?.mtimeMs ?? 0
      ) || Date.now();

      sourceBySessionId.set(
        sessionId,
        mergeClaudeSessionSource(sourceBySessionId.get(sessionId), {
          key: transcript?.path || sessionDir?.path || normalizePath(join(projectDirPath, `${sessionId}.session`)),
          sessionId,
          projectKey,
          projectDirPath,
          indexPath,
          transcriptPath: transcript?.path,
          sessionDirPath: sessionDir?.path,
          fullPathHint: entry.fullPath ? normalizePath(entry.fullPath) : undefined,
          projectPathHint: entry.projectPath
            ? normalizePath(entry.projectPath)
            : (sessionIndexFile?.originalPath ? normalizePath(sessionIndexFile.originalPath) : historySession?.projectPath),
          displayTitleHint: normalizeTitleCandidate(entry.customTitle || entry.summary || entry.agentName),
          firstPromptHint: normalizeTitleCandidate(entry.firstPrompt),
          createdAtHint: toTimestamp(entry.created) ?? historySession?.createdAt,
          updatedAtHint,
          fileSizeHint: transcript?.size ?? 0,
          messageCountHint: entry.messageCount ?? historySession?.messageCount,
          historySession,
        })
      );
    }

    for (const [sessionId, transcript] of transcriptBySessionId) {
      const historySession = historyBySessionId.get(sessionId);
      sourceBySessionId.set(
        sessionId,
        mergeClaudeSessionSource(sourceBySessionId.get(sessionId), {
          key: transcript.path,
          sessionId,
          projectKey,
          projectDirPath,
          indexPath,
          transcriptPath: transcript.path,
          fullPathHint: transcript.path,
          projectPathHint: historySession?.projectPath || sessionIndexFile?.originalPath,
          firstPromptHint: historySession?.firstPrompt,
          createdAtHint: historySession?.createdAt,
          updatedAtHint: Math.max(transcript.mtimeMs, historySession?.updatedAt ?? 0),
          fileSizeHint: transcript.size,
          messageCountHint: historySession?.messageCount,
          historySession,
        })
      );
    }

    for (const [sessionId, sessionDir] of sessionDirBySessionId) {
      const historySession = historyBySessionId.get(sessionId);
      if (!historySession) continue;

      sourceBySessionId.set(
        sessionId,
        mergeClaudeSessionSource(sourceBySessionId.get(sessionId), {
          key: sessionDir.path,
          sessionId,
          projectKey,
          projectDirPath,
          indexPath,
          sessionDirPath: sessionDir.path,
          projectPathHint: historySession.projectPath || sessionIndexFile?.originalPath,
          firstPromptHint: historySession.firstPrompt,
          createdAtHint: historySession.createdAt,
          updatedAtHint: Math.max(sessionDir.mtimeMs, historySession.updatedAt ?? 0),
          fileSizeHint: 0,
          messageCountHint: historySession.messageCount,
          historySession,
        })
      );
    }
  }

  const sources = [...sourceBySessionId.values()].sort((a, b) => b.updatedAtHint - a.updatedAtHint);
  const sourceSignature = `${CLAUDE_CODE_LIST_SOURCE_VERSION}:${
    createIndexedListSourceSignature(
      signatureFiles
        .map((item) => ({
          path: normalizePath(item.path),
          mtimeMs: item.mtimeMs,
          size: item.size,
        }))
        .sort((a, b) => a.path.localeCompare(b.path))
    )
  }`;

  return { sources, sourceSignature };
}
