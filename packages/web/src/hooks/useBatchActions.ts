import { useCallback, useRef, useState } from "react";
import {
  changeModelProviders,
  generateAiTitles,
  getErrorMessage,
  moveConversations,
  type ConversationMeta,
} from "../lib/api";
import type { ToastPayload } from "../components/ToastViewport";

const TITLE_BATCH_SIZE = 5;

export interface GenProgress {
  total: number;
  current: number;
  currentTitle: string;
  results: { id: string; title?: string; error?: string }[];
}

interface UseBatchActionsOptions {
  conversations: ConversationMeta[];
  selectedIds: Set<string>;
  ensureModelProviderVisible: (name: string) => void;
  reloadAllData: () => Promise<void>;
  pushToast: (payload: ToastPayload) => void;
}

// 封装批量异步操作：AI 批量生成标题、批量切换 Codex provider、批量移动到目录。
// 不涉及导出/删除确认弹窗，那些保留在 App.tsx（纯 UI state）。
export function useBatchActions({
  conversations,
  selectedIds,
  ensureModelProviderVisible,
  reloadAllData,
  pushToast,
}: UseBatchActionsOptions) {
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState<GenProgress | null>(null);
  const abortRef = useRef(false);

  const handleBatchChangeModelProvider = useCallback(
    async (newProvider: string) => {
      const targetProvider = newProvider.trim();
      if (!targetProvider || selectedIds.size === 0) return;

      const selectedConversations = conversations.filter((item) => selectedIds.has(item.id));
      if (selectedConversations.length === 0) return;

      if (selectedConversations.some((item) => item.provider !== "codex")) {
        pushToast({
          variant: "warning",
          title: "不支持批量切换",
          description: "批量 provider 切换目前仅支持 Codex 对话",
        });
        return;
      }

      if (selectedConversations.every((item) => item.modelProvider === targetProvider)) {
        pushToast({
          variant: "info",
          title: "无需切换",
          description: `已选对话当前都已使用 ${targetProvider}`,
        });
        return;
      }

      try {
        const res = await changeModelProviders(
          selectedConversations.map((item) => item.id),
          targetProvider
        );
        if (res.success) {
          ensureModelProviderVisible(targetProvider);
          await reloadAllData();
          pushToast({
            variant: "info",
            title: "批量切换完成",
            description: `已更新 ${res.updated} 条 Codex 对话`,
          });
        } else {
          pushToast({
            variant: "error",
            title: "批量切换失败",
            description: res.error,
          });
        }
      } catch (error) {
        pushToast({
          variant: "error",
          title: "批量切换失败",
          description: getErrorMessage(error, "批量切换失败"),
        });
      }
    },
    [conversations, ensureModelProviderVisible, pushToast, reloadAllData, selectedIds]
  );

  const handleBatchMove = useCallback(
    async (targetProjectKey: string) => {
      const key = targetProjectKey.trim();
      if (!key || selectedIds.size === 0) return;

      const selectedConversations = conversations.filter((item) => selectedIds.has(item.id));
      if (selectedConversations.length === 0) return;
      const unsupported = selectedConversations.find(
        (item) => item.capabilities?.canMoveConversation === false
      );
      if (unsupported) {
        pushToast({
          variant: "warning",
          title: "当前选择不支持批量移动",
          description: unsupported.capabilities?.moveConversationDisabledReason,
        });
        return;
      }

      const providerNames = new Set(selectedConversations.map((item) => item.provider));
      if (providerNames.size > 1) {
        pushToast({
          variant: "warning",
          title: "不支持跨工具批量移动",
          description: "请只选择同一 CLI 的对话后再批量移动",
        });
        return;
      }

      if (selectedConversations.every((item) => item.projectKey === key)) {
        pushToast({
          variant: "info",
          title: "无需移动",
          description: "已选对话都在该目录下",
        });
        return;
      }

      try {
        const res = await moveConversations(
          selectedConversations.map((item) => item.id),
          key
        );
        if (res.success) {
          await reloadAllData();
          pushToast({
            variant: "info",
            title: "批量移动完成",
            description: `已移动 ${res.moved} 条对话`,
          });
        } else {
          pushToast({
            variant: "error",
            title: "部分对话移动失败",
            description: `成功 ${res.moved} 条，失败 ${res.failed} 条${res.failures[0]?.error ? `：${res.failures[0].error}` : ""}`,
          });
          await reloadAllData();
        }
      } catch (error) {
        pushToast({
          variant: "error",
          title: "批量移动失败",
          description: getErrorMessage(error, "批量移动失败"),
        });
      }
    },
    [conversations, pushToast, reloadAllData, selectedIds]
  );

  const handleBatchGenerate = useCallback(async () => {
    if (selectedIds.size === 0 || batchGenerating) return;
    const selectedConversations = conversations.filter((item) => selectedIds.has(item.id));
    const unsupportedConversations = selectedConversations.filter(
      (item) => item.capabilities?.canGenerateTitle === false
    );
    const unsupportedCount = unsupportedConversations.length;
    const ids = selectedConversations
      .filter((item) => item.capabilities?.canGenerateTitle !== false)
      .map((item) => item.id);
    const disabledReason = unsupportedConversations[0]?.capabilities?.generateTitleDisabledReason;

    if (ids.length === 0) {
      pushToast({
        variant: "warning",
        title: "当前选择不支持批量标题生成",
        description: disabledReason ?? "当前选中的对话不能修改标题",
      });
      return;
    }

    if (unsupportedCount > 0) {
      pushToast({
        variant: "warning",
        title: "已跳过不支持的对话",
        description: disabledReason
          ? `${unsupportedCount} 条对话不支持标题生成：${disabledReason}`
          : `${unsupportedCount} 条对话不支持标题生成，本次仅处理其他 provider`,
        duration: 6000,
      });
    }

    setBatchGenerating(true);
    abortRef.current = false;
    setGenProgress({ total: ids.length, current: 0, currentTitle: "", results: [] });

    const results: GenProgress["results"] = [];
    for (let i = 0; i < ids.length; i += TITLE_BATCH_SIZE) {
      if (abortRef.current) break;

      const chunk = ids.slice(i, i + TITLE_BATCH_SIZE);
      const label = chunk
        .map((id) => conversations.find((c) => c.id === id)?.title || id)
        .join(" / ");
      setGenProgress((prev) => ({
        ...prev!,
        current: Math.min(i + 1, ids.length),
        currentTitle: label,
      }));

      try {
        const res = await generateAiTitles(chunk);
        results.push(...res.results.map((item) => ({
          id: item.id,
          title: item.title,
          error: item.error,
        })));
      } catch (error) {
        const message = getErrorMessage(error, "请求失败");
        results.push(...chunk.map((id) => ({ id, error: message })));
      }

      setGenProgress((prev) => ({
        ...prev!,
        current: Math.min(i + chunk.length, ids.length),
        currentTitle: label,
        results: [...results],
      }));
    }

    await reloadAllData();
    setBatchGenerating(false);
  }, [selectedIds, batchGenerating, conversations, reloadAllData, pushToast]);

  const handleAbortGenerate = useCallback(() => {
    abortRef.current = true;
  }, []);

  const closeGenProgress = useCallback(() => {
    setGenProgress(null);
  }, []);

  return {
    batchGenerating,
    genProgress,
    handleBatchChangeModelProvider,
    handleBatchMove,
    handleBatchGenerate,
    handleAbortGenerate,
    closeGenProgress,
  };
}
