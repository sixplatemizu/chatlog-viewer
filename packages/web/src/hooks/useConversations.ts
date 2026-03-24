import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchProviders,
  fetchConversations,
  fetchConversation,
  fetchCodexProviders,
  getErrorMessage,
  isAbortError,
  type ProviderInfo,
  type ConversationMeta,
  type Conversation,
  type CodexModelProvider,
} from "../lib/api";
import type { ToastPayload } from "../components/ToastViewport";

const SEARCH_DEBOUNCE_MS = 350;
const DETAIL_PAGE_SIZE = 200;

interface UseConversationsOptions {
  onNotify?: (toast: ToastPayload) => void;
}

function resolveActiveProviders(current: Set<string>, providerList: ProviderInfo[]): Set<string> {
  const available = providerList.filter((p) => p.available).map((p) => p.name);
  if (current.size === 0) return new Set(available);

  const preserved = available.filter((name) => current.has(name));
  return new Set(preserved.length > 0 ? preserved : available);
}

function resolveActiveModelProviders(
  current: Set<string>,
  modelProviders: CodexModelProvider[]
): Set<string> {
  const availableNames = modelProviders.map((provider) => provider.name);
  if (current.size === 0) return new Set(availableNames);

  const preserved = availableNames.filter((name) => current.has(name));
  return new Set(preserved.length > 0 ? preserved : availableNames);
}

function getModelProviderParam(
  activeProviders: Set<string>,
  activeModelProviders: Set<string>,
  modelProviders: CodexModelProvider[]
): string | undefined {
  if (!activeProviders.has("codex") || modelProviders.length === 0) {
    return undefined;
  }

  if (activeModelProviders.size >= modelProviders.length) {
    return undefined;
  }

  return Array.from(activeModelProviders).join(",");
}

