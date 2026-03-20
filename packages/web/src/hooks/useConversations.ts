import { useState, useEffect, useCallback } from "react";
import {
  fetchProviders,
  fetchConversations,
  fetchConversation,
  type ProviderInfo,
  type ConversationMeta,
  type Conversation,
} from "../lib/api";

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 加载 provider 列表
  useEffect(() => {
    fetchProviders().then((list) => {
      setProviders(list);
      const available = list.filter((p) => p.available).map((p) => p.name);
      setActiveProviders(new Set(available));
    });
  }, []);

  // 加载对话列表
  const loadConversations = useCallback(async () => {
    setLoading(true);
    try {
      const providerParam =
        activeProviders.size > 0 ? Array.from(activeProviders).join(",") : undefined;
      const data = await fetchConversations({
        provider: providerParam,
        search: search || undefined,
        sort,
      });
      setConversations(data.conversations);
      setTotal(data.total);
    } catch (e) {
      console.error("加载对话列表失败:", e);
    } finally {
      setLoading(false);
    }
  }, [activeProviders, search, sort]);

  useEffect(() => {
    if (activeProviders.size > 0) {
      loadConversations();
    }
  }, [loadConversations, activeProviders]);

  // 选择对话
  const selectConversation = useCallback(async (id: string) => {
    setSelectedId(id);
    setLoadingDetail(true);
    try {
      const conv = await fetchConversation(id);
      setConversation(conv);
    } catch (e) {
      console.error("加载对话详情失败:", e);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const toggleProvider = useCallback((name: string) => {
    setActiveProviders((prev) => {
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
    refresh: loadConversations,
    selectedIds,
    toggleSelect,
    selectAll,
    deselectAll,
    toggleSelectGroup,
  };
}
