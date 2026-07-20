import type {
  Conversation,
  ConversationCapabilities,
  ConversationMeta,
  ConversationProvider,
  Message,
  TitleSyncMode,
} from "../providers/types.js";
import { generateTitle } from "../utils/ai.js";
import { getErrorMessage, isNotFoundError, MutationConflictError } from "../utils/errors.js";
import { logProviderError } from "../utils/logger.js";
import {
  getTitleGenerationCliPriority,
  getTitleGenerationCliSessionReuse,
  type TitleGenerationCli,
} from "../utils/provider-paths.js";
import {
  deleteNativeTitleSnapshot,
  deleteTitle,
  getTitle,
  recordTitleHistory,
  setNativeTitleSnapshot,
  setTitle,
  type TitleHistorySource,
} from "../utils/title-store.js";
import { runKeyedMutation } from "../utils/mutation-queue.js";

export const MAX_TITLE_LENGTH = 100;

const TITLE_GENERATION_BADGE_LABEL = "标题生成";
const TITLE_GENERATION_CLI_PROVIDER: Record<TitleGenerationCli, string> = {
  codex: "codex",
  claude: "claude-code",
  opencode: "opencode",
};

export interface GeneratedConversationTitle {
  success: true;
  oldTitle: string;
  title: string;
  usedCli: string;
  attempts: number;
  cleanedTitleSessions: number;
  durationMs: number;
}

export interface GenerateConversationTitleOptions {
  priority?: string[];
  reuseSession?: boolean | Partial<Record<TitleGenerationCli, boolean>>;
  timeoutMs?: number;
  retries?: number;
  availableCliNames?: TitleGenerationCli[];
}

export interface PersistConversationTitleOptions {
  historySource?: TitleHistorySource;
  expectedTitle?: string;
  force?: boolean;
}

function isTitleGenerationCli(value: string): value is TitleGenerationCli {
  return Object.hasOwn(TITLE_GENERATION_CLI_PROVIDER, value);
}

function hasTitleGenerationBadge(conversation: ConversationMeta): boolean {
  return conversation.badges?.some((badge) => badge.label === TITLE_GENERATION_BADGE_LABEL) ?? false;
}

export function normalizeTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("标题不能为空");
  }

  const normalized = value.trim();
  if (normalized.length > MAX_TITLE_LENGTH) {
    throw new Error(`标题不能超过 ${MAX_TITLE_LENGTH} 个字符`);
  }
  return normalized;
}

export function resolveProviderTitleSyncMode(provider: ConversationProvider | undefined): TitleSyncMode {
  if (!provider) return "overlay";
  return provider.capabilities?.titleSyncMode ?? (provider.updateTitle ? "native" : "overlay");
}

export function resolveConversationCapabilities(provider: ConversationProvider | undefined): ConversationCapabilities {
  if (!provider) {
    return {
      canUpdateTitle: true,
      canGenerateTitle: true,
      canEditMessage: false,
      canDeleteMessage: false,
      canMoveConversation: false,
      canDeleteConversation: false,
      supportsMetadataOnly: false,
    };
  }

  const canUpdateTitle = provider.capabilities?.canUpdateTitle ?? true;
  const canGenerateTitle = provider.capabilities?.canGenerateTitle ?? canUpdateTitle;
  const canEditMessage = provider.capabilities?.canEditMessage ?? !!provider.updateMessage;
  const canDeleteMessage = provider.capabilities?.canDeleteMessage
    ?? !!(provider.deleteMessage || provider.deleteMessages);
  const canMoveConversation = provider.capabilities?.canMoveConversation ?? !!provider.move;
  const canDeleteConversation = provider.capabilities?.canDeleteConversation ?? true;

  return {
    canUpdateTitle,
    canGenerateTitle,
    canEditMessage,
    canDeleteMessage,
    canMoveConversation,
    canDeleteConversation,
    supportsMetadataOnly: provider.capabilities?.supportsMetadataOnly ?? false,
    updateTitleDisabledReason: provider.capabilities?.updateTitleDisabledReason,
    generateTitleDisabledReason: provider.capabilities?.generateTitleDisabledReason,
    editMessageDisabledReason: provider.capabilities?.editMessageDisabledReason,
    deleteMessageDisabledReason: provider.capabilities?.deleteMessageDisabledReason,
    moveConversationDisabledReason: provider.capabilities?.moveConversationDisabledReason,
    deleteConversationDisabledReason: provider.capabilities?.deleteConversationDisabledReason,
  };
}

export function getTitleMutationDisabledReason(
  provider: ConversationProvider,
  operation: "update" | "generate"
): string | null {
  const capabilities = resolveConversationCapabilities(provider);
  if (operation === "update" && !capabilities.canUpdateTitle) {
    return capabilities.updateTitleDisabledReason ?? `${provider.displayName} 不支持修改标题`;
  }
  if (operation === "generate" && !capabilities.canGenerateTitle) {
    return capabilities.generateTitleDisabledReason ?? `${provider.displayName} 不支持 AI 标题生成`;
  }
  return null;
}