export function useConversations(options: UseConversationsOptions = {}) {
  const { onNotify } = options;
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [activeProviders, setActiveProviders] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("updatedAt");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [codexModelProviders, setCodexModelProviders] = useState<CodexModelProvider[]>([]);
  const [activeModelProviders, setActiveModelProviders] = useState<Set<string>>(new Set());
  const detailAbortRef = useRef<AbortController | null>(null);
  const activeProvidersRef = useRef(activeProviders);
  const activeModelProvidersRef = useRef(activeModelProviders);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    activeProvidersRef.current = activeProviders;
  }, [activeProviders]);

  useEffect(() => {
    activeModelProvidersRef.current = activeModelProviders;
  }, [activeModelProviders]);

  const notifyError = useCallback(
    (title: string, error: unknown, fallback: string) => {
      const message = getErrorMessage(error, fallback);
      console.error(`${title}:`, message);
      onNotify?.({
        variant: "error",
        title,
        description: message,
      });
    },
    [onNotify]
  );

  const loadProviderData = useCallback(async (signal?: AbortSignal) => {
    const [providerList, modelProviders] = await Promise.all([
      fetchProviders(signal),
      fetchCodexProviders(signal),
    ]);

    const nextActiveProviders = resolveActiveProviders(activeProvidersRef.current, providerList);
    const nextActiveModelProviders = resolveActiveModelProviders(
      activeModelProvidersRef.current,
      modelProviders
    );

    setProviders(providerList);
    setActiveProviders(nextActiveProviders);
    setCodexModelProviders(modelProviders);
    setActiveModelProviders(nextActiveModelProviders);
    activeProvidersRef.current = nextActiveProviders;
    activeModelProvidersRef.current = nextActiveModelProviders;

    return {
      providerList,
      modelProviders,
      nextActiveProviders,
      nextActiveModelProviders,
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [search]);

  // 加载 provider 列表
  useEffect(() => {
    const abortController = new AbortController();

    loadProviderData(abortController.signal)
      .catch((error) => {
        if (!isAbortError(error)) {
          notifyError("初始化数据加载失败", error, "初始化数据加载失败");
        }
      });

    return () => abortController.abort();
  }, [loadProviderData, notifyError]);

  // 加载对话列表
  const loadConversations = useCallback(async (
    signal?: AbortSignal,
    overrides?: {
      providerList?: ProviderInfo[];
      activeProviderSet?: Set<string>;
      modelProviders?: CodexModelProvider[];
      activeModelProviderSet?: Set<string>;
    }
  ) => {
    setLoading(true);

    const currentProviders = overrides?.providerList ?? providers;
    const currentActiveProviders = overrides?.activeProviderSet ?? activeProviders;
    const currentModelProviders = overrides?.modelProviders ?? codexModelProviders;
    const currentActiveModelProviders = overrides?.activeModelProviderSet ?? activeModelProviders;

    if (currentProviders.length > 0 && currentActiveProviders.size === 0) {
      setConversations([]);
      setTotal(0);
      setLoading(false);
      return { total: 0, conversations: [] as ConversationMeta[] };
    }

    const providerParam =
      currentProviders.length > 0 ? Array.from(currentActiveProviders).join(",") : undefined;
    const modelProviderParam = getModelProviderParam(
      currentActiveProviders,
      currentActiveModelProviders,
      currentModelProviders
    );

    try {
      const data = await fetchConversations({
        provider: providerParam,
        search: debouncedSearch || undefined,
        sort,
        modelProvider: modelProviderParam,
        signal,
      });
      setConversations(data.conversations);
      setTotal(data.total);
      return data;
    } catch (error) {
      if (!isAbortError(error)) {
        notifyError("加载对话列表失败", error, "加载对话列表失败");
      }
      return null;
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [activeModelProviders, activeProviders, codexModelProviders, debouncedSearch, notifyError, providers, sort]);

  useEffect(() => {
    const abortController = new AbortController();
    void loadConversations(abortController.signal);
    return () => abortController.abort();
  }, [loadConversations]);

  // 当前选中项如果不在过滤后的列表中，则清空详情
  useEffect(() => {
    if (!selectedId) return;
    if (conversations.some((item) => item.id === selectedId)) return;
    setSelectedId(null);
    setConversation(null);
  }, [conversations, selectedId]);

  const loadConversationDetail = useCallback(
    async (id: string, options?: { appendEarlier?: boolean }) => {
      const appendEarlier = options?.appendEarlier ?? false;

      detailAbortRef.current?.abort();
      const abortController = new AbortController();
      detailAbortRef.current = abortController;

      if (appendEarlier) {
        setLoadingEarlier(true);
      } else {
        setSelectedId(id);
        setLoadingDetail(true);
        setConversation(null);
      }

      try {
        const before = appendEarlier ? conversation?.messages.length ?? 0 : 0;
        const conv = await fetchConversation(id, {
          limit: DETAIL_PAGE_SIZE,
          before,
          signal: abortController.signal,
        });

        if (appendEarlier && conversation && conversation.id === id) {
          setConversation({
            ...conv,
            messages: [...conv.messages, ...conversation.messages],
          });
        } else {
          setConversation(conv);
        }
      } catch (error) {
        if (!isAbortError(error)) {
          notifyError("加载对话详情失败", error, "加载对话详情失败");
          setConversation(null);
        }
      } finally {
        if (!abortController.signal.aborted) {
          if (appendEarlier) {
            setLoadingEarlier(false);
          } else {
            setLoadingDetail(false);
          }
        }
      }
    },
    [conversation, notifyError]
  );

  const reloadAllData = useCallback(async () => {
    const providerState = await loadProviderData();
    const listData = await loadConversations(undefined, {
      providerList: providerState.providerList,
      activeProviderSet: providerState.nextActiveProviders,
      modelProviders: providerState.modelProviders,
      activeModelProviderSet: providerState.nextActiveModelProviders,
    });

    if (!selectedId) return;

    if (listData?.conversations.some((item) => item.id === selectedId)) {
      await loadConversationDetail(selectedId);
    } else {
      setSelectedId(null);
      setConversation(null);
    }
  }, [loadConversationDetail, loadConversations, loadProviderData, selectedId]);

  // 选择对话
  const selectConversation = useCallback(async (id: string) => {
    await loadConversationDetail(id);
  }, [loadConversationDetail]);

  const loadEarlierMessages = useCallback(async () => {
    if (!conversation || !conversation.hasMore || loadingEarlier) return;
    await loadConversationDetail(conversation.id, { appendEarlier: true });
  }, [conversation, loadConversationDetail, loadingEarlier]);

  useEffect(() => {
    return () => {
      detailAbortRef.current?.abort();
    };
  }, []);

  const toggleProvider = useCallback((name: string) => {
    setActiveProviders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleModelProvider = useCallback((name: string) => {
    setActiveModelProviders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // 多选操作
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(conversations.map((c) => c.id)));
  }, [conversations]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const toggleSelectGroup = useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      if (allSelected) {
        ids.forEach((id) => next.delete(id));
      } else {
        ids.forEach((id) => next.add(id));
      }
      return next;
    });
  }, []);

  return {
    providers,
    conversations,
    total,
    loading,
    activeProviders,
    toggleProvider,
    search,
    setSearch,
    sort,
    setSort,
    selectedId,
    selectConversation,
    conversation,
    loadingDetail,
    loadingEarlier,
    loadEarlierMessages,
    refresh: loadConversations,
    selectedIds,
    toggleSelect,
    selectAll,
    deselectAll,
    toggleSelectGroup,
    codexModelProviders,
    activeModelProviders,
    toggleModelProvider,
    reloadProviders: loadProviderData,
    reloadAllData,
  };
}
