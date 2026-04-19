import { Hono } from "hono";
import { homedir } from "os";
import type {
  ConversationProvider,
  ConversationMeta,
  ConversationCapabilities,
  TitleSyncMode,
  Conversation,
  Message,
} from "../providers/types.js";
import { CodexProvider } from "../providers/codex.js";
import { getAllTitles, getTitle, setTitle, deleteTitle } from "../utils/title-store.js";
import { generateTitle, getAvailableClis, resetSession } from "../utils/ai.js";
import { getIndexedListSnapshot, hasFreshIndexedListCache, queryConversationIndex } from "../utils/cache.js";
import { getErrorMessage, getErrorStatus, isNotFoundError } from "../utils/errors.js";
import { logProviderError } from "../utils/logger.js";
import {
  getAppConfig,
  getProviderConfigPath,
  getProviderPaths,
  getTitleGenerationCliPriority,
  normalizeTitleGenerationCliPriority,
  updateProviderConfigs,
  type ProviderPathMigrationSelection,
  type ProviderPathConfig,
  type ResolvedProviderName,
  type TitleGenerationCli,
} from "../utils/provider-paths.js";

const RESOLVED_PROVIDER_NAMES = new Set<ResolvedProviderName>(["claude-code", "codex", "iflow"]);
const TITLE_GENERATION_CLI_NAMES = new Set<TitleGenerationCli>(["codex", "claude"]);

function isResolvedProviderName(name: string): name is ResolvedProviderName {
  return RESOLVED_PROVIDER_NAMES.has(name as ResolvedProviderName);
}

function isTitleGenerationCli(name: string): name is TitleGenerationCli {
  return TITLE_GENERATION_CLI_NAMES.has(name as TitleGenerationCli);
}

function normalizeOptionalPathInput(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("路径必须是字符串");
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeProjectDisplayPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").trim();
}

function getProjectDisplayScore(project: string, projectKey: string): number {
  const normalizedProject = normalizeProjectDisplayPath(project);
  const normalizedProjectKey = normalizeProjectDisplayPath(projectKey);
  if (!normalizedProject || normalizedProject === normalizedProjectKey) return 0;

  const parts = normalizedProject.split("/").filter(Boolean);
  if (parts.length === 0) return 0;
  if (parts.length === 3 && /^[A-Za-z]:$/.test(parts[0] || "") && parts[1] === "Users") {
    return 1;
  }
  return parts.length + 10;
}

function pickBetterProjectDisplayName(current: string, candidate: string, projectKey: string): string {
  const normalizedCurrent = normalizeProjectDisplayPath(current || projectKey);
  const normalizedCandidate = normalizeProjectDisplayPath(candidate || projectKey);
  if (!normalizedCurrent) return normalizedCandidate;
  if (!normalizedCandidate) return normalizedCurrent;

  const currentScore = getProjectDisplayScore(normalizedCurrent, projectKey);
  const candidateScore = getProjectDisplayScore(normalizedCandidate, projectKey);
  if (candidateScore > currentScore) return normalizedCandidate;
  if (candidateScore === currentScore && normalizedCandidate.length > normalizedCurrent.length) {
    return normalizedCandidate;
  }
  return normalizedCurrent;
}