export async function persistConversationTitle(
  provider: ConversationProvider,
  id: string,
  title: string,
  options: PersistConversationTitleOptions = {}
): Promise<void> {
  const normalizedTitle = normalizeTitle(title);
  const historySource = options.historySource ?? "chatlog-viewer";

  if (provider.updateTitle) {
    await runKeyedMutation(`conversation-title:${id}`, async () => {
      const previousTitle = (await provider.read(id, { limit: 1 })).title.trim() || null;
      const expectedTitle = options.expectedTitle?.trim();
      if (!options.force && expectedTitle !== undefined && previousTitle !== expectedTitle) {
        throw new MutationConflictError(
          `标题已被其他操作修改，已保留当前标题“${previousTitle || "空"}”，未覆盖为“${normalizedTitle}”`
        );
      }
      await provider.updateTitle!(id, normalizedTitle);
      const persistedTitle = (await provider.read(id, { limit: 1 })).title.trim();
      if (persistedTitle !== normalizedTitle) {
        throw new Error(
          `${provider.displayName} 原生标题写入校验失败：期望“${normalizedTitle}”，实际“${persistedTitle || "空"}”`
        );
      }

      try {
        await setNativeTitleSnapshot(id, persistedTitle, {
          historySource,
          recordHistory: false,
        });
        await deleteTitle(id, { recordHistory: false });
        await recordTitleHistory({
          id,
          action: "set-native-title",
          source: historySource,
          oldTitle: previousTitle,
          newTitle: persistedTitle,
        });
      } catch (error) {
        logProviderError("conversations.title.audit", provider.name, error);
      }
    });
    return;
  }

  await runKeyedMutation(`conversation-title:${id}`, async () => {
    const providerTitle = (await provider.read(id, { limit: 1 })).title.trim() || null;
    const currentOverlayTitle = (await getTitle(id))?.trim() || providerTitle;
    const expectedTitle = options.expectedTitle?.trim();
    if (!options.force && expectedTitle !== undefined && currentOverlayTitle !== expectedTitle) {
      throw new MutationConflictError(
        `标题已被其他操作修改，已保留当前标题“${currentOverlayTitle || "空"}”，未覆盖为“${normalizedTitle}”`
      );
    }
    await setTitle(id, normalizedTitle, { historySource });
  });
}

export function resolveConversationTitle(
  provider: ConversationProvider | undefined,
  currentTitle: string,
  customTitle: string | null | undefined
): string {
  if (resolveProviderTitleSyncMode(provider) === "native") {
    return currentTitle;
  }

  const normalizedCustomTitle = customTitle?.trim();
  if (!normalizedCustomTitle) {
    return currentTitle;
  }

  return normalizedCustomTitle;
}

export function buildTitleGenerationMessages(conversation: Conversation): Message[] {
  const realMessages = conversation.messages.filter((message) => {
    if (message.role === "tool") return false;
    if (message.role === "system" && conversation.transcriptMissing) return false;
    return !!message.content.trim();
  });

  if (realMessages.length > 0) {
    return realMessages;
  }

  const hint = conversation.titleGenerationHint?.trim();
  if (!hint) {
    return conversation.messages;
  }

  return [
    {
      role: "user",
      content: hint,
    },
  ];
}

async function deleteConversationWithCleanup(
  provider: ConversationProvider,
  id: string
): Promise<{ cleanedStale: boolean }> {
  try {
    await provider.delete(id);
    await deleteTitle(id);
    await deleteNativeTitleSnapshot(id);
    return { cleanedStale: false };
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    await deleteTitle(id);
    await deleteNativeTitleSnapshot(id);
    return { cleanedStale: true };
  }
}

export async function cleanupFreshTitleGenerationSessions(
  providers: ConversationProvider[],
  usedCli: string,
  sessionRetained: boolean,
  sessionPersisted: boolean,
  generatedSessionId?: string,
  preexistingSessionIds: ReadonlySet<string> = new Set()
): Promise<number> {
  if (!isTitleGenerationCli(usedCli) || sessionRetained || !sessionPersisted) return 0;

  const providerName = TITLE_GENERATION_CLI_PROVIDER[usedCli];
  const cleanupProvider = providers.find((provider) => provider.name === providerName);
  if (!cleanupProvider) return 0;

  if (generatedSessionId) {
    const generatedId = `${providerName}:${generatedSessionId}`;
    try {
      await deleteConversationWithCleanup(cleanupProvider, generatedId);
      return 1;
    } catch (error) {
      logProviderError("conversations.generate-title.cleanup", cleanupProvider.name, error);
      return 0;
    }
  }

  let deleted = 0;
  let conversations: ConversationMeta[];
  try {
    conversations = await cleanupProvider.list({ eagerSearchIndex: false });
  } catch (error) {
    logProviderError("conversations.generate-title.cleanup-list", cleanupProvider.name, error);
    return deleted;
  }
  for (const conversation of conversations) {
    if (!hasTitleGenerationBadge(conversation)) continue;
    if (preexistingSessionIds.has(conversation.id)) continue;

    try {
      await deleteConversationWithCleanup(cleanupProvider, conversation.id);
      deleted += 1;
    } catch (error) {
      logProviderError("conversations.generate-title.cleanup", cleanupProvider.name, error);
    }
  }

  return deleted;
}

