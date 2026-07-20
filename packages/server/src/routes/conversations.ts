import { Hono } from "hono";
import type {
  ConversationProvider,
  ConversationMeta,
} from "../providers/types.js";
import { CodexProvider } from "../providers/codex.js";
import { getAllTitles, getTitle, deleteTitle, deleteNativeTitleSnapshot } from "../utils/title-store.js";
import { getIndexedListSnapshot, hasFreshIndexedListCache, queryConversationIndex } from "../utils/cache.js";
import { getErrorMessage, getErrorStatus, isNotFoundError } from "../utils/errors.js";
import { logProviderError } from "../utils/logger.js";
import {
  generateAndPersistConversationTitle,
  getTitleMutationDisabledReason,
  normalizeTitle,
  persistConversationTitle,
  resolveConversationCapabilities,
  resolveConversationTitle,
  resolveProviderTitleSyncMode,
} from "../services/conversation-title.js";

const MAX_BATCH_CONVERSATION_IDS = 500;
const MAX_BATCH_MESSAGE_IDS = 2_000;
const MAX_MODEL_PROVIDER_LENGTH = 100;
const MAX_MESSAGE_CONTENT_LENGTH = 1_000_000;
const DEFAULT_CONVERSATION_LIST_LIMIT = 5_000;
const MAX_CONVERSATION_LIST_LIMIT = 5_000;

function normalizeProjectDisplayPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").trim();
}

