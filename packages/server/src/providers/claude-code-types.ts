import type { Message } from "./types.js";

// Claude Code provider 的共享数据模型：transcript 条目、sessions-index、history 与会话来源。
// 仅类型定义，无运行时逻辑；供 title / messages / session-index / source / provider 主模块共用。

export interface ClaudeCodeEntry {
  type: string;
  subtype?: string;
  uuid?: string;
  messageId?: string;
  parentUuid?: string | null;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    id?: string;
    model?: string;
  };
  cwd?: string;
  timestamp?: string;
  // 仅在 type==="custom-title" / "agent-name" / "summary" 等元数据条目上出现，
  // Claude /resume 的"会话名"主要来源；UI 也应优先用这个。
  customTitle?: string;
  agentName?: string;
  summary?: string;
}

export interface ClaudeCodeSessionIndexEntry {
  sessionId?: string;
  fullPath?: string;
  fileMtime?: number;
  firstPrompt?: string;
  summary?: string;
  customTitle?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
  agentName?: string;
}

export interface ClaudeCodeSessionIndexFile {
  version?: number;
  entries?: ClaudeCodeSessionIndexEntry[];
  originalPath?: string;
}

export interface ClaudeCodeHistoryEntry {
  display?: string;
  timestamp?: number;
  project?: string;
  sessionId?: string;
}

export interface ClaudeHistorySession {
  projectPath?: string;
  firstPrompt?: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount: number;
  messages: Message[];
}

export interface ClaudeCodeSessionSource {
  key: string;
  sessionId: string;
  projectKey: string;
  projectDirPath: string;
  indexPath: string;
  transcriptPath?: string;
  sessionDirPath?: string;
  fullPathHint?: string;
  projectPathHint?: string;
  displayTitleHint?: string;
  firstPromptHint?: string;
  createdAtHint?: number;
  updatedAtHint: number;
  fileSizeHint: number;
  messageCountHint?: number;
  historySession?: ClaudeHistorySession;
}

export type ClaudeCodeContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
};
