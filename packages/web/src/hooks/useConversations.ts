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

const SEARCH_DEBOUNCE_MS = 350;
const DETAIL_PAGE_SIZE = 200;

export function useConversations() {
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
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [search]);

  // 加载 provider 列表
  useEffect(() => {
    const abortController = new AbortController();

    Promise.all([
      fetchProviders(abortController.signal),
      fetchCodexProviders(abortController.signal),
    ])
      .then(([providerList, modelProviders]) => {
        setProviders(providerList);
        const available = providerList.filter((p) => p.available).map((p) => p.name);
        setActiveProviders(new Set(available));
        setCodexModelProviders(modelProviders);
        setActiveModelProviders(new Set(modelProviders.map((m) => m.name)));
      })
      .catch((error) => {
        if (!isAbortError(error)) {
          console.error("初始化数据加载失败:", getErrorMessage(error, "初始化数据加载失败"));
        }
      });

    return () => abortController.abort();
  }, []);

  // 加载对话列表
  const loadConversations = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);

    if (providers.length > 0 && activeProviders.size === 0) {
      setConversations([]);
      setTotal(0);
      setLoading(false);
      return;
    }

    const providerParam =
      providers.length > 0 ? Array.from(activeProviders).join(",") : undefined;

    let modelProviderParam: string | undefined;
    if (activeProviders.has("codex") && codexModelProviders.length > 0) {
      if (activeModelProviders.size < codexModelProviders.length) {
        modelProviderParam = Array.from(activeModelProviders).join(",");
      }
    }

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
    } catch (error) {
      if (!isAbortError(error)) {
        console.error("加载对话列表失败:", getErrorMessage(error, "加载对话列表失败"));
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [activeModelProviders, activeProviders, codexModelProviders.length, debouncedSearch, providers.length, sort]);

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
          console.error("加载对话详情失败:", getErrorMessage(error, "加载对话详情失败"));
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
    [conversation]
  );

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
  };
}
