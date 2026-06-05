import type {
  Conversation,
  ConversationCapabilities,
  ConversationMeta,
  ConversationProvider,
  Message,
  TitleSyncMode,
} from "../providers/types.js";
import { generateTitle } from "../utils/ai.js";
import { getErrorMessage, isNotFoundError } from "../utils/errors.js";
import { logProviderError } from "../utils/logger.js";
import {
  getTitleGenerationCliPriority,
  getTitleGenerationCliSessionModes,
  getTitleGenerationCliSessionReuse,
  type TitleGenerationCli,
} from "../utils/provider-paths.js";
import { deleteNativeTitle, deleteTitle, setNativeTitle, setTitle } from "../utils/title-store.js";

export const MAX_TITLE_LENGTH = 100;

const TITLE_GENERATION_BADGE_LABEL = "标题生成";
const TITLE_GENERATION_CLI_PROVIDER: Record<TitleGenerationCli, string> = {
  codex: "codex",
  claude: "claude-code",
  opencode: "opencode",
};

export interface GeneratedConversationTitle {
  success: true;
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
    };
  }

  const canUpdateTitle = provider.capabilities?.canUpdateTitle ?? true;
  const canGenerateTitle = provider.capabilities?.canGenerateTitle ?? canUpdateTitle;

  return {
    canUpdateTitle,
    canGenerateTitle,
    updateTitleDisabledReason: provider.capabilities?.updateTitleDisabledReason,
    generateTitleDisabledReason: provider.capabilities?.generateTitleDisabledReason,
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
  title: string
): Promise<void> {
  const normalizedTitle = normalizeTitle(title);

  if (provider.updateTitle) {
    await provider.updateTitle(id, normalizedTitle);
    await setNativeTitle(id, normalizedTitle);
    await deleteTitle(id);
    return;
  }

  await setTitle(id, normalizedTitle);
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
    await deleteNativeTitle(id);
    return { cleanedStale: false };
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    await deleteTitle(id);
    await deleteNativeTitle(id);
    return { cleanedStale: true };
  }
}

export async function cleanupFreshTitleGenerationSessions(
  providers: ConversationProvider[],
  usedCli: string
): Promise<number> {
  if (!isTitleGenerationCli(usedCli)) return 0;

  const modes = getTitleGenerationCliSessionModes();
  let deleted = 0;
  const cleanupProviderNames = new Set(
    Object.entries(modes)
      .filter(([, mode]) => mode === "fresh")
      .map(([cli]) => TITLE_GENERATION_CLI_PROVIDER[cli as TitleGenerationCli])
  );

  for (const providerName of cleanupProviderNames) {
    const cleanupProvider = providers.find((provider) => provider.name === providerName);
    if (!cleanupProvider) continue;

    const conversations = await cleanupProvider.list({ eagerSearchIndex: false });
    for (const conversation of conversations) {
      if (!hasTitleGenerationBadge(conversation)) continue;

      try {
        await deleteConversationWithCleanup(cleanupProvider, conversation.id);
        deleted += 1;
      } catch (error) {
        logProviderError("conversations.generate-title.cleanup", cleanupProvider.name, error);
      }
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
  const startedAt = Date.now();
  const result = await generateTitle(buildTitleGenerationMessages(conversation), {
    priority: options.priority ?? getTitleGenerationCliPriority(),
    reuseSession: options.reuseSession ?? getTitleGenerationCliSessionReuse(),
    projectDir: conversation.project,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    availableCliNames: options.availableCliNames,
  });
  await persistConversationTitle(provider, id, result.title);
  const cleanedTitleSessions = await cleanupFreshTitleGenerationSessions(providers, result.usedCli);
  return {
    success: true,
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