function normalizeStringArrayField(
  value: unknown,
  fieldName: string,
  options: { maxItems: number; emptyMessage: string }
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} 必须是数组`);
  }

  const items = [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
  )];

  if (items.length === 0) {
    throw new Error(options.emptyMessage);
  }
  if (items.length > options.maxItems) {
    throw new Error(`${fieldName} 单次最多支持 ${options.maxItems} 项`);
  }

  return items;
}

function normalizeBoundedStringField(
  value: unknown,
  fieldName: string,
  options: { maxLength: number; emptyMessage: string }
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(options.emptyMessage);
  }

  const normalized = value.trim();
  if (normalized.length > options.maxLength) {
    throw new Error(`${fieldName} 不能超过 ${options.maxLength} 个字符`);
  }

  return normalized;
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

  // 对话列表
  app.get("/conversations", async (c) => {
    const providerFilter = c.req.query("provider");
    const search = c.req.query("search")?.toLowerCase();
    const sort = c.req.query("sort") || "updatedAt";
    const modelProviderFilter = c.req.query("modelProvider");
    const requireSearchReady = !!search;
    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");
    const requestedLimit = limitParam ? Number.parseInt(limitParam, 10) : DEFAULT_CONVERSATION_LIST_LIMIT;
    const requestedOffset = offsetParam ? Number.parseInt(offsetParam, 10) : 0;
    const listLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_CONVERSATION_LIST_LIMIT)
      : DEFAULT_CONVERSATION_LIST_LIMIT;
    const listOffset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;

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
    const providerWarnings = new Set<string>();
    const parsedModelProviders = modelProviderFilter !== undefined
      ? modelProviderFilter.split(",").map((name) => name.trim()).filter(Boolean)
      : undefined;

    const activeProviders = providers.filter((provider) => activeProviderNameSet.has(provider.name));
    const providerRefreshResults = await Promise.all(activeProviders.map(async (provider) => {
      try {
        const cacheKey = getProviderListCacheKey(provider);
        if (!(await provider.detect())) {
          return {
            warning: `${provider.displayName} 当前不可用，结果可能不完整`,
          };
        }
        const sourceSignature = (await provider.getListSourceSignature?.()) ?? undefined;
        if (hasFreshIndexedListCache(cacheKey, undefined, { requireSearchReady, sourceSignature })) {
          return { cacheKey };
        }

        const refreshedItems = await provider.list({ eagerSearchIndex: requireSearchReady });
        if (hasFreshIndexedListCache(cacheKey, undefined, { requireSearchReady, sourceSignature })) {
          return { cacheKey };
        }

        return {
          providerName: provider.name,
          refreshedItems,
          warning: requireSearchReady
            ? `${provider.displayName} 搜索索引尚未就绪，当前仅匹配标题和目录`
            : undefined,
        };
      } catch (error) {
        logProviderError("conversations.list", provider.name, error);
        return {
          warning: `${provider.displayName} 刷新失败：${getErrorMessage(error)}，结果可能不完整`,
        };
      }
    }));

    for (const result of providerRefreshResults) {
      if (result.cacheKey) {
        indexedCacheKeys.push(result.cacheKey);
      }
      if (result.providerName && result.refreshedItems) {
        refreshedByProvider.set(result.providerName, result.refreshedItems);
      }
      if (result.warning) {
        providerWarnings.add(result.warning);
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
        const resolvedTitle = await resolveConversationTitle(provider, conv.title, customTitles[conv.id]);
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

    const conversationsPage = filtered.slice(listOffset, listOffset + listLimit);

    return c.json({
      total: filtered.length,
      conversations: conversationsPage,
      providerCounts,
      codexModelProviderCounts,
      listTruncated: conversationsPage.length + listOffset < filtered.length,
      nextOffset: conversationsPage.length + listOffset < filtered.length
        ? listOffset + conversationsPage.length
        : undefined,
      partialSearch: requireSearchReady && providerWarnings.size > 0,
      partialResults: providerWarnings.size > 0,
      warnings: [...providerWarnings],
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
        provider,
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
    const capabilities = resolveConversationCapabilities(provider);
    if (!capabilities.canEditMessage || !provider.updateMessage) {
      return c.json({
        error: capabilities.editMessageDisabledReason ?? `${provider.displayName} 不支持编辑消息`,
      }, 400);
    }

    const body = await c.req.json<{ content?: unknown }>();
    if (typeof body?.content !== "string" || !body.content.trim()) {
      return c.json({ error: "消息内容不能为空" }, 400);
    }
    if (body.content.length > MAX_MESSAGE_CONTENT_LENGTH) {
      return c.json({ error: `消息内容不能超过 ${MAX_MESSAGE_CONTENT_LENGTH} 个字符` }, 400);
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
    const capabilities = resolveConversationCapabilities(provider);
    if (!capabilities.canDeleteMessage || (!provider.deleteMessages && !provider.deleteMessage)) {
      return c.json({
        error: capabilities.deleteMessageDisabledReason ?? `${provider.displayName} 不支持删除消息`,
      }, 400);
    }

    const body = await c.req.json<{ messageIds?: unknown }>();
    let messageIds: string[];
    try {
      messageIds = normalizeStringArrayField(body?.messageIds, "messageIds", {
        maxItems: MAX_BATCH_MESSAGE_IDS,
        emptyMessage: "待删除消息不能为空",
      });
    } catch (error) {
      return c.json({ error: getErrorMessage(error) }, 400);
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
    const capabilities = resolveConversationCapabilities(provider);
    if (!capabilities.canDeleteMessage || !provider.deleteMessage) {
      return c.json({
        error: capabilities.deleteMessageDisabledReason ?? `${provider.displayName} 不支持删除消息`,
      }, 400);
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
    let ids: string[];
    try {
      ids = normalizeStringArrayField(body?.ids, "ids", {
        maxItems: MAX_BATCH_CONVERSATION_IDS,
        emptyMessage: "待删除对话不能为空",
      });
    } catch (error) {
      return c.json({ error: getErrorMessage(error) }, 400);
    }

    const settled = await Promise.allSettled(ids.map(async (id) => {
      const providerName = id.split(":")[0];
      const provider = providers.find((p) => p.name === providerName);
      if (!provider) {
        throw new Error("未知的 provider");
      }
      const capabilities = resolveConversationCapabilities(provider);
      if (!capabilities.canDeleteConversation) {
        throw new Error(
          capabilities.deleteConversationDisabledReason ?? `${provider.displayName} 不支持删除对话`
        );
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
    const capabilities = resolveConversationCapabilities(provider);
    if (!capabilities.canDeleteConversation) {
      return c.json({
        error: capabilities.deleteConversationDisabledReason ?? `${provider.displayName} 不支持删除对话`,
      }, 400);
    }

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

    const body = await c.req.json<{ title?: unknown }>();
    let title: string;
    try {
      title = normalizeTitle(body?.title);
    } catch (error) {
      return c.json({ error: getErrorMessage(error) }, 400);
    }

    await persistConversationTitle(provider, id, title);
    return c.json({ success: true, title });
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
      const result = await generateAndPersistConversationTitle(providers, provider, id);
      return c.json(result);
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, getErrorStatus(e));
    }
  });

  app.post("/conversations/generate-title/batch", async (c) => {
    const body = await c.req.json<{ ids?: unknown }>();
    let ids: string[];
    try {
      ids = normalizeStringArrayField(body?.ids, "ids", {
        maxItems: MAX_BATCH_CONVERSATION_IDS,
        emptyMessage: "待生成标题的对话不能为空",
      });
    } catch (error) {
      return c.json({ error: getErrorMessage(error) }, 400);
    }

    const results: Array<{
      id: string;
      title?: string;
      usedCli?: string;
      cleanedTitleSessions?: number;
      error?: string;
    }> = [];

    for (const id of ids) {
      const providerName = id.split(":")[0];
      const provider = providers.find((p) => p.name === providerName);
      if (!provider) {
        results.push({ id, error: "未知的 provider" });
        continue;
      }
      try {
        const result = await generateAndPersistConversationTitle(providers, provider, id);
        results.push({
          id,
          title: result.title,
          usedCli: result.usedCli,
          cleanedTitleSessions: result.cleanedTitleSessions,
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
    const capabilities = resolveConversationCapabilities(provider);
    if (!capabilities.canMoveConversation || !provider.move) {
      return c.json({
        error: capabilities.moveConversationDisabledReason ?? `${provider.displayName} 不支持移动对话`,
      }, 400);
    }

    const body = await c.req.json<{ targetProjectKey?: unknown }>();
    let targetProjectKey: string;
    try {
      targetProjectKey = normalizeBoundedStringField(body?.targetProjectKey, "targetProjectKey", {
        maxLength: 1_000,
        emptyMessage: "目标文件夹不能为空",
      });
    } catch (error) {
      return c.json({ error: getErrorMessage(error) }, 400);
    }

    try {
      await provider.move(id, targetProjectKey);
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, getErrorStatus(e));
    }
  });

  // 批量移动对话到同一 provider 下的指定项目文件夹
  app.post("/conversations/move/batch", async (c) => {
    const body = await c.req.json<{ ids?: unknown; targetProjectKey?: unknown }>();
    let ids: string[];
    let targetProjectKey: string;
    try {
      ids = normalizeStringArrayField(body?.ids, "ids", {
        maxItems: MAX_BATCH_CONVERSATION_IDS,
        emptyMessage: "待移动对话不能为空",
      });
      targetProjectKey = normalizeBoundedStringField(body?.targetProjectKey, "targetProjectKey", {
        maxLength: 1_000,
        emptyMessage: "目标文件夹不能为空",
      });
    } catch (error) {
      return c.json({ error: getErrorMessage(error) }, 400);
    }

    // 要求所有对话来自同一 provider —— 不同 provider 的 projectKey 语义不一致。
    const providerNames = new Set(ids.map((id) => id.split(":")[0]));
    if (providerNames.size > 1) {
      return c.json({ error: "批量移动仅支持来自同一 CLI 的对话" }, 400);
    }

    const providerName = [...providerNames][0];
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return c.json({ error: "未知的 provider" }, 404);
    const capabilities = resolveConversationCapabilities(provider);
    if (!capabilities.canMoveConversation || !provider.move) {
      return c.json({
        error: capabilities.moveConversationDisabledReason ?? `${provider.displayName} 不支持移动对话`,
      }, 400);
    }

    const settled = await Promise.allSettled(ids.map(async (id) => {
      await provider.move!(id, targetProjectKey);
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
      moved: ids.length - failures.length,
      failed: failures.length,
      failures,
    });
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

  // 批量修改 Codex 对话的 model_provider
  app.put("/conversations/model-provider/batch", async (c) => {
    const codex = providers.find((p) => p.name === "codex") as CodexProvider | undefined;
    if (!codex) return c.json({ error: "Codex provider 不可用" }, 404);

    const body = await c.req.json<{ ids?: unknown; modelProvider?: unknown }>();
    let ids: string[];
    let modelProvider: string;
    try {
      ids = normalizeStringArrayField(body?.ids, "ids", {
        maxItems: MAX_BATCH_CONVERSATION_IDS,
        emptyMessage: "待修改对话不能为空",
      });
      modelProvider = normalizeBoundedStringField(body?.modelProvider, "modelProvider", {
        maxLength: MAX_MODEL_PROVIDER_LENGTH,
        emptyMessage: "model provider 不能为空",
      });
    } catch (error) {
      return c.json({ error: getErrorMessage(error) }, 400);
    }
    if (ids.some((id) => !id.startsWith("codex:"))) {
      return c.json({ error: "批量切换 model provider 仅支持 Codex 对话" }, 400);
    }

    try {
      const updated = await codex.changeModelProviders(ids, modelProvider);
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

    const body = await c.req.json<{ modelProvider?: unknown }>();
    let modelProvider: string;
    try {
      modelProvider = normalizeBoundedStringField(body?.modelProvider, "modelProvider", {
        maxLength: MAX_MODEL_PROVIDER_LENGTH,
        emptyMessage: "model provider 不能为空",
      });
    } catch (error) {
      return c.json({ error: getErrorMessage(error) }, 400);
    }

    try {
      await codex.changeModelProvider(id, modelProvider);
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, getErrorStatus(e));
    }
  });

  return app;
}