export async function generateAndPersistConversationTitle(
  providers: ConversationProvider[],
  provider: ConversationProvider,
  id: string,
  options: GenerateConversationTitleOptions = {}
): Promise<GeneratedConversationTitle> {
  const disabledReason = getTitleMutationDisabledReason(provider, "generate");
  if (disabledReason) {
    throw new Error(disabledReason);
  }

  const conversation = await provider.read(id);
  const reuseSession = options.reuseSession ?? getTitleGenerationCliSessionReuse();
  const preexistingTitleSessions = new Map<TitleGenerationCli, Set<string>>();
  const titleSessionSnapshotsReady = new Set<TitleGenerationCli>();
  const generatedTitleSessionIds = new Map<TitleGenerationCli, Set<string>>();
  const startedAt = Date.now();
  let cleanedTitleSessions = 0;
  let result: Awaited<ReturnType<typeof generateTitle>>;

  try {
    result = await generateTitle(buildTitleGenerationMessages(conversation), {
      priority: options.priority ?? getTitleGenerationCliPriority(),
      reuseSession,
      projectDir: conversation.project,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      availableCliNames: options.availableCliNames,
      beforeToolRun: async (toolName, run) => {
        const toolReusesSession = typeof reuseSession === "object"
          ? reuseSession[toolName] ?? false
          : reuseSession;
        if (!run.sessionWillPersist || (toolReusesSession && toolName !== "opencode")) return;
        if (preexistingTitleSessions.has(toolName)) return;
        const providerName = TITLE_GENERATION_CLI_PROVIDER[toolName];
        const titleProvider = providers.find((item) => item.name === providerName);
        if (!titleProvider) {
          preexistingTitleSessions.set(toolName, new Set());
          return;
        }

        try {
          const conversations = await titleProvider.list({ eagerSearchIndex: false });
          preexistingTitleSessions.set(
            toolName,
            new Set(conversations.filter(hasTitleGenerationBadge).map((entry) => entry.id))
          );
          titleSessionSnapshotsReady.add(toolName);
        } catch (error) {
          logProviderError("conversations.generate-title.snapshot", titleProvider.name, error);
        }
      },
      afterToolRun: (toolName, run) => {
        if (!run.sessionPersisted || !run.generatedSessionId) return;
        if (run.sessionRetained) {
          const providerName = TITLE_GENERATION_CLI_PROVIDER[toolName];
          preexistingTitleSessions.get(toolName)?.add(`${providerName}:${run.generatedSessionId}`);
          return;
        }
        const sessionIds = generatedTitleSessionIds.get(toolName) ?? new Set<string>();
        sessionIds.add(run.generatedSessionId);
        generatedTitleSessionIds.set(toolName, sessionIds);
      },
    });
    await persistConversationTitle(provider, id, result.title, {
      historySource: "ai",
      expectedTitle: conversation.title,
    });
  } finally {
    const cleanupToolNames = new Set<TitleGenerationCli>([
      ...preexistingTitleSessions.keys(),
      ...generatedTitleSessionIds.keys(),
    ]);
    for (const toolName of cleanupToolNames) {
      const preexistingSessionIds = preexistingTitleSessions.get(toolName) ?? new Set<string>();
      for (const sessionId of generatedTitleSessionIds.get(toolName) ?? []) {
        cleanedTitleSessions += await cleanupFreshTitleGenerationSessions(
          providers,
          toolName,
          false,
          true,
          sessionId,
          preexistingSessionIds
        );
      }
      if (!titleSessionSnapshotsReady.has(toolName)) continue;
      cleanedTitleSessions += await cleanupFreshTitleGenerationSessions(
        providers,
        toolName,
        false,
        true,
        undefined,
        preexistingSessionIds
      );
    }
  }

  return {
    success: true,
    oldTitle: conversation.title,
    title: result.title,
    usedCli: result.usedCli,
    attempts: result.attempts,
    cleanedTitleSessions,
    durationMs: Date.now() - startedAt,
  };
}

export function formatTitleActionError(error: unknown): string {
  return getErrorMessage(error);
}
