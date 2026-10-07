import { open } from "fs/promises";
import { dirname, join } from "path";
import { runKeyedMutation } from "../utils/mutation-queue.js";
import { visitJsonl } from "../utils/jsonl.js";
import { getProviderConfigPath } from "../utils/provider-paths/index.js";
import { normalizePath } from "./shared/provider-utils.js";
import type { ConversationBadge } from "./types.js";
import type { ClaudeCodeEntry } from "./claude-code-types.js";

// Claude Code 原生标题：/resume 语义的 custom-title / agent-name 元条目
// （transcript 追加写入 + 全文流式读取），以及 AI 标题生成会话的识别与徽标。

export const CLAUDE_TITLE_GENERATION_BADGE_LABEL = "标题生成";

export function normalizeTitleCandidate(value?: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

export function buildConversationTitle(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const normalized = normalizeTitleCandidate(candidate);
    if (normalized) {
      return normalized.slice(0, 100);
    }
  }
  return "未知对话";
}

export function normalizeClaudePathForCompare(value?: string | null): string {
  return normalizePath(value ?? "").replace(/^\/\/\?\//, "").toLowerCase();
}

export function getClaudeTitleSessionProjectPath(): string {
  return join(dirname(getProviderConfigPath()), "ai-title-sessions", "claude");
}

export function isClaudeTitleGenerationProject(value?: string | null): boolean {
  const normalized = normalizeClaudePathForCompare(value);
  return !!normalized && normalized === normalizeClaudePathForCompare(getClaudeTitleSessionProjectPath());
}

export function buildClaudeTitleGenerationBadges(): ConversationBadge[] {
  return [{
    label: CLAUDE_TITLE_GENERATION_BADGE_LABEL,
    tone: "cyan",
    title: "ChatView AI 标题生成产生的 Claude Code session",
  }];
}

export function mergeClaudeBadges(...groups: Array<ConversationBadge[] | undefined>): ConversationBadge[] | undefined {
  const badges = groups.flatMap((group) => group ?? []);
  return badges.length > 0 ? badges : undefined;
}

export async function appendTranscriptNativeTitle(
  filePath: string,
  sessionId: string,
  title: string
): Promise<void> {
  await runKeyedMutation(`claude-transcript:${filePath}`, async () => {
    const file = await open(filePath, "a+");
    try {
      const fileStat = await file.stat();
      let prefix = "";
      if (fileStat.size > 0) {
        const lastByte = Buffer.alloc(1);
        await file.read(lastByte, 0, 1, fileStat.size - 1);
        if (lastByte[0] !== 0x0a && lastByte[0] !== 0x0d) {
          prefix = "\n";
        }
      }

      const entries: ClaudeCodeEntry[] = [
        {
          type: "custom-title",
          customTitle: title,
          sessionId,
        },
        {
          type: "agent-name",
          agentName: title,
          sessionId,
        },
      ];
      await file.write(`${prefix}${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    } finally {
      await file.close();
    }
  });
}

export async function readTranscriptNativeTitle(filePath: string): Promise<string | null> {
  let title: string | null = null;
  await visitJsonl<ClaudeCodeEntry>(filePath, (entry) => {
    if (entry.type === "custom-title") {
      title = normalizeTitleCandidate(entry.customTitle) ?? title;
    } else if (entry.type === "agent-name") {
      title = normalizeTitleCandidate(entry.agentName) ?? title;
    }
  });
  return title;
}