function buildProjectInfosFromConversations(
  providerName: string,
  conversations: ConversationMeta[]
): Array<{ provider: string; projectKey: string; displayName: string }> {
  const projects = new Map<string, string>();

  for (const conversation of conversations) {
    const projectKey = conversation.projectKey?.trim() || conversation.project?.trim();
    if (!projectKey) continue;

    const currentDisplayName = projects.get(projectKey) ?? projectKey;
    projects.set(
      projectKey,
      pickBetterProjectDisplayName(currentDisplayName, conversation.project || projectKey, projectKey)
    );
  }

  return [...projects.entries()]
    .map(([projectKey, displayName]) => ({
      provider: providerName,
      projectKey,
      displayName,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function resolveProviderTitleSyncMode(provider: ConversationProvider | undefined): TitleSyncMode {
  if (!provider) return "overlay";
  return provider.capabilities?.titleSyncMode ?? (provider.updateTitle ? "native" : "overlay");
}

function resolveConversationCapabilities(provider: ConversationProvider | undefined): ConversationCapabilities {
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

function getTitleMutationDisabledReason(
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

function buildProviderPathSettings(providers: ConversationProvider[]) {
  const loadedConfig = getAppConfig();
  const configuredProviders = loadedConfig.config.providers ?? {};

  return providers.flatMap((provider) => {
    if (!isResolvedProviderName(provider.name)) return [];

    const resolvedProviderName = provider.name;
    const resolved = getProviderPaths(resolvedProviderName);
    const configured = configuredProviders[resolvedProviderName];

    return [{
      name: resolvedProviderName,
      displayName: provider.displayName,
      configuredStoragePath: configured?.storagePath,
      configuredStateDbPath: configured?.stateDbPath,
      ...resolved,
    }];
  });
}

async function persistConversationTitle(
  provider: ConversationProvider,
  id: string,
  title: string
): Promise<void> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    throw new Error("标题不能为空");
  }

  if (provider.updateTitle) {
    await provider.updateTitle(id, normalizedTitle);
    await deleteTitle(id);
    return;
  }

  await setTitle(id, normalizedTitle);
}

async function resolveConversationTitle(
  currentTitle: string,
  customTitle: string | null | undefined
): Promise<string> {
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

  if (conversation.titleGenerationHint?.trim()) {
    return [{
      role: "user",
      content: conversation.titleGenerationHint.trim(),
    }];
  }

  return conversation.messages.filter((message) => !!message.content.trim());
}

async function deleteConversationWithCleanup(
  provider: ConversationProvider,
  id: string
): Promise<{ cleanedStale: boolean }> {
  try {
    await provider.delete(id);
    await deleteTitle(id);
    return { cleanedStale: false };
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    await deleteTitle(id);
    return { cleanedStale: true };
  }
}

export function createConversationRoutes(providers: ConversationProvider[]) {
  const app = new Hono();
  const providerByName = new Map(providers.map((provider) => [provider.name, provider]));

  function getProviderListCacheKey(provider: ConversationProvider): string {
    return `${provider.name}::${provider.getStoragePath()}::indexed`;
  }

  // 可用 provider 列表
  app.get("/providers", async (c) => {
    const list = await Promise.all(
      providers.map(async (p) => ({
        name: p.name,
        displayName: p.displayName,
        available: await p.detect(),
        storagePath: p.getStoragePath(),
      }))
    );
    return c.json(list);
  });

  app.get("/settings/provider-paths", async (c) => {
    return c.json({
      configPath: getProviderConfigPath(),
      providers: buildProviderPathSettings(providers),
      ai: {
        titleGenerationCliPriority: getTitleGenerationCliPriority(),
      },
    });
  });

  app.put("/settings/provider-paths", async (c) => {
    const body = await c.req.json<{
      providers?: Record<string, { storagePath?: unknown; stateDbPath?: unknown }>;
      migrations?: Record<string, { storagePath?: unknown; stateDbPath?: unknown }>;
      ai?: { titleGenerationCliPriority?: unknown };
    }>();

    if (!body || typeof body !== "object" || !body.providers || typeof body.providers !== "object") {
      return c.json({ error: "providers 配置不能为空" }, 400);
    }

    const updates: Partial<Record<ResolvedProviderName, ProviderPathConfig>> = {};
    const migrations: Partial<Record<ResolvedProviderName, ProviderPathMigrationSelection>> = {};
    let titleGenerationCliPriority: TitleGenerationCli[] | undefined;

    try {
      for (const [providerName, value] of Object.entries(body.providers)) {
        if (!isResolvedProviderName(providerName)) continue;
        if (!value || typeof value !== "object") {
          return c.json({ error: `${providerName} 配置格式错误` }, 400);
        }

        const nextConfig: ProviderPathConfig = {};

        if ("storagePath" in value) {
          nextConfig.storagePath = normalizeOptionalPathInput(value.storagePath);
        }

        if ("stateDbPath" in value) {
          if (providerName !== "codex" && value.stateDbPath !== null && value.stateDbPath !== undefined) {
            return c.json({ error: `${providerName} 不支持 state db 路径配置` }, 400);
          }
          nextConfig.stateDbPath = normalizeOptionalPathInput(value.stateDbPath);
        }

        updates[providerName] = nextConfig;
      }

      if (body.migrations && typeof body.migrations === "object") {
        for (const [providerName, value] of Object.entries(body.migrations)) {
          if (!isResolvedProviderName(providerName) || !value || typeof value !== "object") continue;

          const nextSelection: ProviderPathMigrationSelection = {};

          if ("storagePath" in value) {
            if (typeof value.storagePath !== "boolean") {
              return c.json({ error: `${providerName} storagePath 迁移标记必须是布尔值` }, 400);
            }
            nextSelection.storagePath = value.storagePath;
          }

          if ("stateDbPath" in value) {
            if (providerName !== "codex") {
              return c.json({ error: `${providerName} 不支持 state db 迁移配置` }, 400);
            }
            if (typeof value.stateDbPath !== "boolean") {
              return c.json({ error: `${providerName} stateDbPath 迁移标记必须是布尔值` }, 400);
            }
            nextSelection.stateDbPath = value.stateDbPath;
          }

          if (nextSelection.storagePath || nextSelection.stateDbPath) {
            migrations[providerName] = nextSelection;
          }
        }
      }

      if (body.ai !== undefined) {
        if (!body.ai || typeof body.ai !== "object") {
          return c.json({ error: "ai 配置格式错误" }, 400);
        }

        if ("titleGenerationCliPriority" in body.ai) {
          if (!Array.isArray(body.ai.titleGenerationCliPriority)) {
            return c.json({ error: "标题生成 CLI 优先级必须是数组" }, 400);
          }
          titleGenerationCliPriority = normalizeTitleGenerationCliPriority(
            body.ai.titleGenerationCliPriority
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
          );
        }
      }
    } catch (error) {
      return c.json({ error: getErrorMessage(error) }, 400);
    }

    const updated = await updateProviderConfigs(updates, process.env, homedir(), {
      migrations,
      ...(titleGenerationCliPriority ? {
        ai: {
          titleGenerationCliPriority,
        },
      } : {}),
    });

    return c.json({
      configPath: getProviderConfigPath(),
      providers: buildProviderPathSettings(providers),
      ai: {
        titleGenerationCliPriority: getTitleGenerationCliPriority(),
      },
      migrationResults: updated.migrationResults,
    });
  });

  // 对话列表
  app.get("/conversations", async (c) => {
    const providerFilter = c.req.query("provider");
    const search = c.req.query("search")?.toLowerCase();
    const sort = c.req.query("sort") || "updatedAt";
    const modelProviderFilter = c.req.query("modelProvider");
    const requireSearchReady = !!search;

    const providerNames = providerFilter !== undefined
      ? providerFilter
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
      : null;
    const activeProviderNameSet = new Set(providerNames ?? providers.map((provider) => provider.name));

    const customTitles = await getAllTitles();
    const indexedCacheKeys: string[] = [];
    const refreshedByProvider = new Map<string, ConversationMeta[]>();
    const searchWarnings = new Set<string>();
    const parsedModelProviders = modelProviderFilter !== undefined
      ? modelProviderFilter.split(",").map((name) => name.trim()).filter(Boolean)
      : undefined;

    for (const provider of providers) {
      const shouldReportWarning = activeProviderNameSet.has(provider.name);
      try {
        const cacheKey = getProviderListCacheKey(provider);
        if (!(await provider.detect())) {
          if (requireSearchReady && shouldReportWarning) {
            searchWarnings.add(`${provider.displayName} 当前不可用，搜索结果可能不完整`);
          }
          continue;
        }
        const sourceSignature = (await provider.getListSourceSignature?.()) ?? undefined;
        if (hasFreshIndexedListCache(cacheKey, undefined, { requireSearchReady, sourceSignature })) {
          indexedCacheKeys.push(cacheKey);
          continue;
        }

        const refreshedItems = await provider.list({ eagerSearchIndex: requireSearchReady });
        if (hasFreshIndexedListCache(cacheKey, undefined, { requireSearchReady, sourceSignature })) {
          indexedCacheKeys.push(cacheKey);
        } else {
          refreshedByProvider.set(provider.name, refreshedItems);
          if (requireSearchReady && shouldReportWarning) {
            searchWarnings.add(`${provider.displayName} 搜索索引尚未就绪，当前仅匹配标题和目录`);
          }
        }
      } catch (error) {
        logProviderError("conversations.list", provider.name, error);
        if (requireSearchReady && shouldReportWarning) {
          searchWarnings.add(`${provider.displayName} 刷新失败，搜索结果可能不完整`);
        }
      }
    }

    const indexedConversationsBase = queryConversationIndex({
      cacheKeys: indexedCacheKeys,
      search,
      sort: sort === "createdAt" || sort === "provider" ? sort : "updatedAt",
    });

    const indexedProviderSet = new Set(
      indexedCacheKeys.map((cacheKey) => cacheKey.split("::")[0])
    );
    const filterByModelProviders = (item: ConversationMeta): boolean => {
      if (item.provider !== "codex") return true;
      if (!item.modelProvider) return true;
      if (modelProviderFilter === undefined) return true;
      if (!parsedModelProviders || parsedModelProviders.length === 0) return false;
      return parsedModelProviders.includes(item.modelProvider);
    };

    let filteredRefreshed = [...refreshedByProvider.entries()].flatMap(([providerName, items]) => {
      if (indexedProviderSet.has(providerName)) {
        return [];
      }
      return items;
    });

    if (search) {
      filteredRefreshed = filteredRefreshed.filter(
        (item) =>
          item.title.toLowerCase().includes(search) ||
          item.project.toLowerCase().includes(search)
      );
    }

    const baseConversations = [...indexedConversationsBase, ...filteredRefreshed];

    // Codex provider facet 依赖当前搜索结果，但不受 modelProvider 自身筛选影响。
    const codexModelProviderCounts: Record<string, number> = {};
    const providerCounts: Record<string, number> = {};
    const providerFacetBase: ConversationMeta[] = [];
    for (const item of baseConversations) {
      if (item.provider === "codex" && item.modelProvider) {
        codexModelProviderCounts[item.modelProvider] = (codexModelProviderCounts[item.modelProvider] ?? 0) + 1;
      }
      if (modelProviderFilter !== undefined && !filterByModelProviders(item)) continue;
      providerFacetBase.push(item);
      providerCounts[item.provider] = (providerCounts[item.provider] ?? 0) + 1;
    }

    const filteredBase = providerFilter !== undefined
      ? providerFacetBase.filter((item) => activeProviderNameSet.has(item.provider))
      : providerFacetBase;

    const filtered = (await Promise.all(filteredBase
      .map(async (conv) => {
        const provider = providerByName.get(conv.provider);
        const resolvedTitle = await resolveConversationTitle(conv.title, customTitles[conv.id]);
        const capabilities = resolveConversationCapabilities(provider);

        return {
          ...conv,
          title: resolvedTitle,
          titleSyncMode: resolveProviderTitleSyncMode(provider),
          capabilities,
        };
      })))
      .sort((a, b) => {
        if (sort === "createdAt") return b.createdAt - a.createdAt;
        if (sort === "provider") {
          return a.provider.localeCompare(b.provider) || b.updatedAt - a.updatedAt;
        }
        return b.updatedAt - a.updatedAt;
      });

    return c.json({
      total: filtered.length,
      conversations: filtered,
      providerCounts,
      codexModelProviderCounts,
      partialSearch: requireSearchReady && searchWarnings.size > 0,
      warnings: [...searchWarnings],
    });
  });

  // 对话详情
  app.get("/conversations/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const providerName = id.split(":")[0];
    const provider = providerByName.get(providerName);
    if (!provider) return c.json({ error: "未知的 provider" }, 404);

    const limitParam = c.req.query("limit");
    const beforeParam = c.req.query("before");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
    const before = beforeParam ? Number.parseInt(beforeParam, 10) : undefined;

    try {
      const conversation = await provider.read(id, {
        limit: Number.isFinite(limit) && limit! > 0 ? limit : undefined,
        before: Number.isFinite(before) && before! >= 0 ? before : undefined,
      });
      const resolvedTitle = await resolveConversationTitle(
        conversation.title,
        await getTitle(id)
      );
      return c.json({
        ...conversation,
        title: resolvedTitle,
        titleSyncMode: resolveProviderTitleSyncMode(provider),
        capabilities: resolveConversationCapabilities(provider),
      });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, getErrorStatus(e));
    }
  });

  app.patch("/conversations/:id/messages/:messageId", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const messageId = decodeURIComponent(c.req.param("messageId"));
    const providerName = id.split(":")[0];
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return c.json({ error: "未知的 provider" }, 404);
    if (!provider.updateMessage) {
      return c.json({ error: `${provider.displayName} 不支持编辑消息` }, 400);
    }

    const body = await c.req.json<{ content?: unknown }>();
    if (typeof body?.content !== "string" || !body.content.trim()) {
      return c.json({ error: "消息内容不能为空" }, 400);
    }

    try {
      await provider.updateMessage(id, messageId, body.content);
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, getErrorStatus(e));
    }
  });

  app.post("/conversations/:id/messages/batch-delete", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const providerName = id.split(":")[0];
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return c.json({ error: "未知的 provider" }, 404);
    if (!provider.deleteMessages && !provider.deleteMessage) {
      return c.json({ error: `${provider.displayName} 不支持删除消息` }, 400);
    }

    const body = await c.req.json<{ messageIds?: unknown }>();
    if (!Array.isArray(body?.messageIds)) {
      return c.json({ error: "messageIds 必须是数组" }, 400);
    }

    const messageIds = body.messageIds
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    if (messageIds.length === 0) {
      return c.json({ error: "待删除消息不能为空" }, 400);
    }

    try {
      if (provider.deleteMessages) {
        await provider.deleteMessages(id, messageIds);
      } else {
        for (const messageId of messageIds) {
          await provider.deleteMessage!(id, messageId);
        }
      }
      return c.json({ success: true, deleted: messageIds.length });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, getErrorStatus(e));
    }
  });

  app.delete("/conversations/:id/messages/:messageId", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const messageId = decodeURIComponent(c.req.param("messageId"));
    const providerName = id.split(":")[0];
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return c.json({ error: "未知的 provider" }, 404);
    if (!provider.deleteMessage) {
      return c.json({ error: `${provider.displayName} 不支持删除消息` }, 400);
    }

    try {
      await provider.deleteMessage(id, messageId);
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, getErrorStatus(e));
    }
  });

  app.post("/conversations/batch-delete", async (c) => {
    const body = await c.req.json<{ ids?: unknown }>();
    if (!Array.isArray(body?.ids)) {
      return c.json({ error: "ids 必须是数组" }, 400);
    }

    const ids = [...new Set(
      body.ids
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )];
    if (ids.length === 0) {
      return c.json({ error: "待删除对话不能为空" }, 400);
    }

    const settled = await Promise.allSettled(ids.map(async (id) => {
      const providerName = id.split(":")[0];
      const provider = providers.find((p) => p.name === providerName);
      if (!provider) {
        throw new Error("未知的 provider");
      }

      await deleteConversationWithCleanup(provider, id);
      return id;
    }));

    const failures = settled.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      return [{
        id: ids[index] || "",
        error: getErrorMessage(result.reason),
      }];
    });

    return c.json({
      success: failures.length === 0,
      deleted: ids.length - failures.length,
      failed: failures.length,
      failures,
    });
  });

  // 删除对话
  app.delete("/conversations/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const providerName = id.split(":")[0];
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return c.json({ error: "未知的 provider" }, 404);

    try {
      const result = await deleteConversationWithCleanup(provider, id);
      return c.json({ success: true, cleanedStale: result.cleanedStale });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, getErrorStatus(e));
    }
  });

  // 修改标题
  app.put("/conversations/:id/title", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const providerName = id.split(":")[0];
    const provider = providerByName.get(providerName);
    if (!provider) return c.json({ error: "未知的 provider" }, 404);
    const disabledReason = getTitleMutationDisabledReason(provider, "update");
    if (disabledReason) return c.json({ error: disabledReason }, 400);

    const body = await c.req.json<{ title: string }>();
    if (!body.title?.trim()) return c.json({ error: "标题不能为空" }, 400);

    await persistConversationTitle(provider, id, body.title.trim());
    return c.json({ success: true, title: body.title.trim() });
  });

  // AI 生成标题
  app.post("/conversations/:id/generate-title", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const providerName = id.split(":")[0];
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return c.json({ error: "未知的 provider" }, 404);
    const disabledReason = getTitleMutationDisabledReason(provider, "generate");
    if (disabledReason) return c.json({ error: disabledReason }, 400);

    try {
      const conversation = await provider.read(id);
      const result = await generateTitle(buildTitleGenerationMessages(conversation), {
        priority: getTitleGenerationCliPriority(),
      });
      await persistConversationTitle(provider, id, result.title);
      return c.json({ success: true, title: result.title, usedCli: result.usedCli });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, getErrorStatus(e));
    }
  });

  app.post("/conversations/generate-title/batch", async (c) => {
    const body = await c.req.json<{ ids?: unknown }>();
    if (!Array.isArray(body?.ids)) {
      return c.json({ error: "ids 必须是数组" }, 400);
    }

    const ids = [...new Set(
      body.ids
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )];
    if (ids.length === 0) {
      return c.json({ error: "待生成标题的对话不能为空" }, 400);
    }

    const results: Array<{ id: string; title?: string; usedCli?: string; error?: string }> = [];

    for (const id of ids) {
      const providerName = id.split(":")[0];
      const provider = providers.find((p) => p.name === providerName);
      if (!provider) {
        results.push({ id, error: "未知的 provider" });
        continue;
      }
      const disabledReason = getTitleMutationDisabledReason(provider, "generate");
      if (disabledReason) {
        results.push({ id, error: disabledReason });
        continue;
      }

      try {
        const conversation = await provider.read(id);
        const result = await generateTitle(buildTitleGenerationMessages(conversation), {
          priority: getTitleGenerationCliPriority(),
        });
        await persistConversationTitle(provider, id, result.title);
        results.push({
          id,
          title: result.title,
          usedCli: result.usedCli,
        });
      } catch (e) {
        results.push({
          id,
          error: getErrorMessage(e),
        });
      }
    }

    const generated = results.filter((item) => !!item.title).length;
    return c.json({
      success: generated === results.length,
      generated,
      failed: results.length - generated,
      results,
    });
  });

  // 移动对话到另一个项目文件夹
  app.post("/conversations/:id/move", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const providerName = id.split(":")[0];
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return c.json({ error: "未知的 provider" }, 404);
    if (!provider.move) return c.json({ error: `${provider.displayName} 不支持移动对话` }, 400);

    const body = await c.req.json<{ targetProjectKey: string }>();
    if (!body.targetProjectKey?.trim()) return c.json({ error: "目标文件夹不能为空" }, 400);

    try {
      await provider.move(id, body.targetProjectKey.trim());
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, getErrorStatus(e));
    }
  });

  // 列出某个 provider 的所有项目文件夹
  app.get("/projects", async (c) => {
    const providerFilter = c.req.query("provider");
    const result: { provider: string; projectKey: string; displayName: string }[] = [];

    for (const p of providers) {
      if (providerFilter && p.name !== providerFilter) continue;

      try {
        const cacheKey = getProviderListCacheKey(p);
        const sourceSignature = (await p.getListSourceSignature?.()) ?? undefined;
        if (hasFreshIndexedListCache(cacheKey, undefined, { sourceSignature })) {
          const cachedItems = getIndexedListSnapshot(cacheKey);
          if (cachedItems) {
            result.push(...buildProjectInfosFromConversations(p.name, cachedItems));
            continue;
          }
        }

        if (!p.listProjects) continue;
        const projects = await p.listProjects();
        for (const pk of projects) {
          result.push({
            provider: p.name,
            projectKey: pk,
            displayName: pk,
          });
        }
      } catch (error) {
        logProviderError("projects.list", p.name, error);
      }
    }
    return c.json(result);
  });

  // 可用的 AI CLI 工具
  app.get("/ai/clis", async (c) => {
    const clis = await getAvailableClis();
    return c.json(clis);
  });

  app.delete("/ai/clis/sessions", async (c) => {
    await resetSession();
    return c.json({ success: true });
  });

  app.delete("/ai/clis/:name/session", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    if (!isTitleGenerationCli(name)) {
      return c.json({ error: "未知的 AI CLI" }, 404);
    }

    await resetSession(name);
    return c.json({ success: true });
  });

  // Codex model_provider 列表
  app.get("/codex-providers", (c) => {
    const codex = providers.find((p) => p.name === "codex") as CodexProvider | undefined;
    if (!codex) return c.json([]);
    return c.json(codex.listModelProviders());
  });

  // 批量修改 Codex 对话的 model_provider
  app.put("/conversations/model-provider/batch", async (c) => {
    const codex = providers.find((p) => p.name === "codex") as CodexProvider | undefined;
    if (!codex) return c.json({ error: "Codex provider 不可用" }, 404);

    const body = await c.req.json<{ ids?: unknown; modelProvider?: unknown }>();
    if (!Array.isArray(body?.ids)) {
      return c.json({ error: "ids 必须是数组" }, 400);
    }

    const ids = body.ids
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return c.json({ error: "待修改对话不能为空" }, 400);
    }
    if (ids.some((id) => !id.startsWith("codex:"))) {
      return c.json({ error: "批量切换 model provider 仅支持 Codex 对话" }, 400);
    }

    if (typeof body.modelProvider !== "string" || !body.modelProvider.trim()) {
      return c.json({ error: "model provider 不能为空" }, 400);
    }

    try {
      const updated = await codex.changeModelProviders(ids, body.modelProvider.trim());
      return c.json({ success: true, updated });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, getErrorStatus(e));
    }
  });

  // 修改 Codex 对话的 model_provider
  app.put("/conversations/:id/model-provider", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!id.startsWith("codex:")) {
      return c.json({ error: "仅支持修改 Codex 对话的 model provider" }, 400);
    }

    const codex = providers.find((p) => p.name === "codex") as CodexProvider | undefined;
    if (!codex) return c.json({ error: "Codex provider 不可用" }, 404);

    const body = await c.req.json<{ modelProvider: string }>();
    if (!body.modelProvider?.trim()) {
      return c.json({ error: "model provider 不能为空" }, 400);
    }

    try {
      await codex.changeModelProvider(id, body.modelProvider.trim());
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, getErrorStatus(e));
    }
  });

  return app;
}
